// Everything that leaves the app: WAV, stems, MIDI, JSON, cover art, share
// links, the library and live recording.
import { state } from '../state.js';
import { renderSong, tempoMapOf } from '../audio/engine.js';
import { analyseBuffer, normalisationGain, encodeWav, download } from '../export/wav.js';
import { songToMidi } from '../export/midi.js';
import { zipStore } from '../export/zip.js';
import { drawArtwork, shareUrl, encodeState, decodeState } from '../export/artwork.js';
import { extractTheme } from '../import/midi.js';
import { libraryList, librarySave, libraryDelete } from '../state.js';
import { els, app, toast, notice, fail } from './ctx.js';
import { renderMeta, renderSections, renderSummary, pushHistory, snapshot } from './generate.js';
import { ensurePlayer } from './transport.js';
import { drawViz } from './visuals.js';
import { syncControls } from './dials.js';

// ------------------------------------------------------------- export
export function stemTracks(song) {
  return ['drums', 'bass', 'chords', 'lead', 'pad', 'arp'].filter((t) => (song.tracks[t] || []).length > 0);
}

export function targetLufs() {
  const v = els.exporttarget?.value ?? 'style';
  if (v === 'raw') return null;
  if (v === 'style') return state.song?.lufs ?? -14;
  return Number(v);
}

export async function exportWav() {
  if (!state.song) return;
  toast('Rendering audio…');
  try {
    const buf = await renderSong(state.song, { sampleRate: 44100 });
    const target = targetLufs();
    const gain = target == null ? 1 : normalisationGain(buf, target, -1);
    const info = analyseBuffer(buf);
    app.lastLufs = info.lufs + 20 * Math.log10(gain || 1);
    const bytes = encodeWav(buf, { bitDepth: 16, gain });
    download(new Blob([bytes], { type: 'audio/wav' }), `${slug(state.song.title)}.wav`);
    toast(target == null
      ? `WAV ready · ${info.lufs.toFixed(1)} LUFS (unnormalised)`
      : `WAV ready · ${app.lastLufs.toFixed(1)} LUFS → target ${target}`);
    renderSummary();
  } catch (err) {
    fail('WAV export', err);
  }
}

export async function exportStems() {
  if (!state.song) return;
  const song = state.song;
  const tracks = stemTracks(song);
  if (!tracks.length) { toast('Nothing to stem'); return; }
  try {
    toast('Measuring mix…');
    const mix = await renderSong(song, { sampleRate: 44100 });
    const target = targetLufs();
    const gain = target == null ? 1 : normalisationGain(mix, target, -1);
    const files = [];
    const levels = [];
    for (let i = 0; i < tracks.length; i++) {
      toast(`Rendering stem ${i + 1}/${tracks.length} — ${tracks[i]}`);
      const buf = await renderSong(song, { sampleRate: 44100, only: [tracks[i]] });
      const info = analyseBuffer(buf);
      levels.push(`${tracks[i]}: ${(info.lufs + 20 * Math.log10(gain || 1)).toFixed(1)} LUFS`);
      files.push({ name: `${slug(song.title)}-${tracks[i]}.wav`, data: encodeWav(buf, { bitDepth: 16, gain }) });
    }
    files.push({
      name: 'README.txt',
      data: new TextEncoder().encode(
        `Stems for "${song.title}"\nSeed: ${song.seed}\nKey: ${song.key.name}\nTempo: ${song.bpm} BPM\n`
        + `Style: ${song.style} · Mood: ${song.mood} · Tech: ${song.tech}\n`
        + `All stems share one gain (measured on the full mix), so they sum to the exported mix.\n\n`
        + `Per-stem loudness at that gain:\n${levels.map((l) => `  ${l}`).join('\n')}\n`,
      ),
    });
    const zip = zipStore(files);
    download(new Blob([zip], { type: 'application/zip' }), `${slug(song.title)}-stems.zip`);
    toast(`${tracks.length} stems exported`);
  } catch (err) {
    fail('Stem export', err);
  }
}

export function exportMidi() {
  if (!state.song) return;
  try {
    const bytes = songToMidi(state.song);
    download(new Blob([bytes], { type: 'audio/midi' }), `${slug(state.song.title)}.mid`);
    toast('MIDI exported');
  } catch (err) { fail('MIDI export', err); }
}

export function exportJson() {
  if (!state.song) return;
  const blob = new Blob([JSON.stringify(state.song, null, 2)], { type: 'application/json' });
  download(blob, `${slug(state.song.title)}.musicgen.json`);
  toast('Song JSON exported');
}

export function importJson() {
  els.fileinput.value = '';
  els.fileinput.click();
}

export function applySong(song) {
  if (!song || !song.tracks || !song.presets || !song.seed) throw new Error('not a song file');
  state.song = song;
  state.presets = normalisePresets(song.presets);
  state.seed = song.seed;
  syncControls();
  renderMeta();
  renderSections();
  renderSummary();
  drawViz(0);
  checkVersion(song.composerVersion, 'song file');
  toast(`Imported “${song.title}”`);
}

export async function onMidiPicked() {
  const file = els.midiinput.files?.[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { notes, beats, trackName } = extractTheme(bytes, { maxBeats: state.presets.timeSig[0] * 2 });
    if (!notes.length) throw new Error('no notes found');
    pushHistory();
    setPresets({ themeSeed: notes });
    generate();
    notice(`Theme imported from “${file.name}”${trackName ? ` (${trackName})` : ''} — ${notes.length} notes over ${beats} beats. Every section now derives from it.`);
    toast('Theme imported');
  } catch (err) {
    fail('MIDI import', err);
    toast('That MIDI file did not contain a melody I could read');
  }
}

export async function onFilePicked() {
  const file = els.fileinput.files?.[0];
  if (!file) return;
  try {
    applySong(JSON.parse(await file.text()));
  } catch (err) {
    fail('Import', err);
    toast('That file is not a MusicGen song');
  }
}

export function exportArt() {
  if (!state.song) return;
  try {
    const canvas = document.createElement('canvas');
    drawArtwork(canvas, state.song, 1024);
    canvas.toBlob((blob) => {
      download(blob, `${slug(state.song.title)}-cover.png`);
      toast('Cover art exported');
    }, 'image/png');
  } catch (err) { fail('Cover art', err); }
}

export async function doShare() {
  const url = shareUrl(state.presets, state.seed);
  const text = `${state.song?.title ?? 'A song'} — made with MusicGen`;
  try {
    if (navigator.share) {
      const payload = { title: 'MusicGen', text, url };
      if (state.song && navigator.canShare) {
        const canvas = document.createElement('canvas');
        drawArtwork(canvas, state.song, 512);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (blob) {
          const file = new File([blob], `${slug(state.song.title)}.png`, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) payload.files = [file];
        }
      }
      await navigator.share(payload);
      return;
    }
    await navigator.clipboard.writeText(url);
    toast('Share link copied');
  } catch {
    app.history.replaceState(null, '', `#s=${encodeState(state.presets, state.seed)}`);
    toast('Link is in the address bar');
  }
}

export async function doSave() {
  if (!state.song) return;
  try {
    await librarySave(state.song);
    toast(`Saved “${state.song.title}”`);
  } catch (err) {
    fail('Save', err);
    toast('Could not save — storage may be full');
  }
}

export async function exportLibrary() {
  try {
    const items = await libraryList();
    if (!items.length) { toast('Library is empty'); return; }
    const files = items.map((it) => ({
      name: `${slug(it.title)}-${it.id.slice(0, 8)}.musicgen.json`,
      data: new TextEncoder().encode(JSON.stringify(it.song || { presets: it.presets, seed: it.seed, title: it.title }, null, 2)),
    }));
    files.push({
      name: 'library.txt',
      data: new TextEncoder().encode(items.map((it) => `${it.title}\t${it.style}\t${it.mood}\t${it.bpm}\t${it.seed}`).join('\n')),
    });
    download(new Blob([zipStore(files)], { type: 'application/zip' }), 'musicgen-library.zip');
    toast(`${items.length} songs exported`);
  } catch (err) {
    fail('Library export', err);
  }
}

export async function openLibrary() {
  const render = async (query = '') => {
    els.libraryList.innerHTML = '';
    try {
      const items = await libraryList();
      const q = query.trim().toLowerCase();
      const filtered = q
        ? items.filter((it) => `${it.title} ${it.style} ${it.mood} ${(it.tags || []).join(' ')}`.toLowerCase().includes(q))
        : items;
      if (!filtered.length) els.libraryList.textContent = items.length ? 'No matches.' : 'Nothing saved yet.';
      for (const it of filtered) {
        const row = document.createElement('div');
        row.className = 'lib-item';
        const label = document.createElement('div');
        label.innerHTML = `<strong>${escapeHtml(it.title)}</strong><br><small>${escapeHtml(it.style)} · ${escapeHtml(it.mood)} · ${it.bpm} BPM</small>`;
        const load = document.createElement('button');
        load.textContent = 'Load';
        load.addEventListener('click', () => {
          pushHistory();
          state.previous = { presets: snapshot(), seed: state.seed };
          state.presets = normalisePresets({ ...state.presets, ...it.presets });
          state.seed = it.seed;
          syncControls();
          generate();
          checkVersion(it.composerVersion, 'saved song');
          els.library.close();
        });
        const rename = document.createElement('button');
        rename.textContent = 'Rename';
        rename.addEventListener('click', async () => {
          const name = prompt('New title', it.title);
          if (!name) return;
          await libraryRename(it.id, name);
          render(els.searchlib.value);
        });
        const dup = document.createElement('button');
        dup.textContent = 'Copy';
        dup.addEventListener('click', async () => {
          await libraryDuplicate(it.id);
          render(els.searchlib.value);
        });
        const del = document.createElement('button');
        del.textContent = '✕';
        del.setAttribute('aria-label', `Delete ${it.title}`);
        del.addEventListener('click', async () => {
          await libraryDelete(it.id);
          row.remove();
        });
        row.append(label, load, rename, dup, del);
        els.libraryList.appendChild(row);
      }
    } catch (err) {
      fail('Library', err);
      els.libraryList.textContent = 'Library unavailable.';
    }
  };
  els.searchlib.oninput = () => render(els.searchlib.value);
  await render('');
  els.library.showModal();
}

export function slug(s) {
  return (s || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song';
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------- settings
export function openSettings() {
  els.setTheme.value = state.ui.theme || 'system';
  els.setVolume.value = String(Math.round((state.ui.volume ?? 0.9) * 100));
  els.setVolumeOut.textContent = els.setVolume.value;
  els.setTarget.value = els.exporttarget?.value ?? 'style';
  els.settingsDialog.showModal();
}

// ------------------------------------------------------------- recording
let recorder = null;
let recordChunks = [];

export async function toggleRecord() {
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  try {
    ensurePlayer();
    if (app.player.ctx.state === 'suspended') await app.player.ctx.resume();
    const dest = app.player.ctx.createMediaStreamDestination();
    app.player.graph.chain.output.connect(dest);
    const stream = dest.stream;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recordChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) recordChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recordChunks, { type: recorder.mimeType || 'audio/webm' });
      download(blob, `${slug(state.song?.title || 'take')}.webm`);
      toast('Recording saved');
      try { app.player.graph.chain.output.disconnect(dest); } catch { /* noop */ }
    };
    recorder.start();
    if (!app.player.playing) await play();
    toast('Recording — press Record again to stop');
  } catch (err) {
    fail('Recording', err);
  }
}
