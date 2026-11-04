# What MusicGen can take from seven music projects

A reading of the seven repositories you linked, ranked by what they would actually
change in MusicGen — not by how impressive they are in themselves.

The filter is MusicGen's own promise: **no server, no samples, no ML runtime, a
~300 KB shell that works offline, and every song a pure function of
`(presets, seed)`.** Anything that breaks one of those is not a feature, it is a
different product. Several of these projects are excellent and still fail that
test, and saying so is more useful than a wish list.

---

## 1. The score is a first-class object (YuE2, ACE-Step 1.5)

**YuE2** is built around *symbolic planning*: it writes a melody-and-chord plan,
then realises that plan as audio. Its API is explicitly staged —
`plan() → generate_semantic() → synthesize() → decode()` — and the selling point
is that you can read and **edit the plan before rendering**. **ACE-Step 1.5**
makes the same move from the other direction: a language model acts as a
*planner* that turns a request into a song blueprint (structure, metadata,
captions) which then guides the diffusion decoder.

MusicGen already has the eleven-stage pipeline and already has a `Song` object —
but the plan is invisible. It is produced and rendered in one gesture. The
borrow is the **boundary, not the model**:

- expose `compose(presets, seed)` as two calls — `plan(presets, seed)` returning
  sections, chord grid, motif, tempo map; then `render(plan)` — and keep the
  existing determinism guarantee across both;
- let the user edit the plan (swap a chord, reorder a section, mute the counter-line,
  nudge the motif) and re-render. Same seed, same notes, human-chosen structure;
- the edited plan is still a value: serialise it into the share link, so an edited
  song is as reproducible as a generated one.

This is the single highest-value change on this list. It turns a slot machine
into an instrument, which is what the README already claims MusicGen is. It costs
no bundle size and no licence exposure: the *architecture* is the idea, and ideas
are not what these repos license.

**Do not** take their weights. ACE-Step needs ≥4 GB VRAM and YuE2 wants 24 GB and
Python; either one would end the offline-PWA premise and the 300 KB budget. If
you ever want that quality tier, it belongs in a separate companion app that
imports MusicGen's JSON.

## 2. Orders, patterns, and a file you can hand to a player (MilkyTracker)

MilkyTracker is a FastTracker II-compatible `.XM`/`.MOD` editor. Three of its
ideas are cheap for you:

- **The orders table.** A tracker's song is a flat list of pattern indices you
  can reorder, repeat and jump between — song structure as data, edited directly.
  MusicGen has sections and section-looping but no way to say "play chorus,
  chorus, bridge, chorus". A small orders strip (drag to reorder, click to
  duplicate, per-row repeat count) is a day's work and removes the most common
  "the arrangement is nearly right" complaint.
- **The pattern grid.** A vertical, monospaced, row-per-tick view with one column
  per channel is a genuinely different reading of the same music than a piano
  roll, and for drums it is better — you see the groove as a shape. It can share
  the existing `visual/pianoRoll.js` event source; it is a second renderer, not a
  second engine.
- **`.XM` export.** A module file is a few KB, embeds its own samples, and plays
  in any tracker, VLC, or OpenMPT. Next to a Type-1 MIDI file (which loses the
  timbre) and a WAV (which loses the editability), it is the missing middle: the
  song *and* its instruments, small enough to email. The format is publicly
  specified, so an independent implementation is fine — but write it from the
  specification, not from MilkyTracker's source, which is GPL-family.

## 3. Reliability lessons from a synth engine (SuperSonic, clockwork)

**SuperSonic** is scsynth re-hosted to run in the browser as an AudioWorklet,
natively, and inside the BEAM. **clockwork** is the layer underneath it: session
clock, device IO, OSC, MIDI, gamepad, Ableton Link, and four kinds of low-latency
lane into the DSP.

Neither is a dependency you can take — clockwork is AGPL-3.0-or-later and
SuperSonic's licence is mixed, and both are alpha with a moving ABI. But they are
the most battle-tested answer available to "what breaks a browser audio app", and
MusicGen should read them as a checklist:

- **Mobile resilience.** SuperSonic documents suspend/resume, a full reload when
  resume fails, and a client that restores its synthdefs and buffers afterwards.
  MusicGen has `ensureAudible()` on every tick, which is the same instinct one
  layer down. iOS Safari still kills an `AudioContext` on backgrounding more
  often than it should; a "we lost the audio device, rebuild the graph and
  restore the position" path is worth more than any new preset.
- **Scheduling in the engine, timestamped to the sample.** MusicGen's scheduler
  runs a 200 ms lookahead and drops late notes. A section jump or a tempo change
  currently has to be threaded through that window. SuperSonic holds far-future
  bundles itself and cancels with `/clearSched` — the equivalent (a cancellable,
  sample-stamped event queue in the worklet) would make seeks and section jumps
  exact instead of approximately right.
- **A malloc-free audio path.** Their rule is zero allocation or blocking on the
  audio thread. Your worklets are small enough to hold to that literally, and
  the check is mechanical: no `new`, no array literals, no string building inside
  `process()`.
- **Telemetry as a first-class feature.** They expose OSC throughput, scheduler
  depth and lateness, ring-buffer fill and glitch detection through a one-way
  shared-memory lane. MusicGen has no answer to "why did it stutter on my phone".
  A debug HUD with voice-pool occupancy, scheduler lateness and dropout count
  would turn every future bug report into a measurement.

## 4. Live performance, without becoming a live-coding environment (Sonic Pi, Tidal)

**Sonic Pi** (live coding for performance and for schools) and **Tidal** (patterns
as functions, with mini-notation) are the two best arguments that a small pattern
language beats a wall of dials for *performance*.

The borrowable idea is **mini-notation**: a one-line pattern string like
`bd ~ sn [bd bd] ~` that is far quicker to type and to read than a step grid, and
that composes (repeat, stack, slow, fast). For MusicGen, a pattern field on the
drum and bass tracks — parsed into the existing groove templates — would give
power users direct control without touching the composer.

Two cautions, both real:

- **Licensing.** Tidal is GPL-3.0 and its `POLICY.md` states that ports and
  projects using Tidal source as a reference for algorithms or types are
  derivative works under the same licence. MusicGen is PolyForm Noncommercial.
  So: read the *notation* documentation, design your own parser and your own
  combinator semantics, and do not open the Haskell. If you would rather not
  carry that question at all, the orders table in §2 covers much of the same
  ground with no exposure.
- **Identity.** Both projects assume a user who wants to write code. MusicGen's
  pitch is one tap and a seed. Mini-notation should therefore be an *optional
  lane* on two tracks, not a new front door — otherwise you have rebuilt Sonic Pi
  with a smaller library.

The other Sonic Pi idea worth stealing is pedagogical: a "show me what it did"
panel that prints the plan — key, chords, motif transforms, the notes — as text.
It is the same object as §1, seen from the teaching side.

## 5. What to deliberately not do

- **Ship a local model.** ACE-Step and YuE2 are the right answer to "make it sound
  like a record" and the wrong answer to "works on a phone, offline, in 300 KB".
- **Ableton Link.** clockwork supports it natively; in a browser PWA there is no
  usable path today. Tempo sync would need a companion binary — note it, don't
  promise it.
- **A tracker as the primary UI.** MilkyTracker's grid is a superb second view.
  As the default it would lose the one-tap audience that is MusicGen's whole
  position.

---

## Ranked shortlist

| # | Change | Source | Cost | Licence risk | Why it is worth it |
|---|--------|--------|------|--------------|--------------------|
| 1 | `plan()` / `render()` split; editable plan in the UI and in share links | YuE2, ACE-Step | M | none (architecture) | Turns generation into composition; keeps determinism |
| 2 | Orders strip: reorder / duplicate / repeat sections | MilkyTracker | S | none | Fixes the "arrangement is nearly right" gap |
| 3 | Audio-health HUD + rebuild-on-device-loss path | SuperSonic | S | none | Reliability; makes bug reports measurable |
| 4 | Tracker-style pattern view (second renderer) | MilkyTracker | M | none | Better drum editing; reuses existing events |
| 5 | `.XM` export, written from the format spec | MilkyTracker | M | low (spec, not source) | Portable song + instruments in a few KB |
| 6 | Mini-notation on drum/bass tracks | Tidal (concept) | M | **high** — GPL/derivative policy | Fast, readable pattern control |
| 7 | Gamepad and MIDI-in performance control | clockwork | M | none | Makes it playable as an instrument |
| 8 | "Show me what it did" plan-as-text panel | Sonic Pi | S | none | Accessibility and teaching; same object as #1 |

Items 1, 2, 3 and 8 share one underlying change — making the plan a real object —
and together they are the coherent next release. Items 5 and 7 are the two
features that would most widen who can use the output.

---

## Sources

Read on 4 November 2026:

- ACE-Step 1.5 — <https://github.com/ace-step/ACE-Step-1.5> (LM-as-planner, DiT decoder, 10 s–10 min, LoRA personalisation)
- YuE2 — <https://github.com/multimodal-art-projection/YuE> (symbolic planning, staged `plan → generate_semantic → synthesize → decode`, code Apache-2.0 with a separate model licence)
- MilkyTracker — <https://github.com/milkytracker/MilkyTracker> (FastTracker II-compatible `.XM`/`.MOD` editor)
- clockwork — <https://github.com/samaaron/clockwork> (DSP hosting: clock, OSC, MIDI, gamepad, Ableton Link; AGPL-3.0-or-later or commercial; alpha)
- SuperSonic — <https://github.com/samaaron/supersonic> (scsynth as an AudioWorklet / native / NIF, malloc-free audio path, engine-side scheduling, telemetry)
- Sonic Pi — <https://github.com/sonic-pi-net/sonic-pi> (live coding for performance and education)
- Tidal — <https://codeberg.org/uzu/tidal> (patterns as functions, mini-notation; GPL-3.0 with a derivative-works policy)
