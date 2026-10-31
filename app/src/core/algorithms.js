// Small, pure, testable generative algorithms. No side effects, no DOM.

// ---- Euclidean rhythms -------------------------------------------------
// distributes `pulses` as evenly as possible over `steps`.
export function euclid(pulses, steps, rotation = 0) {
  if (steps <= 0) return [];
  const p = Math.max(0, Math.min(steps, Math.round(pulses)));
  // canonical Euclidean distribution, pulse on step 0
  const pattern = [];
  for (let i = 0; i < steps; i++) {
    pattern.push((i * p) % steps < p ? 1 : 0);
  }
  if (!rotation) return pattern;
  const r = ((rotation % steps) + steps) % steps;
  return pattern.slice(r).concat(pattern.slice(0, r));
}

export function euclidRotations(pulses, steps) {
  const out = [];
  for (let r = 0; r < steps; r++) out.push(euclid(pulses, steps, r));
  return out;
}

// ---- Markov chains -----------------------------------------------------
// Builds a 2nd-order chain from sequences, falls back to 1st order.
export function buildMarkov(sequences, order = 2) {
  const table = new Map();
  for (const seq of sequences) {
    for (let i = 0; i < seq.length; i++) {
      for (let o = 1; o <= order; o++) {
        if (i - o < 0) continue;
        const key = seq.slice(i - o, i).join('|');
        if (!table.has(key)) table.set(key, new Map());
        const row = table.get(key);
        const nxt = seq[i];
        row.set(nxt, (row.get(nxt) || 0) + 1);
      }
    }
  }
  return table;
}

export function markovNext(table, history, rng, fallback = null) {
  for (let o = Math.min(2, history.length); o >= 1; o--) {
    const key = history.slice(history.length - o).join('|');
    const row = table.get(key);
    if (row && row.size) {
      const items = [...row.keys()];
      const weights = items.map((k) => row.get(k));
      return rng.weighted(items, weights);
    }
  }
  return fallback;
}

// ---- L-systems ---------------------------------------------------------
export function lsystem(axiom, rules, iterations) {
  let s = axiom;
  for (let i = 0; i < iterations; i++) {
    let next = '';
    for (const ch of s) next += rules[ch] ?? ch;
    s = next;
  }
  return s;
}

// L-system string -> boolean 16-step grid (X = hit)
export function lsystemGrid(axiom, rules, iterations, steps = 16) {
  const s = lsystem(axiom, rules, iterations);
  const grid = new Array(steps).fill(0);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === 'X' || s[i] === 'x') grid[i % steps] = 1;
  }
  return grid;
}

// ---- Cellular automata -------------------------------------------------
export function wolfram(rule, steps = 16, seedRow = null, rng = null) {
  const rows = [];
  let row = seedRow
    ? seedRow.slice()
    : Array.from({ length: steps }, (_, i) => (rng ? (rng.float() < 0.5 ? 1 : 0) : i === (steps >> 1) ? 1 : 0));
  rows.push(row);
  for (let r = 1; r < steps; r++) {
    const next = new Array(steps).fill(0);
    for (let i = 0; i < steps; i++) {
      const l = row[(i - 1 + steps) % steps];
      const c = row[i];
      const rt = row[(i + 1) % steps];
      const idx = (l << 2) | (c << 1) | rt;
      next[i] = (rule >> idx) & 1;
    }
    rows.push(next);
    row = next;
  }
  return rows;
}

// ---- Rhythm trees ------------------------------------------------------
// Recursive subdivision -> onsets in beats.
export function rhythmTree(rng, bars = 1, beatsPerBar = 4, depth = 3, density = 0.6) {
  const out = [];
  const span = bars * beatsPerBar;
  function split(start, len, d) {
    if (d <= 0 || len < 0.25) {
      if (rng.chance(density)) out.push({ t: start, d: len });
      return;
    }
    const r = rng.float();
    if (r < 0.45) { split(start, len / 2, d - 1); split(start + len / 2, len / 2, d - 1); }
    else if (r < 0.7) { split(start, len / 2, d - 1); }
    else if (r < 0.85) { split(start + len / 2, len / 2, d - 1); }
    else { if (rng.chance(density)) out.push({ t: start, d: len }); }
  }
  split(0, span, depth);
  return out.sort((a, b) => a.t - b.t);
}

// ---- Weighted choice with "no repeat within N" -------------------------
export function weightedNoRepeat(items, weights, history, rng, window = 2) {
  const recent = history.slice(-window);
  const w = items.map((it, i) => (recent.includes(it) ? Math.max(0, weights[i]) * 0.15 : Math.max(0, weights[i])));
  return rng.weighted(items, w);
}

// ---- Grid helpers ------------------------------------------------------
export function gridToOnsets(grid, stepBeats, velocity = 1) {
  const out = [];
  grid.forEach((v, i) => { if (v) out.push({ t: i * stepBeats, d: stepBeats, v: velocity }); });
  return out;
}

export function rotate(grid, n) {
  const k = ((n % grid.length) + grid.length) % grid.length;
  return grid.slice(k).concat(grid.slice(0, k));
}

export function densityOf(grid) {
  return grid.reduce((a, b) => a + (b ? 1 : 0), 0) / grid.length;
}
