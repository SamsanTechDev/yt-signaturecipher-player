# How the solver works

A mind map and a step-by-step walkthrough of what actually happens when you run
`play.bat` / `node solve.js`.

Everything below was verified against the player bundle this app downloads
automatically (`base.js`), not a hard-coded copy.

---

## Mind map

```
                        ┌──────────────────────────────────────────┐
                        │           signatureCipher solver         │
                        │  "ask YouTube's own player, don't copy"  │
                        └───────────────────┬──────────────────────┘
                                            │
     ┌──────────────┬───────────────┬───────┴────────┬───────────────┬──────────────┐
     │              │               │                │               │              │
 ┌───▼────┐   ┌─────▼─────┐   ┌─────▼─────┐   ┌──────▼──────┐  ┌─────▼─────┐  ┌─────▼─────┐
 │ 1 INPUT│   │ 2 CLEAN   │   │ 3 SANDBOX │   │ 4 LOAD      │  │ 5 SIG     │  │ 6 N       │
 │ cipher │   │ cleanCipher│  │ fake      │   │ base.js in  │  │ Kh + Gh   │  │ g.ti.get  │
 │ .txt   │   │ strips    │   │ browser   │   │ a Node vm   │  │ 8 ops     │  │ rewrites  │
 │        │   │ JSON/quote│   │ globals   │   │ + inject    │  │ s -> sig  │  │ n -> n'   │
 └───┬────┘   └─────┬─────┘   └─────┬─────┘   └──────┬──────┘  └─────┬─────┘  └─────┬─────┘
     │              │               │                │               │              │
  s  106 chars   "s=…",  ->  s=…  no network       _yt_player     106 -> 100      19 -> 14
  sp "sig"       {…}     ->  s=…  no DOM side fx   .__api          chars           chars
  url …&n=…      player  ->  s=…  timers muted     cached once     (pure)          (in place)
     │              │               │                │               │              │
     └──────────────┴───────────────┴────────────────┴───────┬───────┴──────────────┘
                                                             │
                        ┌────────────────────────────────────┼────────────────────────────────────┐
                        │                                    │                                    │
                  ┌─────▼──────┐                     ┌───────▼───────┐                    ┌───────▼───────┐
                  │ 7 REBUILD  │                     │ 8 PROVE       │                    │ 9 PLAY        │
                  │ ?sig=…     │                     │ Range GET     │                    │ play.html     │
                  │ ?n=…       │                     │ 206 = works   │                    │ /stream proxy │
                  │            │                     │ 403 = broken  │                    │ auto-stop     │
                  └────────────┘                     └───────────────┘                    └───────────────┘
```

### The three facts the whole thing rests on

```
1. the transform is a pure function     s  ──► sig        (string to string)
                                        url ──► n'         (string to string)
2. the player exposes those functions   Kh(41,790,·) then Gh(21,2482,·)
                                        new g.ti(url,true).get("n")
3. minified names are closure-local     so we inject one line inside the IIFE
                                        to publish them as _yt_player.__api
```

---

## Step by step

### 1. Input — what a `signatureCipher` actually is

Paste this (or drop it in `cipher.txt`):

```
s=g%3DgpLpgLHd4Q3…&sp=sig&url=https%3A%2F%2Frr8---sn-…%2Fvideoplayback%3F…%26n%3DqnHT6bGsVXD4lrzRZAM
```

Three parts:

| part | meaning |
| --- | --- |
| `s` | the **encrypted** signature (106 chars here) |
| `sp` | the name to write the answer back as — always `sig` today |
| `url` | the real stream URL, with the throttling token `n` inside it |

The URL is useless as-is: googlevideo answers **403** because `sig` is missing
and `n` is still the un-decoded value.

### 2. Clean — `cleanCipher()` in `solver.js`

DevTools gives you the value in whatever shape you copied it, so the first job
is normalisation. All of these become `s=…&sp=…&url=…`:

```
"s=…&sp=sig&url=…",                  a quoted JSON string  (+ trailing comma)
"s=…&sp=sig&url=…"                   a bare JSON string
{"itag":137,"signatureCipher":"…"}   one format object
{"streamingData":{…}}                a whole playerResponse
s=…&sp=sig&url=…                     already raw
```

That was the last bug: a quoted value made `raw s len : 0`, so nothing was
signed and every probe returned 403.

### 3. Sandbox — `tools/sandbox.js`

`base.js` is browser code. It touches `window`, `document.createElement`,
`navigator.userAgent`, `performance.now()`, `localStorage`, `matchMedia`, …

So we build a fake browser:

- **elements**: `makeEl()` returns an object where every DOM method is a no-op;
- **storage / observers / events**: stubs that do nothing;
- **network**: `fetch` **rejects** — the player can never phone home;
- **timers**: wrapped in `try/catch`, because the player reports internal
  errors via `setTimeout(() => { throw e })`; that must not kill our process;
- **intrinsics**: deliberately *not* injected from Node — the context keeps its
  own `String`/`Array`, so the player's obfuscation behaves identically.

`vm.createContext(sandbox)` turns that object into a real JavaScript global
environment, isolated from ours.

### 4. Load the player — `vm-solve.js`

`base.js` is one big IIFE: `(function(g){ …all the code… })(_yt_player);`

Every useful function (`Kh`, `Gh`, `Nh`, `Se`, `g.ti`) is a `var` **inside**
that closure — invisible from outside. Minifiers also rename them per build, so
you cannot rely on the names staying.

The trick is three lines:

```js
const tail = '})(_yt_player);';
const i = src.lastIndexOf(tail);
const inject = 'g.__api={rk:rk,Kh:Kh,Gh:Gh,Nh:Nh,ti:g.ti,Se:Se};\n';
return src.slice(0, i) + inject + src.slice(i);
```

We splice that assignment **just before the closing `})(_yt_player);`**, i.e.
inside the closure, where those names are still in scope. Running the file then
publishes them on the global `_yt_player` object:

```js
vm.runInContext(patchedSource(file), context, { filename: 'base.js', timeout: 60000 });
const api = vm.runInContext('_yt_player.__api', context);
```

Cost: **~150–240 ms once** (2.5 MB of minified JS to parse). The result is
cached in `cached`, so every later solve is a few milliseconds.

### 5. Solve the signature — exactly what the player does

The player's own helper is `rk` (visible above `Gh` in `base.js`):

```js
rk = function (a, b = "", c = "") {
  a = new g.ti(a, true);
  a.set("alr", "yes");
  c && (c = Gh(21, 2482, Kh(41, 790, c)), a.set(b, Nh(4, 17, c)));
  return a;
};
```

Read it literally:

1. wrap the URL in the player's URL class,
2. `c = Gh(21, 2482, Kh(41, 790, c))` — **this is the signature transform**,
3. `a.set(b, Nh(4, 17, c))` — write it back under `sp`, `Nh` is just
   `encodeURIComponent` (verified).

So our solver performs the same two calls (`vm-solve.js`):

```js
function playerSig(rawS, file = BASE) {
  const { api } = load(file);
  return String(api.Gh(21, 2482, api.Kh(41, 790, String(rawS))));
}
```

**But it does not start there.** Transcribing the chain above is one way to read
the player; calling the builder itself is another, and it cannot drift.

#### The shortcut that runs first: `.set("alr","yes")` (`engine/alr.js`)

The function above exists in every build — only its name and the helpers it
calls change. So instead of matching `rk`/`Gh` by shape, the solver looks for
the **marker** `set("alr","yes")` in the source, names the function that
contains it, and then drives that function:

```js
const url = builder(probeUrl, "s", encodeURIComponent(rawS));
url.set("n", rawN);      // this setter runs the player's n transform
url.get("s");            // <- the solved signature
```

This is YouTube's own code path, not our reading of it, so a rename or a new
opcode cannot break it. Every marker hit is still **verified** behaviourally
(some belong to a getter, a redirect builder, or an async class method), and the
result is just tier `0.25` in the search: one probe decides whether it was
right. If the marker disappears, `discover()` returns `null` and the chain
reading below carries on unchanged.

Measured on build `a5c2aafe`: builder `Bs`, serializer `Ue`, and the current
cipher solved on the **first probe**.

The rest of this section is the fallback — how the same transform is recovered
when the builder cannot be used.

**What those two functions really are.** They are dispatchers. The pair of
numbers is not a payload — it selects a code path and obfuscates the indexes:

```
d = b ^ a          for the signature:  d = 2482 ^ 21 = 2471
```

`Kh(41, 790, s)` is the legacy decode stage — in this build it is an
**identity function** (verified on 200 random inputs: output === input).

`Gh(21, 2482, s)` is where the work happens. Its body for this `a` is:

```js
e = c.split("");                       // string -> array of chars
pU.OE(e, 1);                           // swap e[0] <-> e[1 % len]
pU.VJ(e, 48);                          // e.reverse()
pU.OE(e, 53);                          // swap e[0] <-> e[53 % len]
pU.OE(e, 9);                           // swap e[0] <-> e[9 % len]
pU.VJ(e, 26);                          // e.reverse()
pU.dD(e, 3);                           // e.splice(0, 3)   drop 3 chars
pU.VJ(e, 69);                          // e.reverse()
pU.dD(e, 3);                           // e.splice(0, 3)   drop 3 chars
f = e.join("");                        // array -> string
```

with the three primitives (`pU` in `base.js`):

| op | code | meaning |
| --- | --- | --- |
| `OE` | `a[0] ⇄ a[b % a.length]` | swap first with index `b` |
| `dD` | `a.splice(0, b)` | drop the first `b` chars |
| `VJ` | `a.reverse()` | reverse |

and the arguments are literally `d` XOR constants from the source:
`d^2455 = 48`, `d^2450 = 53`, `d^2478 = 9`, `d^2493 = 26`, `d^2530 = 69`.

**Measured on the current cipher** (106 chars, itag 137):

```
1. OE arg=1   len=106
2. VJ arg=48  len=106
3. OE arg=53  len=106
4. OE arg=9   len=106
5. VJ arg=26  len=106
6. dD arg=3   len=106 -> 103
7. VJ arg=69  len=103
8. dD arg=3   len=103 -> 100
result: AE0s2JYwRAIgFmNRAdOsZ9A4uCh7dnYzZt4ZaOb8vdh-nQNLWNye93Y…
```

Six characters are dropped (two `dD 3`), so **106 → 100**. I re-implemented
those eight lines by hand and compared them with the player on 200 random
inputs: **200/200 identical**, and identical for the real `s`.

The point of loading the player instead of writing those eight lines: the
constants are per-build. Next player ships `OE 37, dD 2, …` and a hard-coded
program dies instantly.

### 6. Solve `n` — the throttling token

`n` is not signed; it is a "do not throttle me" token. With the raw value
googlevideo answers **403**, with the decoded one **206**.

Again we use the player's own URL class (`vm-solve.js`):

```js
function playerN(url, file = BASE) {
  const { api } = load(file);
  const u = new api.ti(String(url), true);   // player's URL wrapper
  return u.get('n');                          // decode + return the new n
}
```

Why that works — `g.ti` in `base.js`:

```js
class {
  constructor(a, b = false) { this.A = a; this.C = b; this.url = ""; this.j = {}; }
  set(a, b) { … this.url = "" }                          // invalidate cache
  get(a) { Gh(1, 8224, this); return this.j[a] || null; } // <-- the transform
  Ge()   { this.url || (this.url = Se(18, 7182, this));   // serialize back
           return this.url; }
}
```

`get('n')` calls `Gh(1, 8224, this)`. With `a = 1` the signature branch is
skipped (`(a-2&5) = 5 ≠ 1`) and the **other** branch fires:

```js
if (a >> 2 >= -67 && (a | 6) >> 4 < 1 && c.A) var e = Se(40, 1447, c);
```

So the `n` pipeline is `Se(40, 1447, urlObject)`, which internally re-parses the
URL and rewrites the `n` parameter of that object. Traced on the current
cipher:

```
get("n")
 └─ Gh(1, 8224, obj)
     └─ Se(40, 1447, obj)
         ├─ Lh(16, 7356, obj) × 43      character-level table work
         ├─ Nh(6, 1842, obj)            (percent/param encoding)
         └─ Gh(10, 8235, obj) ─ Kh(1,770) ─ Kh(12,3890) ─ Se(2,1162)
result: qnHT6bGsVXD4lrzRZAM (19) -> 150bcioiBR8MZg (14)
```

We do not re-implement any of that. We hand it a URL, ask for `get('n')`, and
take the answer.

### 7. Rebuild the URL — the whole output

```
in : …videoplayback?…&n=qnHT6bGsVXD4lrzRZAM            (no sig)
out: …videoplayback?…&n=150bcioiBR8MZg&sig=AE0s2JYw…   (signed + decoded)
```

`sp` is kept (`sig`), and `s` is not carried over — googlevideo only wants the
solved `sig`.

Verified equivalence: the URL our solver produces is **character-for-character
identical** to the one the player's own `rk(url, "sig", s)` produces, except
`rk` also adds a cosmetic `alr=yes`. Same `sig` (100 chars), same `n` (14).

### 8. Prove it — googlevideo is the judge

No heuristics, no "looks right". One `Range: bytes=0-1023` GET:

| request | expected | why |
| --- | --- | --- |
| solved URL | **206** `bytes 0-1023/94918454` | sig + n accepted |
| solved URL with raw `n` | 403 | throttle token still encoded |
| solved URL with `n` removed | 403 | `n` is mandatory |
| solved URL with `sig` removed | 403 | unsigned |

If row 1 is 206, the signature is correct. That is the only definition of
"works" this project uses, and `solve.js` prints it as
`RESULT: PLAYABLE (206)`.

### 9. Play

`build-play.js` writes `play.html` with the solved URL in a `<video>`; if the
browser refuses the cross-origin URL it falls back to the local `/stream`
proxy, which forwards `Range` headers so seeking works.

The server is temporary: the page holds an `EventSource('/events')` connection;
when the tab closes the connection drops and the server exits ~3 s later (a
`/bye` beacon and a 45 s idle timer are the backups).

---

## Why the old solver suddenly returned 403

```
old solver.js
├─ hard-coded 8-op program for s      from player 20744
│    swap 62, splice 2, swap 54, reverse,
│    splice 2, reverse, swap 1, splice 2
├─ hard-coded 21-op program for n
└─ current player 20746 runs different ops with different arguments
     OE 1, VJ, OE 53, OE 9, VJ, dD 3, VJ, dD 3   ← what we measured now
```

Same *family* of operations, different **order and constants**. A snapshot of
one build is worthless on the next one — which is exactly why the solver now
calls the player instead of copying it.

---

## Speed

| what | cost |
| --- | --- |
| read + parse 2.5 MB `base.js` in the vm | ~150–240 ms, **once** |
| signature (8 array ops on ~100 chars) | microseconds |
| `n` transform | microseconds |
| HTTP proof against googlevideo | ~100–300 ms (network) |

That is why `play.bat` feels instant: the only heavy step is paid once per run.

---

## Verify it yourself

```powershell
node solve.js                 # solve + 206 proof, no server
node vm-solve.js              # low-level: solve cipher.txt, print sig/n/url
node yt-cipher.js check       # (D: copy) deterministic + 206 check
```

Cross-checks you can reproduce:

```js
// load the player exactly like the solver does, then:
api.Kh(41, 790, s) === s                              // true  (identity in this build)
api.Gh(21, 2482, s)                                   // the 100-char sig
new api.ti(url, true).get('n')                        // the 14-char n
```

---

## Glossary

| term | meaning |
| --- | --- |
| `s` | encrypted signature, URL-encoded in the cipher |
| `sp` | parameter name to write the result to (`sig`) |
| `sig` | solved signature, sent to googlevideo |
| `n` | throttling token; must be decoded or you get 403 |
| `itag` | stream id (137 = 1080p video-only mp4, 140 = audio, 313 = 4K) |
| 206 | partial content — googlevideo accepted the request |
| 403 | forbidden — bad/absent `sig` or `n`, or an expired URL |
| `base.js` | the player bundle that contains the real transform (downloaded at runtime, never committed) |
