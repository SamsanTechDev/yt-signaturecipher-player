/**
 * engine/sites.js - find the signature transform by READING the player.
 *
 * Why this module exists
 * ----------------------
 * Earlier versions guessed. They asked "which helper behaves like `s -> sig`?"
 * and then *invented* call expressions such as `Bh(5,203,s)` or
 * `Gh(21,2482,Kh(41,790,s))`. Player 20754 broke every one of those guesses,
 * and the breakage is instructive: those helpers are not transforms at all.
 *
 *     Bh = function(a,b,c,d,e){ var f=a.he, h=f[eg]|0; zh(f,b) ... }   // protobuf reader
 *     Fm = function(a,b=0,c=a.length,d){ ... }                         // string checksum
 *
 * Calling them "with the right opcodes" produced a 9-character sig where the
 * real one is 100 characters, and every such guess was (correctly) rejected.
 *
 * The real transform lives at a *call site*, chained inside a builder:
 *
 *     if (k.s) { var f=c, h=k.sp; let l = Ic(4,1278, Jc(48,9011, k.s));
 *                f[w[15]](h, Jc(5,5897, l)) }
 *
 * So this module asks a different question: where does the player feed `s`
 * into an expression, and what does that expression produce? That is data
 * flow, and obfuscation does not hide data flow.
 *
 * Hard-won detail: never paren-scan raw minified JS. The license banner at the
 * top of base.js contains a lone `"`, and one unbalanced quote makes every
 * later matching scan fail. `maskSource()` blanks comments and literals while
 * preserving offsets, and all structural scans run on the mask.
 *
 * What it returns
 * ---------------
 * A *chain*: plain data, in the order the player evaluates it.
 *
 *     s -> Jc(48,9011,s) -> Ic(4,1278,·)      then the player wraps the result
 *
 * The outer wrap (`Jc(5,5897,l)`) is the player's base64 step. Whether the
 * final URL needs the wrapped or unwrapped value depends on `sparams`, not on
 * how the player calls itself, so both variants become candidates and the
 * oracle settles it. See `variants()`.
 */
'use strict';

/**
 * A literal-argument call: `Ic(4,1278,`. Ints only - no expressions, no
 * identifiers - so this matches obfuscated dispatch calls and nothing else.
 */
const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*/g;

/**
 * Blank out comments and string literals, keeping every index in place.
 *
 * @returns {string} same length as `src`; newlines preserved.
 */
function maskSource(src) {
  const chars = src.split('');
  const n = chars.length;
  const blank = (a, b) => { for (let i = a; i < b && i < n; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '; };
  let i = 0;
  while (i < n) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (ch === '/' && next === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (chars[j] === '\\') { j += 2; continue; }
        if (chars[j] === ch) { j++; break; }
        if (chars[j] === '\n' && ch !== '`') break;   // unterminated: one line
        j++;
      }
      blank(i + 1, j - 1);
      i = j;
      continue;
    }
    i++;
  }
  return chars.join('');
}

/**
 * Index of the `)` closing the `(` at `open`, on masked source. -1 if none
 * within `limit` characters (bounded so a malformed mask cannot hang a scan).
 */
function matchingClose(mask, open, limit = 4000) {
  let d = 0;
  const stop = Math.min(mask.length, open + limit);
  for (let i = open; i < stop; i++) {
    const ch = mask[i];
    if (ch === '(') d++;
    else if (ch === ')') { d--; if (d === 0) return i; }
  }
  return -1;
}

/**
 * The literal-argument call that directly encloses position `open` (which is
 * the `(` of a call). Returns `{ fn, a, b, open, valueStart }` or null.
 *
 * Walks back from `open` over any closing parens of calls that END just
 * before it (the siblings already evaluated), then requires `name(a,b,`.
 */
function enclosingLiteralCall(mask, open) {
  let i = open - 1;
  while (i >= 0 && /\s/.test(mask[i])) i--;
  // Walk back over sibling expressions - but remember that a `)` we meet is
  // usually *unbalanced*: it is a frame opened earlier, inside a call head
  // whose `(` we have not reached yet (`Ic(4,1278,Jc(48,9011,k.s)` - walking
  // back from `Ic`'s `(` starts with `Jc`'s `)` still open). Only what
  // *closes* below zero is genuinely a complete sibling. Rewinding to the
  // matching `(` on the first shared `)` would jump out of the call and miss
  // the nesting entirely.
  let d = 0;
  for (; i >= 0; i--) {
    const ch = mask[i];
    if (ch === ')' || ch === ']' || ch === '}') d++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (d === 0) break;
      d--;
    } else if (ch === ',' && d === 0) break;   // sibling argument / var decl
    else if (ch === ';' && d === 0) break;     // another statement
    else if ((ch === '>' || ch === '=') && d === 0) break; // arrow / assignment
  }
  const valueStart = i + 1;
  const start = Math.max(0, valueStart - 48);
  const head = /([A-Za-z_$][\w$]*)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*$/.exec(mask.slice(start, valueStart));
  if (!head) return null;
  // `d` should be 0 here: everything we walked over was balanced. A value
  // like `f(` would leave frames open, meaning the `(` we are looking for
  // belongs to a call we have not reached - not an enclosing one.
  if (d !== 0) return null;
  const callOpen = valueStart - head[0].length + head[0].lastIndexOf('(');
  if (mask[callOpen] !== '(') return null;
  return { fn: head[1], a: Number(head[2]), b: Number(head[3]), open: callOpen, valueStart };
}

/**
 * Innermost-to-outermost chain of literal-argument calls containing `cursor`.
 *
 * `cursor` is where the innermost call's value argument begins, i.e. just
 * after `name(a,b,`: `let l = Ic(4,1278,<cursor>Jc(48,9011,k.s))`.
 *
 * @returns [{ fn, a, b, open, close }] - innermost first.
 */
function chainAround(mask, cursor) {
  let valueStart = cursor;
  const steps = [];
  for (let depth = 0; depth < 4; depth++) {
    // The innermost call is `name(a,b,<value>)` where <value> begins at
    // `valueStart`; its `(` is the character just before `name` + `(a,b,`.
    const head = /([A-Za-z_$][\w$]*)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*$/.exec(mask.slice(Math.max(0, valueStart - 48), valueStart));
    if (!head) break;
    // `head[0]` ends with `,`; the call's `(` is at its last `(`.
    const open = valueStart - head[0].length + head[0].lastIndexOf('(');
    if (mask[open] !== '(') break;
    const close = matchingClose(mask, open);
    if (close < 0) break;
    steps.push({ fn: head[1], a: Number(head[2]), b: Number(head[3]), open, close });
    valueStart = outward(mask, steps, open, head[1], close);
    if (valueStart === null) break;
  }
  return steps;
}

/**
 * Extend `steps` outward from the call at `open`. Returns the next value start
 * when nesting continues, or null when the walk is finished.
 *
 * Two shapes exist in real players:
 *   nesting  `Ic(4,1278, Jc(48,9011,k.s) )`
 *   locals   `let l = Ic(...); f.set(h, Jc(5,5897, l))`
 */
function outward(mask, steps, open, fn, close) {
  const parent = enclosingLiteralCall(mask, open);
  if (parent) return parent.valueStart;
  for (const step of throughLocals(mask, open - fn.length)) steps.push(step);
  return null;
}

/**
 * Same, but given the index of a `name(a,b,` head to start from.
 * The value argument starts where the head ends.
 */
function chainAt(mask, headIndex) {
  const m = /^([A-Za-z_$][\w$]*)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*/.exec(mask.slice(headIndex, headIndex + 48));
  if (!m) return [];
  return chainAround(mask, headIndex + m[0].length);
}

/**
 * Data flow through a local variable.
 *
 * Minified players like to split the chain across statements:
 *
 *     let l = Ic(4,1278, Jc(48,9011, k.s));
 *     f.set(h, Jc(5,5897, l));
 *
 * No purely nesting-based scan can see the second step. So: find the local
 * that the chain is assigned to, then look for later calls in the same block
 * that consume that local, and keep going - a chain of locals is fine.
 *
 * @param {string} mask
 * @param {number} end index just past the value expression (`)` of the call)
 * @returns {Array} steps appended in evaluation order
 */
function throughLocals(mask, start) {
  const out = [];
  let cursor = start;
  for (let hop = 0; hop < 3; hop++) {
    const local = assignedName(mask, cursor);
    if (!local) break;
    const stopBrace = mask.indexOf('}', cursor);
    const limit = stopBrace < 0 ? Math.min(mask.length, cursor + 1200) : Math.min(stopBrace, cursor + 1200);
    const re = new RegExp(`(?<![\\w$.])${escapeRe(local)}(?![\\w$])`, 'g');
    re.lastIndex = cursor;
    let hit = null;
    let m;
    while ((m = re.exec(mask)) && m.index < limit) {
      const at = m.index;
      const after = mask.slice(at + local.length, at + local.length + 24);
      const before = mask.slice(Math.max(0, at - 32), at);
      if (/^\s*=/.test(after)) continue;    // the assignment itself
      if (before.endsWith('.')) continue;   // property access, not our local
      const head = /([A-Za-z_$][\w$]*)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*$/.exec(before);
      if (!head) continue;
      const open = findParenBefore(mask, head[1], at);
      if (open < 0) continue;
      hit = { fn: head[1], a: Number(head[2]), b: Number(head[3]), open, close: matchingClose(mask, open), start: open - head[1].length };
      break;
    }
    if (!hit || hit.close < 0) break;
    out.push(hit);
    cursor = hit.start;   // the outer call may itself be assigned
  }
  return out;
}

/**
 * The local an expression starting at `start` is assigned to: `let l = expr`,
 * `l = expr`, `a=1,l=expr`. Returns the name or null.
 */
function assignedName(mask, start) {
  // The prefix before the chain is small: `let l = `, `h=k.sp;l = `,
  // `a.set(b, `. Match the assignment that ends exactly where the chain
  // begins (the `$(?![\s\S])`-free form: slice to `start`, anchor with `$`).
  const prefix = mask.slice(Math.max(0, start - 60), start);
  const m = /(?:^|[;{},]|\b(?:let|const|var))\s*([A-Za-z_$][\w$]{0,2})\s*=\s*$/.exec(prefix);
  return m ? m[1] : null;
}

/**
 * Chain for a value expression that starts at `pos`: look FORWARD for the
 * call that consumes it (`Jc(48,9011,<value>)`), then continue outward
 * through nesting and locals exactly like `chainAround`.
 *
 * @returns [{ fn, a, b, open, close }] - value-side first.
 */
function chainOutward(mask, pos) {
  let i = pos;
  while (i < mask.length && /\s/.test(mask[i])) i++;
  // Skip the value itself (balanced) to reach the `,` or `)` that follows.
  let d = 0;
  for (; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (d === 0) break; d--; }
    else if (ch === ',' && d === 0) break;
  }
  // Walk back over the value to the call head that leads into it.
  let j = i - 1;
  d = 0;
  for (; j >= 0; j--) {
    const ch = mask[j];
    if (ch === ')' || ch === ']' || ch === '}') d++;
    else if (ch === '(' || ch === '[' || ch === '{') { d--; if (d === 0) break; }
    else if (ch === ',' && d === 0) break;
  }
  if (j < 0) return [];
  const head = /([A-Za-z_$][\w$]*)\(\s*(\d+)\s*,\s*(\d+)\s*,$/.exec(mask.slice(Math.max(0, j - 48), j + 1));
  if (!head) return [];
  const open = j + 1 - head[0].length + head[0].lastIndexOf('(');
  if (mask[open] !== '(') return [];
  const close = matchingClose(mask, open);
  if (close < 0) return [];
  const steps = [{ fn: head[1], a: Number(head[2]), b: Number(head[3]), open, close }];
  // Continue exactly like chainAround: climb while something encloses us.
  let valueStart = outward(mask, steps, open, head[1], close);
  while (valueStart !== null) {
    const h = /([A-Za-z_$][\w$]*)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*$/.exec(mask.slice(Math.max(0, valueStart - 48), valueStart));
    if (!h) break;
    const o = valueStart - h[0].length + h[0].lastIndexOf('(');
    const c = matchingClose(mask, o);
    if (c < 0) break;
    steps.push({ fn: h[1], a: Number(h[2]), b: Number(h[3]), open: o, close: c });
    valueStart = outward(mask, steps, o, h[1], c);
  }
  return steps;
}

/**
 * The `)` that closes exactly the `(` at `open`, even when `)` run together. */
function ownClose(mask, open, close) {
  let d = 0;
  for (let i = open; i <= close && i < mask.length; i++) {
    if (mask[i] === '(') d++;
    else if (mask[i] === ')') { d--; if (d === 0) return i; }
  }
  return close;
}

/** The `(` that opens `fn(` in the call whose head ends at `headEnd`. */
function findParenBefore(mask, fn, headEnd) {
  const i = mask.lastIndexOf(fn + '(', headEnd);
  return i < 0 ? -1 : i + fn.length;
}

/**
 * Where does the innermost call's value argument end?
 *
 * `open` is the `(` of `name(a,b,<value>)`. The value runs to the `)` that
 * closes it, or to the top-level comma that separates it from the next
 * argument of the same call (common: `f(name(a,b,s), x)`).
 *
 * @returns { end, kind: 'close'|'comma'|'none' }
 */
function valueEnd(mask, open) {
  let depth = 0;
  const stop = Math.min(mask.length, open + 400);
  // Start just inside the call's own `(` so its parenthesised arguments are
  // depth 1, not 0.
  for (let i = open + 1; i < stop; i++) {
    const ch = mask[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return { end: i, kind: 'close' };
      depth--;
      continue;
    }
    // A comma at the call's own level ends the value argument.
    if (ch === ',' && depth === 0) return { end: i, kind: 'comma' };
  }
  return { end: -1, kind: 'none' };
}

/** Index of the value-argument terminator, or -1. */
function argTerminator(mask, open) {
  return valueEnd(mask, open).end;
}

/** Find every place the player turns a cipher `s` into an `sp` value. */
function findSigSites(src) {
  const mask = maskSource(src);
  const out = [];
  const seen = new Set();
  const push = (site) => {
    const key = site.chain.map((c) => `${c.fn}(${c.a},${c.b})`).join('>');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ ...site, key });
  };

  // ---- A. anchored on the cipher-object construction ---------------------
  // `new <UrlClass>(<x>.url, true)` marks the builder; inside that statement,
  // `<x>.s` is the cipher signature being transformed.
  const ctorRe = /new\s+([\w$.]{1,16})\(\s*([A-Za-z_$][\w$]{0,4})\.url\s*,\s*(?:!0|true)\s*\)/g;
  let m;
  const ctorSites = [];
  while ((m = ctorRe.exec(mask))) ctorSites.push({ cls: m[1], obj: m[2], at: m.index });
  for (const c of ctorSites) {
    // The enclosing statement can be long (it may inline whole class bodies),
    // so bound it by the enclosing block instead of the next `;`.
    const from = Math.max(0, c.at - 400);
    const stmtStart = from + (mask.slice(from, c.at).lastIndexOf('{') + 1);
    const to = Math.min(mask.length, c.at + 900);
    const block = mask.slice(stmtStart, to);
    const sRe = new RegExp(`\\b${escapeRe(c.obj)}\\.s\\b`, 'g');
    let sm;
    while ((sm = sRe.exec(block))) {
      const sAbs = stmtStart + sm.index;
      // `if (k.s)` and `.has(k.s)` are tests, not transforms: only a `.s`
      // that sits inside a literal-argument call produces a chain, so keep
      // looking instead of stopping at the first mention. The call that
      // wraps the value comes *after* it (`Jc(48,9011,<k.s>)`), so look
      // forward - looking back would only ever find the receiver.
      const chain = chainOutward(mask, sAbs + sm[0].length);
      if (!chain.length) continue;
      push({ chain, sExpr: sm[0], urlExpr: `${c.obj}.url`, at: sAbs, how: 'builder', cls: c.cls });
      break;
    }
  }

  // ---- B. generic: any `<x>.s` inside a literal-argument call chain ------
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(mask))) {
    const open = m.index + m[0].length - 1;
    const ve = valueEnd(mask, open);
    if (ve.end < 0) continue;
    const passed = mask.slice(open + 1, ve.end);
    const lone = /(?:^|,)\s*(?:([A-Za-z_$][\w$]{0,4})\.)?s\s*$/.exec(passed);
    const anyS = lone || /(?<![\w$.])([A-Za-z_$][\w$]{0,4})\.s\b/.exec(passed);
    if (!anyS) continue;
    const sExpr = lone ? (lone[1] ? `${lone[1]}.s` : 's') : `${anyS[1]}.s`;
    const chain = chainAround(mask, open + 1);
    if (!chain.length) continue;
    push({ chain, sExpr, urlExpr: null, at: m.index, how: 'chain' });
  }

  return preferLongest(out);
}

/**
 * Collapse sites that share an `s` expression, keeping the LONGEST chain.
 *
 * The same transform is reachable two ways: the generic scan sees the inner
 * call (`Jc(48,9011,·)`) and the builder anchor sees the whole expression
 * (`Jc(48,9011,·) -> Ic(4,1278,·) -> wrap`). The longer chain is the one that
 * matches what the player actually computes, and `variants()` derives the
 * shorter, wrap-free reading from it.
 */
function preferLongest(sites) {
  const best = new Map();
  for (const s of sites) {
    const prev = best.get(s.sExpr);
    if (!prev) { best.set(s.sExpr, s); continue; }
    // Longer chain wins; on a tie the builder site wins, because it also
    // tells us which URL object the signature is being written into.
    const better = s.chain.length > prev.chain.length
      || (s.chain.length === prev.chain.length && s.how === 'builder' && prev.how !== 'builder');
    if (better) best.set(s.sExpr, s);
  }
  // The cipher's own `s` first, then by chain length.
  return [...best.values()].sort((a, b) => {
    const as = a.sExpr === 's' || a.sExpr.endsWith('.s') ? 0 : 1;
    const bs = b.sExpr === 's' || b.sExpr.endsWith('.s') ? 0 : 1;
    return as - bs || b.chain.length - a.chain.length;
  });
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** How many times the player calls `<fn>(a,b,` anywhere. */
function countCalls(mask, step) {
  const re = new RegExp(`(?<![\\w$.])${escapeRe(step.fn)}\\(\\s*${step.a}\\s*,\\s*${step.b}\\s*,`, 'g');
  let n = 0;
  while (re.exec(mask)) n++;
  return n;
}

/**
 * Split a chain into "the transform" and "the outer wrap".
 *
 * The wrap (base64) is generic: the player uses the same outer call wherever
 * it encodes something, so it is called more than once. The transform is
 * specific. That is a heuristic, not a fact - `variants()` returns both
 * readings so the oracle can decide.
 */
function splitWrap(mask, chain) {
  if (chain.length < 2) return { transform: chain, wrap: null, certain: true };
  const outer = chain[chain.length - 1];
  const rest = chain.slice(0, -1);
  const uses = countCalls(mask, outer);
  // The outer step is a wrap either way: this function is only asked about
  // call *chains*, and a chain's last step always produces a value someone
  // re-encodes. `certain` records whether the player uses it more than once
  // (generic helper) - useful for ordering, not for dropping the reading.
  return { transform: rest, wrap: outer, certain: uses > 1 };
}

/**
 * Every plausible reading of one site, most-likely first.
 * Each variant is `{ shape, note, chain }`, with `shape` safe to store as JSON.
 */
function variants(src, chain) {
  const mask = maskSource(src);
  const out = [];
  const add = (steps, note) => {
    if (!steps.length) return;
    out.push({
      shape: { kind: 'site', steps: steps.map((s) => ({ fn: s.fn, a: s.a, b: s.b })) },
      note,
      chain: steps,
    });
  };
  const cut = splitWrap(mask, chain);
  // Order matters: the bare transform is the reading that matches `sparams`,
  // the wrapped one is the player's own bookkeeping - so it goes second. When
  // the two cannot be told apart, both must still be offered; the oracle is
  // the only thing that actually knows.
  add(cut.transform, cut.certain ? 'site (wrap removed)' : 'site');
  if (chain.length > cut.transform.length) add(chain, 'site + wrap');
  return out;
}

/** Human-readable chain, for traces and the UI. */
function describeChain(chain) {
  if (!chain || !chain.length) return '(none)';
  return chain.map((c) => `${c.fn}(${c.a},${c.b},·)`).join(' -> ');
}

module.exports = {
  CALL_RE, maskSource, findSigSites, splitWrap, chainAround, chainAt, chainOutward,
  enclosingLiteralCall, throughLocals, assignedName, argTerminator, valueEnd,
  variants, describeChain, countCalls, matchingClose,
};
