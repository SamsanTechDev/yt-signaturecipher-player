/**
 * solver.js - solve YouTube's signature ("s") and throttling-parameter ("n").
 *
 * The 2026 player computes both inside an obfuscated bytecode VM, not with a
 * plain array program. Porting that program is what broke the old solver, so
 * the default path now executes the real player JS (base.js) in a Node vm and
 * calls its own helpers:
 *
 *   sig = Gh(21, 2482, Kh(41, 790, s))
 *   n   = new g.ti(url, true).get("n")
 *
 * The static program below is kept only as reference / --static archaeology.
 * Normal use (solve.js, build-play.js, server.js) always goes through the
 * player VM and never falls back silently.
 */

'use strict';

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function swap0(a, index) {
  const n = a.length;
  if (!n) return;
  const i = ((index % n) + n) % n;
  const t = a[0];
  a[0] = a[i];
  a[i] = t;
}

function rotateRight(a, d) {
  const n = a.length;
  if (!n) return;
  let k = ((d % n) + n) % n;
  if (!k) return;
  const tail = a.splice(n - k, k);
  a.unshift.apply(a, tail);
}

function removeAt(a, index) {
  const n = a.length;
  if (!n) return;
  a.splice(((index % n) + n) % n, 1);
}

// ---------------------------------------------------------------------------
// signature ("s")
// ---------------------------------------------------------------------------

/** Apply the recovered signature op program to a string. */
function sigTransform(input) {
  const a = String(input).split('');
  swap0(a, 62);      // Jk(62)
  a.splice(0, 2);    // QD(2)
  swap0(a, 54);      // Jk(54)
  a.reverse();       // rZ
  a.splice(0, 2);    // QD(2)
  a.reverse();       // rZ
  swap0(a, 1);       // Jk(1)
  a.splice(0, 2);    // QD(2)
  return a.join('');
}

// ---------------------------------------------------------------------------
// n transform
// ---------------------------------------------------------------------------

const N_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const N_KEY = 'Hg1OiH';

/**
 * In-place keyed substitution used by the player.
 *   out[i] = A[(idx(in[i]) - idx(key[i])) mod 64]
 * where key[i] is N_KEY[i] for i < N_KEY.length and otherwise out[i - len].
 * Equivalent to the player's feedback form (each emitted char extends the key
 * array by one, so the key lags the output by exactly N_KEY.length).
 */
function nSubstitute(a, key = N_KEY, alphabet = N_ALPHABET) {
  const L = alphabet.length;
  const keyArr = key.split('');
  for (let i = 0; i < a.length; i++) {
    const k = i < keyArr.length ? keyArr[i] : a[i - keyArr.length];
    const out = alphabet[
      ((alphabet.indexOf(a[i]) - alphabet.indexOf(k)) % L + L) % L
    ];
    a[i] = out;
    keyArr.push(out);
  }
}

/** Portable `n` transform. Returns a string of length input.length - 2. */
function nTransform(input) {
  const a = String(input).split('');

  swap0(a, 1823040307);
  a.reverse();
  swap0(a, -1801468882);
  swap0(a, 1414855249);
  a.reverse();
  swap0(a, 2099090603);
  swap0(a, 1219082256);
  swap0(a, -383983821);
  a.reverse();

  rotateRight(a, -1246045650);   // ua(33)
  nSubstitute(a);                // Xg(14)
  rotateRight(a, 1853049713);    // xa(80)
  rotateRight(a, -417793934);    // ua(33)
  swap0(a, -1906451345);
  rotateRight(a, -344767539);    // ua(33)
  swap0(a, 1052197245);

  removeAt(a, 887234779);        // wb(4)
  a.reverse();                   // Wl(10)
  rotateRight(a, 628430794);     // ua(33)
  rotateRight(a, 744466386);     // xa(80)
  removeAt(a, 2025915789);       // wb(4)

  return a.join('');
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Static (legacy) solve. Correct for player builds up to signatureTimestamp
 * ~20744, where `s`/`n` were plain array programs. The 2026 players replaced
 * them with a bytecode VM, so this is only the fallback.
 */
function decipherStatic(cipher, opts = {}) {
  const params = new URLSearchParams(cipher);
  const url = params.get('url');
  if (!url) throw new Error('cipher has no url');
  const base = new URL(url);
  const s = params.get('s');
  if (s) {
    const sp = params.get('sp') || 'signature';
    const raw = decodeURIComponent(s);
    base.searchParams.set(sp, (opts.sigTransform || sigTransform)(raw));
  }
  const n = base.searchParams.get('n');
  if (n) base.searchParams.set('n', (opts.nTransform || nTransform)(n));
  return {
    url: base.toString(),
    sig: s ? base.searchParams.get(params.get('sp') || 'signature') : null,
    n: n ? base.searchParams.get('n') : null,
    rawS: s ? decodeURIComponent(s) : null,
    rawN: n,
    engine: 'static',
    errors: [],
  };
}

/** Strip JSON/quotes/labels around a pasted signatureCipher. */
function cleanCipher(input) {
  let text = String(input == null ? '' : input).trim();

  // A bare quoted JSON string: "s=...&url=..."
  if (text.startsWith('"')) {
    try {
      const s = JSON.parse(text);
      if (typeof s === 'string') text = s.trim();
    } catch (e) { /* not a complete JSON string */ }
  }

  // A whole playerResponse / format object
  if (text.startsWith('{') || text.startsWith('[')) {
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    const json = data ? JSON.stringify(data) : '';
    const hit = json.match(/"signatureCipher"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      || json.match(/"cipher"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (hit) text = JSON.parse(`"${hit[1]}"`);
  }

  // Strip a `"signatureCipher": ` label first, then the surrounding quotes.
  // Order matters: stripping quotes first leaves `"s=...` as the first key
  // (key becomes `"s`, so the real `s` is silently never found).
  text = text
    .replace(/^.*?\bsignatureCipher["']?\s*[:=]\s*/is, '')
    .replace(/^[\s"']+/, '')
    .replace(/["'],?\s*$/, '')
    .trim();

  // A pasted cipher is sometimes URL-encoded once more than it should be
  // (`...&url=https%3A%2F%2F...%22%2C`): decode the whole string if the `url`
  // value looks encoded. Guarded so a doubly-encoded url= is left alone.
  if (/[?&]url=https?%3A/i.test(text) || /%22%2C$|%22$/.test(text)) {
    try {
      const once = decodeURIComponent(text);
      if (/[?&]url=https?:\/\//i.test(once)) text = once;
    } catch (e) { /* not simply encoded */ }
  }

  // Drop trailing junk from a copy-pasted JSON fragment (`",` etc.).
  return text.replace(/["',\s]+$/, '').trim();
}

/**
 * Solve a `signatureCipher` with the *current* player by default.
 *
 * The player computes `s` and `n` inside an obfuscated VM whose helper names
 * change every release, so vm-solve.js boots `base.js` in a vm sandbox and
 * *resolves* those helpers by behaviour instead of by name.
 *
 * opts.engine: 'player' (default) | 'static'
 * opts.base:   path to a different base.js
 *
 * The player VM is always used. The static program is only reachable with
 * opts.engine === 'static' (or YT_ENGINE=static) for archaeology.
 */
function solveDetailed(cipher, opts = {}) {
  const engine = opts.engine || process.env.YT_ENGINE || 'player';
  const errors = [];
  const cleaned = typeof cipher === 'string'
    ? cleanCipher(cipher)
    : cleanCipher(new URLSearchParams({
      ...(cipher.s != null ? { s: cipher.s } : {}),
      ...(cipher.sp ? { sp: cipher.sp } : {}),
      ...(cipher.url ? { url: cipher.url } : {}),
    }).toString());

  if (engine !== 'static') {
    // Go through the learning engine, not the fixed shape list. The engine
    // reads the transform out of the player's own call sites, replays a
    // remembered recipe, and searches until googlevideo answers 206. The old
    // `vmSolver.solveCipher` here hard-coded helper names and threw as soon
    // as a build renamed them - which surfaced as a bare "probes: 1".
    let r;
    try {
      r = require('./vm-solve.js').solveSmart(cleaned, {
        base: opts.base, force: opts.force, onEvent: opts.onEvent,
      });
      if (r && typeof r.then === 'function') {
        return r.then((res) => finishDetailed(res, cleaned, opts, errors));
      }
    } catch (e) {
      errors.push('engine: ' + e.message);
    }
    return finishDetailed(r, cleaned, opts, errors);
  }

  const r = decipherStatic(cleaned, opts);
  r.errors = errors;
  return r;
}

/** Normalise a solveSmart result into the shape callers of solveDetailed expect. */
function finishDetailed(res, cleaned, opts, errors) {
  if (res && res.url) {
    return {
      url: res.url,
      sig: res.sig,
      n: res.solvedN,
      rawS: res.rawS,
      rawN: res.rawN,
      engine: 'player',
      ok: true,
      report: res.engine || null,
      errors,
    };
  }
  if (res && res.engine) {
    // The engine ran and every candidate was rejected. That is a result, so
    // report it instead of throwing away its probe history.
    return {
      url: null, sig: res.sig, n: res.solvedN, rawS: res.rawS, rawN: res.rawN,
      engine: 'player', ok: false, report: res.engine, errors,
    };
  }
  const r = decipherStatic(cleaned, opts);
  r.errors = errors;
  return r;
}

/** Turn a `signatureCipher` / `cipher` string into a playable URL. */
function decipher(cipher, opts = {}) {
  return solveDetailed(cipher, opts).url;
}

module.exports = {
  sigTransform,
  nTransform,
  nSubstitute,
  decipher,
  decipherStatic,
  solveDetailed,
  cleanCipher,
  N_KEY,
  N_ALPHABET,
};
