// Themes: FX bias, texture density, title words, artwork palette.
export const THEMES = {
  // No theme: no ambience, no palette bias, plain titles.
  none: {
    id: 'none', name: 'None (plain)',
    fxBias: { reverb: 0, delay: 0, chorus: 0 },
    textureDensity: 0, brightness: 0.5,
    palette: ['#0b0e17', '#1b2440', '#7f9bff', '#e8ecf7'],
    words: ['Untitled', 'Sketch', 'Study', 'Take', 'Draft'],
  },
  space: {
    id: 'space', name: 'Space',
    fxBias: { reverb: 0.25, delay: 0.15, chorus: 0.2 },
    textureDensity: 0.4, brightness: 0.55,
    palette: ['#0b1026', '#1b2a5e', '#5f7bd9', '#c9d6ff'],
    words: ['Drift', 'Orbit', 'Nebula', 'Void', 'Aphelion', 'Signal', 'Gravity', 'Pale Blue'],
  },
  ocean: {
    id: 'ocean', name: 'Ocean',
    fxBias: { reverb: 0.2, delay: 0.1, chorus: 0.15 },
    textureDensity: 0.5, brightness: 0.5,
    palette: ['#04222e', '#0b5c6b', '#2fa3a8', '#d5f4f2'],
    words: ['Tide', 'Undertow', 'Salt', 'Deep', 'Current', 'Foam', 'Harbour', 'Blue Hour'],
  },
  rain: {
    id: 'rain', name: 'Rain',
    fxBias: { reverb: 0.3, delay: 0.18, chorus: 0.1 },
    textureDensity: 0.55, brightness: 0.4,
    palette: ['#141a1f', '#2a3a44', '#4f6f7f', '#c3d4da'],
    words: ['Neon Rain', 'Downpour', 'Gutter', 'Window', 'Static', 'Puddle', 'Late Bus', 'Wet Asphalt'],
  },
  cyberpunk: {
    id: 'cyberpunk', name: 'Cyberpunk',
    fxBias: { reverb: 0.15, delay: 0.3, chorus: 0.05 },
    textureDensity: 0.7, brightness: 0.85,
    palette: ['#10001c', '#4b0b6b', '#e5007d', '#00e5ff'],
    words: ['Chrome', 'Grid', 'Blackout', 'Kill Switch', 'Night Market', 'Augment', 'Nerve', 'Sector 9'],
  },
  medieval: {
    id: 'medieval', name: 'Medieval',
    fxBias: { reverb: 0.35, delay: 0.05, chorus: 0.0 },
    textureDensity: 0.3, brightness: 0.45,
    palette: ['#1d1710', '#3f3324', '#8a7148', '#e6dcc3'],
    words: ['Keep', 'Vellum', 'Hearth', 'Wander', 'Banner', 'Bell Tower', 'Frost Fair', 'Old Road'],
  },
  forest: {
    id: 'forest', name: 'Forest',
    fxBias: { reverb: 0.3, delay: 0.12, chorus: 0.1 },
    textureDensity: 0.45, brightness: 0.45,
    palette: ['#0d1a12', '#1f3b26', '#4f7f4a', '#d8e8c8'],
    words: ['Canopy', 'Moss', 'Fern', 'Clearing', 'Lantern', 'Understory', 'Pine', 'Slow Creek'],
  },
  nightdrive: {
    id: 'nightdrive', name: 'Night Drive',
    fxBias: { reverb: 0.2, delay: 0.25, chorus: 0.12 },
    textureDensity: 0.6, brightness: 0.6,
    palette: ['#08080f', '#1d1d33', '#5a4bd6', '#ff5f8f'],
    words: ['Motorway', 'Headlight', 'Third Gear', 'Tunnel', 'Empty Lane', 'Dash Glow', 'Toll Road', '4 a.m.'],
  },
  festival: {
    id: 'festival', name: 'Festival',
    fxBias: { reverb: 0.15, delay: 0.2, chorus: 0.05 },
    textureDensity: 0.8, brightness: 0.9,
    palette: ['#1a0010', '#7a1030', '#ff6b1a', '#ffe66d'],
    words: ['Mainstage', 'Sunrise Set', 'Hands Up', 'Confetti', 'Encore', 'Front Row', 'Firework', 'All Night'],
  },
  desert: {
    id: 'desert', name: 'Desert',
    fxBias: { reverb: 0.4, delay: 0.2, chorus: 0.05 },
    textureDensity: 0.35, brightness: 0.55,
    palette: ['#2a1a0d', '#6b4520', '#c98a3d', '#f6e3c0'],
    words: ['Dune', 'Mirage', 'Caravan', 'Dry Wind', 'Sandglass', 'Oasis', 'Long Shadow', 'Kiln'],
  },
  winter: {
    id: 'winter', name: 'Winter',
    fxBias: { reverb: 0.35, delay: 0.12, chorus: 0.1 },
    textureDensity: 0.35, brightness: 0.6,
    palette: ['#0e1a24', '#274155', '#7fa8c4', '#eaf4fb'],
    words: ['Frost', 'Glass Lake', 'Sleet', 'Hollow', 'Cold Iron', 'Snowline', 'Static Snow', 'Thaw'],
  },
};

export const THEME_IDS = Object.keys(THEMES);
