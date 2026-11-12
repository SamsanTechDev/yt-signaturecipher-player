# YouTube signatureCipher → playable browser link

Paste a `signatureCipher`, run `play.bat`, and watch the video in your browser.

YouTube scrambles two fields of every stream URL (`s` and `n`). This app asks the
player itself to unscramble them, then hands you a link that returns **HTTP 206**
and a local page that plays it.

---

## 1. Copy the cipher

1. Open **YouTube Music** (or YouTube) in your browser and start a song/video.
2. Press **F12** to open DevTools.
3. In the **Network** tab, search for `player`.
4. Click the **`v1/player`** request.
5. In **Response**, find the line **`"signatureCipher"`**.
6. Copy that whole value — **one line**, starting with `s=` and containing
   `&url=https%3A%2F%2F...googlevideo.com...`

> If you only see `"url"` and no `"signatureCipher"`, that stream is not
> scrambled. Any `itag` works, but pick an audio or video format you want.

## 2. Paste it

Open **`cipher.txt`**, replace the placeholder line with the cipher (one line),
and save.

> `cipher.txt` is not in the repository (it holds your personal signed URL). If
> it is missing, just double-click **`play.bat`** once — it creates the file and
> tells you to paste.

## 3. Run it

Double-click **`play.bat`**.

That's all. It solves the cipher, downloads the current player JS if needed,
starts a local player, and opens it in your browser.

The player is at **http://127.0.0.1:8766/**. Close the tab and the server stops
by itself (after ~45 s).

---

## What you should see

```
--- input ---
itag       : 140
raw s len  : 107

--- how it was solved ---
transform  : read from the player build
probes     : 2
took       : 1204 ms

--- probe (googlevideo is the judge) ---
solved    -> 206  bytes 0-1023/65630409  video/mp4
raw n     -> 403  0 bytes

RESULT: PLAYABLE (206)
```

`206` means the link works. `403` means something is wrong — almost always an
expired cipher (links die after a few hours), so copy a fresh one.

## Run it without the .bat

```powershell
node solve.js --build --serve     # solve, build play.html, serve on :8766
node solve.js                     # just solve and print the link
node solve.js --status            # what has been learned so far
node tools/self-check.js          # health check
```

Requires **Node.js 18+** (no packages to install).

Every push runs the same offline checks on GitHub Actions (Node 20, 22 and 24),
so `main` is always green. Version history is in `CHANGELOG.md`; releases are
tagged `v1.x.y`.

## The player is fetched and checked automatically

You never copy `base.js` by hand:

- **missing** (fresh clone, or you deleted it) → downloaded on the next run
- **younger than 6 h** → used as-is
- **older than 6 h** → YouTube's current build hash is checked; only a new
  build is downloaded, otherwise the old file is kept
- **a solve fails** → the hash is checked again. If YouTube shipped a new
  build, the old file is deleted, the new one downloaded, and the search
  retries. If the build is unchanged, it says so instead of re-downloading —
  then the cipher (an expired link) is the problem.

The build hash and update date are kept in `state/player.json`.

## Two ways to the same answer

The solver tries YouTube's own code path first, then falls back to reading the
player too — both are kept, because they fail differently:

1. **The player's own builder** (`engine/alr.js`). Every build contains a
   function that wraps a URL and calls `.set("alr","yes")`. We find it by that
   marker, hand it the cipher, and read the answer back. No helper names, no
   opcodes — a rename cannot break it.
2. **The search** (`engine/learn.js`). If that builder is missing or wrong, the
   engine reads the transform out of the player, plans candidate after
   candidate, and keeps the first one googlevideo answers with `206`.

Either way the result is proven with a real request before you see a link.

## Files

| File | What it is |
| --- | --- |
| `play.bat` | Double-click entry point |
| `cipher.txt` | Your pasted cipher (gitignored — it contains your IP) |
| `solve.js` | Solver + CLI |
| `solver.js` | Cipher parsing and URL building |
| `vm-solve.js` | Boots the player in a VM to get the real transform |
| `engine/` | Self-learning engine (discovery, planning, probes, memory) |
| `server.js` | Local player + `/stream` Range proxy |
| `build-play.js` | Generates `play.html` |
| `live.html` | Live progress page (`/live`) |
| `HOW-IT-WORKS.md` | Full technical walkthrough |
| `CHANGELOG.md` | Version history |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `403` on a fresh cipher | Run again: the build hash is checked and a new player is downloaded only if YouTube changed it |
| Video will not play in the page | Use the local page (`http://127.0.0.1:8766/`), not the raw link |
| `No usable signatureCipher` | Put the cipher on one line and replace the placeholder |
| No `signatureCipher` in DevTools | That stream is not scrambled by YouTube |

## Disclaimer

For personal, educational use. You are responsible for complying with
YouTube's Terms of Service and any content rights. This tool does not download
or store videos; it only derives a URL your browser already can play. No
credentials, IPs, or signed links are committed to this repository.
