// Survivors-like genre: what an app uses from the DOM-free side. The content definition and
// service, the GameSimulation and the World it runs, the step input, the event payloads and the
// lockstep hash. Rules internals (heroes, weapons, the content sub-schemas) stay in their modules.
// No DOM or Three.js here; those are in "@arcadekit/survivors/browser".

export {
  SurvivorsContent,
  makeSurvivorsContentLayer,
  survivorsContentDefinition,
} from "./content";
export {
  HudSample,
  RunSummary,
  type SurvivorsEvent,
  UpgradeChoice,
} from "./events";
export { hashWorld } from "./hash-world";
export {
  HeroInput,
  type SurvivorsInput,
  UpgradePick,
  combineHeroInputs,
  soloInput,
} from "./input";
export { GameContent } from "./schema";
export { survivorsSimulation } from "./simulation";
export {
  type SurvivorsConfig,
  type World,
  chooseUpgrade,
  isChoosing,
} from "./world";
