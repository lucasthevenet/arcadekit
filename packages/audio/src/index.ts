// Sound for a game: the audio system apps and sound views call, its mixer, the Effect
// service, and the player's audio settings. Plain TypeScript with no DOM; the Web Audio
// backend is in ./browser.

export { Audio, SilentAudioLayer, silentAudio } from "./service";
export {
  AudioSettings,
  type AudioSettingsStore,
  applyAudioSettings,
  defaultAudioSettings,
  makeAudioSettingsStore,
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
