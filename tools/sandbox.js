// Minimal browser stub + vm context, good enough to load and run YouTube's
// obfuscated base.js (player JS) in plain Node.
const vm = require('vm');

function makeEl(tag) {
  const noop = function () {};
  const e = {
    tagName: (tag || 'div').toUpperCase(), nodeName: (tag || 'div').toUpperCase(),
    style: {}, dataset: {}, attributes: {}, childNodes: [], children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: (c) => c, removeChild: (c) => c, insertBefore: (c) => c,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    hasAttribute: () => false, addEventListener: noop, removeEventListener: noop,
    dispatchEvent: () => true, getElementsByTagName: () => [], querySelector: () => null,
    querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus: noop, blur: noop, click: noop, contains: () => false,
    canPlayType: () => 'maybe', play: () => Promise.resolve(), pause: noop, load: noop,
    currentTime: 0, duration: NaN, volume: 1, muted: false, readyState: 0,
    textContent: '', innerHTML: '', innerText: '', className: '', id: '',
    parentNode: null, firstChild: null, nextSibling: null,
    cloneNode: () => makeEl(tag), getContext: () => null, toDataURL: () => 'data:,',
    src: '', href: '',
  };
  return e;
}

function makeSandbox() {
  const noop = function () {};
  const document = {
    documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
    createElement: (t) => makeEl(t), createElementNS: (ns, t) => makeEl(t),
    createTextNode: () => ({ nodeType: 3, textContent: '' }),
    createDocumentFragment: () => makeEl('fragment'),
    getElementById: () => null, getElementsByTagName: () => [],
    getElementsByClassName: () => [], querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, readyState: 'complete',
    location: null, cookie: '', title: '', visibilityState: 'visible', hidden: false,
    hasFocus: () => true, fonts: { ready: Promise.resolve(), add: noop },
    implementation: { createHTMLDocument: () => document },
    currentScript: null, baseURI: 'https://www.youtube.com/', referrer: '',
    compatMode: 'CSS1Compat',
  };
  document.documentElement.ownerDocument = document;
  document.head.ownerDocument = document;
  document.body.ownerDocument = document;

  const location = {
    href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    protocol: 'https:', host: 'www.youtube.com', hostname: 'www.youtube.com',
    port: '', pathname: '/watch', search: '?v=dQw4w9WgXcQ', hash: '',
    origin: 'https://www.youtube.com', assign: noop, replace: noop, reload: noop,
    toString() { return this.href; },
  };
  document.location = location;

  const navigator = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Win32', language: 'en-US', languages: ['en-US', 'en'],
    appName: 'Netscape', appVersion: '5.0 (Windows)', vendor: 'Google Inc.',
    onLine: true, cookieEnabled: true, hardwareConcurrency: 8, deviceMemory: 8,
    maxTouchPoints: 0, product: 'Gecko', productSub: '20030107', doNotTrack: null,
    userAgentData: undefined, sendBeacon: () => true, javaEnabled: () => false,
    plugins: { length: 0 }, mimeTypes: { length: 0 },
    getBattery: () => Promise.resolve({ charging: true, level: 1 }),
  };

  const performance = {
    now: () => Number(process.hrtime.bigint() / 1000n) / 1000,
    timeOrigin: Date.now(), mark: noop, measure: noop, clearMarks: noop, clearMeasures: noop,
    getEntriesByName: () => [], getEntriesByType: () => [], getEntries: () => [],
    memory: { jsHeapSizeLimit: 2e9, usedJSHeapSize: 1e7, totalJSHeapSize: 2e7 },
  };

  // The player funnels internal errors through setTimeout(() => { throw e }).
  // Swallow those so a probe that is not meant to be called cannot crash the
  // host process; synchronous errors are still visible to the caller.
  //
  // Timers are `unref`'d: the player sets long-lived housekeeping timers
  // (heartbeats, watchdogs) that would otherwise keep `node solve.js` alive
  // forever after the work is done. They still fire while we are running,
  // because the process is busy then anyway.
  const unref = (t) => { try { if (t && t.unref) t.unref(); } catch (e) { /* ignore */ } return t; };

  // The player occasionally schedules with a bogus delay (NaN or Infinity),
  // which makes Node print "TimeoutNaNWarning" on every call. Discovery probes
  // thousands of internals, so the noise is overwhelming; clamp instead.
  const ms = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 2147483647);
  };

  const safeTimeout = (fn, delay, ...args) => unref(setTimeout(() => {
    try { if (typeof fn === 'function') fn(...args); } catch (e) { /* player async error */ }
  }, ms(delay)));
  const safeInterval = (fn, delay, ...args) => unref(setInterval(() => {
    try { if (typeof fn === 'function') fn(...args); } catch (e) { /* player async error */ }
  }, Math.max(1, ms(delay))));

  // NOTE: do *not* inject host intrinsics (String/Array/Proxy/...). The context
  // must keep its own intrinsics so that patching String.prototype inside the
  // context actually affects the player's own literals.
  const sandbox = {
    document, navigator, location, performance,
    // The player logs its own telemetry ("plyr.<n> ...") through console. That
    // is noise for us and can be very chatty during discovery, so route it to
    // a sink unless the caller asks for it.
    console: process.env.YT_VERBOSE
      ? console
      : { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {}, group() {}, groupEnd() {}, table() {}, time() {}, timeEnd() {} },
    setTimeout: safeTimeout, clearTimeout, setInterval: safeInterval, clearInterval, queueMicrotask,
    // Probing arbitrary internals makes the player schedule callbacks that
    // throw after we have lost the stack. Swallow those; a probe is not
    // supposed to be able to crash the host.
    requestAnimationFrame: (cb) => setTimeout(() => {
      try { cb(performance.now()); } catch (e) { /* player async error */ }
    }, 16),
    cancelAnimationFrame: clearTimeout,
    TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
    URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
    atob, btoa, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    escape, unescape, isNaN, isFinite, parseInt, parseFloat,
    structuredClone: globalThis.structuredClone,
    crypto: globalThis.crypto,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    Event: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    EventTarget: class { addEventListener() {} removeEventListener() {} dispatchEvent() { return true; } },
    XMLHttpRequest: class {
      constructor() { this.readyState = 0; this.responseText = ''; this.status = 0; }
      open() {} send() {} setRequestHeader() {} abort() {} addEventListener() {}
      getResponseHeader() { return null; } getAllResponseHeaders() { return ''; }
    },
    fetch: () => Promise.reject(new Error('network disabled in sandbox')),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    devicePixelRatio: 1,
    innerWidth: 1920, innerHeight: 1080, outerWidth: 1920, outerHeight: 1080,
    pageXOffset: 0, pageYOffset: 0, scrollX: 0, scrollY: 0,
    history: { pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop, length: 1, state: null, scrollRestoration: 'auto' },
    HTMLMediaElement: class {}, HTMLVideoElement: class {}, HTMLCanvasElement: class {},
    getComputedStyle: () => ({ getPropertyValue: () => '', width: '0px', height: '0px' }),
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    postMessage: noop, alert: () => {}, confirm: () => true, prompt: () => null,
    open: () => null, close: noop, focus: noop, blur: noop, print: noop,
    scroll: noop, scrollTo: noop, scrollBy: noop,
    requestIdleCallback: (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1),
    cancelIdleCallback: clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.frames = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext('var window = this;', context);
  return { sandbox, context };
}

function loadPlayer(jsSource, opts = {}) {
  const { context } = makeSandbox();
  vm.runInContext(jsSource, context, { filename: opts.filename || 'base.js' });
  const bag = vm.runInContext('typeof _yt_player !== "undefined" ? _yt_player : null', context);
  return { context, bag };
}

module.exports = { makeSandbox, loadPlayer };
