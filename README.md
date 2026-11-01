# MusicGen

**A pocket generative composer.** One tap makes a finished-sounding track — harmony, melody, drums, mix and master — from six presets and a 12-character seed. No accounts, no server, no samples. It runs entirely in your browser, offline, in a light or dark studio.

[![tests](https://github.com/drsamonline/musicgen/actions/workflows/test.yml/badge.svg)](https://github.com/drsamonline/musicgen/actions/workflows/test.yml)
[![a11y: axe clean](https://img.shields.io/badge/axe%20wcag%202.1%20AA-clean-c6f24e.svg)](#accessibility--audit)
[![license: MIT](https://img.shields.io/badge/license-MIT-c6f24e.svg)](LICENSE)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-9aa8ff.svg)](#)
[![size: 49 KB gzipped](https://img.shields.io/badge/size-49%20KB%20gzipped-9aa8ff.svg)](#)
[![PWA: offline-first](https://img.shields.io/badge/PWA-offline--first-c6f24e.svg)](#)
[![web audio api](https://img.shields.io/badge/web%20audio-api-ff9f6b.svg)](#)

**[▶ Live demo](https://drsamonline.github.io/musicgen/)** · **[Open the studio](https://drsamonline.github.io/musicgen/app/)** · **[Releases](https://github.com/drsamonline/musicgen/releases)** · **[Enhancement backlog](docs/ENHANCEMENTS.md)**

![The MusicGen landing page, with a live specimen of a generated song](docs/screenshots/landing-desktop.png)

---

## What it is

A generative composer that behaves like an instrument rather than a toy. Every song is a **pure function of `(presets, seed)`**: the same inputs produce a byte-identical song, so a link is a recording. Random is sampled through a compatibility table so it stays musical, and every note is checked against the key and the chord sounding under it.

The whole thing is vanilla ES modules and the Web Audio API — no framework, no build step, no audio files, no network requests at runtime.

| Dark | Light |
|---|---|
| ![Studio, dark theme](docs/screenshots/studio-desktop.png) | ![Studio, light theme](docs/screenshots/studio-light-desktop.png) |
| *Two columns of dials, live spectrum, section timeline* | *The same studio in light — canvas colours are tokens too* |

| | | |
|---|---|---|
| ![Piano roll on a phone](docs/screenshots/studio-mobile.png) | ![Waveform visualiser](docs/screenshots/studio-spectrum.png) | ![Generated cover art](docs/screenshots/cover-art.png) |
| *Phone: piano roll, chord labels, playhead* | *Waveform mode* | *Cover art from the song's own data* |

## Try it

```bash
git clone https://github.com/drsamonline/musicgen
cd musicgen/app
python3 -m http.server 8080
# → http://localhost:8080
```

Then use your browser's **Install** / **Add to Home Screen** (iOS: Share → Add to Home Screen). The service worker precaches the whole shell, so after that first visit it launches and plays with the network switched off.

## What's inside

**The composer** — eleven stages, each testable: key and mode → harmonic grid (2nd-order Markov over style progressions, modal interchange) → voicing with a voice-leading solver → bass → drums (groove templates, Euclidean layers, phrase fills) → motif → development transforms → pad and counter-line → arp → humanise → tension curve.

**The presets** — 11 styles, 10 moods, 10 themes, 8 song types, 7 synthesis technologies, plus a compatibility table that maps styles to allowed moods and engines.

**The synthesis** — subtractive, FM, chiptune (real `PeriodicWave` pulses), additive, wavetable, Karplus-Strong and noise instruments; a drum kit built from oscillators and filtered noise; generated convolution reverb, tempo-synced delay and chorus; glue compressor and limiter on the master. Voice cap with stealing, 25 ms lookahead scheduler.

**The exports** — WAV (16/24/32-bit, normalised to the style's LUFS target under a −1 dBTP ceiling), per-track stems as a zip, Type-1 MIDI, 1024 px cover art, and seed links that reproduce the exact song elsewhere.

**The platform bits** — installable PWA, MediaSession metadata with generated artwork, screen Wake Lock during playback, four visualisers, undo/redo of preset changes, keyboard shortcuts, `prefers-reduced-motion` and `prefers-color-scheme` support, and a strict CSP (`default-src 'self'`) with zero runtime fetches.

## Themes

The studio ships **light and dark**, and the choice is yours, not the OS's: the ◐ button (or `T`) cycles **system → light → dark** and the choice is remembered. Every surface is a token, including the canvas palettes — the piano roll, spectrum, waveform and generative-art modes re-theme with the UI rather than staying stuck on one background.

## Accessibility & audit

`npm run audit` runs axe-core (WCAG 2.1 A/AA + best practice) over the studio in **dark, light and desktop**, and over the landing page, then adds app-level checks axe cannot know about: duplicate ids, unlabelled controls, canvases without an accessible name, missing `lang`, console errors. Current state: **zero violations, zero app-level issues, zero console errors**.

```bash
npm run audit
```

## Tests

```bash
npm test              # 24 unit tests, no browser needed
npm run test:browser  # 44 tests in real Chromium with real Web Audio
npm run shots         # regenerate docs/screenshots
npm run audit         # axe + app checks, light and dark
```

The suite asserts, rather than claims:

- determinism — the composer run 100× on the same seed, diffed
- musicality — 330 style × mood × seed cases through the theory validator
- audio — an offline render measured for silence, clipping and LUFS against the style target
- exports — WAV byte length, MIDI header and track count, zip archive structure
- the app — theme switching and persistence, service worker caching, visualiser modes painting, stems quieter than the mix
- the landing page — composing, drawing and linking its specimen

## Performance notes

Measured, not guessed. The reverb IR is synthesised once per context and cached (it used to be rebuilt on every pause); the saturation curve is a shared `Float32Array` instead of 1024 floats per note; analyser buffers are reused across frames; the section-intensity lookup is a binary search rather than a linear scan per note; and pausing fades the master instead of tearing down and rebuilding the audio graph.

## Architecture

```
index.html            landing page (its own live specimen)
landing.css landing.js
app/                  the PWA
  index.html styles.css manifest.webmanifest sw.js icons/
  src/core/           rng algorithms theory voicing motif composer validate
  src/presets/        styles moods themes types techs compatibility
  src/audio/          engine instruments drums fx mastering lufs
  src/export/         wav midi zip artwork
  src/visual/         pianoRoll (+ bars, waveform, generative art)
  src/state.js        src/main.js
  qa/matrix.html      listening matrix (dev only)
tests/unit/ tests/browser/
scripts/              screenshots.mjs, audit.mjs
docs/ENHANCEMENTS.md  the backlog
```

## Design notes

Three decisions are worth knowing about, because they were made against the obvious choice:

**The validator accepts chromatic notes when the chord owns them.** An absolute "everything in the key" rule would reject the modal interchange and borrowed chords that make the harmony interesting. The rule is *in key **or** a tone of the chord sounding at that moment*.

**Loudness targets are per style.** Lo-fi sits at −16 LUFS, EDM at −11, Ambient at −18. Normalising everything to a single streaming number would flatten exactly the character the styles are for.

**No AudioWorklets in v1.** Granular and physical-modelling worklets are where a generative-audio project goes to die. Everything here uses native nodes, which is why it runs on a mid-range phone and why the whole app is 49 KB gzipped.

## Known gaps

Stems are summed from one shared gain rather than re-mixed per track; undo covers preset changes, not generations; sidechain pumping exists in the style data but is not wired into the graph; the library stores presets and metadata rather than note data, so a saved song recomposes from its seed; MIDI import, microtuning and a protocol handler are not implemented. The full backlog is in [docs/ENHANCEMENTS.md](docs/ENHANCEMENTS.md).

## License

MIT — see [LICENSE](LICENSE). Music you generate with it is yours.
