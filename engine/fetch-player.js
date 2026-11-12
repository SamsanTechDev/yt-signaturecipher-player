/**
 * engine/fetch-player.js - get the current player JS without a browser.
 *
 * The solver needs one file: the minified player (`base.js`). Asking a new
 * user to find it by hand is the single most common way this project failed
 * for people - they paste a cipher and get "base.js not found".
 *
 * So we fetch it the same way a browser would:
 *
 *   1. GET an embed page            -> contains `player/<hash>/player_.../base.js`
 *   2. GET /s/player/<hash>/player_ias.vflset/en_US/base.js
 *   3. fall back to player_es6 if the ias variant is missing
 *
 * Rules, in the order they happen:
 *
 *   - no base.js                 -> download it
 *   - base.js older than 6h      -> try to refresh; keep the old file if offline
 *   - solve failed               -> ask YouTube for the current hash. Only if it
 *                                   differs do we delete the file and download
 *                                   again; if it matches, the cipher is the
 *                                   problem and re-downloading would be noise.
 *
 * Nothing here is build-specific: the hash comes from YouTube, and the engine
 * reads whatever transform that file happens to contain.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIN_BYTES = 500 * 1024;      // a real player is ~2.5 MB; anything less is an error page
const MAX_AGE_MS = Number(process.env.PLAYER_MAX_AGE_MS || 6 * 60 * 60 * 1000);

const STATE_DIR = path.join(__dirname, '..', 'state');
const META = path.join(STATE_DIR, 'player.json');

/** Is `file` a plausible player bundle already on disk? */
function looksValid(file) {
  try { return fs.statSync(file).size >= MIN_BYTES; } catch (e) { return false; }
}

/** What do we know about the file we have? */
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch (e) { return null; }
}

function writeMeta(meta) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(META, JSON.stringify(meta, null, 2));
  } catch (e) { /* a sidecar file is nice to have, never required */ }
}

function ageMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch (e) { return Infinity; }
}

/** Request a URL with the headers YouTube expects. */
async function request(url) {
  const r = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
      'accept': 'text/html,application/javascript,*/*',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return { body: await r.text(), headers: r.headers };
}

/** Ask YouTube which player hash is current. */
async function findPlayerId() {
  const pages = [
    'https://www.youtube.com/embed/dQw4w9WgXcQ?hl=en&gl=US',
    'https://www.youtube.com/?hl=en&gl=US',
  ];
  const errors = [];
  for (const page of pages) {
    try {
      const { body } = await request(page);
      const m = body.match(/player\/([0-9a-f]{8})\/player[^"']*?\/base\.js/);
      if (m) return m[1];
      errors.push(page + ': no player id in the page');
    } catch (e) { errors.push(page + ': ' + e.message); }
  }
  throw new Error('could not read a player id\n  ' + errors.join('\n  '));
}

/** Download the player for `id`, trying the variants YouTube serves. */
async function downloadPlayer(id) {
  const variants = ['player_ias.vflset/en_US', 'player_es6.vflset/en_US'];
  const errors = [];
  for (const v of variants) {
    const url = `https://www.youtube.com/s/player/${id}/${v}/base.js`;
    try {
      const r = await request(url);
      if (r.body.length < MIN_BYTES) { errors.push(`${v}: too small (${r.body.length} bytes)`); continue; }
      return { body: r.body, url, lastModified: r.headers.get('last-modified') || null };
    } catch (e) { errors.push(`${v}: ${e.message}`); }
  }
  throw new Error('no player variant downloaded\n  ' + errors.join('\n  '));
}

/**
 * Make sure a usable player file exists.
 *
 * @param {string} file    where to keep it (usually ./base.js)
 * @param {object} opts    { force } refetch even if a valid file is present
 *                         { id }    use this player hash instead of asking
 * @returns {Promise<{file:string, fetched:boolean, id?:string, url?:string,
 *                    bytes?:number, lastModified?:string, warning?:string}>}
 */
async function ensurePlayer(file, opts = {}) {
  const abs = path.resolve(file);
  const exists = looksValid(abs);
  const meta = readMeta();

  // Young enough: use it as-is.
  if (exists && !opts.force && ageMs(abs) < MAX_AGE_MS) {
    return { file: abs, fetched: false, id: meta && meta.id, lastModified: meta && meta.lastModified };
  }

  try {
    const id = opts.id || await findPlayerId();

    // Old file, but YouTube still serves the same build: just refresh our
    // bookkeeping. A 3 MB download that produces identical bytes is waste.
    if (exists && !opts.force && meta && meta.id === id) {
      try { fs.utimesSync(abs, new Date(), new Date()); } catch (e) { /* read-only file */ }
      writeMeta({ ...meta, at: Date.now() });
      return { file: abs, fetched: false, unchanged: true, id, lastModified: meta.lastModified };
    }

    const { body, url, lastModified } = await downloadPlayer(id);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    writeMeta({ id, url, at: Date.now(), bytes: body.length, lastModified });
    return { file: abs, fetched: true, id, url, bytes: body.length, lastModified };
  } catch (e) {
    // If a usable file is already there, a network failure is not fatal.
    if (exists) {
      return { file: abs, fetched: false, id: meta && meta.id, lastModified: meta && meta.lastModified, warning: e.message };
    }
    const err = new Error(
      `could not download the player, and no base.js is present.\n  ${e.message}\n`
      + '  Fix: connect to the internet, then run play.bat again.'
    );
    err.cause = e;
    throw err;
  }
}

/**
 * Called after a solve failed.
 *
 * Ask YouTube which build is current. If it is the one we already have, there
 * is nothing to download - the cipher or the link is the problem. If it is
 * different, delete our copy first (so a half-written file can never be used)
 * and fetch the new build.
 *
 * @returns {Promise<{fetched:boolean, changed?:boolean, unchanged?:boolean,
 *                    offline?:boolean, id?:string, error?:string}>}
 */
async function refreshIfChanged(file) {
  const abs = path.resolve(file);

  let id;
  try {
    id = await findPlayerId();
  } catch (e) {
    return { fetched: false, offline: true, error: e.message };
  }

  const meta = readMeta();
  if (meta && meta.id === id && looksValid(abs)) {
    return { fetched: false, unchanged: true, id };
  }

  // Remove the old file before downloading: if the download fails, we must not
  // silently keep a player that YouTube has already replaced.
  try { fs.unlinkSync(abs); } catch (e) { /* already gone */ }
  const r = await ensurePlayer(abs, { force: true, id });
  return { ...r, changed: true, id };
}

module.exports = { ensurePlayer, refreshIfChanged, findPlayerId, downloadPlayer, looksValid, readMeta, UA };
