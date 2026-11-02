// Public audio API. The implementation lives in small modules:
//   worklets.js  — AudioWorklet loading and fallbacks
//   graph.js     — track chains, buses, master chain
//   scheduler.js — tempo map, events, automation, voice dispatch
//   player.js    — live transport
//   render.js    — offline rendering
// Import from here so callers do not need to know the layout.
export { prepareWorklets } from './worklets.js';
export { TRACK_NAMES, buildGraph, applyVariant, voiceCap } from './graph.js';
export { tempoMapOf, buildEvents, makeScheduler, applyAutomation } from './scheduler.js';
export { Player } from './player.js';
export { renderSong } from './render.js';
