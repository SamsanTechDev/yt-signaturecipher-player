/**
 * engine/store.js - persistent memory.
 *
 * Two files, both under `state/`:
 *
 *   learned.json  - verified recipes, keyed by base.js fingerprint (exact) and
 *                   by build structure (survives a rename). Each entry records
 *                   how the sig and n were solved and how many probes it cost.
 *   history.jsonl - append-only log of every solve, including failures, so we
 *                   can see a build drifting before the solve breaks.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt
 * the recipe file that makes the fast path work.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state');
const LEARNED = path.join(STATE_DIR, 'learned.json');
const HISTORY = path.join(STATE_DIR, 'history.jsonl');

const SCHEMA = 2;

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/** Load the whole learned store (creating an empty one if absent). */
function loadLearned() {
  const data = readJson(LEARNED, null);
  if (!data || data.schema !== SCHEMA) {
    return { schema: SCHEMA, exact: {}, structural: {}, updatedAt: null };
  }
  data.exact = data.exact || {};
  data.structural = data.structural || {};
  return data;
}

/** Atomic write. */
function writeLearned(data) {
  ensureDir();
  data.schema = SCHEMA;
  data.updatedAt = new Date().toISOString();
  const tmp = `${LEARNED}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, LEARNED);
  return data;
}

/** Look up a verified recipe for this exact build. */
function getExact(fingerprint) {
  return loadLearned().exact[fingerprint] || null;
}

/** Look up a verified recipe for a structurally similar build. */
function getStructural(structKey) {
  return loadLearned().structural[structKey] || null;
}

/**
 * Remember a recipe that produced 206.
 *
 * @param build   { fingerprint, structure, timestamp, file }
 * @param recipe  { sig: shape, n: tuple, probes: number, notes }
 */
function saveRecipe(build, recipe) {
  const data = loadLearned();
  const now = new Date().toISOString();
  const entry = {
    build: {
      fingerprint: build.fingerprint,
      structure: build.structure,
      timestamp: build.timestamp || null,
      file: build.file ? path.basename(build.file) : null,
    },
    recipe: {
      sig: recipe.sig,
      n: recipe.n,
      // Keep the provenance so a human can audit *why* it works.
      notes: recipe.notes || null,
    },
    probes: recipe.probes || null,
    foundAt: now,
    lastOk: now,
    hits: ((data.exact[build.fingerprint] || {}).hits || 0) + 1,
  };
  data.exact[build.fingerprint] = entry;
  if (build.structure) data.structural[build.structure] = entry;
  writeLearned(data);
  return entry;
}

/**
 * A recipe existed but was wrong (403 on a fresh cipher).
 * Keep it (for auditing) but mark it stale so it is not tried first again.
 */
function markStale(fingerprint, reason) {
  const data = loadLearned();
  const entry = data.exact[fingerprint];
  if (!entry) return false;
  entry.stale = true;
  entry.staleReason = reason || 'oracle rejected recipe';
  entry.staleAt = new Date().toISOString();
  writeLearned(data);
  return true;
}

/** One JSONL line per solve attempt. Never throws. */
function appendHistory(record) {
  try {
    ensureDir();
    fs.appendFileSync(HISTORY, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch (e) { /* history is best-effort */ }
}

/** Read the last N history records (newest first). */
function readHistory(limit = 20) {
  try {
    const lines = fs.readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch (e) { return { raw: l }; }
    });
  } catch (e) {
    return [];
  }
}

/**
 * Drop a remembered recipe for one build (exact key, and its structural twin if
 * that twin points at the same build).
 *
 * @returns true if anything was removed.
 */
function forget(fingerprint, structure) {
  const data = loadLearned();
  let removed = false;
  if (data.exact[fingerprint]) { delete data.exact[fingerprint]; removed = true; }
  for (const [k, e] of Object.entries(data.structural)) {
    if (k === structure || (e.build && e.build.fingerprint === fingerprint)) {
      delete data.structural[k];
      removed = true;
    }
  }
  if (removed) writeLearned(data);
  return removed;
}

// ---------------------------------------------------------------------------
// experience memory
//
// The learned recipes above answer "what worked on THIS build". This answers a
// different question: "which candidates usually work, and which usually waste a
// probe". It is accumulated from every run, wins AND losses, so the planner can
// try the most promising candidate first instead of re-deriving the order.
//
// A candidate is identified by its LABEL (`ast`, `dispatch:Bh(5,203)`, ...), not
// by fingerprint, so the experience carries across builds.
// ---------------------------------------------------------------------------

const EXPERIENCE = path.join(STATE_DIR, 'experience.json');
const EXP_SCHEMA = 1;

function loadExperience() {
  const d = readJson(EXPERIENCE, null);
  if (!d || d.schema !== EXP_SCHEMA || typeof d.candidates !== 'object' || !d.candidates) {
    return { schema: EXP_SCHEMA, candidates: {}, wins: 0, losses: 0, updatedAt: null };
  }
  return d;
}

function writeExperience(data) {
  try {
    ensureDir();
    data.updatedAt = new Date().toISOString();
    const tmp = `${EXPERIENCE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, EXPERIENCE);
  } catch (e) { /* experience is best-effort */ }
}

/**
 * Record the outcome of trying one candidate.
 * @param {string} label  candidate label, e.g. 'ast'
 * @param {boolean} ok    did this candidate produce the 206?
 * @param {number} cost   probes it consumed before deciding (1 for the winner)
 */
function noteCandidate(label, ok, cost = 1) {
  if (!label) return;
  const data = loadExperience();
  const c = data.candidates[label] || { tries: 0, wins: 0, probes: 0, firstWinAt: null, lastSeen: null };
  c.tries += 1;
  if (ok) {
    c.wins += 1;
    if (c.firstWinAt === null) c.firstWinAt = c.probes;
  }
  c.probes += Math.max(1, Number(cost) || 1);
  c.lastSeen = new Date().toISOString();
  data.candidates[label] = c;
  if (ok) data.wins += 1; else data.losses += 1;
  writeExperience(data);
}

/**
 * Rank candidate labels by track record.
 *
 * Score favours candidates that actually win and that cost few probes to do it.
 * A candidate that has never won is demoted, but never removed: a build can
 * change and make an old loser the new winner, so it stays in the plan.
 */
function rankCandidates(labels) {
  const data = loadExperience();
  // Bands, not a blended number: a candidate that has ever won beats one that
  // is merely untested, which beats one that has only ever failed. Inside a
  // band, cheaper wins come first. Getting this wrong is expensive - demoting
  // the only working candidate pushes it behind every guess in the plan.
  const score = (label) => {
    const c = data.candidates[label];
    if (!c || !c.tries) return 1000;                       // untested: keep its planned place
    if (c.wins > 0) {
      const winRate = c.wins / c.tries;
      const avgCost = c.probes / c.tries;
      return 5000 + winRate * 100 - avgCost;               // proven: always first
    }
    return Math.max(0, 100 - c.tries);                     // never won: sink, but ordered
  };
  return [...labels].sort((a, b) => score(b) - score(a));
}

/** Headline numbers for --status and the UI. */
function experienceSummary() {
  const data = loadExperience();
  const rows = Object.entries(data.candidates).map(([label, c]) => ({
    label,
    tries: c.tries,
    wins: c.wins,
    winRate: c.tries ? c.wins / c.tries : 0,
    avgProbes: c.tries ? c.probes / c.tries : 0,
    probesSaved: Math.max(0, c.probes - c.wins),           // probes spent on losses
  })).sort((a, b) => b.wins - a.wins || a.avgProbes - b.avgProbes);
  const totalProbes = rows.reduce((n, r) => n + Math.round(r.avgProbes * r.tries), 0);
  return {
    candidates: rows,
    wins: data.wins,
    losses: data.losses,
    totalProbes,
    bestLabel: rows.length ? rows[0].label : null,
    updatedAt: data.updatedAt,
  };
}
/** Everything the user should see from `--status`. */
function summary() {
  const data = loadLearned();
  const exact = Object.keys(data.exact).map((key) => ({ key, ...data.exact[key] }));
  const fresh = exact.filter((e) => !e.stale);
  return {
    schema: data.schema,
    updatedAt: data.updatedAt,
    exact: exact.length,
    structural: Object.keys(data.structural).length,
    builds: exact.length,
    fresh: fresh.length,
    stale: exact.length - fresh.length,
    entries: exact,
    recent: readHistory(10),
  };
}

module.exports = {
  LEARNED, HISTORY, STATE_DIR, STATE_FILE: LEARNED,
  getExact, getStructural, saveRecipe, markStale,
  appendHistory, readHistory, summary, loadLearned, forget,
  EXPERIENCE, loadExperience, noteCandidate, rankCandidates, experienceSummary,
};
