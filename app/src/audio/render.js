// Offline rendering: the same graph and scheduler as live playback, so what
// you export is what you heard.
import { buildGraph } from './graph.js';
import { buildEvents, makeScheduler, applyAutomation } from './scheduler.js';
import { prepareWorklets } from './worklets.js';
import { scheduleTransitions } from './transitions.js';

// ---------------------------------------------------------------- offline
export async function renderSong(song, { sampleRate = 44100, tailSec = 2, onProgress = null, only = null } = {}) {
  const lengthSec = song.durationSec + tailSec;
  const frames = Math.ceil(lengthSec * sampleRate);
  const OfflineCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtor) throw new Error('OfflineAudioContext unavailable');
  const ctx = new OfflineCtor(2, frames, sampleRate);
  await prepareWorklets(ctx);
  const graph = buildGraph(ctx, song);
  applyAutomation(graph, song, 0, 0);
  const schedule = makeScheduler(graph, song);
  scheduleTransitions(graph, song, 0, 0);
  const events = buildEvents(song, only);
  for (let i = 0; i < events.length; i++) {
    try { schedule(events[i], Math.max(0, events[i].sec)); } catch { graph.cap.dropped++; }
    // yield every few hundred notes: scheduling thousands of nodes in one
    // go is what makes an export look like a freeze
    if (i > 0 && i % 250 === 0) {
      if (onProgress) onProgress(0.15 + (i / events.length) * 0.3);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  // Fade the master out over the last 140 ms: a file that ends on a non-zero
  // sample is the click you hear as a glitch at the end of the song.
  try {
    const g = graph.master.gain;
    const fadeAt = Math.max(0.05, Math.min(lengthSec - 0.02, song.durationSec - 0.14));
    g.setValueAtTime(g.value, fadeAt);
    g.linearRampToValueAtTime(0.0001, Math.min(lengthSec, fadeAt + 0.14));
    g.setValueAtTime(0, Math.max(0, Math.min(lengthSec - 0.0005, fadeAt + 0.145)));
  } catch { /* best effort */ }

  if (onProgress) onProgress(0.5);
  const buf = await ctx.startRendering();
  if (onProgress) onProgress(1);
  return buf;
}
