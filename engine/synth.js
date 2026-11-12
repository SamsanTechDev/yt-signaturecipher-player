/**
 * engine/synth.js - build new candidate shapes when no known shape works.
 *
 * History is the search space. Three generators, all emitting replayable
 * shape DATA (see engine/sig-shapes.js):
 *
 *   1. promoteStatic      repack known call expressions / static programs into
 *                         new combinations, including "same inner transform,
 *                         different outer helper" - which is what recovers a
 *                         build that renamed the dispatch function.
 *   2. composeTransforms  chain the build's own s -> s helpers: A(s), A(B(s)).
 *   3. opcodePairs        apply the classic opcode pairs to each helper we can
 *                         find, in case the helper was renamed but the opcodes
 *                         stayed.
 */
'use strict';

const MAX_PER_GENERATOR = 64;

/** Convert an expression record into a proper shape. */
function toShape(e) {
  const shape = { kind: 'call', helper: e.helper, a: e.a, b: e.b };
  if (e.inner) {
    shape.inner = e.inner.kind ? e.inner : { kind: 'call', helper: e.inner.helper, a: e.inner.a, b: e.inner.b };
  }
  return shape;
}

/**
 * Promote known dynamic expressions and static programs into new shapes.
 *
 * @param staticSeeds  shape registry's STATIC_SEEDS
 * @param dynExprs     known call expressions [{ helper, a, b, inner? }]
 * @param helperNames  names worth probing as dispatch helpers
 */
function promoteStatic(staticSeeds, dynExprs, helperNames) {
  const out = [];
  const push = (shape, note) => {
    if (out.length < MAX_PER_GENERATOR) out.push({ shape, note });
  };

  // 1. exact known expressions
  for (const e of dynExprs) push(toShape(e), 'known');

  // 2. rewrap: every inner transform under every outer dispatcher
  const inners = dynExprs.filter((e) => e.inner);
  for (const o of dynExprs) {
    for (const i of inners) {
      push({
        kind: 'call', helper: o.helper, a: o.a, b: o.b,
        inner: { kind: 'call', helper: i.inner.helper, a: i.inner.a, b: i.inner.b },
      }, 'rewrap');
    }
  }

  // 3. rename-outer: same inner, a different helper name
  for (const i of inners) {
    for (const name of helperNames) {
      if (name === i.inner.helper) continue;
      push({
        kind: 'call', helper: name, a: i.a, b: i.b,
        inner: { kind: 'call', helper: i.inner.helper, a: i.inner.a, b: i.inner.b },
      }, 'rename-outer');
    }
  }

  // 4. opcode pairs applied directly to each helper
  const AB_PAIRS = [[5, 203], [14, 908], [9, 1814], [21, 2482], [41, 790], [4, 17]];
  for (const name of helperNames) {
    for (const [a, b] of AB_PAIRS) {
      push({ kind: 'call', helper: name, a, b }, 'opcodes');
    }
  }

  // 5. static seeds as pure-JS shapes (cheap, no player needed)
  for (const seed of staticSeeds) {
    push({ kind: 'static1', ops: seed.ops }, 'static');
  }

  return out;
}

/** Chain the player's own standalone s -> s helpers. */
function composeTransforms(transformHelpers) {
  const out = [];
  for (const h of transformHelpers.slice(0, 4)) {
    out.push({ kind: 'dyn1', fn: h.name });
  }
  for (const a of transformHelpers.slice(0, 3)) {
    for (const b of transformHelpers.slice(0, 3)) {
      if (a.name === b.name) continue;
      out.push({ kind: 'dyn2', a: a.name, b: b.name });
    }
  }
  return out;
}

module.exports = { promoteStatic, composeTransforms, toShape };