// Scheduling: tempo map, the event list, automation envelopes and the
// per-event voice dispatch (native or worklet).
import { synthVoice, isOffline } from './instruments.js';
import { drumVoice } from './drums.js';
import { freqOf, pc } from '../core/theory.js';
import { TECHS } from '../presets/techs.js';
import { makeTempoMap, DEFAULT_DRIFT } from '../core/tempo.js';
import { TRACK_NAMES, applyVariant } from './graph.js';

// ---------------------------------------------------------------- scheduling
// The song's tempo map, rebuilt from its segments (the song JSON stores data,
// not closures).
export function tempoMapOf(song) {
  if (song.tempo?.segments?.length) {
    return makeTempoMap(song.tempo.segments, {
      base: song.tempo.base ?? song.bpm,
      drift: song.tempo.drift ?? DEFAULT_DRIFT,
    });
  }
  return makeTempoMap([{ beat: 0, bpm: song.bpm || 100 }], { base: song.bpm || 100, drift: 0 });
}

export function buildEvents(song, only = null) {
  const map = tempoMapOf(song);
  const events = [];
  const list = only ? TRACK_NAMES.filter((t) => only.includes(t)) : TRACK_NAMES;
  for (const track of list) {
    for (const n of song.tracks[track] || []) events.push({ sec: map.secondsAt(n.t), beat: n.t, track, n });
  }
  events.sort((a, b) => a.sec - b.sec || a.track.localeCompare(b.track));
  return events;
}

// Sections are contiguous, so a binary search over precomputed start beats
// beats scanning the list for every note.
function sectionIntensity(song) {
  const spans = song.sections.map((s) => ({
    start: s.bar * song.beatsPerBar,
    end: (s.bar + s.bars) * song.beatsPerBar,
    intensity: s.intensity ?? 0.6,
  }));
  return (beat) => {
    let lo = 0, hi = spans.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (beat < spans[mid].start) hi = mid - 1;
      else if (beat >= spans[mid].end) lo = mid + 1;
      else { found = mid; break; }
    }
    return found >= 0 ? spans[found].intensity : 0.6;
  };
}

function pruneVoices(cap, now) {
  const a = cap.active;
  if (!a.length) return;
  let w = 0;
  for (let i = 0; i < a.length; i++) if (a[i].end > now) a[w++] = a[i];
  a.length = w;
}

function stealQuietest(cap, now, at = now) {
  const a = cap.active;
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i].vel < best) { best = a[i].vel; idx = i; }
  }
  const victim = a[idx];
  if (victim?.out?.gain) {
    try {
      victim.out.gain.cancelScheduledValues(at);
      victim.out.gain.setTargetAtTime(0.0001, at, 0.01);
    } catch { /* noop */ }
  }
  a.splice(idx, 1);
  cap.stolen++;
}

const BED_SPEC = {
  engine: 'noise', attack: 1.4, decay: 2, sustain: 0.8, release: 2.4,
  cutoff: 900, q: 1.2, gain: 0.16,
};

// Automation envelopes drawn from the tension curve: each section opens the
// track tone filter and the reverb send as it gets more intense.
export function applyAutomation(graph, song, t0 = 0, fromSec = 0) {
  const map = tempoMapOf(song);
  const ctx = graph.ctx;
  for (const name of TRACK_NAMES) {
    const t = graph.tracks[name];
    if (!t?.tone) continue;
    for (const sec of song.sections) {
      const start = t0 + map.secondsAt(sec.bar * song.beatsPerBar) - fromSec;
      const end = t0 + map.secondsAt((sec.bar + sec.bars) * song.beatsPerBar) - fromSec;
      if (end < ctx.currentTime) continue;
      const at = Math.max(start, ctx.currentTime);
      const cutoff = 900 + sec.intensity * 13000;
      try {
        t.tone.frequency.setValueAtTime(Math.max(200, cutoff * 0.8), at);
        t.tone.frequency.linearRampToValueAtTime(Math.min(18000, cutoff), Math.max(at + 0.05, end));
      } catch { /* noop */ }
    }
  }
}

export function makeScheduler(graph, song) {
  const map = tempoMapOf(song);
  const durOf = (n) => Math.max(0.03, map.secondsAt(n.t + n.d) - map.secondsAt(n.t));
  const intensityAt = sectionIntensity(song);
  const tech = graph.tech;
  const offline = isOffline(graph.ctx);

  const variant = song.variant ?? 0;

  // microtuning: a cents offset per pitch class, if the song carries one
  const tuneFreq = (p) => {
    const cents = song.tuning?.cents?.[pc(p)] ?? 0;
    return freqOf(p) * Math.pow(2, cents / 1200);
  };

  return function scheduleEvent(ev, when) {
    const { track, n } = ev;
    const brightness = 0.55 + intensityAt(n.t) * 0.7;

    // worklet voices take whole notes as messages
    const wnode = graph.tracks[track]?.worklet;
    if (wnode) {
      const spec = track === 'bed' ? BED_SPEC : (tech.instruments[track] || tech.instruments.chords);
      try {
        wnode.node.port.postMessage({
          type: 'note', when, dur: Math.max(0.05, durOf(n)),
          freq: tuneFreq(n.p),
          vel: n.v * (wnode.engine === 'waveguide' ? 3.4 : 1.1),
          damping: spec.damping ?? 0.6, brightness,
        });
        graph.cap.active.push({ end: when + durOf(n) + 0.6, out: null, vel: n.v });
        return;
      } catch { /* fall through to native synthesis */ }
    }

    if (track === 'drums') {
      drumVoice(graph.ctx, graph.tracks.drums.input, {
        when, kind: n.drum, vel: n.v, engine: tech.drums?.engine || 'analog',
        metallic: (song.metallicHats ?? false) || tech.drums?.engine === 'chiptune',
      });
      if (n.drum === 'kick' && song.sidechain) {
        const g = graph.sidechain.gain;
        try {
          g.setValueAtTime(1, when);
          g.linearRampToValueAtTime(0.55, when + 0.008);
          g.linearRampToValueAtTime(1, when + Math.min(0.3, 0.16 + 30 / (song.bpm || 100)));
        } catch { /* noop */ }
      }
      return;
    }

    const base = track === 'bed' ? BED_SPEC : (tech.instruments[track] || tech.instruments.chords);
    const spec = track === 'bed' ? base : applyVariant(base, variant);

    // Voice pool: prune what has finished, then steal the quietest voice
    // rather than silently dropping the new note. Dropping is what made
    // dense passages lose their melody. In an offline render "now" is the
    // event's own time — the whole song is scheduled in one pass.
    const now = offline ? when : graph.ctx.currentTime;
    pruneVoices(graph.cap, now);
    if (graph.cap.active.length >= graph.cap.max) stealQuietest(graph.cap, now, when);

    // legato: a note that follows closely on a mono-ish track slides into it
    let glideFrom = null;
    if (track === 'bass' || track === 'lead') {
      const prev = graph.lastNote[track];
      const endSec = map.secondsAt(n.t);
      if (prev && endSec - prev.end < 0.09 && Math.abs(n.p - prev.p) <= 7 && n.p !== prev.p) {
        glideFrom = tuneFreq(prev.p);
      }
      graph.lastNote[track] = { p: n.p, end: endSec + durOf(n) };
    }

    const voice = synthVoice(graph.ctx, graph.tracks[track].input, {
      when,
      dur: durOf(n),
      freq: tuneFreq(n.p),
      vel: n.v,
      spec,
      brightness,
      glideFrom,
    });
    if (voice) graph.cap.active.push({ end: voice.end, out: voice.out, vel: n.v });
  };
}
