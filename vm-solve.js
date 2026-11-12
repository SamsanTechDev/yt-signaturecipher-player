/* vm-solve.js - solve a signatureCipher by running the real player VM locally.
 *
 * WHY THIS FILE LOOKS LIKE THIS
 * -----------------------------
 * YouTube renames the player's internals on every player build. The old
 * version of this solver hard-coded one expression against one build's names
 * (`Gh(21,2482,Kh(41,790,s))` + `g.ti`). Drop in the next base.js and `Kh` no
 * longer exists - that is the "new base.js breaks it" crash.
 *
 * So nothing here is tied to one build:
 *
 *   1. load base.js in a sandbox, handing back a reader closure created in the
 *      player's own scope so its top-level names can be looked up by name
 *   2. resolve the sig transform by trying an ordered list of CALL SHAPES
 *      (SIG_SHAPES) and keeping the first that behaves like a signature
 *   3. resolve `n` by duck-typing the URL class (get/set + URL getter) and
 *      confirming it actually transforms an `n`
 *   4. cache per build fingerprint (path + size + mtime)
 *
 * Next release: run `node vm-solve.js --check`. If it fails, add one shape to
 * SIG_SHAPES - you do not have to re-derive anything from a stack trace.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeSandbox } = require('./tools/sandbox.js');

const BASE = path.join(__dirname, 'base.js');

/** Cache per base file fingerprint so a replaced base.js is never stale. */
let cached = null;

function fingerprint(file) {
  const st = fs.statSync(file);
  return `${path.resolve(file)}:${st.size}:${st.mtimeMs}`;
}

/**
 * Append an export hook just before the IIFE closes.
 *
 * The helpers we need (`Bh`, `Fm`, `ZE`, ... in the 2026 builds) are closure
 * *locals*, not properties of `g` or of the sandbox global, so they cannot be
 * enumerated after the file has run. We therefore rewrite the entry line -
 * the file starts with `var _yt_player={};(function(g){var window=this;` -
 * to hand the host a live accessor for every identifier the file declares:
 *
 *     (function(g, __reg){ var window=this; ...locals...;
 *        __reg(function(n){ try { return eval(n); } catch(e){} });
 *     })(_yt_player, function(reader){ ...install __vmExport... });
 *
 * The `reader` closure is created in the IIFE's own scope, so `eval(name)`
 * resolves exactly the top-level declarations of *that* build - no name list,
 * no build-specific assumptions.
 */
function patchedSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  const tail = '})(_yt_player);';
  const i = src.lastIndexOf(tail);
  if (i < 0) throw new Error(`${path.basename(file)}: IIFE tail not found`);

  // Add a second IIFE parameter + matching argument.
  const headRe = /\(function\(g\)\{/;
  const hm = headRe.exec(src);
  if (!hm) throw new Error(`${path.basename(file)}: IIFE head not found`);
  const after = hm.index + hm[0].length;

  const open = src.slice(0, hm.index) + '(function(g,__ytReg){' + src.slice(after);

  // Split off the closing `})(_yt_player);` and rebuild it with one extra arg.
  const close = /}\)\(_yt_player\);?\s*$/;
  const cm = close.exec(open);
  if (!cm) throw new Error(`${path.basename(file)}: IIFE tail not found`);
  const body = open.slice(0, cm.index);

  const readerRegister = '\n;__ytReg(function(__ytN){try{return eval(__ytN)}catch(__ytE){return void 0}});\n';

  return body + readerRegister
    + '})(_yt_player, function(__ytRead){ _yt_player.__vmExport = { read: __ytRead }; });\n';
}

/** The player's exported members plus the live closure reader. */
function harvest(context) {
  return vm.runInContext(`(function(){
    var exp = _yt_player;
    var out = {};
    if (exp) { for (var k in exp) { try { out["g." + k] = exp[k]; } catch (e) {} } }
    return { scope: out, read: exp && exp.__vmExport ? exp.__vmExport.read : null };
  })()`, context);
}

/** Look up `name` in the player's top-level closure scope. */
function readLocal(read, name) {
  try { return read(name); } catch (e) { return undefined; }
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

const PROBE_S = 'AEAE0s2JYwRQIhAO-YVBJ2Mf1g_XoCY3LhNf20adBIEvqGB5CQ8S32jXq5AiByJELBmFLvI';
const PROBE_URL = 'https://rr1---sn-abc.googlevideo.com/videoplayback?v=probe&itag=18'
  + '&n=AbCdEfGhIjKlMn&sp=sig&sig=AAAA&lsig=xyz&lsparams=x&expire=1';

/**
 * Ordered list of *call shapes* for the signature transform.
 *
 * This is the part that used to break: the old solver hard-coded ONE shape
 * (`Gh(21,2482,Kh(41,790,s))`) against build-specific names. Now each entry
 * is a shape, every shape is tried against a known-good probe, and the first
 * one that returns a plausible same-length cipher string wins. When YouTube
 * reshuffles the names again, you add one line here instead of debugging a
 * ReferenceError.
 *
 *   family  - which obfuscation generation the shape belongs to
 *   sig     - given a resolver, build the `s -> sig` function
 */
const SIG_SHAPES = [
  {
    // web_20261027+ : `Bh(5,203,Fm(14,908,s))`. Fm/Bh are polymorphic
    // dispatchers; the constants are the opcodes for the sig VM.
    family: 'bh-fm',
    build: (L) => (s) => L('Bh')(5, 203, L('Fm')(14, 908, s)),
  },
  {
    // intermediate build: the sig VM wrapped in a second dispatch.
    family: 'bh-fm-wrapped',
    build: (L) => (s) => L('Bh')(9, 1814, L('Bh')(5, 203, L('Fm')(14, 908, s))),
  },
  {
    // web_2026 (previous base.js): Kh/Gh/Nh + the old sig expression.
    family: 'kh-gh-nh',
    build: (L) => (s) => {
      const Kh = L('Kh'); const Gh = L('G');
      const k = typeof Kh === 'function' ? Kh : L('g.Kh');
      return String(Gh(21, 2482, k(41, 790, s)));
    },
  },
];

/**
 * Does `fn` behave like the sig transform?
 *
 * The trim amount is NOT fixed across builds (the old one left 3 chars, this
 * one takes 7), so we check behaviour rather than a magic length:
 *   - same input -> same output (deterministic)
 *   - output is a cipher-alphabet string, shorter than or equal to the input
 *   - it reacts to the input: two different `s` values give different results
 */
function looksLikeSig(fn, s) {
  const a1 = fn(s);
  if (typeof a1 !== 'string' || !a1.length || a1 === s) return false;
  if (!/^[A-Za-z0-9_\-=]+$/.test(a1)) return false;
  if (a1.length > s.length) return false;
  if (fn(s) !== a1) return false;                 // not deterministic

  const s2 = s.slice(0, -4) + 'Wxyz';
  const a2 = fn(s2);
  if (typeof a2 !== 'string' || a2 === a1) return false;
  return true;
}

/**
 * Resolve the sig transform: try every shape, in order.
 * Names that do not exist simply make that shape throw -> next shape.
 */
function resolveSig(read, scope) {
  // Resolver: closure locals first (Bh/Fm/...), then exported `g` members.
  const get = (name) => {
    const local = readLocal(read, name);
    if (local !== undefined) return local;
    const exported = scope['g.' + name] !== undefined ? scope['g.' + name] : scope[name];
    if (exported === undefined) throw new Error(`helper ${name} not present in this build`);
    return exported;
  };

  const tried = [];
  for (const shape of SIG_SHAPES) {
    const L = (name) => {
      // `G` is a legacy alias used by the kh-gh-nh family.
      if (name === 'G') {
        for (const alias of ['Gh', 'G']) {
          try { return get(alias); } catch (e) { /* next */ }
        }
        throw new Error('helper Gh not present in this build');
      }
      return get(name);
    };

    let fn;
    try { fn = shape.build(L); } catch (e) { tried.push(`${shape.family}: ${e.message}`); continue; }
    let out;
    try { out = fn(PROBE_S); } catch (e) { tried.push(`${shape.family}: ${e.message}`); continue; }
    if (!looksLikeSig(fn, PROBE_S)) { tried.push(`${shape.family}: output does not behave like a sig transform`); continue; }
    return { shape: shape.family, fn, out, tried };
  }
  const err = new Error(`no known sig transform shape matched this base.js.\n  tried: ${tried.join('\n  ')}`);
  err.tried = tried;
  throw err;
}

/** Same idea, but for classes on the `g` namespace. */
function findUrlClasses(scope) {
  const out = [];
  const seen = new Set();
  for (const [name, C] of Object.entries(scope)) {
    if (typeof C !== 'function') continue;
    if (seen.has(C)) continue;
    seen.add(C);
    const proto = C.prototype;
    if (!proto || typeof proto.get !== 'function' || typeof proto.set !== 'function') continue;
    let getter = null;
    for (const m of Object.getOwnPropertyNames(proto)) {
      if (m === 'constructor' || m === 'get' || m === 'set' || m === 'clone') continue;
      // Native classes (URL, URLSearchParams) expose accessors that throw on
      // `this` - read the descriptor instead of the property itself.
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(proto, m); } catch (e) { continue; }
      if (!desc || typeof desc.value !== 'function' || desc.value.length !== 0) continue;
      try {
        const inst = new C(PROBE_URL);
        const s = inst[m]();
        if (typeof s === 'string' && s.startsWith('http')) { getter = m; break; }
      } catch (e) { /* not it */ }
    }
    if (!getter) continue;
    out.push({ name, C, getter });
  }
  return out;
}

/**
 * Ask the URL class for `n`. If `n` comes back transformed, this is the class
 * and the transformed value is our answer. This is the strongest probe: it
 * only succeeds when the player actually runs its n-VM.
 */
function testUrlClass(cand, rawN, taintedN) {
  const WORDS = ['n'];
  for (const w of WORDS) {
    try {
      const a = new cand.C(PROBE_URL, true);
      const solved = a.get(w);
      if (solved && solved !== rawN) {
        // Confirm it is deterministic and not simply echoing the tainted value.
        const b = new cand.C(PROBE_URL, true);
        const solved2 = b.get(w);
        if (solved === solved2 && (taintedN === undefined || solved !== taintedN)) {
          return { ok: true, solved };
        }
      }
    } catch (e) { /* try next */ }
  }
  return { ok: false };
}

/**
 * Build the solver for one base.js. Returns an object with sig(rawS) and
 * n(url) closures plus a report of what was discovered.
 */
function buildSolver(file) {
  const { context } = makeSandbox();
  vm.runInContext(patchedSource(file), context, { filename: path.basename(file), timeout: 60000 });

  const { scope, read } = harvest(context);
  if (typeof read !== 'function') {
    throw new Error(`${path.basename(file)}: closure reader was not installed (IIFE shape changed)`);
  }

  const report = { file: path.basename(file) };

  // Signature: first shape whose probe output looks like a solved sig.
  const sig = resolveSig(read, scope);
  report.sigShape = sig.shape;

  // `n`: the URL class that actually transforms an `n` parameter.
  const rawN = new URL(PROBE_URL).searchParams.get('n');
  const urlCands = findUrlClasses(scope);
  let urlClass = null;
  for (const c of urlCands) {
    const t = testUrlClass(c, rawN);
    if (t.ok) { urlClass = c; report.nSolvedProbe = t.solved; break; }
  }
  report.urlClasses = urlCands.map((c) => c.name);

  if (!urlClass) throw new Error(`${path.basename(file)}: no URL class found (nothing solved \`n\`)`);

  return {
    report,
    sig: (rawS) => String(sig.fn(String(rawS))),
    n: (url) => {
      const u = new urlClass.C(String(url), true);
      return u.get('n');
    },
    url: (url) => {
      const u = new urlClass.C(String(url), true);
      return u[urlClass.getter]();
    },
  };
}

/** Load (and cache) the solver for a base.js file. */
function load(file = BASE) {
  const fp = fingerprint(file);
  if (cached && cached.fp === fp) return cached;
  const solver = buildSolver(file);
  solver.fp = fp;
  solver.file = path.resolve(file);
  cached = solver;
  return cached;
}

/** Return the player's own solved signature for a raw `s`. */
function playerSig(rawS, file = BASE) {
  return load(file).sig(rawS);
}

/** Return the player's own solved `n` for a URL that contains `?n=`. */
function playerN(url, file = BASE) {
  return load(file).n(url);
}

/** Signal to solver.js whether a given base.js can be solved at all. */
function describe(file = BASE) {
  return load(file).report;
}

function solveCipher(cipher, opts = {}) {
  // Accept a raw paste (file contents, JSON fragment, quoted string) as well
  // as an already-cleaned cipher string.
  const { cleanCipher } = require('./solver.js');
  const params = new URLSearchParams(cleanCipher(cipher));
  const base = params.get('url');
  if (!base) throw new Error('cipher has no url');

  // Signature: strip the base64 padding the cipher carries as %3D.
  const rawS = (params.get('s') || '').replace(/\\u003d/gi, '=');
  const decodedS = decodeURIComponent(rawS);
  const sp = params.get('sp') || 'sig';
  const file = opts.base || BASE;

  let url = base;
  let sig = null;
  if (decodedS) {
    sig = opts.sigTransform ? opts.sigTransform(decodedS) : playerSig(decodedS, file);
    const u = new URL(url);
    u.searchParams.set(sp, sig);
    url = u.toString();
  }

  // `get("n")` runs the player's n transform and returns the new value.
  const u = new URL(url);
  const rawN = u.searchParams.get('n');
  let solvedN = null;
  if (rawN) {
    solvedN = opts.nTransform ? opts.nTransform(rawN) : playerN(url, file);
    if (solvedN && solvedN !== rawN) {
      u.searchParams.set('n', solvedN);
      url = u.toString();
    }
  }
  return { url, rawS: decodedS, sig, rawN, solvedN, report: load(file).report };
}

/**
 * Solve using the self-learning engine.
 *
 * Unlike solveCipher, this does not assume any helper name is present: it
 * discovers what the build can do, replays a remembered recipe when it has one,
 * and otherwise searches until googlevideo answers 206 - then remembers that.
 *
 * Set YT_LEARN=0 to disable the engine and fall back to the fixed shapes.
 */
async function solveSmart(cipher, opts = {}) {
  if (process.env.YT_LEARN === '0') return solveCipher(cipher, opts);

  // The engine probes arbitrary player internals; a stray async throw from one
  // of them must not kill the process.
  const quiet = (e) => {};
  process.on('uncaughtException', quiet);
  process.on('unhandledRejection', quiet);

  const learn = require('./engine/learn.js');
  const { cleanCipher } = require('./solver.js');
  const cleaned = cleanCipher(cipher);

  // The engine is allowed to exhaust every candidate and still fail. That is
  // a normal outcome, not an exception: returning it keeps the probe history
  // so the UI can show exactly what was attempted instead of going blank.
  let res;
  try {
    res = await learn.solveAuto(cleaned, { base: opts.base || BASE, force: opts.force, onEvent: opts.onEvent });
  } catch (e) {
    return { ok: false, url: null, sig: null, solvedN: null,
      engine: { ok: false, error: e.message, probes: 0, trace: [] } };
  }

  if (!res.ok) {
    return { ok: false, url: null, sig: null, solvedN: null,
      engine: { ok: false, probes: res.probes || 0, trace: res.trace || [],
                error: 'tried ' + (res.probes || 0) + ' candidate(s), all rejected (403)' } };
  }

  const params = new URLSearchParams(cleaned);
  return {
    ok: true,
    url: res.url,
    rawS: decodeURIComponent(params.get('s') || ''),
    sig: res.sig,
    rawN: new URL(params.get('url')).searchParams.get('n'),
    solvedN: res.solvedN,
    engine: {
      ok: true,
      probes: res.probes,
      winner: res.winner,
      source: res.reusedRecipe
        ? 'remembered recipe'
        : (res.recalled ? 're-learned (old recipe was stale)' : 'searched and learned'),
      recalled: res.recalled ? res.recalled.source : null,
      reused: !!res.reusedRecipe,
      build: {
        timestamp: res.build.timestamp,
        fingerprint: res.build.fingerprint,
        structure: res.build.structure,
        urlClass: (res.discover.urlClasses[0] || {}).name || null,
        transform: (res.discover.transformHelpers[0] || {}).name || null,
        // The player's own URL builder, when this build exposes the alr marker.
        alr: res.alr ? res.alr.name : null,
      },
    },
  };
}

module.exports = {
  load, playerSig, playerN, playerUrl: (url, f = BASE) => load(f).url(url),
  solveCipher, patchedSource, describe, PROBE_S, PROBE_URL,
  solveSmart,
};

if (require.main === module) {
  // --check / --describe: report what resolved, without needing a cipher.
  if (process.argv.includes('--check') || process.argv.includes('--describe')) {
    const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || BASE;
    try {
      console.log('base   :', path.resolve(file));
      console.log('report :', JSON.stringify(describe(file), null, 2));
      console.log('sig(probe):', playerSig(PROBE_S, file));
      console.log('n(probe)  :', playerN(PROBE_URL, file));
      console.log('\nOK - this base.js is solvable.');
    } catch (e) {
      console.error('\nFAIL - this base.js is not solvable by the known shapes:');
      console.error(e.message);
      console.error('\nFix: add a shape to SIG_SHAPES in vm-solve.js that matches the new build.');
      process.exitCode = 1;
    }
    return;
  }

  const file = process.argv[2] || path.join(__dirname, 'cipher.txt');
  const cipher = fs.readFileSync(file, 'utf8').trim();
  const t = Date.now();
  const r = solveCipher(cipher);
  console.log('solved in', Date.now() - t, 'ms');
  console.log('discovered:', JSON.stringify(r.report));
  console.log('sig :', r.sig);
  console.log('n   :', r.solvedN);
  console.log('url :', r.url);
  (async () => {
    const res = await fetch(r.url, { headers: { range: 'bytes=0-1023', 'user-agent': 'Mozilla/5.0' } });
    console.log('probe:', res.status, res.headers.get('content-range'), res.headers.get('content-type'));
  })();
}
