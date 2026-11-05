// Survivors-like genre: content schema, definition and service, the simulation (rules and
// GameSimulation), its step input and its event payloads.
// No DOM or Three.js here; those are in "@arcadekit/survivors/browser".

export {
  SurvivorsContent,
  makeSurvivorsContentLayer,
  survivorsContentDefinition,
} from "./content";
export {
  HeroHud,
  HudSample,
  RunSummary,
  type SurvivorsEvent,
  UpgradeChoice,
} from "./events";
export {
  type Hero,
  type HeroStatus,
  MAX_HEROES,
  type Stats,
  type WeaponSlot,
  auraRadius,
  recomputeStats,
  weaponCooldown,
  weaponDamage,
} from "./hero";
export { hashWorld } from "./hash-world";
export {
  HeroInput,
  type PlayersStep,
  type SurvivorsInput,
  UpgradePick,
  combineHeroInputs,
  soloInput,
} from "./input";
export {
  EnemyDef,
  GameContent,
  HeroDef,
  PassiveDef,
  Rules,
  StatKey,
  WaveDef,
  WeaponDef,
  findBrokenReferences,
} from "./schema";
export { survivorsSimulation } from "./simulation";
export {
  type RunStatus,
  type SurvivorsConfig,
  type SurvivorsCues,
  type World,
  chooseUpgrade,
  createWorld,
  hudSample,
  isChoosing,
  step,
} from "./world";
