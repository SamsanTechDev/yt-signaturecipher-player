/**
 * tools/self-check.js - the whole app's health in one command.
 *
 *   node tools/self-check.js         parsing + engine + player checks (offline)
 *   node tools/self-check.js --live  also boot the player and check /stream
 *
 * Offline checks never need a cipher or the network. `--live` needs a valid
 * cipher.txt and reaches googlevideo, exactly like the real app.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0;

function pass(name, extra) {
  console.log('  PASS  ' + name + (extra ? '   ' + extra : ''));
}
function fail(name, extra) {
  failed++;
  console.log('  FAIL  ' + name + (extra ? '   ' + extra : ''));
}
function check(name, ok, extra) { ok ? pass(name, extra) : fail(name, extra); }

// ---------------------------------------------------------------------------
// 1. signatureCipher parsing - every shape a user can paste from DevTools
// ---------------------------------------------------------------------------
console.log('\n[cipher parsing]');
const { cleanCipher } = require('../solver.js');

const BODY = 's=AAA&sp=sig&url=https://x.googlevideo.com/videoplayback%3Fa%3D1%26n%3Dabc';
const shapes = [
  ['bare value', BODY],
  ['quoted label', `"signatureCipher": "${BODY}"`],
  ['indented label', `                "signatureCipher": "${BODY}",`],
  ['trailing quote+comma', `${BODY}",`],
  ['whole player response', JSON.stringify({
    streamingData: { adaptiveFormats: [{ signatureCipher: BODY }] },
  })],
  ['double-encoded url', 's=AAA&sp=sig&url=https%3A%2F%2Fx.googlevideo.com%2Fvideoplayback%3Fa%3D1%26n%3Dabc'],
];

for (const [name, input] of shapes) {
  const q = new URLSearchParams(cleanCipher(input));
  const ok = q.get('s') === 'AAA'
    && /^https:\/\/x\.googlevideo\.com\/videoplayback/.test(q.get('url') || '')
    && q.get('sp') === 'sig'
    && q.get('"s') === null; // a stray quote would hide the real key
  check(name, ok, 's=' + q.get('s'));
}

// ---------------------------------------------------------------------------
// 2. engine: can it read a signature chain out of the real player?
// ---------------------------------------------------------------------------
console.log('\n[player engine]');
const base = path.join(ROOT, 'base.js');
if (!fs.existsSync(base) || fs.statSync(base).size < 500 * 1024) {
  console.log('  SKIP  base.js not downloaded yet (run: node solve.js)');
} else {
  const sites = require('../engine/sites.js');
  const src = fs.readFileSync(base, 'utf8');
  const found = sites.findSigSites(src);
  check('sig chain found in base.js', found.length > 0,
    found.length ? sites.describeChain(found[0].chain) : 'no site matched');
}

// ---------------------------------------------------------------------------
// 3. live player + proxy (opt-in, needs a valid cipher.txt)
// ---------------------------------------------------------------------------
const live = process.argv.includes('--live');
if (live) {
  console.log('\n[live player]');
  const PORT = process.env.PORT || '8803';
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT }, stdio: 'ignore',
  });

  (async () => {
    try {
      const baseUrl = `http://127.0.0.1:${PORT}`;
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try { await fetch(baseUrl + '/api/link'); up = true; } catch (e) { /* still booting */ }
      }
      check('server is up', up, baseUrl);
      if (!up) return;

      const api = await fetch(baseUrl + '/api/link');
      const link = await api.json();
      check('/api/link returns a url', api.status === 200 && !!link.url, link.error || 'itag ' + link.itag);

      const r = await fetch(baseUrl + '/stream', { headers: { range: 'bytes=0-1023' } });
      const buf = Buffer.from(await r.arrayBuffer());
      check('/stream serves video bytes', r.status === 206 && /^video\//.test(r.headers.get('content-type') || ''),
        r.status + ' ' + (r.headers.get('content-type') || '-') + ' ' + buf.length + ' bytes');
    } catch (e) {
      fail('live check', e.message);
    } finally {
      srv.kill();
    }
  })().then(done);
} else {
  done();
}

function done() {
  console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
  process.exitCode = failed ? 1 : 0;
}
