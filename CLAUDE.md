# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Keyboard Hero: a Guitar Hero–style rhythm game for the keyboard (A S D F frets, Space to strum), shipped as an offline PWA. There is no build step and there are no dependencies. The code is plain ES modules loaded straight from `index.html`.

(The parent `../CLAUDE.md` describes the shoryuken.me workspace and its shared-origin rules; the one above that, `~/Workspace/CLAUDE.md`, is an unrelated Rust/Fallout project. Ignore that one here.)

## Commands

```bash
npm test                                   # node --test tests/*.test.mjs
node --test tests/song.test.mjs            # single test file
npm run serve                              # python3 -m http.server 8080 → http://localhost:8080/
npm run bump                               # bump js/version.js patch + BUILT timestamp (-- minor|major)
npm run icons                              # redraw icons/ from scripts/make_icons.py (Pillow)
```

There is no linter or bundler. The page must be served over HTTP, not `file://`.

## Architecture

- `js/song.js`: `mulberry32`/`hashSeed`, the game constants (`DIFFS`, timing windows, scoring, lane keys) and `generateSong(seed, diff)`, which returns the chart (`notes`) and the synth backing (`backing`). DOM-free and unit-tested.
- `js/analysis.js`: charting the player's own file. `analyseAudio(buffer)` takes an AudioBuffer-like object (only `sampleRate`, `length`, `numberOfChannels`, `getChannelData` are used) and returns tempo, beats and onsets; `buildFileSong(an, diff)` turns that into a chart. DOM-free apart from `decodeAudio`, which needs an AudioContext. The tests feed it a synthetic click track.
- `js/app.js`: the Web Audio synth (`audio`), game state (`S`), judging (`strum`, `hit`, `miss`, sustains), the perspective canvas highway, menus, input and persistence. Song time is `audio.ctx.currentTime - S.songStart - offset`, and `startGame` sets `songStart` 0.6 s ahead.

### Determinism

A seed plus a difficulty always gives the same chart; a loaded file plus a difficulty always gives the same chart for that file (seeded from its name). Chart randomness must go through `mulberry32(hashSeed(...))`, never `Math.random` (which is fine for cosmetic effects and the Shuffle button). The tests check this.

## Conventions and gotchas

- **Adding or renaming a file:** add it to `ASSETS` in `sw.js` (`tests/assets.test.mjs` fails otherwise), then `npm run bump` so installed copies move to a clean cache.
- **Manifest `id`:** pinned to `/kh/`. Never change it: browsers would treat the app as a new one and existing installs would duplicate.
- **Shared origin:** this app lives on shoryuken.me next to other PWAs. `localStorage` keys use the `keyboardhero.` prefix (`keyboardhero.best.<diff>`, `keyboardhero.offset`). `sw.js` is the RSB-family worker: it deletes only caches with its own `kh-` prefix, handles only requests inside `self.registration.scope`, reads through `caches.open(CACHE_NAME)` (never `caches.match()`), precaches with `cache: 'reload'` and fetches network-first with `cache: 'no-cache'` so Cloudflare's 4 h max-age can't serve stale code.
- **Fonts are bundled** in `fonts/` so the game works offline; don't add remote stylesheets or fonts (a test checks). The canvas draws text in Bungee and Barlow Condensed too.
- **Sustain room** uses `Math.floor(x / half + 1e-9)`: without the epsilon a floating-point 7.999… drops half a beat (the final chord came out at 3.5 beats instead of 4).
- **Menu panels** are centred with `margin: auto`, not `align-items: center`, so a panel taller than the window scrolls instead of losing its top.

## Deployment

Live at https://shoryuken.me/kh/ (`/var/www/shoryuken.me/kh/`; server conventions are in `../CLAUDE.md`). After `npm test` and `npm run bump`, ship only the served files:

```bash
rsync -a --delete --chmod=D755,F644 index.html manifest.webmanifest sw.js css js fonts icons root@185.163.204.17:/var/www/shoryuken.me/kh/
```

GitHub Pages also deploys from `master` via `.github/workflows/pages.yml`.
