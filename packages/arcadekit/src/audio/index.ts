// Sound for a game: the audio system apps and sound views call, its mixer, the Effect
// service, a genre's cue table, and the shape of the player's audio settings. Plain TypeScript
// with no DOM; the Web Audio backend is in ./browser.

export {
  type AnyCueTable,
  type CueSounds,
  type CueSoundsOf,
  CueTable,
  type CueTableClass,
  type CueTableDefinition,
  type CueTableId,
  type CueTableService,
  SoundId,
} from "./cue-table";
export { Audio, SilentAudioLayer, silentAudio } from "./service";
export {
  AudioSettings,
  applyAudioSettings,
  defaultAudioSettings,
} from "./settings";
export {
  type AudioBus,
  type AudioClip,
  type AudioGain,
  AudioLoadError,
  type AudioMixer,
  type AudioMixerOptions,
  type AudioOutput,
  type AudioSystem,
  type AudioVoice,
  makeAudioMixer,
  type SoundDef,
  type SoundList,
} from "./system";
