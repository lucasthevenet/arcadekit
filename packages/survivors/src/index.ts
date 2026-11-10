// Survivors-like genre: what an app uses from the DOM-free side. The content, the simulation
// with the World it runs, its config and step input, the events it reports, the command it takes
// with its rejections, the lockstep hash and the Co-op rules. Rules internals (heroes, weapons,
// the content sub-schemas) stay in their modules.
// No DOM or Three.js here; those are in "@arcadekit/survivors/browser".

export { ChooseUpgrade, NoSuchChoice, OfferClosed } from "./commands";
export { SurvivorsContent } from "./content";
export {
  type SurvivorsCoop,
  type SurvivorsCoopEvent,
  survivorsCoopRules,
} from "./coop";
export {
  HeroLeft,
  Hud,
  HudSample,
  LeveledUp,
  RunEnded,
  RunSummary,
  type SurvivorsEvent,
  UpgradeChoice,
} from "./events";
export { hashWorld } from "./hash-world";
export { HeroInput, SurvivorsInput, UpgradePick } from "./input";
export { GameContent } from "./schema";
// The genre's rules, for headless or replay use: a `Game.Loop` or a scenario steps `Survivors`.
// `survivorsSimulation` is the same rules for the hosts still on the older contract.
export { Survivors, survivorsSimulation } from "./simulation";
export {
  type SurvivorsConfig,
  type World,
  chooseUpgrade,
  isChoosing,
} from "./world";
