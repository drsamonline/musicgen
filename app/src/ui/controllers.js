// Controllers: a gamepad and a MIDI keyboard, so the studio can be played
// rather than clicked.
//
// Two rules shape this file. The mapping is data, and the reading of that data
// is a pure function — a gamepad is edge-triggered (a held button must fire
// once, not sixty times a second) and that is exactly the kind of thing that
// breaks silently. And nothing here talks to a device until the user asks:
// `navigator.requestMIDIAccess()` shows a permission prompt, so it happens on
// a button, never on boot.

// Standard gamepad layout. Anything past ten buttons is ignored rather than
// guessed at, because a wrong guess fires an action nobody asked for.
export const PAD_ACTIONS = {
  0: 'play',        // A / cross
  1: 'generate',    // B / circle
  2: 'random',      // X / square
  3: 'evolve',      // Y / triangle
  4: 'mutate',      // LB
  5: 'vizNext',     // RB
  6: 'volumeDown',  // LT
  7: 'volumeUp',    // RT
  8: 'loop',        // back / select
  9: 'ab',          // start
};

export const PAD_LABELS = {
  play: 'Play / pause', generate: 'Generate', random: 'Random', evolve: 'Evolve',
  mutate: 'Mutate', vizNext: 'Next view', volumeDown: 'Quieter', volumeUp: 'Louder',
  loop: 'Loop section', ab: 'A/B compare',
};

// Edge-triggered reading of one pad. Held buttons fire once; a pad that
// disappears (unplugged mid-song) does not fire a storm of releases.
export function makePadReader() {
  const held = new Map();
  return function read(pad) {
    const fired = [];
    if (!pad || !pad.buttons) return fired;
    const key = pad.index ?? 0;
    let down = held.get(key);
    if (!down) { down = new Set(); held.set(key, down); }
    pad.buttons.forEach((b, i) => {
      // A trigger reports pressed:false with a high analog value — the browser
      // only flips `pressed` past its own threshold — so either signal counts.
      const pressed = !!(b.pressed || (b.value ?? 0) > 0.5);
      const was = down.has(i);
      if (pressed && !was) {
        down.add(i);
        const action = PAD_ACTIONS[i];
        if (action) fired.push(action);
      } else if (!pressed && was) {
        down.delete(i);
      }
    });
    return fired;
  };
}

// A MIDI message, decoded. Channel is deliberately ignored: a keyboard sends on
// whatever channel it likes and the user should not have to care.
export function midiMessageToAction(data) {
  if (!data || data.length < 2) return null;
  const status = data[0];
  const cmd = status & 0xf0;
  const d1 = data[1];
  const d2 = data.length > 2 ? data[2] : 0;
  if (cmd === 0x90 && d2 > 0) return { type: 'noteon', note: d1, velocity: d2 / 127 };
  if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) return { type: 'noteoff', note: d1 };
  if (cmd === 0xb0 && d1 === 7) return { type: 'volume', value: d2 / 127 };
  if (cmd === 0xb0 && d1 === 1) return { type: 'mod', value: d2 / 127 };
  return null;
}

// ---------------------------------------------------------------- runtime
// Everything below touches a browser API, and is wired by main.js so the
// mapping above can be tested on its own.
let padTimer = null;
let midiAccess = null;

export function listPads() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  try {
    return [...navigator.getGamepads()].filter(Boolean);
  } catch {
    return [];
  }
}

export function startGamepads(run, { onChange = null } = {}) {
  if (padTimer || typeof navigator === 'undefined' || !navigator.getGamepads) return false;
  const read = makePadReader();
  let seen = 0;
  padTimer = setInterval(() => {
    const pads = listPads();
    if (pads.length !== seen) {
      seen = pads.length;
      if (onChange) onChange(pads);
    }
    for (const pad of pads) {
      for (const action of read(pad)) {
        try { run(action); } catch { /* an action that fails must not kill the loop */ }
      }
    }
  }, 60);
  return true;
}

export function stopGamepads() {
  if (padTimer) { clearInterval(padTimer); padTimer = null; }
}

// MIDI. `navigator.requestMIDIAccess` is behind a permission prompt, so this
// is only ever called from a click.
export async function connectMidi(handle, { onChange = null } = {}) {
  if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
    throw new Error('This browser has no Web MIDI support');
  }
  const access = await navigator.requestMIDIAccess({ sysex: false });
  midiAccess = access;
  const attach = () => {
    for (const input of access.inputs.values()) {
      input.onmidimessage = (ev) => {
        const action = midiMessageToAction(ev.data);
        if (action) handle(action);
      };
    }
    if (onChange) onChange(listMidiInputs());
  };
  attach();
  access.onstatechange = attach;
  return listMidiInputs();
}

export function listMidiInputs() {
  if (!midiAccess) return [];
  try {
    return [...midiAccess.inputs.values()].map((i) => ({
      id: i.id, name: i.name || 'MIDI input', manufacturer: i.manufacturer || '', state: i.state,
    }));
  } catch {
    return [];
  }
}

export function midiConnected() {
  return !!midiAccess;
}
