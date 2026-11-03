// Survivors-like genre: content schema, content service and the simulation.
// No DOM or Three.js here; those are in "@gamekit/survivors/browser".

export {
  CONTENT_FILES,
  SurvivorsContent,
  makeSurvivorsContentLayer,
} from "./content";
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
export {
  type HudSample,
  type RunStatus,
  type RunSummary,
  type Stats,
  type SurvivorsConfig,
  type SurvivorsEvent,
  type SurvivorsInput,
  type UpgradeChoice,
  type WeaponSlot,
  type World,
  auraRadius,
  chooseUpgrade,
  createWorld,
  hudSample,
  recomputeStats,
  step,
  weaponCooldown,
  weaponDamage,
} from "./world";
