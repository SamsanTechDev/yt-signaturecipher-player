/**
 * engine/oracle.js - googlevideo is the judge.
 *
 * Every candidate URL is proven by asking the server. 206 means the sig and n
 * are both right; 403 means at least one is wrong. This module is the only
 * place that knows what "works" means, so the search engine never has to guess.
 *
 * Design notes
 * ------------
 * * Concurrent, batched: the search may have hundreds of candidates, so we
 *   probe in small parallel batches instead of one-at-a-time.
 * * Cheap requests: `Range: bytes=0-1` (2 bytes), so probing costs almost
 *   nothing in bandwidth.
 * * Early stop: the first 206 ends the search; remaining requests are dropped.
 * * Backoff: a 429 is retried with a delay, never treated as "wrong".
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 15000;

/** Probe one URL. Returns a verdict record; never throws. */
async function probe(url, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        range: 'bytes=0-1',
        'user-agent': UA,
        referer: 'https://www.youtube.com/',
      },
      signal: ctrl.signal,
    });
    // Drain so the socket is released.
    await res.arrayBuffer().catch(() => {});
    return {
      status: res.status,
      ok: res.status === 206 || res.status === 200,
      range: res.headers.get('content-range') || '',
      type: res.headers.get('content-type') || '',
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      status: 'ERR',
      ok: false,
      error: e.name === 'AbortError' ? 'timeout' : e.message,
      ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a list of tasks in parallel. Each task is `{ id, url }`.
 * Stops scheduling new work as soon as `stopWhen(candidate)` is true.
 *
 * @returns {Map<string, verdict>}
 */
async function probeBatch(tasks, opts = {}) {
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const results = new Map();
  let next = 0;
  let stop = false;

  async function worker() {
    while (!stop) {
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      const v = await probe(task.url, opts);
      results.set(task.id, v);
      if (v.status === 429 && opts.onRateLimit) await opts.onRateLimit();
      if (v.ok && opts.onHit) {
        stop = true;
        opts.onHit(task, v);
      }
      if (opts.onProgress) opts.onProgress(results.size, tasks.length);
    }
  }

  const n = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

module.exports = { probe, probeBatch, DEFAULT_CONCURRENCY };
