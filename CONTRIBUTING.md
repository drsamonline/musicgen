# Contributing

Thanks for looking. This project has one unusual rule, and everything else follows from it.

## The determinism rule

`src/core/` is a **pure** library: same `(presets, seed)` in, byte-identical song out. That means no `Math.random()`, no `Date.now()`, no `document`, no `fetch` in those files. `npm run lint` enforces it in CI, so a PR that reaches for the clock fails fast rather than mysteriously breaking every shared link.

If you need randomness, take an `Rng` and fork it: `rng.fork('drums')`. Forks are stable per label, which is why locking the drums can freeze one track without freezing the rest.

## Before you open a PR

```bash
npm test               # 32 unit tests
npm run test:browser   # 73 tests in real Chromium (needs Chrome + puppeteer)
npm run lint           # determinism
npm run budget         # shell size, precache completeness, no external requests
npm run visual         # pixel-diff the studio against committed baselines
npm install --no-save axe-core puppeteer
npm run audit          # axe in dark + light + desktop, plus app checks
```

All of them must pass — the visual check is the one exception: its baselines are rendered on one machine, so it reports in CI and gates locally. If you changed the composer, also listen: open `app/qa/matrix.html`, play the 27 cells, and say in the PR what you heard that changed.

## Changing the composer

Any change to the notes a seed produces is a **breaking change for every existing share link**. When you make one:

1. Bump `COMPOSER_VERSION` in `src/core/composer.js`.
2. Update the golden snapshot in `tests/unit/run.js` — deliberately, not by copying the failure.
3. Note it in the PR: "this changes every seed".

The version travels inside share links and song files, so an old link can tell the listener it will sound different instead of silently lying.

## Style

Vanilla ES modules, no build step, no dependencies at runtime. Keep the app shell under 200 KB gzipped — `npm run budget` checks it. Prefer a clear 40-line function to a clever 12-line one; this code is meant to be read by someone learning how a synthesiser works.

## What is welcome

- A style, mood or theme object (one object, no code changes).
- A synthesis recipe that stays on native nodes.
- Tests that describe a bug you hit.
- Accessibility fixes, especially anything a screen reader actually reports.

## What needs a conversation first

AudioWorklets, MIDI import, and anything that adds a runtime dependency or a network call. Those are all reasonable ideas that change the shape of the project.
