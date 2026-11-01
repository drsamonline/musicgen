// App state + persistence (localStorage for prefs, IndexedDB for the library).
import { DEFAULT_PRESETS, normalisePresets } from './core/composer.js';
import { randomSeed } from './core/rng.js';

const KEY = 'musicgen.v1';

export const state = {
  presets: { ...DEFAULT_PRESETS },
  locks: { style: false, mood: false, theme: false, tech: false, type: false, bpm: false },
  seed: randomSeed(12),
  song: null,
  ui: { volume: 0.9, vizMode: 'roll', advanced: false, theme: 'system', muted: false, position: 0 },
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(reason = 'change') {
  for (const fn of listeners) {
    try { fn(state, reason); } catch (err) { console.error(err); }
  }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return state;
    const saved = JSON.parse(raw);
    if (saved.presets) state.presets = normalisePresets({ ...DEFAULT_PRESETS, ...saved.presets });
    if (saved.locks) state.locks = { ...state.locks, ...saved.locks };
    if (saved.seed) state.seed = String(saved.seed);
    if (saved.ui) state.ui = { ...state.ui, ...saved.ui };
  } catch { /* corrupt prefs are not fatal */ }
  return state;
}

let saveTimer = null;
export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        presets: state.presets, locks: state.locks, seed: state.seed, ui: state.ui,
      }));
    } catch { /* quota or private mode */ }
  }, 250);
}

export function setPresets(patch, reason = 'presets') {
  state.presets = normalisePresets({ ...state.presets, ...patch });
  persist();
  emit(reason);
}

export function toggleLock(axis) {
  state.locks[axis] = !state.locks[axis];
  persist();
  emit('locks');
}

// ------------------------------------------------------------ library (IDB)
const DB_NAME = 'musicgen';
const STORE = 'songs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function librarySave(song) {
  const db = await openDb();
  const id = `${song.seed}-${song.presets.style}-${song.presets.mood}`;
  const entry = {
    id, title: song.title, seed: song.seed, presets: song.presets,
    style: song.presets.style, mood: song.presets.mood, bpm: song.bpm,
    key: song.key.name, createdAt: new Date().toISOString(),
    // the whole song, so a saved entry is a file you can diff and re-import
    song,
  };
  try {
    return await put(db, entry);
  } catch (err) {
    // quota: fall back to the recipe (presets + seed reproduce the same song)
    return put(db, { ...entry, song: { ...song, tracks: undefined }, notes: 'recipe only' });
  }
}

function put(db, entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve(entry.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function libraryRename(id, title) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const entry = req.result;
      if (entry) store.put({ ...entry, title });
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function libraryDuplicate(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const entry = req.result;
      if (entry) {
        store.put({
          ...entry,
          id: `${entry.id}-copy-${Date.now()}`,
          title: `${entry.title} (copy)`,
          createdAt: new Date().toISOString(),
        });
      }
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function libraryList() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
    req.onerror = () => reject(req.error);
  });
}

export async function libraryDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
