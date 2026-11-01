# Enhancement backlog

Everything I would do next, ordered by category rather than by wish. Effort is **S** (a sitting), **M** (a day), **L** (a week or more). Impact is on the *product*, not on lines of code.

Status key: `[ ]` not started · `[~]` partial · `[x]` done in the current build.

---

## 1. Musical engine

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 1.1 | `[x]` Section modulation (pivot chord, direct, whole-step "gear change") | M | H | Spec'd, not built. Styles would need a `modulation` weight; the tension curve should trigger it, not chance. |
| 1.2 | `[x]` Section aliasing — reuse a section's phrases with mutations | M | H | Cheaper than regenerating and it is what makes A-B-A feel like one piece. |
| 1.3 | `[x]` Counter-line that actually answers the lead | M | H | The pad exists; call-and-response (lead rests → pad fills) does not. |
| 1.4 | `[x]` Polymeter and 3-against-4 | M | M | Euclidean drums are ready for it; the bar grid assumes one meter. |
| 1.5 | `[x]` Automation envelopes per track (cutoff, send, gain) drawn from the tension curve | M | H | Currently brightness is one number per note. |
| 1.6 | `[~]` Sidechain pumping for EDM | S | M | Flag exists in the style table; the graph ignores it. |
| 1.7 | `[x]` Melody contour memory — a motif that resolves rather than wanders | M | H | Track phrase-final intervals and bias the last note to a chord tone. |
| 1.8 | `[x]` Voice-leading for the bass against the chord top voice in all styles | S | M | The validator only checks it for Jazz/Classical. |
| 1.9 | `[x]` Drum pattern mutations instead of regeneration within a section | S | M | Same reason as 1.2. |
| 1.10 | `[x]` Groove template editor (16-step grid in the UI) | L | M | Big win for "this is an instrument" perception. |
| 1.11 | `[x]` Microtuning / just intonation per key | M | L | Spec'd as P2; nice for Ambient, invisible to most users. |
| 1.12 | `[x]` Melody instrument doubling (lead + octave / fifth) per style | S | M | Cheap thickness for Rock/Folk. |
| 1.13 | `[x]` Chord rhythm variation (anticipations, pushes) | S | H | Right now chords always land on the bar line. |
| 1.14 | `[x]` Intro/outro generators that fade the arrangement rather than the volume | M | M | Currently an outro is just a quiet section. |
| 1.15 | `[x]` Golden-seed listening log with notes | S | H | A file of "seed → what's wrong with it" is worth more than another feature. |
| 1.16 | `[x]` Tempo range 20–500 BPM | S | H | Was 40–200. Delay line, drum subdivision, swing and scheduler all had to survive 20 and 500; both are in the test suite now. |

## 2. Synthesis & sound design

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 2.1 | `[x]` Filter envelope per instrument (independent of amplitude) | S | H | The single biggest "does this sound like a synth" lever. |
| 2.2 | `[x]` Per-note drift/analogue instability | S | M | Slow detune LFO per voice. |
| 2.3 | `[ ]` Real wavetable morph (baked tables + crossfade) | M | M | Current version crossfades two oscillators. |
| 2.4 | `[x]` Granular + physical modelling in AudioWorklets | L | M | Deferred deliberately; must feature-detect and fall back. |
| 2.5 | `[ ]` Formant/vowel layer for pads | M | L | Cinematic/Ambient only. |
| 2.6 | `[x]` Drum kit depth — metallic hats, layered claps, rim variants | S | M | Hats are one noise burst; "chip" mode is a flag, not a recipe. |
| 2.7 | `[x]` Per-track FX: per-track reverb size, delay division, drive | M | H | Sends are global right now. |
| 2.8 | `[x]` Instrument-level preset variants (e.g. three bass flavours per tech) | M | M | Multiplies the palette without new engines. |
| 2.9 | `[x]` Velocity → timbre mapping (brighter on hard hits) | S | H | Velocity currently only changes gain. |
| 2.10 | `[x]` Legato/glide for mono lead and bass | S | M | |
| 2.11 | `[x]` Noise-bed generator for Ambient/Drone themes | S | M | The theme already claims texture density. |
| 2.12 | `[x]` Stereo width per track (Haas + detune) with mono-bass crossover | M | H | Spec'd; currently panning only. |

## 3. Mixing, mastering & analysis

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 3.1 | `[x]` Real mono-bass crossover (LR4 split below 120 Hz) | S | M | Now it is just "bass is panned centre". |
| 3.2 | `[x]` Mix-balance acceptance test (band energy per track) | S | H | Loudness is asserted; balance is not. This is the gap that lets drums run over everything. |
| 3.3 | `[x]` Per-style EQ curve instead of one shelf pair | M | M | |
| 3.4 | `[x]` True-peak oversampling (4×) in the measurement | M | M | Current peak is sample peak. |
| 3.5 | `[x]` LUFS short-term meter in the UI | S | M | Makes the loudness story visible. |
| 3.6 | `[x]` A/B against the previous generation, with a level-matched toggle | M | H | The fastest way to judge a composer change. |
| 3.7 | `[x]` Export normalisation options (target / raw / streaming preset) | S | M | |
| 3.8 | `[x]` Spectral tilt report in `qa/` for golden seeds | M | L | |

## 4. Performance & architecture

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 4.1 | `[x]` Cache the reverb IR per context | S | H | Was rebuilt on every pause. |
| 4.2 | `[x]` Share the saturation curve instead of per-note allocation | S | H | |
| 4.3 | `[x]` Reuse analyser buffers across frames | S | M | |
| 4.4 | `[x]` Binary search for section intensity | S | M | |
| 4.5 | `[x]` Fade the master on pause instead of rebuilding the graph | S | H | |
| 4.6 | `[x]` Voice pool with real priority stealing (quietest-oldest, with fade) | M | H | Current cap drops quiet notes at schedule time. |
| 4.7 | `[x]` Move the scheduler to an AudioWorklet clock | M | M | setInterval jitters under load. |
| 4.8 | `[ ]` Offload rendering to a Worker with OfflineAudioContext | L | M | Keeps the UI at 60 fps during a 3-minute export. |
| 4.9 | `[ ]` Typed-array note storage (SoA) for large songs | M | L | Only matters past ~10k notes. |
| 4.10 | `[x]` Startup budget check in CI (gzipped size + first-audio latency) | S | M | |

## 5. UI / UX

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 5.1 | `[x]` Light theme with an explicit toggle (system → light → dark) | M | H | |
| 5.2 | `[x]` Four visualiser modes, theme-aware | M | H | |
| 5.3 | `[x]` Undo/redo of preset changes | S | M | |
| 5.4 | `[x]` Drag-to-zoom and scroll on the piano roll | M | H | The roll is a picture right now, not a timeline. |
| 5.5 | `[x]` Click a note in the roll to audition it | S | M | |
| 5.6 | `[x]` Loop a section (timeline has jump, not loop) | S | M | |
| 5.7 | `[x]` Track-level locks (lock the drums, reroll the melody) | M | H | Spec'd P2; needs per-track seed derivation, which the composer already supports. |
| 5.8 | `[x]` Random with an animation of the dials moving | S | L | The spec asks for it; it is polish, not power. |
| 5.9 | `[x]` Onboarding: three taps that show Generate → Random → Export | S | M | |
| 5.10 | `[x]` Empty/error states with a retry rather than a toast | S | M | |
| 5.11 | `[x]` Session restore: reopen the app on the last song and position | S | M | |
| 5.12 | `[x]` A proper settings sheet (volume, theme, reduced motion, defaults) | S | M | |

## 6. Accessibility

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 6.1 | `[x]` axe clean on both themes and both viewports | S | H | Verified in `npm run audit`. |
| 6.2 | `[x]` Heading structure, landmark names, labelled controls, canvas labels | S | H | |
| 6.3 | `[x]` Text alternative for the piano roll (a note list per section) | M | H | A canvas is not "a visual representation" for a screen reader. |
| 6.4 | `[x]` Throttle `aria-live` announcements during slider drags | S | M | Currently every debounced regeneration announces. |
| 6.5 | `[x]` Keyboard-only section timeline (arrow keys, Home/End) | S | M | |
| 6.6 | `[x]` Respect `prefers-contrast: more` | S | L | |
| 6.7 | `[ ]` Focus-visible audit on the sheet and dialogs | S | L | |
| 6.8 | `[ ]` Screen-reader pass with NVDA/VoiceOver on a real device | M | H | Automated checks cannot hear it. |

## 7. Platform / PWA

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 7.1 | `[x]` Custom install prompt (`beforeinstallprompt`) + iOS instructions | S | M | |
| 7.2 | `[x]` Offline-ready badge once the SW controls the page | S | M | |
| 7.3 | `[x]` Share target (receive a seed from the OS share sheet) | M | M | |
| 7.4 | `[x]` File Handling API for `.musicgen.json` | M | M | |
| 7.5 | `[x]` Protocol handler `web+musicgen://` | S | L | |
| 7.6 | `[~]` Background-audio honesty: MediaSession + keep-alive, or say so in the UI | M | H | Some mobile browsers suspend on lock. |
| 7.7 | `[ ]` File System Access for choosing the export folder | M | L | Chromium only. |
| 7.8 | `[x]` Update flow: version bump → "refresh to update" toast | S | M | |
| 7.9 | `[x]` Screenshot list in the manifest for richer install UI | S | L | |
| 7.10 | `[ ]` Optional sync via a file the user owns (no server) | L | M | Keep the zero-account promise. |

## 8. Export & interop

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 8.1 | `[x]` Per-track stems as a zip (own store-only zip writer) | M | H | |
| 8.2 | `[~]` Stems re-mixed per track rather than sharing one gain | M | M | Needs per-track loudness measurement. |
| 8.3 | `[x]` Song JSON export/import (the whole note data, not just a seed) | S | H | Needed for any external editing. |
| 8.4 | `[ ]` MIDI import (so a human phrase can seed the composer) | L | M | Explicitly out of scope in the spec; still the best input idea. |
| 8.5 | `[ ]` OP-1 / Polyend Tracker style tracker export | M | L | |
| 8.6 | `[x]` MP3/OGG via a wasm encoder (or refuse and document why) | M | M | WAV is honest; a 40 MB file is not shareable. |
| 8.7 | `[ ]` QR code for the seed link | S | L | |
| 8.8 | `[x]` `navigator.share` with the cover art attached | S | M | |

## 9. Library & persistence

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 9.1 | `[~]` IndexedDB library (save, list, load, delete) | S | M | No rename, tag, search or duplicate yet. |
| 9.2 | `[x]` Store the full Song JSON, not just presets + seed | S | H | Then a saved song is a file you can diff. |
| 9.3 | `[x]` Rename, tag, search, duplicate, export JSON | M | M | |
| 9.4 | `[x]` Storage-quota handling with a visible usage meter | S | M | |
| 9.5 | `[x]` Bulk export of the library as a zip | S | L | |
| 9.6 | `[ ]` Cross-device handoff via the seed link only (no sync) | S | M | |

## 10. Testing & quality

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 10.1 | `[x]` Unit + browser suites in CI | S | H | |
| 10.2 | `[x]` axe audit script with app-level checks | S | H | |
| 10.3 | `[x]` Golden-seed snapshot diffs in CI | S | H | Catches "the composer changed" on every PR. |
| 10.4 | `[x]` Loudness regression on golden seeds (±1 LUFS) | M | H | |
| 10.5 | `[x]` Voice-cap stress test (7/8 at 180 BPM, full song) | S | M | |
| 10.6 | `[ ]` Visual regression on the studio in both themes | M | M | |
| 10.7 | `[x]` Custom lint rule banning `Math.random`/`Date.now` in `core/` | S | M | The determinism guarantee deserves enforcement. |
| 10.8 | `[x]` Property-based tests for the theory helpers | M | M | |

## 11. Docs & distribution

| # | Item | Effort | Impact | Notes |
|---|------|--------|--------|-------|
| 11.1 | `[x]` Landing page with a live specimen | M | H | |
| 11.2 | `[x]` README with badges and a screenshot gallery | S | H | |
| 11.3 | `[x]` Audio examples on the landing page (three seeds, ~20 s each) | S | H | The page sells a sound; it should play more than one. |
| 11.4 | `[ ]` A 60-second "how the composer works" walkthrough with diagrams | M | M | |
| 11.5 | `[x]` CONTRIBUTING + issue templates | S | L | |
| 11.6 | `[x]` Changelog generated from commit messages | S | L | |

## 12. Product decisions still open

1. **Is the studio a toy or an instrument?** The tracker-style grid editor (1.10) and per-track locks (5.7) push it toward instrument; golden seeds and more styles push it toward toy-that-delivers. Pick one for v2.
2. **Does the seed link need to carry the song, not just the recipe?** A link that reproduces a song only works while the composer is unchanged. Versioned seeds (`seed + composerVersion`) would make old links honest.
3. **Should exports be shareable by default?** WAV is 10 MB/minute. Either ship a small encoder or make the MIDI + seed the default handoff.
4. **How much of the "no server" promise survives a library?** Files-in-the-user's-folder is the honest path; anything else becomes sync.
5. **Do we want a composer version pin in the UI?** If the algorithm changes, every existing seed changes with it — that is a user-visible break worth surfacing.

---

## What v2.2.0 closed

- **AudioWorklets, finally.** Two real DSP processors: `granular-voice` (overlapping Hann-windowed grains, scatter derived from a hash so it stays deterministic) and `physical-voice` (fractional-delay waveguide with damping and a seeded excitation). Both are per-track nodes, both are loaded with `addModule` and both fall back to native nodes if anything fails — the app never depends on a worklet.
- **A clock worklet.** The scheduler can now be driven by an audio-thread tick instead of `setInterval`, which is the difference between a steady tempo and a wobbling one when the main thread is busy.
- **Microtuning.** Just intonation per pitch class, expressed as cents away from 12-TET, applied as a detune in the engine.
- **Groove editor.** A 16-step grid for kick, snare and hat that overrides the style template.
- **Polymeter.** Hats can run three against the bar's four.
- **Automation envelopes.** Each section opens the per-track tone filter and the sends according to the tension curve.
- **Per-track FX** (delay division and drive, with gain compensation so drive adds colour and not level), **instrument variants** (three flavours per tech), **drum depth** (metallic hats, layered claps, a woodier rim), and a **noise bed** for ambient and cinematic songs.
- **Settings dialog**, **live recording** to WebM via MediaRecorder, **protocol handler** (`web+musicgen://`), a **spectral tilt report** and a **generated CHANGELOG**.

## What v2.1.0 closed

- **Versioned seeds.** The composer now stamps `COMPOSER_VERSION` into every share link, song file and library entry. An old link says "this was made with composer v1 — the notes will differ now" instead of silently playing something else. (Reproducing the *old* output would mean keeping every historical composer; that is a decision, not a bug fix.)
- **Legato.** Adjacent bass and lead notes glide instead of retriggering.
- **Per-style EQ.** Two shelves and a mid band per style — the difference between "a mix" and "a lo-fi mix".
- **True peak.** 4× oversampled (Catmull-Rom), so the −1 dBTP ceiling means what it says.
- **Mix balance is now a test**, not an opinion: every track is rendered solo and checked for being audible, not buried, and not letting the drums dominate.
- **Note audition** — tap a note in the roll to hear it.
- **Random flashes the dials it changed**; a first-run hint says what the three buttons do.
- **`prefers-contrast: more`** support.
- **Share target, file handlers and manifest screenshots** — the app can receive a seed from the OS share sheet and be opened with a `.json` song.
- **Library bulk export** as a zip of song JSON.
- **Budget script** — shell size, precache completeness and "no external requests" are now enforced, not asserted in a README.

## What v2.0.0 closed

The audio path was rebuilt rather than patched, because the "sound occasionally glitches or is lost" report had three separate causes:

1. **The voice counter never decremented.** It was driven by `setTimeout`, which is throttled in a background tab and never runs during an offline render, so `active` climbed to the cap and stayed there — after which every quiet note was silently dropped. Replaced with a pool pruned by time, which steals the quietest voice with a fade instead of dropping the new note.
2. **Feedback and noise loops were never disconnected.** Karplus-Strong's delay line rang forever and the noise bed's LFO kept running; over a long session that is a slow CPU creep and, eventually, dropouts.
3. **Notes were fired in a burst when the main thread stalled.** The scheduler now skips anything more than 60 ms late instead of dumping a cluster into the present, and the lookahead is 200 ms.

On top of that: a mono-bass crossover, sidechain ducking, a filter envelope and velocity-to-timbre on every instrument, analogue drift, a stereo width tap, and per-track locks that draw from their own seed stream so a locked drum pattern survives a new seed.

## If I could only do three

1. **4.6 — real voice stealing with fade.** It is the difference between "works" and "works on a phone at 7/8, 180 BPM".
2. **3.2 — a mix-balance test.** Loudness is asserted; balance is not, and balance is what people actually hear.
3. **11.3 — audio on the landing page.** Three seeds, twenty seconds each, and the page stops asking to be trusted.
