/**
 * engine/sig-shapes.js - the signature transform registry.
 *
 * A "shape" is a recipe for reading `s` the way the player does. Shapes are
 * pure DATA so one discovered at runtime can be saved and replayed later.
 *
 * Kinds
 * -----
 *   call    { helper, a, b, inner? }  helper(a, b, inner ? inner(s) : s)
 *   dyn1    { fn }                    helper(s)
 *   dyn2    { a, b }                  a(b(s))   - a and b are expression names
 *                                     or bare helper names
 *   static1 { ops }                   pure array program
 *   static2 { outer, inner }          two array programs composed
 *   alias   { of, fn, arg }           fn(arg, solvedValueOf(of))
 */
'use strict';

const { applyOps, staticSig } = require('./static-seeds.js');

// ---------------------------------------------------------------------------
// builtin families we have actually observed shipping
// ---------------------------------------------------------------------------

const SHAPE_BH_FM = { kind: 'call', helper: 'Bh', a: 5, b: 203, inner: { kind: 'call', helper: 'Fm', a: 14, b: 908 } };
const SHAPE_BH_WRAP = { kind: 'call', helper: 'Bh', a: 9, b: 1814 };
const SHAPE_KH = { kind: 'call', helper: 'Kh', a: 41, b: 790 };
const SHAPE_GH = { kind: 'call', helper: 'Gh', a: 21, b: 2482 };

/** Named composite expressions, usable by dyn2 / inner. */
const DYN_EXPR = {
  'Bh(5,203)': { kind: 'call', helper: 'Bh', a: 5, b: 203 },
  'Bh(9,1814)': SHAPE_BH_WRAP,
  'Fm(14,908)': { kind: 'call', helper: 'Fm', a: 14, b: 908 },
  'Kh(41,790)': SHAPE_KH,
  'Gh(21,2482)': SHAPE_GH,
  'Gh(21,2482,Kh(41,790))': SHAPE_GH,
};

const BUILTIN = [
  { id: 'bh-fm', family: 'bh-fm', shape: SHAPE_BH_FM },
  {
    id: 'bh-fm-wrapped',
    family: 'bh-fm-wrapped',
    shape: { kind: 'dyn2', a: 'Bh(9,1814)', b: 'Bh(5,203,Fm(14,908))' },
  },
  {
    id: 'kh-gh-nh',
    family: 'kh-gh-nh',
    shape: { kind: 'call', helper: 'Gh', a: 21, b: 2482, inner: SHAPE_KH },
  },
];

// ---------------------------------------------------------------------------
// static seeds
// ---------------------------------------------------------------------------

const STATIC_SEEDS = [
  {
    id: 'static-2026',
    ops: [['swap0', 62], ['splice', 0, 2], ['swap0', 54], ['reverse'],
      ['splice', 0, 2], ['reverse'], ['swap0', 1], ['splice', 0, 2]],
  },
  {
    id: 'static-classic-splice',
    ops: [['splice', 0, 1], ['swap0', 12], ['reverse'], ['swap0', 4], ['splice', 0, 2]],
  },
  {
    id: 'static-classic-swap',
    ops: [['swap0', 3], ['reverse'], ['swap0', 18], ['splice', 0, 1]],
  },
];

// add the composite names dynamically so dyn2 can reference them
DYN_EXPR['Bh(5,203,Fm(14,908))'] = SHAPE_BH_FM;

// ---------------------------------------------------------------------------
// compiling
// ---------------------------------------------------------------------------

/** Resolve an expression name to a compiled `(s) => value`. */
function compileExpr(name, resolve) {
  if (DYN_EXPR[name]) return compile(DYN_EXPR[name], resolve);
  // Bare helper name: call it with one argument.
  const f = resolve(name);
  return (s) => f(String(s));
}

/**
 * Turn a shape into a pure `s -> sig` function.
 *
 * @param shape    shape record
 * @param resolve  (name) => helper value from the loaded player
 * @param memo     { [shapeKey]: fn } used by `alias`
 */
function compile(shape, resolve, memo = {}) {
  if (!shape || !shape.kind) throw new Error('shape has no kind');

  switch (shape.kind) {
    case 'call': {
      const outer = resolve(shape.helper);
      const inner = shape.inner ? compile(shape.inner, resolve, memo) : (s) => s;
      return (s) => outer(shape.a, shape.b, inner(String(s)));
    }

    case 'dyn1': {
      const f = resolve(shape.fn);
      return (s) => f(String(s));
    }

    case 'dyn2': {
      const innerFn = compileExpr(shape.b, resolve);
      const outerFn = compileExpr(shape.a, resolve);
      return (s) => outerFn(innerFn(String(s)));
    }

    case 'static1':
      return (s) => staticSig(String(s), shape.ops);

    case 'static2': {
      const outerOp = (s) => applyOps(String(s).split(''), shape.outer).join('');
      const innerOp = (s) => applyOps(String(s).split(''), shape.inner).join('');
      return (s) => outerOp(innerOp(String(s)));
    }

    case 'alias': {
      const base = memo[shape.of];
      if (!base) throw new Error(`alias target ${shape.of} not solved`);
      const f = resolve(shape.fn);
      return (s) => f(shape.arg, base(s));
    }

    case 'site': {
      // A chain recovered from the player's own call sites (engine/sites.js).
      // `steps` is innermost-first; the player evaluates innermost first too.
      const fns = shape.steps.map((st) => ({ ...st, fn: resolve(st.fn) }));
      return (s) => {
        let v = String(s);
        for (const st of fns) v = st.fn(st.a, st.b, v);
        return typeof v === 'string' ? v : String(v);
      };
    }

    default:
      throw new Error(`unknown shape kind ${shape.kind}`);
  }
}

function describe(shape) {
  if (!shape) return 'none';
  switch (shape.kind) {
    case 'call':
      return `${shape.helper}(${shape.a},${shape.b}${shape.inner ? ',' + describe(shape.inner) : ''})`;
    case 'dyn1': return `${shape.fn}(s)`;
    case 'dyn2': return `${shape.a}(${shape.b}(s))`;
    case 'static1': return `static[${shape.ops.length} ops]`;
    case 'static2': return 'static2[outer(inner)]';
    case 'alias': return `alias(${shape.of})`;
    case 'site': return 'site:' + shape.steps.map((st) => `${st.fn}(${st.a},${st.b})`).join('>');
    case 'ast': return 'ast(parsed-player)';
    default: return JSON.stringify(shape);
  }
}

module.exports = {
  BUILTIN, STATIC_SEEDS, DYN_EXPR,
  SHAPE_BH_FM, SHAPE_KH, SHAPE_GH,
  compile, describe,
};