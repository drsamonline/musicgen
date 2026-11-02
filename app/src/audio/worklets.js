// Loading of the AudioWorklet modules. One place, one cache, one fallback
// story: if any of these fail to load the engine carries on with native nodes.

const WORKLET_MODULES = ['granular.js', 'physical.js', 'clock.js'];
const workletReady = new WeakMap();

// Load the AudioWorklet modules once per context. Anything that fails here
// falls back to native nodes — the app must never depend on a worklet.
export async function prepareWorklets(ctx) {
  if (workletReady.has(ctx)) return workletReady.get(ctx);
  const promise = (async () => {
    if (!ctx.audioWorklet?.addModule) return { granular: false, physical: false, clock: false };
    const base = new URL('./worklets/', import.meta.url);
    const ok = { granular: false, physical: false, clock: false };
    for (const name of WORKLET_MODULES) {
      try {
        await ctx.audioWorklet.addModule(new URL(name, base).href);
        if (name === 'granular.js') ok.granular = true;
        if (name === 'physical.js') ok.physical = true;
        if (name === 'clock.js') ok.clock = true;
      } catch { /* fall back */ }
    }
    return ok;
  })();
  workletReady.set(ctx, promise);
  return promise;
}
