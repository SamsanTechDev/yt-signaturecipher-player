/**
 * engine/learn.js - the self-learning solver.
 *
 * Given a base.js it has never seen and a signatureCipher, it works out how to
 * solve it by *asking YouTube*, then remembers the answer.
 *
 *   1. DISCOVER  what can this build do? (duck-typed, name-independent)
 *   2. RECALL    verified recipe for this fingerprint, or a structural twin
 *   3. PLAN      ranked sig candidates: learned > builtin > promoted static >
 *                compositions > pure static
 *   4. SEARCH    (sig, n) combinations against the oracle. A 403 does not stop
 *                the search - many sigs share a 403 and the winner can be far
 *                down the list.
 *   5. REMEMBER  the first 206 is saved keyed by fingerprint AND by structure.
 *
 * Every candidate carries replayable DATA (a shape record), never a function,
 * so what it learns today is what it replays tomorrow.
 */
'use strict';

const path = require('path');
const store = require('./store.js');
const playerMod = require('./player.js');
const shapes = require('./sig-shapes.js');
const synth = require('./synth.js');
const ntuples = require('./n-tuples.js');
const oracle = require('./oracle.js');
const sites = require('./sites.js');
// (no external parser: this engine is self-contained)

const MAX_SIG_TRIES = Number(process.env.YT_MAX_SIG_TRIES || 160);

// ---------------------------------------------------------------------------
// 1. discover
// ---------------------------------------------------------------------------

function discover(file, opts = {}) {
  const p = playerMod.load(file, opts);
  return { player: p, build: p.build, urlClasses: p.urlClasses, transformHelpers: p.transformHelpers };
}

// ---------------------------------------------------------------------------
// 2. recall
// ---------------------------------------------------------------------------

function recall(build) {
  const exact = store.getExact(build.fingerprint);
  if (exact && !exact.stale) return { source: 'exact', entry: exact };
  const near = store.getStructural(build.structure);
  if (near && !near.stale) return { source: 'structural', entry: near };
  return null;
}

// ---------------------------------------------------------------------------
// 3. plan - every entry is { tier, label, shape } with a REPLAYABLE shape
// ---------------------------------------------------------------------------

function planSig(d, recalled) {
  const out = [];
  const seen = new Set();

  const push = (tier, label, shape) => {
    if (!shape || seen.has(label)) return;
    seen.add(label);
    out.push({ tier, label, shape });
  };

  // tier 0 - a recipe that already produced 206 here (or on a twin)
  if (recalled && recalled.entry.recipe && recalled.entry.recipe.sig) {
    push(0, 'learned-sig', recalled.entry.recipe.sig);
  }

  // tier 0.5 - READ from the player, not guessed.
  //
  // Everything below this line is inference: "this helper behaves like a
  // transform". That inference is what broke on player 20754. The call site is
  // not inference - it is the code YouTube actually runs, so it goes first.
  // See engine/sites.js.
  for (const s of sites.findSigSites(d.player.source)) {
    for (const v of sites.variants(d.player.source, s.chain)) {
      push(0.5, 'site:' + sites.describeChain(s.chain) + (v.note.includes('wrap') ? ' [wrap]' : ''), v.shape);
    }
    // The call site can also be read one step short: the player may pass `s`
    // through more calls than the cipher's `sparams` ask for. Offer every
    // prefix and suffix of the chain, not only the two ends. Same code path
    // as everything else: the oracle decides, we just make sure the reading
    // that matches `sparams` is actually on the list.
    const steps = s.chain.map((c) => ({ fn: c.fn, a: c.a, b: c.b }));
    for (let cutStart = 0; cutStart <= steps.length; cutStart++) {
      for (let cutEnd = steps.length; cutEnd > cutStart; cutEnd--) {
        const sub = steps.slice(cutStart, cutEnd);
        if (sub.length === steps.length) continue;
        push(0.6, 'sub:' + sites.describeChain(sub),
          { kind: 'site', steps: sub });
      }
    }
  }

  // If the player told us where it transforms `s`, do not burn the oracle's
  // rate limit on guesses. The guesses are kept as a fallback for players
  // whose call site we cannot read, but when a site exists it is the answer.
  const haveSite = out.some((c) => typeof c.tier === 'number' && c.tier === 0.5);
  if (haveSite) return out;

  // tier 1 - builtin families, most recent first
  for (const b of shapes.BUILTIN) push(1, b.id, b.shape);

  // tier 1b - helpers that ARE a whole transform on their own
  for (const h of d.transformHelpers) {
    if (h.a === undefined) push(1, 'dyn1:' + h.name, { kind: 'dyn1', fn: h.name });
  }

  // tier 1c - helpers that behave like a transform only when called as a
  // dispatcher, `helper(a, b, s)`. Discovery found the opcode pair for us, so a
  // renamed dispatch function still lands here.
  for (const h of d.transformHelpers) {
    if (h.a === undefined) continue;
    push(1, 'dispatch:' + h.name + '(' + h.a + ',' + h.b + ')',
      { kind: 'call', helper: h.name, a: h.a, b: h.b });
  }

  // tier 2 - promoted static programs / renamed dispatch helpers
  const dynExprs = [
    { helper: 'Bh', a: 5, b: 203, inner: { helper: 'Fm', a: 14, b: 908 } },
    { helper: 'Bh', a: 9, b: 1814 },
    { helper: 'Gh', a: 21, b: 2482, inner: { helper: 'Kh', a: 41, b: 790 } },
    { helper: 'Fm', a: 14, b: 908 },
  ];
  const helperNames = ['Bh', 'Fm', 'Gh', 'Kh', 'Nh', 'Qa'];
  for (const s of synth.promoteStatic(shapes.STATIC_SEEDS, dynExprs, helperNames)) {
    push(2, 'promoted:' + s.note + ':' + shapes.describe(s.shape), s.shape);
  }

  // tier 3 - compositions of transforms this build exposes
  for (const s of synth.composeTransforms(d.transformHelpers)) {
    push(3, 'compose:' + shapes.describe(s), s);
  }

  // tier 4 - pure static programs, no player needed
  for (const seed of shapes.STATIC_SEEDS) push(4, seed.id, { kind: 'static1', ops: seed.ops });

  return out;
}

/** Compile + run one candidate on the real `s`. Returns sig or null. */
function runSig(cand, player, rawS) {
  let fn;
  try { fn = shapes.compile(cand.shape, player.resolve); } catch (e) { return null; }
  let out;
  try { out = fn(String(rawS)); } catch (e) { return null; }
  if (typeof out !== 'string' || !out.length || out === rawS) return null;
  if (!/^[A-Za-z0-9_\-=]+$/.test(out)) return null;
  return out;
}

// ---------------------------------------------------------------------------
// url construction
// ---------------------------------------------------------------------------

function urlWithSig(baseUrl, sp, sig) {
  const u = new URL(baseUrl);
  u.searchParams.set(sp, sig);
  return u.toString();
}

function buildUrl(baseUrl, sp, sig, n) {
  const u = new URL(baseUrl);
  if (sig != null) u.searchParams.set(sp, sig);
  if (n) u.searchParams.set('n', n);
  else u.searchParams.delete('n');
  return u.toString();
}

// ---------------------------------------------------------------------------
// 4+5. search
// ---------------------------------------------------------------------------

async function search(ctx) {
  const { d, rawS, sp, baseUrl, rawN, opts } = ctx;
  const trace = [];
  let probes = 0;
  // Progress sink so a UI can narrate the search live. Never throws.
  const emit = (ev) => {
    if (typeof ctx.onEvent !== 'function') return;
    try { ctx.onEvent(ev); } catch (e) { /* a broken listener must not stop a solve */ }
  };

  // Order the n candidates by track record too. The builder lists
  // 'n-unchanged' first because some builds leave n alone, but where it
  // never works it is a wasted probe, so experience moves it down.

  // Experience keys on structure, not the class name: two differently
  // named URL classes are the same solution, so a win teaches both.
  const nKey = (t) => 'n:' + (t.cls === null ? 'unchanged'
    : 'get/' + JSON.stringify(t.arg) + '/ctor' + t.ctorArgs);
  const allTuples = ntuples.buildNTuples(d.urlClasses, rawN);
  // Prune before spending a probe on each:
  //   * a class that throws, or hands back the same n, cannot be the solver -
  //     that is exactly what 'n-unchanged' already tests;
  //   * two classes producing the same n are one candidate, not two.
  const tuples = (function prune() {
    const seenN = new Set([String(rawN)]);
    const out = [{ cls: null, method: null, arg: null, ctorArgs: 0, note: 'n-unchanged' }];
    for (const t of allTuples) {
      if (t.cls === null) continue;
      let got;
      // A class may be discovered but still unusable at this point (it can
      // require state the page would have provided). That is not fatal - just
      // not a candidate.
      // Probe with the REAL url: some classes reject anything that is not a
      // youtube/googlevideo address, and pruning on a fake url would discard the
      // only class that works.
      // Use the exact url the search will use, including the n parameter -
      // a class cannot transform an n that is not there.
      try {
        got = ntuples.applyNTuple(t, d.player.classesByName, buildUrl(baseUrl, sp, rawS, rawN));
      }
      catch (e) { continue; }
      if (!got || typeof got !== 'string') continue;
      // applyNTuple may hand back the solved n (what we want), a bare url
      // (that class ignores n entirely - same as leaving n alone), or null.
      // Only a plausible token is a distinct candidate; a url means this
      // class adds nothing, so the probe would be wasted.
      if (typeof got !== 'string') continue;
      if (!/^[A-Za-z0-9_-]{8,}$/.test(got)) continue;
      // A class that answers with the n it was given is not solving
      // anything, so it duplicates n-unchanged, which is already first.
      if (got === String(rawN)) continue;
      if (seenN.has(got)) continue;
      seenN.add(got);
      out.push(t);
    }
    return out;
  })();
  if (process.env.YT_DEBUG_PLAN) console.error('[prune] all=' + allTuples.map((x) => x.note).join(' , ') + ' | kept=' + tuples.map((x) => x.note).join(' , '));
  if (tuples.length !== allTuples.length) {
    trace.push('  pruned n candidates: ' + allTuples.length + ' -> ' + tuples.length);
  }
  if (tuples.length > 1) {
    const nOrder = store.rankCandidates(tuples.map(nKey));
    const nByLabel = new Map(tuples.map((t) => [nKey(t), t]));
    const sorted = nOrder.map((l) => nByLabel.get(l)).filter(Boolean);
    if (sorted.length === tuples.length) tuples.splice(0, tuples.length, ...sorted);
  }
  const planned = planSig(d, ctx.recalled);

  // Render each planned shape once, dropping duplicates and unrenderables.
  const rendered = [];
  const seenSig = new Set();
  for (const cand of planned) {
    if (rendered.length >= MAX_SIG_TRIES) break;
    const sig = runSig(cand, d.player, rawS);
    if (sig === null || seenSig.has(sig)) continue;
    seenSig.add(sig);
    rendered.push({ tier: cand.tier, label: cand.label, shape: cand.shape, sig });
  }
  // Re-order by track record. The learned recipe always stays first; everything
  // else is sorted by how often it has actually won, so a candidate that works
  // on this kind of build is tried before one that never has.
  const learnedFirst = rendered.filter((c) => c.tier === 0);
  const rest = rendered.filter((c) => c.tier !== 0);
  if (rest.length > 1) {
    const order = store.rankCandidates(rest.map((c) => c.label));
    const byLabel = new Map(rest.map((c) => [c.label, c]));
    const reordered = order.map((l) => byLabel.get(l)).filter(Boolean);
    rendered.length = 0;
    rendered.push(...learnedFirst, ...reordered);
    if (order.some((l, i) => l !== rest[i].label)) trace.push('  reordered by experience');
  }

  trace.push('  ' + rendered.length + ' distinct sig candidates; ' + tuples.length + ' n tuples');
  emit({
    stage: 'plan',
    message: rendered.length + ' sig candidates, ' + tuples.length + ' n candidates',
    candidates: rendered.map((c) => ({ tier: c.tier, label: c.label })),
    nCandidates: tuples.length,
  });
  if (!rendered.length) return { ok: false, probes, trace };

  // Recalled recipe first (tier 0 candidate already carries its saved shape).
  const learned = rendered.find((c) => c.tier === 0);
  if (learned) {
    // The recipe stores the sig shape AND the n tuple that won last time, so
    // replay tries that exact pair first, then the other n candidates.
    const savedN = ctx.recalled && ctx.recalled.entry && ctx.recalled.entry.recipe
      ? ctx.recalled.entry.recipe.n : null;
    const replayTuples = savedN
      ? [savedN, ...tuples.filter((t) => t.note !== savedN.note)]
      : tuples;
    for (const t of replayTuples) {
      let n = rawN;
      if (t.cls) {
        try { n = ntuples.applyNTuple(t, d.player.classesByName, urlWithSig(baseUrl, sp, learned.sig)) || rawN; } catch (e) { continue; }
      }
      const url = buildUrl(baseUrl, sp, learned.sig, n);
      probes += 1;
      emit({ stage: 'probe', probes, label: 'learned', tier: 0, n: ntuples.describeNTuple(t) });
      const r0 = await oracle.probe(url);
      store.noteCandidate(nKey(t), r0.ok, 1);
      emit({ stage: 'probe-result', probes, label: 'learned', tier: 0, n: ntuples.describeNTuple(t), status: r0.status, ok: r0.ok });
      if (r0.ok) {
        trace.push('  recalled ' + ctx.recalled.source + ' recipe -> 206');
        return {
          ok: true, url, sig: learned.sig, solvedN: n, probes,
          recipe: { sig: learned.shape, n: t },
          winner: { label: 'learned', tier: 0 },
          reusedRecipe: true,
          trace,
        };
      }
    }
    trace.push('  recalled recipe now 403 - re-learning');
    store.markStale(d.build.fingerprint, 'recalled recipe returned 403');
  }

  // Full search. Outer loop = sig, inner = n. Keep going through 403s.
  for (const cand of rendered.filter((c) => c.tier !== 0)) {
    for (const t of tuples) {
      let n = rawN;
      if (t.cls) {
        try { n = ntuples.applyNTuple(t, d.player.classesByName, urlWithSig(baseUrl, sp, cand.sig)); } catch (e) { continue; }
        if (!n) n = rawN;
      }
      const url = buildUrl(baseUrl, sp, cand.sig, n);
      probes += 1;
      emit({ stage: 'probe', probes, label: cand.label, tier: cand.tier, n: ntuples.describeNTuple(t) });
      const r = await oracle.probe(url);
      emit({ stage: 'probe-result', probes, label: cand.label, tier: cand.tier, n: ntuples.describeNTuple(t), status: r.status, ok: r.ok });
      // Remember how this candidate behaved, win or lose, so the next run can
      // put the ones that actually work first.
      store.noteCandidate(cand.label, r.ok, 1);
      store.noteCandidate(nKey(t), r.ok, 1);
      if (r.ok) {
        trace.push('  206 at ' + cand.label + ' + ' + ntuples.describeNTuple(t));
        return {
          ok: true, url, sig: cand.sig, solvedN: n, probes,
          recipe: { sig: cand.shape, n: t },
          winner: { label: cand.label, tier: cand.tier, nTuple: t },
          trace,
        };
      }
    }
  }

  return { ok: false, probes, trace };
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

async function solveAuto(cipher, opts = {}) {
  const file = opts.base || path.join(__dirname, '..', 'base.js');

  const params = new URLSearchParams(cipher);
  const baseUrl = params.get('url');
  if (!baseUrl) throw new Error('cipher has no url');
  const rawS = decodeURIComponent(params.get('s') || '');
  const sp = params.get('sp') || 'sig';
  const rawN = new URL(baseUrl).searchParams.get('n');

  // Fast path: a quick load (classes + exports, no transform scan) is enough to
  // try a remembered recipe. Only if that misses do we pay for full discovery.
  const quick = discover(file, { quick: true });
  const build = quick.build;
  const recalled = opts.force ? null : recall(build);

  let d = quick;
  if (!recalled || opts.force) d = discover(file);

  const result = await search({ d, rawS, sp, baseUrl, rawN, recalled, opts, onEvent: opts.onEvent });

  store.appendHistory({
    kind: result.ok ? 'solved' : 'failed',
    fingerprint: build.fingerprint,
    structure: build.structure,
    timestamp: build.timestamp,
    probes: result.probes,
    recalled: recalled ? recalled.source : null,
    reused: !!result.reusedRecipe,
    winner: result.winner || null,
  });

  if (result.ok && result.recipe.sig) {
    store.saveRecipe(build, {
      sig: result.recipe.sig,
      n: result.recipe.n,
      probes: result.probes,
      notes: result.winner,
    });
  }

  return { ...result, build, recalled, discover: d };
}

module.exports = { solveAuto, search, discover, planSig, recall, buildUrl, urlWithSig };
