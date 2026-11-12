/**
 * engine/player.js - load one base.js and report what it can do.
 *
 * This replaces the old "hard-code Kh/Gh/Nh/ti" step. Discovery answers:
 *   * which helpers this build exposes (closure locals + exported g)
 *   * which functions behave like an s -> s transform
 *   * which classes behave like the URL class (get/set + url getter)
 *   * a fingerprint and a structural signature
 *
 * The structural signature is what lets a recipe survive a rename.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeSandbox } = require('../tools/sandbox.js');

// Runs INSIDE the player's vm context, before anything is probed.
//
// Players legitimately schedule work on timers, including retry loops that
// reschedule themselves. In a browser those loops are bounded by real I/O. In
// our sandbox there is no IndexedDB, no worker and no network, so a retry can
// succeed instantly and spin forever - or throw from a promise callback, which
// is an internal Node path that no host-side listener can catch.
//
// So the trap is installed on the inside: every timer callback is guarded, and
// a single callback may only reschedule itself a limited number of times.
const NEW_GUARD_SRC = `
(function () {
  var st = this.setTimeout, si = this.setInterval;
  var LIMIT = 25;

  // Budget is per callback function: a retry loop reschedules the SAME fn.
  var budgets = new WeakMap();
  function spend(fn) {
    var used = budgets.get(fn) || 0;
    if (used >= LIMIT) return false;
    budgets.set(fn, used + 1);
    return true;
  }
  function wrap(fn) {
    if (typeof fn !== "function") return fn;
    return function () {
      if (!spend(fn)) return;
      try { return fn.apply(this, arguments); } catch (e) {}
    };
  }
  this.setTimeout = function (fn, ms) { return st(wrap(fn), ms); };
  this.setInterval = function (fn, ms) { return si(wrap(fn), ms); };
}).call(this);
`;

const PROBE_S = 'AEAE0s2JYwRQIhAO-YVBJ2Mf1g_XoCY3LhNf20adBIEvqGB5CQ8S32jXq5AiByJELBmFLvI';
const PROBE_URL = 'https://rr1---sn-abc.googlevideo.com/videoplayback?v=probe&itag=18'
  + '&n=AbCdEfGhIjKlMn&sp=sig&sig=AAAA&lsig=xyz&lsparams=x&expire=1';

function patchedSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  const hm = /\(function\(g\)\{/.exec(src);
  if (!hm) throw new Error(`${path.basename(file)}: IIFE head not found`);
  const opened = src.slice(0, hm.index) + '(function(g,__ytReg){'
    + src.slice(hm.index + hm[0].length);
  const cm = /\}\)\(_yt_player\);?\s*$/.exec(opened);
  if (!cm) throw new Error(`${path.basename(file)}: IIFE tail not found`);
  const body = opened.slice(0, cm.index);

  // Identifiers the body plausibly declares. Over-collecting is harmless:
  // anything that does not resolve is dropped when the host calls list().
  // This is what makes discovery survive a rename inside `_yt_player`.
  const idents = new Set();
  const patterns = [
    /\b([A-Za-z_$][\w$]*)\s*=\s*function\b/g,
    /\b([A-Za-z_$][\w$]*)\s*=\s*class\b/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\bvar\s+([A-Za-z_$][\w$]*)/g,
    /\blet\s+([A-Za-z_$][\w$]*)/g,
    /\bconst\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) !== null) idents.add(m[1]);
  }
  const literal = JSON.stringify([...idents]);

  return body
    + '\n;__ytReg(function(__ytN){try{return eval(__ytN)}catch(__ytE){return void 0}},'
    + literal + ');\n'
    + '})(_yt_player, function(__ytRead,__ytNames){ _yt_player.__vmExport = { read: __ytRead, names: __ytNames }; });\n';
}

function readTimestamp(src) {
  const m = /signatureTimestamp\s*:\s*(\d{3,6})/.exec(src);
  return m ? Number(m[1]) : null;
}

/**
 * Does fn behave like an s -> sig transform?
 * The trim amount changes between builds (3 chars once, 7 now), so we test
 * behaviour, never a fixed length.
 */
function behavesLikeSig(fn, s = PROBE_S) {
  // Probing arbitrary player internals is intentionally reckless: most of them
  // throw synchronously, and a few are async and reject *after* returning.
  // Quarantine those so one unrelated helper cannot take down discovery.
  let a1;
  try { a1 = fn(s); } catch (e) { return null; }
  if (a1 && typeof a1.then === 'function') {
    try { a1.catch(function () {}); } catch (e) { /* not a real promise */ }
    return null;
  }
  if (typeof a1 !== 'string' || !a1.length || a1 === s) return null;
  if (!/^[A-Za-z0-9_\-=]+$/.test(a1)) return null;
  // Do NOT assume the output is shorter than the input. Modern ciphers
  // re-encode and can grow it (111 chars in -> 115 out on older builds).
  // Only reject an implausible size, which catches hashes and big blobs.
  let again;
  try { again = fn(s); } catch (e) { return null; }
  if (again !== a1) return null;
  const s2 = s.slice(0, -4) + 'Wxyz';
  let a2;
  try { a2 = fn(s2); } catch (e) { return null; }
  if (typeof a2 !== 'string' || a2 === a1) return null;
  return a1;
}

/**
 * Classify a candidate URL class.
 *
 * A class only has to *solve `n`* to be useful. The URL getter and `set` are
 * heuristics, not requirements: demanding them would throw away a perfectly
 * good n-solver on a build where the getter happens to break - exactly the
 * brittle name/shape matching this engine is here to avoid.
 */
function urlClassShape(C) {
  const proto = C && C.prototype;
  if (!proto || typeof proto.get !== 'function') return null;

  const getters = [];
  if (typeof proto.set === 'function') {
    for (const m of Object.getOwnPropertyNames(proto)) {
      if (m === 'constructor' || m === 'get' || m === 'set' || m === 'clone') continue;
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(proto, m); } catch (e) { continue; }
      if (!desc || typeof desc.value !== 'function' || desc.value.length !== 0) continue;
      try {
        const s = new C(PROBE_URL)[m]();
        if (typeof s === 'string' && s.startsWith('http')) getters.push(m);
      } catch (e) { /* not a url getter - fine */ }
    }
  }

  const rawN = new URL(PROBE_URL).searchParams.get('n');
  const ctorArgs = [];
  for (const n of [2, 1]) {
    try {
      const inst = n >= 2 ? new C(PROBE_URL, true) : new C(PROBE_URL);
      if (!inst || typeof inst.get !== 'function') continue;
      const v = inst.get('n');
      if (typeof v === 'string' && v && v !== rawN) ctorArgs.push(n);
    } catch (e) { /* try next arity */ }
  }
  if (!ctorArgs.length) return null;

  return { getters, ctorArgs };
}

/** Names the shape registry may ask for, probed even when not enumerable. */
const KNOWN = ['Bh', 'Fm', 'Kh', 'Gh', 'Nh', 'Se', 'rk', 'ti', 'aj', 'ZE', 'RH', 'fn'];

/**
 * (a, b) pairs that select the signature branch of a dispatcher.
 *
 * These are stable across builds while function names are not: the pair is
 * baked into the call site, and a rename does not touch it.
 */
const DISPATCH_PAIRS = [[5, 203], [14, 908], [9, 1814], [21, 2482], [41, 790], [4, 17]];


// The player schedules promisified work of its own. When a probe hands it input
// the real page would never send, that work can reject long after the probe has
// returned, and the throw lands on the host process instead of inside the vm.
// Discovery is speculative by nature, so those late failures are noise: they
// must not take down the caller. Installed once, process-wide, and only while
// a load is in progress.
// The player's own timers outlive load(), so the guard has to as well. It is
// installed once and left in place: the only thing it swallows is a late throw
// that no caller is waiting on.
let cache = null;

let noiseInstalled = false;
function withNoiseGuard() {
  if (noiseInstalled) return;
  noiseInstalled = true;
  process.on('uncaughtException', ignoreNoise);
  process.on('unhandledRejection', ignoreNoise);
}

withNoiseGuard();

function ignoreNoise(err) {
  if (process.env.YT_VERBOSE) console.error('[player] ignored late error:', (err && err.message) || err);
}

/**
 * @param file  path to base.js
 * @param opts  { quick: true } loads names/classes but skips the expensive
 *              transform scan - enough to replay a learned recipe.
 */
function load(file, opts = {}) {
  const quick = !!opts.quick;
  const st = fs.statSync(file);
  const key = `${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`;
  const cacheKey = key + (quick ? '|quick' : '');
  if (cache && cache.key === cacheKey) return cache.player;

  const source = fs.readFileSync(file, 'utf8');
  const timestamp = readTimestamp(source);

  const { context } = makeSandbox();

  vm.runInContext(patchedSource(file), context, { filename: path.basename(file), timeout: 60000 });

  const exported = vm.runInContext(
    '(function(){var o={};for(var k in _yt_player)o[k]=_yt_player[k];return o;})()', context);
  const read = vm.runInContext('(_yt_player.__vmExport||{}).read', context);
  if (typeof read !== 'function') throw new Error(`${path.basename(file)}: scope reader not installed`);
  const candidateNames = vm.runInContext('(_yt_player.__vmExport||{}).names||[]', context);

  // Probing arbitrary player internals makes the player throw from *inside* its
  // own context - through its own setTimeout and its own promise chains - where
  // a host-side try/catch cannot reach. Install an in-context trap first so a
  // careless probe cannot take the whole process down.
  vm.runInContext(NEW_GUARD_SRC, context);


  const readLocal = (name) => {
    try { return read(name); } catch (e) { return undefined; }
  };

  const resolve = (name) => {
    const local = readLocal(name);
    if (local !== undefined) return local;
    if (exported[name] !== undefined) return exported[name];
    if (exported[`g.${name}`] !== undefined) return exported[`g.${name}`];
    throw new Error(`helper "${name}" is not present in this build`);
  };
  const has = (name) => {
    try { resolve(name); return true; } catch (e) { return false; }
  };

  // Candidate names: everything the IIFE could have declared (closure locals),
  // plus whatever `_yt_player` exports, plus the historical favourites.
  const names = new Set();
  for (const k of Object.keys(exported)) names.add(k.startsWith('g.') ? k.slice(2) : k);
  for (const n of candidateNames) names.add(n);
  for (const n of KNOWN) if (has(n)) names.add(n);

  // -------------------------------------------------------------------------
  // guarded calls
  // -------------------------------------------------------------------------
  //
  // Probing a random player helper can loop forever. A host-side try/catch
  // cannot interrupt that, but `vm` can: run the call inside the context under
  // a timeout and the whole script is aborted when it overruns.
  //
  // The callable is parked on a global slot and invoked by a tiny script, so no
  // host object has to cross the boundary.
  vm.runInContext('this.__ytProbeFn = null; this.__ytProbeArgs = []; this.__ytProbeOut = void 0;', context);
  const PROBE_TIMEOUT = Number(process.env.YT_PROBE_TIMEOUT_MS || 120);

  /**
   * Call `fn(...args)` with a hard timeout.
   * @returns { ran, value, error }  - `ran: false` means it hung or crashed.
   */
  const guardedCall = (fn, args) => {
    try { context.__ytProbeFn = fn; context.__ytProbeArgs = args || []; } catch (e) { return { ran: false, value: undefined }; }
    try {
      vm.runInContext(
        'try { __ytProbeOut = __ytProbeFn.apply(null, __ytProbeArgs); }'
        + ' catch (e) { __ytProbeOut = void 0; }',
        context, { timeout: PROBE_TIMEOUT });
      const out = context.__ytProbeOut;
      return { ran: true, value: out };
    } catch (e) {
      return { ran: false, value: undefined };
    } finally {
      try { context.__ytProbeFn = null; context.__ytProbeArgs = []; context.__ytProbeOut = void 0; } catch (e) { /* ignore */ }
    }
  };

  const fnNames = [];
  const transformHelpers = [];
  const urlClasses = [];

  // Live-calling player internals is the expensive part of discovery, so it
  // runs under an explicit budget instead of "try everything". Names are
  // visited in priority order: the ones we have historically seen carry the
  // transform, then exported `g` members, then other closure locals.
  //
  // Getting this wrong costs a candidate, never correctness - the oracle still
  // decides which rendered sig is right.
  const arity = (v) => {
    const n = Number(v.length);
    return Number.isFinite(n) ? n : 3;
  };
  // Every plain function has a `.prototype` object, so that alone says nothing.
  // A real class (or constructor) also owns methods on that prototype.
  const isClass = (v) => {
    const p = v.prototype;
    return !!p && typeof p === 'object' && Object.getOwnPropertyNames(p).length > 1;
  };

  const priority = (name) => {
    if (KNOWN.includes(name)) return 0;              // historical helpers
    if (exported[name] !== undefined || exported[`g.${name}`] !== undefined) return 1;
    return 2;                                        // closure-only local
  };
  const ordered = [...names].map((n) => ({ n, p: priority(n) })).sort((a, b) => a.p - b.p || a.n.localeCompare(b.n));

  let budget = Number(process.env.YT_SCAN_BUDGET || 20000);
  const fnCandidates = [];
  for (const { n, p } of ordered) {
    let v;
    try { v = resolve(n); } catch (e) { continue; }
    if (typeof v !== 'function') continue;
    fnCandidates.push({ name: n, v, p });
  }

  const cheap = (fn) => {
    let out;
    try { out = fn(PROBE_S); } catch (e) { return null; }
    if (typeof out !== 'string' || !out.length || out === PROBE_S) return null;
    if (!/^[A-Za-z0-9_\-=]+$/.test(out)) return null;
    if (out.length > PROBE_S.length) return null;
    return out;
  };
  const cheapGuarded = (fn) => {
    const r = guardedCall(fn, [PROBE_S]);
    if (!r.ran) return null;
    const out = r.value;
    if (typeof out !== 'string' || !out.length || out === PROBE_S) return null;
    if (!/^[A-Za-z0-9_\-=]+$/.test(out)) return null;
    if (out.length > PROBE_S.length) return null;
    return out;
  };
  const behavesLikeSigGuarded = (fn) => {
    // Full check, but every call is timeout-guarded.
    const call = (s) => { const r = guardedCall(fn, [s]); return r.ran ? r.value : undefined; };
    const a1 = call(PROBE_S);
    if (typeof a1 !== 'string' || !a1.length || a1 === PROBE_S) return null;
    if (!/^[A-Za-z0-9_\-=]+$/.test(a1)) return null;
    if (a1.length > PROBE_S.length) return null;
    if (call(PROBE_S) !== a1) return null;
    const s2 = PROBE_S.slice(0, -4) + 'Wxyz';
    const a2 = call(s2);
    if (typeof a2 !== 'string' || a2 === a1) return null;
    return a1;
  };


  // Classes first (cheap and decisive), then transforms, both inside budget.
  for (const { name, v } of fnCandidates) {
    if (budget <= 0) break;
    if (!isClass(v)) continue;
    budget -= 1;
    let shape;
    try { shape = urlClassShape(v); } catch (e) { shape = null; }
    if (shape) {
      urlClasses.push({
        name,
        C: v,
        getter: shape.getters[0],
        getters: shape.getters,
        ctorArgs: shape.ctorArgs,
        transformsN: shape.ctorArgs.length > 0,
        // The real URL class can also rebuild its own url. A type that merely
        // accepts (url, true) and echoes a transformed n does not, so this
        // separates the real solver from look-alikes.
        hasUrlGetter: shape.getters.length > 0,
      });
    }
  }

  // Best candidates first: one whose url getter works, and whose ctor arity is
  // the (url, true) form we actually want.
  urlClasses.sort((a, b) => (Number(b.hasUrlGetter) - Number(a.hasUrlGetter))
    || (Number(b.ctorArgs.includes(2)) - Number(a.ctorArgs.includes(2))));
  // Keep only a handful: the n-search runs once per class, and one or two
  // look-alikes is plenty of fallback.
  urlClasses.length = Math.min(urlClasses.length, Number(process.env.YT_MAX_URL_CLASSES || 3));

  for (const { name, v } of fnCandidates) {
    if (budget <= 0) break;
    // A real class was already classified above.
    if (isClass(v)) continue;
    if (arity(v) < 1) continue;
    budget -= 1;
    fnNames.push(name);
    const out = behavesLikeSigGuarded(v);
    if (out) transformHelpers.push({ name, out });
  }

  for (const { name } of fnCandidates) if (!fnNames.includes(name)) fnNames.push(name);

  // Dispatchers are NOT `f(s)`: they are `dispatch(a, b, value)` where `a`/`b`
  // select the branch. Their names churn every build, but the opcode pairs do
  // not. Probe plausible dispatchers with the known pairs and keep any that
  // behaves like a transform - that is what recovers a renamed build.
  //
  // This is the expensive stage, so it runs in two passes: one cheap call to
  // discard the vast majority (they throw or return a non-string), and the full
  // behavioural check only on what survives.
  const dispatchers = [];
  let budget2 = quick ? 0 : Number(process.env.YT_DISPATCH_BUDGET || 20000);
  for (const { name, v } of fnCandidates) {
    if (budget2 <= 0) break;
    if (isClass(v)) continue;
    if (arity(v) < 3) continue;
    budget2 -= 1;
    dispatchers.push(name);
    for (const [a, b] of DISPATCH_PAIRS) {
      const probe = (s) => v(a, b, String(s));
      if (!cheapGuarded(probe)) continue;
      const out = behavesLikeSigGuarded(probe);
      if (out) {
        transformHelpers.push({ name, out, a, b });
        break;
      }
    }
  }

  const structure = [
    timestamp,
    fnNames.length,
    urlClasses.length,
    has('Kh') ? 1 : 0,
    has('Bh') ? 1 : 0,
    has('Fm') ? 1 : 0,
    transformHelpers.map((h) => h.name).sort().join('+'),
  ].join(':');

  const build = {
    file: path.resolve(file),
    name: path.basename(file),
    fingerprint: `${path.basename(file)}|${st.size}|${Math.round(st.mtimeMs)}|ts=${timestamp}`,
    structure,
    timestamp,
    names: [...names],
    fnNames,
    urlClasses: urlClasses.map((c) => ({
      name: c.name, getter: c.getter, getters: c.getters, ctorArgs: c.ctorArgs, transformsN: c.transformsN,
    })),
    // Full records, so callers can see *how* a helper is invoked, not just its
    // name: `a`/`b` present means it is a dispatcher, absent means `helper(s)`.
    transformHelpers: transformHelpers.map((h) => ({
      name: h.name, out: h.out, a: h.a, b: h.b,
    })),
    has,
  };

  const classesByName = {};
  for (const c of urlClasses) classesByName[c.name] = c;

  const player = {
    build, read: readLocal, resolve, exported, classesByName,
    urlClasses, transformHelpers, PROBE_S, PROBE_URL,
    // Raw source, so the AST solver can parse the player the way yt-dlp does
    // instead of probing its internals.
    source,
  };

  cache = { key: cacheKey, player };
  return player;
}

module.exports = {
  load, patchedSource, readTimestamp, behavesLikeSig, urlClassShape,
  PROBE_S, PROBE_URL,
};
