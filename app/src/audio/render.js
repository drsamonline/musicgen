// Offline rendering: the same graph and scheduler as live playback, so what
// you export is what you heard.
import { buildGraph } from './graph.js';
import { buildEvents, makeScheduler, applyAutomation } from './scheduler.js';
import { prepareWorklets } from './worklets.js';

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
  if (onProgress) onProgress(0.5);
  const buf = await ctx.startRendering();
  if (onProgress) onProgress(1);
  return buf;
}
