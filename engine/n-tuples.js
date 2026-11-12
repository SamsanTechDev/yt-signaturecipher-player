/**
 * engine/n-tuples.js - candidate descriptions for the `n` (throttle) parameter.
 *
 * `n` is solved by the player's URL class. Several methods on that class can
 * look like they transform `n`, and the class may need different constructor
 * arities, so we enumerate candidate tuples and let the oracle pick.
 *
 * A tuple is plain data so it can be saved and replayed:
 *   { cls: 'aj', method: 'get', arg: 'n', ctorArgs: 2 }
 * meaning `new cls(url, true).get('n')`. `cls: null` means "leave n as-is".
 */
'use strict';

/**
 * @param urlClasses  discovery output: [{ name, getter, getters, ctorArgs }]
 * @param rawN        the untransformed n
 */
function buildNTuples(urlClasses, rawN) {
  const out = [];

  // Baseline: keep n untouched. Some builds/content do not taint it.
  out.push({ cls: null, method: null, arg: null, ctorArgs: 0, note: 'n-unchanged' });

  for (const c of urlClasses) {
    const antics = Array.isArray(c.ctorArgs) && c.ctorArgs.length ? c.ctorArgs : [2, 1];
    for (const nArgs of antics) {
      for (const m of methodsForN(c)) {
        out.push({
          cls: c.name,
          method: m.method,
          arg: m.arg,
          ctorArgs: nArgs,
          note: `${c.name}.${m.method}(${m.arg == null ? '' : JSON.stringify(m.arg)})/[ctor ${nArgs}]`,
        });
      }
    }
  }

  const seen = new Set();
  return out.filter((t) => {
    const k = `${t.cls}|${t.method}|${t.arg}|${t.ctorArgs}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every plausible way to ask this class for a transformed `n`. */
function methodsForN(c) {
  const out = [{ method: 'get', arg: 'n' }, { method: 'get', arg: null }];
  return out;
}

/** Run one n-tuple. Returns the solved n, or null. Throws if unusable. */
function applyNTuple(tuple, classesByName, url) {
  if (!tuple || !tuple.cls) return null;
  const c = classesByName[tuple.cls];
  if (!c) throw new Error(`class ${tuple.cls} not in this build`);
  const inst = tuple.ctorArgs >= 2 ? new c.C(String(url), true) : new c.C(String(url));
  const v = tuple.arg == null ? inst[tuple.method]() : inst[tuple.method](tuple.arg);
  return typeof v === 'string' ? v : null;
}

function describeNTuple(t) {
  return t && t.cls ? `${t.cls}.${t.method}(${t.arg == null ? '' : t.arg})/[ctor ${t.ctorArgs}]` : 'n unchanged';
}

module.exports = { buildNTuples, applyNTuple, describeNTuple };