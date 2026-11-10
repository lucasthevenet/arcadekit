// Survivors-like genre: what an app uses from the DOM-free side. The content, the simulation
// with the World it runs, its config and step input, the events it reports, the commands it takes
// with their rejections, the lockstep hash and the Co-op rules. Rules internals (heroes, weapons,
// the content sub-schemas) stay in their modules.
// No DOM or Three.js here; those are in "@arcadekit/survivors/browser".

export {
  ChooseUpgrade,
  HoldPause,
  NoSuchChoice,
  NotPlaying,
  OfferClosed,
} from "./commands";
export { SurvivorsContent } from "./content";
export {
  type SurvivorsCoop,
  type SurvivorsCoopEvent,
  survivorsCoopRules,
} from "./coop";
export {
  HeroLeft,
  Hud,
  LeveledUp,
  RunEnded,
  RunSummary,
  UpgradeChoice,
} from "./events";
export { hashWorld } from "./hash-world";
export { HeroInput, SurvivorsInput } from "./input";
export { GameContent } from "./schema";
// The genre's rules, for headless or replay use: a `Game.Loop` or a scenario steps them.
export { Survivors } from "./simulation";
export type { SurvivorsConfig, World } from "./world";
