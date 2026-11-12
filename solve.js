/**
 * solve.js - the one command you need.
 *
 *   node solve.js                 solve cipher.txt and probe the result
 *   node solve.js my-cipher.txt   solve a different cipher file
 *   node solve.js --build         also (re)generate play.html
 *   node solve.js --build --serve start the local player at http://127.0.0.1:8766
 *
 *   node solve.js --status        what has been learned so far
 *   node solve.js --discover      what the current base.js exposes (no network)
 *   node solve.js --verify        re-check the remembered recipe against YouTube
 *   node solve.js --forget        drop the remembered recipe for this base.js
 *
 * A signatureCipher has two scrambled fields:
 *   s -> the real "sig" parameter
 *   n -> the throttling token
 *
 * Both are solved by the current player itself, booted in a Node vm. The engine
 * does not care what the helper functions are called: it discovers what the
 * build can do, replays a recipe that already worked, and otherwise searches
 * until googlevideo itself answers 206 - then remembers that recipe.
 *
 * The final check is always the server:
 *   correct sig + correct n -> HTTP 206 (bytes), anything wrong -> HTTP 403.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { solveDetailed, cleanCipher } = require('./solver.js');

const argv = process.argv.slice(2);
const wantBuild = argv.includes('--build');
const wantServe = argv.includes('--serve');
const wantStatus = argv.includes('--status');
const wantDiscover = argv.includes('--discover');
const wantVerify = argv.includes('--verify');
const wantForget = argv.includes('--forget');
const wantForce = argv.includes('--force');
const file = argv.find((a) => !a.startsWith('--')) || 'cipher.txt';

const BASE = path.join(__dirname, 'base.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** The engine probes arbitrary player internals; contain their async noise. */
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

async function probe(label, url) {
  try {
    const r = await fetch(url, { headers: { range: 'bytes=0-1023', 'user-agent': UA } });
    const b = await r.arrayBuffer();
    const range = r.headers.get('content-range') || '';
    const type = r.headers.get('content-type') || '';
    const size = range.includes('/') ? Number(range.split('/')[1]) : b.byteLength;
    console.log(`${label.padEnd(9)} -> ${r.status}  ${range || b.byteLength + ' bytes'}  ${type}`);
    return { status: r.status, range, type, size };
  } catch (e) {
    console.log(`${label.padEnd(9)} -> ERR ${e.message}`);
    return { status: 'ERR' };
  }
}

// ---------------------------------------------------------------------------
// side commands
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const store = require('./engine/store.js');
  const s = store.summary();
  console.log('--- learned recipes ---');
  console.log('store file :', store.STATE_FILE);
  console.log('exact      :', s.exact, ' build(s)');
  console.log('structural :', s.structural, ' shape(s)');
  if (!s.entries.length) {
    console.log('\nNothing learned yet. Run `node solve.js` once.');
    return;
  }
  for (const e of s.entries) {
    const sig = e.recipe.sig
      ? (e.recipe.sig.kind === 'alr' ? 'alr:' + e.recipe.sig.builder : (e.recipe.sig.helper || e.recipe.sig.kind))
      : '?';
    const n = !e.recipe.n ? 'none'
      : e.recipe.n.alr ? 'alr builder'
        : e.recipe.n.cls ? `${e.recipe.n.cls}.${e.recipe.n.method}(${e.recipe.n.arg})` : 'none';
    console.log(`\n  ${e.key}`);
    console.log(`    sig ${sig}  n ${n}`);
    console.log(`    probes ${e.probes}  hits ${e.hits}  stale ${!!e.stale}`);
    console.log(`    last ok ${e.lastOk || '-'}${e.staleReason ? '  (' + e.staleReason + ')' : ''}`);
  }


  // What the runs have taught the planner.
  const exp = store.experienceSummary();
  if (exp.candidates.length) {
    console.log('');
    console.log('--- experience (' + exp.wins + ' wins / ' + exp.losses + ' losses) ---');
    for (const c of exp.candidates.slice(0, 8)) {
      const pct = (c.winRate * 100).toFixed(0).padStart(3);
      console.log('  ' + c.label.padEnd(34) + ' tried ' + String(c.tries).padStart(3)
        + '  won ' + String(c.wins).padStart(3) + '  (' + pct + '%)  avg ' + c.avgProbes.toFixed(1) + ' probe(s)');
    }
  }
}
async function cmdDiscover() {
  const { discover } = require('./engine/learn.js');
  const d = discover(BASE);
  const b = d.build;
  console.log('--- base.js ---');
  console.log('file        :', b.name);
  console.log('sigTimestamp:', b.timestamp);
  console.log('structure   :', b.structure);
  console.log('fingerprint :', b.fingerprint);
  console.log('\n--- URL class(es)  [solves n] ---');
  if (!b.urlClasses.length) console.log('  (none found)');
  for (const c of b.urlClasses) {
    console.log(`  ${c.name}  getter=${c.getter || '-'}  ctor(${c.ctorArgs.join('|')})`);
  }
  console.log('\n--- transform helper(s)  [solve s] ---');
  if (!b.transformHelpers.length) console.log('  (none found)');
  for (const h of b.transformHelpers) {
    const how = h.a === undefined ? `${h.name}(s)` : `${h.name}(${h.a},${h.b},s)`;
    console.log(`  ${how}`);
  }

  const alr = require('./engine/alr.js').discover(d.player);
  console.log("\n--- player's own builder  [solve s + n in one call] ---");
  if (alr) {
    console.log(`  ${alr.name}  (found via .set("alr","yes"), serializer ${alr.serializer})`);
    console.log("  tried first: it is YouTube's own code path, not our reading of it");
  } else {
    console.log('  (none found - the marker or the URL object changed; search will carry on)');
  }

  console.log('\nDiscovery is behavioural: names above may change on any build.');
}

async function cmdVerify() {
  const store = require('./engine/store.js');
  const { discover } = require('./engine/learn.js');
  const cipher = cleanCipher(fs.readFileSync(file, 'utf8'));
  const vq = new URLSearchParams(cipher);
  if (decodeURIComponent(vq.get('s') || '').length < 10) {
    console.log(`No usable signatureCipher in ${file} - paste one first.`);
    return;
  }
  const b = discover(BASE, { quick: true }).build;
  const e = store.getExact(b.fingerprint) || store.getStructural(b.structure);
  if (!e) {
    console.log('No remembered recipe for this base.js yet. Run `node solve.js` first.');
    return;
  }

  // Re-run the cipher through the engine but force it to *replay* the recipe.
  const { solveSmart } = require('./vm-solve.js');
  const r = await solveSmart(cipher, { force: true });
  console.log('build      :', b.fingerprint);
  console.log('recipe sig :', e.recipe.sig && (e.recipe.sig.helper || e.recipe.sig.kind));
  const ok = r.engine && r.engine.ok;
  if (!ok) {
    console.log('RESULT     : FAILED - the remembered recipe no longer works');
    console.log('             run `node solve.js` to re-learn, or `--forget` to drop it');
    return;
  }
  const p = await probe('verify', r.url);
  const pass = p.status === 206 || p.status === 200;
  console.log('RESULT     :', pass ? 'OK (' + p.status + ')' : 'FAILED (' + p.status + ')');
}

async function cmdForget() {
  const store = require('./engine/store.js');
  const { discover } = require('./engine/learn.js');
  const b = discover(BASE, { quick: true }).build;
  const removed = store.forget(b.fingerprint, b.structure);
  console.log(removed ? 'Forgot the remembered recipe for this base.js.' : 'Nothing was remembered for this base.js.');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

(async () => {
  if (wantStatus) return cmdStatus();

  // Commands that only inspect the player.
  const playerCmds = wantDiscover || wantForget || wantVerify;
  const { ensurePlayer, refreshIfChanged } = require('./engine/fetch-player.js');
  async function getPlayer(force) {
    try {
      const got = await ensurePlayer(BASE, { force: !!force });
      if (got.fetched) {
        console.log(`player : downloaded base.js (${(got.bytes / 1048576).toFixed(2)} MB, build ${got.id})`);
      } else if (got.warning) {
        console.log(`player : using existing base.js (${got.warning})`);
      } else {
        console.log(`player : base.js up to date${got.id ? ' (build ' + got.id + ')' : ''}`);
      }
      return true;
    } catch (e) {
      console.error('player : ' + e.message);
      return false;
    }
  }

  if (playerCmds) {
    if (!await getPlayer()) process.exit(1);
    if (wantDiscover) return cmdDiscover();
    if (wantForget) return cmdForget();
    return cmdVerify();
  }

  // Fetch the player before looking at the cipher. Removing base.js should
  // never make the app stop at "paste a cipher" - the download is the thing
  // the user asked for, and it makes the next run instant.
  const playerOk = await getPlayer();

  if (!fs.existsSync(file)) {
    // A fresh clone has no cipher.txt (it holds your personal signed URL, so it
    // is gitignored). Create the template instead of failing.
    const example = path.join(__dirname, 'cipher.example.txt');
    if (file === 'cipher.txt' && fs.existsSync(example)) fs.copyFileSync(example, file);
  }
  if (!fs.existsSync(file)) {
    console.error(`cipher file not found: ${file}`);
    console.error('Write a signatureCipher into cipher.txt (or pass a file path).');
    process.exit(1);
  }

  const rawText = fs.readFileSync(file, 'utf8');
  const cipher = cleanCipher(rawText);
  // Validate the two fields a real cipher must carry. The template file has
  // example text, so a loose `/url=/` test would match it and start solving.
  const probeQ = new URLSearchParams(cipher);
  const goodS = decodeURIComponent(probeQ.get('s') || '').length > 10;
  const goodUrl = /^https?:\/\/[^/]+\//.test(probeQ.get('url') || '');
  if (!goodS || !goodUrl) {
    console.error(`No usable signatureCipher in ${file}.`);
    console.error('Delete the # comment lines, then paste the whole "signatureCipher"');
    console.error('value on one line. It starts with  s=  and contains');
    console.error('&url=https%3A%2F%2F...googlevideo.com...');
    process.exit(1);
  }
  const q = probeQ;
  const base = new URL(q.get('url'));

  if (!playerOk) process.exit(1);

  const { solveSmart } = require('./vm-solve.js');

  const t0 = Date.now();
  let solved = await solveSmart(cipher, { base: BASE, force: wantForce });

  // All candidates 403. Before giving up, ask YouTube whether it has shipped a
  // new build. If it has: delete the old base.js and retry with the new one.
  // If it has not: say so, because re-downloading would change nothing.
  if (!solved.url) {
    const r = await refreshIfChanged(BASE);
    if (r.fetched) {
      console.log(`player : YouTube has a new build (${r.id}) - re-downloaded it, retrying`);
      solved = await solveSmart(cipher, { base: BASE, force: true });
    } else if (r.unchanged) {
      console.log(`player : base.js is already the current build (${r.id}) - the cipher is the problem`);
    } else if (r.error) {
      console.log('player : could not check for a new build (' + r.error + ')');
    }
  }
  const ms = Date.now() - t0;

  // A build that cannot be solved is a normal result, not a crash. Report it
  // in full. Only exit when nothing is being served - otherwise the page stays
  // up, explains what happened, and the next run retries by itself.
  const engEarly = solved.engine || {};

  if (!solved.url) {
    console.log('--- input ---');
    console.log('file       :', file);
    console.log('itag       :', base.searchParams.get('itag'));
    console.log('raw s len  :', decodeURIComponent(q.get('s') || '').length);
    console.log('');
    console.log('--- result ---');
    console.log('solved     : NO');
    console.log('probes     :', engEarly.probes || 0, 'candidate(s) tested');
    console.log('reason     :', engEarly.error || 'no working candidate found');
    if (engEarly.trace) for (const t of engEarly.trace.slice(-4)) console.log('           ', t);
    console.log('');
    console.log('RESULT: NOT PLAYABLE - every candidate returned 403');
    console.log('  - every signature/n reading this player offered was rejected');
    console.log('  - run again: base.js is re-downloaded automatically and the search restarts');
    console.log('  - if it keeps failing, grab a fresh signatureCipher (links expire)');
    if (!wantServe) process.exit(2);
    console.log('  - server stays up: open http://127.0.0.1:' + (process.env.PORT || 8766) + '/live to retry');
  } else {
    console.log('--- input ---');
    console.log('file       :', file);
    console.log('itag       :', base.searchParams.get('itag'));
    console.log('raw s len  :', solved.rawS ? solved.rawS.length : 0);
    console.log('raw n      :', solved.rawN);

    console.log('\n--- how it was solved ---');
    const eng = solved.engine || {};
    if (eng.ok) {
      console.log('build ts   :', eng.build.timestamp);
      console.log('url class  :', eng.build.urlClass);
      const viaAlr = !!(eng.winner && String(eng.winner.label).startsWith('alr:'));
      console.log('transform  :', viaAlr
        ? `${eng.build.alr}  (the player's own builder)`
        : eng.build.transform + (eng.winner && eng.winner.label && eng.winner.label.startsWith('dispatch') ? ' (dispatcher)' : ''));
      if (eng.build.alr && !viaAlr) console.log('alr builder:', eng.build.alr, '(found, not needed)');
      console.log('source     :', eng.reused
        ? `remembered recipe (${eng.recalled}) - nothing to search`
        : eng.recalled
          ? `remembered recipe was stale (${eng.recalled}) - re-learned`
          : 'searched and learned');
      console.log('probes     :', eng.probes);
      console.log('took       :', ms + ' ms');
    } else {
      console.log('engine     :', 'fallback to fixed shapes');
      if (eng.error) console.log('reason     :', eng.error);
      if (eng.trace) for (const t of eng.trace.slice(-4)) console.log('           ', t);
    }

    console.log('\n--- solved ---');
    console.log('solved sig :', solved.sig);
    console.log('solved n   :', solved.solvedN || '(none)');
    console.log('solved URL :', solved.url);
    if (solved.errors && solved.errors.length) {
      for (const e of solved.errors) console.log('warning    :', e);
    }

    const rawN = solved.rawN;
    const solvedUrl = solved.url;
    console.log('\n--- probe (googlevideo is the judge) ---');
    const ok = await probe('solved', solvedUrl);
    if (rawN) {
      const u = new URL(solvedUrl); u.searchParams.set('n', rawN);
      await probe('raw n', u.toString());
    }
    { const u = new URL(solvedUrl); u.searchParams.delete('n'); await probe('no n', u.toString()); }
    { const u = new URL(solvedUrl); u.searchParams.delete(q.get('sp') || 'sig'); await probe('no sig', u.toString()); }

    const pass = ok.status === 206 || ok.status === 200;
    if (pass) {
      console.log('\nRESULT: PLAYABLE (' + ok.status + ')');
    } else {
      console.log('\nRESULT: NOT PLAYABLE (' + ok.status + ')');
      console.log('  · 403 usually means the link expired — copy a fresh signatureCipher');
      console.log('  · if a fresh cipher also gives 403, the recipe was marked stale: run again to re-learn');
    }
  }

  if (wantBuild) {
    if (!solved.url) {
      console.log('\nbuild  : skipped - no playable URL to embed');
    } else {
      const { build } = require('./build-play.js');
      try {
        await build(file, path.join(__dirname, 'play.html'));
      } catch (e) {
        // Never swallow this: a failed build means no player page, and the user
        // needs the reason. Keep going so /live still opens.
        console.log('\nbuild  : could not write play.html - ' + e.message);
      }
    }
  }
  if (wantServe) {
    process.env.PORT = process.env.PORT || '8766';
    // The server reads a file, not the in-memory cipher. Keep it pointed at the
    // same input when the user passed a custom path.
    if (file !== 'cipher.txt' && !process.env.CIPHER) process.env.CIPHER = path.resolve(file);
    require('./server.js');
  }
})();
