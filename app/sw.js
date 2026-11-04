// Service worker: cache-first app shell. There are no runtime assets to
// fetch, so a full precache means the app is genuinely offline.
const VERSION = 'musicgen-v21';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/main.js',
  'src/ui/ctx.js',
  'src/ui/dials.js',
  'src/ui/generate.js',
  'src/ui/transport.js',
  'src/ui/visuals.js',
  'src/ui/exporters.js',
  'src/ui/plan.js',
  'src/ui/health.js',
  'src/ui/controllers.js',
  'src/state.js',
  'src/core/rng.js',
  'src/core/algorithms.js',
  'src/core/theory.js',
  'src/core/voicing.js',
  'src/core/motif.js',
  'src/core/composer.js',
  'src/core/plan-edit.js',
  'src/core/validate.js',
  'src/core/tempo.js',
  'src/presets/styles.js',
  'src/presets/moods.js',
  'src/presets/themes.js',
  'src/presets/types.js',
  'src/presets/techs.js',
  'src/presets/compatibility.js',
  'src/audio/engine.js',
  'src/audio/graph.js',
  'src/audio/scheduler.js',
  'src/audio/player.js',
  'src/audio/render.js',
  'src/audio/worklets.js',
  'src/audio/textures.js',
  'src/audio/transitions.js',
  'src/audio/instruments.js',
  'src/audio/drums.js',
  'src/audio/fx.js',
  'src/audio/mastering.js',
  'src/audio/lufs.js',
  'src/audio/health.js',
  'src/audio/worklets/granular.js',
  'src/audio/worklets/physical.js',
  'src/audio/worklets/clock.js',
  'src/export/wav.js',
  'src/export/midi.js',
  'src/export/xm.js',
  'src/export/zip.js',
  'src/import/midi.js',
  'src/export/artwork.js',
  'src/visual/pianoRoll.js',
  'src/visual/tracker.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(request);
      if (res.ok && res.type === 'basic') cache.put(request, res.clone());
      return res;
    } catch {
      const shell = await cache.match('index.html');
      if (shell) return shell;
      throw new Error('offline and not cached');
    }
  })());
});
