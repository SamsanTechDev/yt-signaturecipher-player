/**
 * build-play.js - turn a solved cipher into play.html.
 *
 *   node build-play.js                # reads cipher.txt, writes play.html
 *   node build-play.js my-cipher.txt other.html
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { solveDetailed, cleanCipher } = require('./solver.js');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mb = (n) => n ? (n / 1024 / 1024).toFixed(1) + ' MB' : '-';

async function readCipher(file) {
  const cipher = cleanCipher(fs.readFileSync(file, 'utf8'));
  const q = new URLSearchParams(cipher);
  const base = new URL(q.get('url'));
  // solveDetailed is async now (it may read a player and probe googlevideo).
  const solved = await solveDetailed(cipher);
  if (!solved || !solved.url) {
    throw new Error('not solved: ' + ((solved && solved.report && solved.report.error) || 'no playable url'));
  }
  return {
    cipher,
    videoUrl: solved.url,
    rawS: solved.rawS || '',
    solvedSig: solved.sig || '',
    rawN: solved.rawN,
    solvedN: solved.n,
    engine: solved.engine,
    itag: base.searchParams.get('itag'),
    id: base.searchParams.get('id') || '',
    clen: Number(base.searchParams.get('clen') || 0),
    dur: Number(base.searchParams.get('dur') || 0),
    expireAt: Number(base.searchParams.get('expire') || 0) * 1000,
  };
}

async function build(file = 'cipher.txt', out = 'play.html') {
  const c = await readCipher(file);

  let probe = { status: '-' };
  try {
    const r = await fetch(c.videoUrl, { headers: { range: 'bytes=0-1023', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } });
    await r.arrayBuffer();
    probe = { status: r.status, range: r.headers.get('content-range') || '', type: r.headers.get('content-type') || '' };
  } catch (e) { probe = { status: 'ERR', range: e.message }; }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solved stream - itag ${esc(c.itag)}</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --card:#141821; --line:#242a36; --text:#eef1f7; --muted:#9aa3b2; --accent:#ff2d55; --ok:#33d17a; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:radial-gradient(1000px 600px at 50% -10%, #1a2030 0%, var(--bg) 55%); color:var(--text); font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 18px 60px; }
  h1 { font-size: clamp(20px,3vw,30px); margin:0 0 4px; letter-spacing:-0.02em; }
  .sub { color:var(--muted); margin:0 0 18px; }
  .player { position:relative; background:#000; border:1px solid var(--line); border-radius:16px; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,.45); aspect-ratio:16/9; }
  .player video { position:absolute; inset:0; width:100%; height:100%; border:0; background:#000; }
  .fallback { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:24px; text-align:center; background:#10141c; }
  .fallback h2 { margin:0; font-size:18px; } .fallback p { margin:0; color:var(--muted); max-width:52ch; }
  .player.failed video { display:none; } .player.failed .fallback { display:flex; }
  .bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:16px 0 8px; }
  .btn { appearance:none; border:1px solid var(--line); background:#1b2130; color:var(--text); padding:9px 14px; border-radius:10px; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; }
  .btn:hover { background:#232b3d; } .btn.primary { background:var(--accent); border-color:transparent; color:#fff; }
  .status { display:inline-flex; align-items:center; gap:8px; padding:6px 11px; border-radius:999px; border:1px solid var(--line); background:#11151d; color:var(--muted); font-size:13px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 12px currentColor; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-top:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; }
  .kv { display:grid; grid-template-columns:100px 1fr; gap:6px 10px; font-size:13px; }
  .kv dt { color:var(--muted); } .kv dd { margin:0; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; word-break:break-all; }
  .mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12.5px; word-break:break-all; color:#cfd6e4; }
  details { margin-top:10px; } summary { cursor:pointer; color:var(--muted); }
  .hint { color:var(--muted); font-size:13px; margin:10px 0 0; }
  footer { margin-top:24px; color:var(--muted); font-size:12.5px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Solved stream</h1>
  <p class="sub">itag ${esc(c.itag)} &middot; source id <span class="mono">${esc(c.id)}</span></p>

  <div class="player" id="box">
    <video id="v" controls playsinline preload="metadata" src="/stream" data-direct="${esc(c.videoUrl)}"></video>
    <div class="fallback">
      <h2>Signed URL expired</h2>
      <p>This googlevideo link is no longer valid. Put a fresh signatureCipher in <span class="mono">cipher.txt</span> and run <span class="mono">node solve.js --build</span>.</p>
    </div>
  </div>

  <div class="bar">
    <span class="status"><span class="dot"></span><span id="statusText">Ready</span></span>
    <button class="btn primary" id="playBtn">Play</button>
    <a class="btn" href="${esc(c.videoUrl)}" target="_blank" rel="noreferrer">Open stream URL</a>
    <button class="btn" id="copyBtn">Copy solved URL</button>
  </div>
  <p class="hint">Signed links expire (this one: ${esc(new Date(c.expireAt).toLocaleString())}). itag 137 and similar are DASH video-only, so they have no audio track.</p>

  <div class="grid">
    <div class="card"><h2>Signature (s)</h2><dl class="kv">
      <dt>raw length</dt><dd>${c.rawS.length}</dd>
      <dt>solved sig</dt><dd class="mono">${esc(c.solvedSig)}</dd>
    </dl></div>
    <div class="card"><h2>Throttling (n)</h2><dl class="kv">
      <dt>raw n</dt><dd class="mono">${esc(c.rawN || '')}</dd>
      <dt>solved n</dt><dd class="mono">${esc(c.solvedN || '')}</dd>
    </dl></div>
    <div class="card"><h2>Probe</h2><dl class="kv">
      <dt>status</dt><dd>${esc(probe.status)}</dd>
      <dt>range</dt><dd>${esc(probe.range)}</dd>
      <dt>type</dt><dd>${esc(probe.type)}</dd>
      <dt>size</dt><dd>${mb(c.clen)}</dd>
      <dt>duration</dt><dd>${c.dur ? c.dur.toFixed(3) + ' s' : '-'}</dd>
    </dl></div>
  </div>

  <details><summary>Show solved URL</summary><p class="mono">${esc(c.videoUrl)}</p></details>
  <footer>Solved by <span class="mono">solver.js</span> using the <span class="mono">${esc(c.engine)}</span> engine. solved sig + solved n &rarr; 206; wrong or missing &rarr; 403.</footer>
</div>
<script>
  var video = document.getElementById('v');
  var box = document.getElementById('box');
  var statusText = document.getElementById('statusText');
  var triedDirect = false;
  var direct = video.getAttribute('data-direct');
  // Serving over http:// means the local proxy handles Range requests and
  // CORS for us. Browsers routinely refuse (or silently stall on) a bare
  // googlevideo URL inside <video>, so try direct only as a fallback.
  function useProxy() {
    if (!location.protocol.startsWith('http')) return false;
    video.src = '/stream';
    video.load();
    return true;
  }
  function useDirect() {
    if (triedDirect || !direct) return false;
    triedDirect = true;
    statusText.textContent = 'Retrying direct...';
    video.src = direct;
    video.load();
    video.play().catch(function () {});
    return true;
  }
  video.addEventListener('playing', function () { statusText.textContent = 'Playing'; });
  video.addEventListener('pause', function () { statusText.textContent = 'Paused'; });
  video.addEventListener('error', function () {
    if (useDirect()) return;
    if (!video.src || !location.protocol.startsWith('http')) {
      box.classList.add('failed');
      statusText.textContent = 'Signed URL expired';
    }
  });
  // A stalled stream fires no "error" at all - it just sits at 0:00. Watch
  // for that and switch source instead of waiting forever.
  setTimeout(function () {
    if (video.readyState === 0 && !triedDirect) useDirect();
  }, 8000);
  useProxy();
  video.play().catch(function () {});
  document.getElementById('playBtn').addEventListener('click', function () { video.play().catch(function () {}); });
  document.getElementById('copyBtn').addEventListener('click', function () {
    navigator.clipboard.writeText(video.getAttribute('src')).then(function () {
      var b = document.getElementById('copyBtn'); var t = b.textContent;
      b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1200);
    }).catch(function () {});
  });
  // The local server is not permanent: heartbeat while this page lives, and
  // tell it to stop the moment the page closes.
  if (location.protocol === 'http:') {
    var beat = function () { fetch('/ping', { cache: 'no-store' }).catch(function () {}); };
    beat();
    setInterval(beat, 15000);
    try { new EventSource('/events'); } catch (e) {}
    addEventListener('pagehide', function () { try { navigator.sendBeacon('/bye'); } catch (e) {} });
  }
</script>
</body>
</html>
`;

  fs.writeFileSync(path.resolve(out), html);
  console.log(`wrote ${out}  (probe ${probe.status})`);
  return out;
}

if (require.main === module) {
  build(process.argv[2] || 'cipher.txt', process.argv[3] || 'play.html')
    .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; });
}

module.exports = { build, readCipher };
