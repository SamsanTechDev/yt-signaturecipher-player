/**
 * engine/alr.js - let the player solve itself ("the alr=yes path").
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything in engine/sites.js reads the player's *data flow*: find where `s`
 * enters `Jc(48,9011, ...)`, rebuild that chain, hope it is the right reading.
 * That works, but it is still our reading of YouTube's code.
 *
 * The player already contains a function whose whole job is to build a playback
 * URL from a cipher - the one that calls `.set("alr","yes")` on a fresh URL
 * object. Hand it the encrypted `s` and it hands back the solved one, because
 * that is what it does in the browser. No names, no opcodes, no chain.
 *
 *     const url = builder(probeUrl, "s", encodeURIComponent(rawS));
 *     url.set("n", rawN);          // the setter runs the n transform
 *     url.get("s")                 // <- the solved signature
 *
 * This is the trick the Python solver uses, and it is rename-proof by
 * construction: it depends on a marker string in the source and a URL object's
 * public shape, not on any single character of minified code.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a replacement for the search. It is one candidate, tried first, and it
 * still has to produce 206 like everything else. If YouTube removes the
 * `alr=yes` marker (or the object stops round-tripping), discover() returns
 * null and the normal engine runs untouched.
 *
 * The suite is also thin on purpose: `set("alr","yes")` appears several times
 * in a real player (a getter, a redirect builder, a class method). Only one of
 * them turns a cipher into a signature, so every candidate is *verified* by
 * building a URL before it is trusted.
 */
'use strict';

const PROBE_S = 'AEAE0s2JYwRQIhAO-YVBJ2Mf1g_XoCY3LhNf20adBIEvqGB5CQ8S32jXq5AiByJELBmFLvI';
const PROBE_N = 'AbCdEfGhIjKlMn';
const PROBE_URL = 'https://rr1---sn-abc.googlevideo.com/videoplayback?v=probe&itag=18'
  + '&n=' + PROBE_N + '&sp=sig&sig=AAAA&lsig=xyz&lsparams=x&expire=1';

/** The marker: a URL object being told "this is an adaptive live response". */
const MARKER = /set\(\s*["']alr["']\s*,\s*["']yes["']\s*\)/g;

/** Methods every URL object has; the transforming one is whatever is left. */
const RESERVED = ['constructor', 'set', 'get', 'clone'];

/**
 * The name of the function whose body encloses `at`.
 *
 * Minified players write builders in a handful of shapes:
 *
 *     Bs=function(a,b="",c=""){ ... }
 *     function Bs(a,b,c){ ... }
 *     Bs=(a,b,c)=>{ ... }
 *
 * Classes and object literals have no name here (their "head" is `constructor`
 * or a key), which is exactly what we want: those are not the cipher builder.
 */
function enclosingName(src, at) {
  let depth = 0;
  let i = at;
  for (; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') depth++;
    else if (ch === '{') { if (depth === 0) break; depth--; }
  }
  if (i <= 0) return null;

  const head = src.slice(Math.max(0, i - 320), i);
  const patterns = [
    /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/,
    /([A-Za-z_$][\w$.]*)\s*=\s*(?:async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*$/,
    /([A-Za-z_$][\w$.]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*$/,
    /([A-Za-z_$][\w$.]*)\s*=\s*[A-Za-z_$][\w$]*\s*=>\s*$/,
  ];
  for (const re of patterns) {
    const m = re.exec(head);
    if (m) return m[1];
  }
  return null;
}

/** Every function name that could be the cipher builder, in source order. */
function markerNames(src, limit = 8) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(MARKER.source, 'g');
  let m;
  while ((m = re.exec(src)) && out.length < limit) {
    const name = enclosingName(src, m.index);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Call the object's own serializer - the method that turns it back into a URL
 * string. Returns that method's name, or null if this object is not a URL.
 *
 * This is the strongest cheap proof that a candidate is a real URL object and
 * not something that merely happens to have get/set (e.g. a Map wrapper).
 */
function findSerializer(obj) {
  let proto;
  try { proto = Object.getPrototypeOf(obj); } catch (e) { return null; }
  if (!proto) return null;
  const keys = Object.keys(proto).concat(Object.getOwnPropertyNames(proto));
  for (const key of keys) {
    if (RESERVED.includes(key)) continue;
    try {
      const out = obj[key]();
      if (typeof out === 'string' && /^https?:\/\//i.test(out)) return key;
    } catch (e) { /* not the serializer - try the next method */ }
  }
  return null;
}

/** Does this function build a URL from a cipher and solve its `s`? */
function verify(builder) {
  const a = builder(PROBE_URL, 's', encodeURIComponent(PROBE_S));
  if (!a || typeof a.get !== 'function' || typeof a.set !== 'function') return null;

  // The signature slot has to exist and be a string; a builder that ignores
  // the third argument (the redirect one) hands back null here.
  let first;
  try { first = a.get('s'); } catch (e) { return null; }
  if (typeof first !== 'string' || !first.length) return null;

  const serializer = findSerializer(a);
  if (!serializer) return null;

  // It must actually change the value, and do it deterministically.
  if (decodeURIComponent(first) === PROBE_S) return null;
  const b = builder(PROBE_URL, 's', encodeURIComponent(PROBE_S));
  if (String(b.get('s')) !== String(first)) return null;

  // ...and it must react to the input rather than echoing a constant.
  const other = PROBE_S.slice(0, -2) + 'Qw';
  const c = builder(PROBE_URL, 's', encodeURIComponent(other));
  if (String(c.get('s')) === String(first)) return null;

  return { serializer };
}

/** The solved signature for `rawS`. */
function sigVia(builder, rawS) {
  const url = builder(PROBE_URL, 's', encodeURIComponent(String(rawS)));
  const s = url && url.get('s');
  if (s == null) return null;
  try { return decodeURIComponent(String(s)); } catch (e) { return String(s); }
}

/**
 * The solved `n` for `rawN`.
 *
 * Order matters: `set("n", ...)` must happen before the first `get("s")`, or
 * some builds mark the object as read and leave `n` untransformed. The caller
 * below never reads `s` first for this reason.
 */
function nVia(builder, rawN) {
  const url = builder(PROBE_URL, 's', encodeURIComponent(PROBE_S));
  url.set('n', String(rawN));
  try { findSerializer(url); } catch (e) { /* lazy work, ignore */ }
  const n = url.get('n');
  return n == null ? null : String(n);
}

/** Both at once - this is the one-probe path. */
function solvePair(builder, rawS, rawN) {
  const url = builder(PROBE_URL, 's', encodeURIComponent(String(rawS)));
  if (rawN != null) url.set('n', String(rawN));
  try { findSerializer(url); } catch (e) { /* lazy work, ignore */ }
  const s = url.get('s');
  const n = rawN == null ? null : url.get('n');
  let sig = null;
  if (s != null) {
    try { sig = decodeURIComponent(String(s)); } catch (e) { sig = String(s); }
  }
  return { sig, n: n == null ? null : String(n) };
}

const cache = new WeakMap();

/**
 * Find and verify the builder for one loaded player.
 *
 * @param   player  engine/player.js output (needs .source and .resolve)
 * @returns null when this build has no usable `alr` builder
 *          { name, serializer, tried, sig(s), n(n), solve(s, n) }
 */
function discover(player) {
  if (!player || typeof player.resolve !== 'function' || !player.source) return null;
  const hit = cache.get(player);
  if (hit !== undefined) return hit;

  const names = markerNames(player.source);
  const tried = [];
  for (const name of names) {
    let builder;
    try { builder = player.resolve(name); } catch (e) {
      tried.push(`${name}: not in this build`);
      continue;
    }
    if (typeof builder !== 'function') { tried.push(`${name}: not a function`); continue; }

    let v;
    try { v = verify(builder); } catch (e) { tried.push(`${name}: ${e.message}`); continue; }
    if (!v) { tried.push(`${name}: does not build a URL from a cipher`); continue; }

    const found = {
      name,
      serializer: v.serializer,
      tried,
      sig: (s) => sigVia(builder, s),
      n: (n) => nVia(builder, n),
      solve: (s, n) => solvePair(builder, s, n),
    };
    cache.set(player, found);
    return found;
  }

  cache.set(player, null);
  return null;
}

module.exports = {
  discover, markerNames, enclosingName, verify, findSerializer,
  sigVia, nVia, solvePair,
  PROBE_S, PROBE_N, PROBE_URL,
};
