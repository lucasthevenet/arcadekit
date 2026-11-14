// arcadekit/audio: sound for a game. `CueTable` is a builder a game writes bare, with its types;
// what a game plays through is the namespace `AudioSystem`, whose key is the service an app
// provides, and the mixer behind the browser's is `AudioMixer`. Plain where a sound view calls it,
// inside its frame (ADR-0024); its loads and its lifecycle are Effect. DOM-free: the Web Audio
// backend is in ./browser.

export * as AudioMixer from "./audio-mixer";
export * as AudioSettings from "./audio-settings";
export * as AudioSystem from "./audio-system";
export {
  type AnyCueTable,
  type CueSounds,
  type CueSoundsOf,
  CueTable,
  type CueTableClass,
  type CueTableDefinition,
  type CueTableId,
  type CueTableService,
} from "./cue-table";
