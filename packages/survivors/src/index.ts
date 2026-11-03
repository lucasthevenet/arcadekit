// Survivors-like genre: content schema, content service, the simulation and its event payloads.
// No DOM or Three.js here; those are in "@gamekit/survivors/browser".

export {
  CONTENT_FILES,
  SurvivorsContent,
  makeSurvivorsContentLayer,
} from "./content";
export {
  HudSample,
  RunSummary,
  type SurvivorsEvent,
  UpgradeChoice,
} from "./events";
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
  type RunStatus,
  type Stats,
  type SurvivorsConfig,
  type SurvivorsInput,
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
