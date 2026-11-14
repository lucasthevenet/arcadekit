/**
 * The survivors world: a run's state, the `Arena`, the step that plays it, the handlers of its
 * commands, and its state hash.
 *
 * A run has one hero per player (`Hero`); everything else is the arena's, shared: the clock, the
 * team's XP and level, the horde, the projectiles, the gems and the `Rng`. Crowds live in the
 * kit's entity pools, one typed array per field, so a step allocates nothing per entity and the
 * garbage collector never causes a stutter: only what a step reports is allocated, and an event
 * is rare. Heroes are visited in slot order everywhere, so every lockstep peer computes the same
 * step, and with one hero every rule computes exactly what the single-player game always has.
 *
 * Plain on purpose: a step gives the same bits on every peer and every replay, so it reads no
 * clock or random source of its own and calls only exact math, and it finishes in the call.
 */
import {
  EntityPool,
  ExactMath,
  Point2,
  Rng,
  SpatialGrid,
  StateHash,
  Timer,
} from "arcadekit/core";
import * as Game from "arcadekit/game";

import { NoSuchChoice, NotPlaying, OfferClosed } from "./commands";
import type { ChooseUpgrade, HoldPause } from "./commands";
import { HeroLeft, LeveledUp, RunEnded } from "./events";
import type { Hud } from "./events";
import type * as GameContent from "./game-content";
import * as Hero from "./hero";
import * as Offer from "./offer";

const PLAYER_RADIUS = 0.5;
const PROJECTILE_RADIUS = 0.25;
const MAX_PROJECTILES = 512;
const MAX_GEMS = 1024;
const NEIGHBOR_BUFFER = 256;
const PROJECTILE_REHIT_DELAY = 0.15;
const GEM_PICKUP_DISTANCE = 0.6;
const GEM_MAGNET_SPEED = 18;
const SPAWN_DISTANCE_MIN = 16;
const SPAWN_DISTANCE_MAX = 22;

// Where `Point2.clampLength` and `Point2.moveToward` write their two numbers: the move a hero wishes for, and
// where a gem flies to. Each is written and read back before anything else runs, so neither
// holds anything between calls, and neither is part of a run.
const wish = Point2.make(0, 0);
const flown = Point2.make(0, 0);

/**
 * A step's input, as a Schema: every player's `Hero.Input` by its hero's slot, as a
 * `Game.PlayerInputs`, and the slots of the heroes whose players leave the run at this step.
 *
 * **When to use**
 *
 * As the simulation's `input`, and to check a recorded script. A host fills one for each step:
 * `Game.soloInput` from one player's source, and a lockstep session from the steps its host
 * confirms, in the run's player order, which must be the order of the config's `heroIds`.
 *
 * **Details**
 *
 * It holds what a player's devices hold and nothing else: a pick and the co-op pause are
 * commands. A hero with no input this step (`null`) stands still. `leaving` lists slots in
 * ascending order.
 *
 * **Example** (Two players, the second leaving)
 *
 * ```ts
 * import { World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * Schema.is(World.Input)({ players: [{ moveX: 1, moveZ: 0 }, null], leaving: [1] }); // => true
 * Schema.is(World.Input)({ players: [{ moveX: 1, moveZ: 0 }] }); // => false
 * ```
 *
 * @category schemas
 */
export const Input = Game.PlayerInputs(Hero.Input);

/**
 * A step's input: what an input source gives the loop for each step.
 *
 * **When to use**
 *
 * To type a script of steps, as a test or a replay writes one, or a step's input a test hands
 * `World.step`.
 *
 * **Example** (One player walking right)
 *
 * ```ts
 * import type { World } from "@arcadekit/survivors";
 *
 * const right: World.Input = { players: [{ moveX: 1, moveZ: 0 }], leaving: [] };
 * right.players[0]?.moveX; // => 1
 * ```
 *
 * @category models
 */
export type Input = typeof Input.Type;

/**
 * What a run starts from: the content, and one hero id per player, in player order.
 *
 * **When to use**
 *
 * As what `engine.start`, `loop.start` or a scenario's `given` takes. A co-op run's config is made
 * from the lobby's picks.
 *
 * **Example** (A run for two players)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const config: World.Config = { content, heroIds: ["bolter", "bolter"] };
 * World.make(config, { seed: 1 }).heroes.length; // => 2
 * ```
 *
 * @category models
 */
export interface Config {
  readonly content: GameContent.GameContent;
  /** One hero id per player, in player order (the host first in lockstep). 1 to 4: `make` throws otherwise. */
  readonly heroIds: readonly string[];
}

const ENEMY_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  hp: Float32Array,
  type: Uint16Array,
  hitFlash: Float32Array,
};
const PROJECTILE_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  vx: Float32Array,
  vz: Float32Array,
  damage: Float32Array,
  life: Float32Array,
  pierce: Uint8Array,
  rehit: Float32Array,
  /** The firing hero's slot times `Hero.maxWeapons`, plus the index in its weapons, so the view can color projectiles. */
  weapon: Uint8Array,
};
const GEM_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  value: Float32Array,
  magnet: Uint8Array,
};

/**
 * A run's cue counters: running totals of the moments that make a sound.
 *
 * **When to use**
 *
 * In a sound view, which plays a sound for each counter that rose since its last frame.
 *
 * **Details**
 *
 * The step bumps them and never reads them, so they only go up during a run, and the state hash
 * leaves them out. They are made with the run, typed arrays included, so bumping one never
 * allocates. `shots` counts by weapon, in the content's order; `hurt` and `downed` by hero slot.
 *
 * **Example** (Kills heard and counted)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 50, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 2 }],
 * });
 * const arena = World.make({ content, heroIds: ["bolter"] }, { seed: 1 });
 * const still = { players: [{ moveX: 0, moveZ: 0 }], leaving: [] };
 * for (let step = 0; step < 600; step++) {
 *   World.step(arena, still, { dt: 1 / 60, step, report: () => {} });
 * }
 * const { cues } = arena;
 * [cues.kills > 0, cues.kills === arena.kills, cues.shots[0]! >= cues.hits]; // => [true, true, true]
 * ```
 *
 * @category models
 */
export interface Cues {
  /** Bolt projectiles fired, one per projectile, by weapon def index (`content.weapons`). The aura fires none. */
  readonly shots: Uint32Array;
  /** Bolt projectiles hitting an enemy. Aura damage isn't counted: the aura hums instead. */
  hits: number;
  /** Enemies killed, by anything. */
  kills: number;
  /** Gems picked up by a hero. */
  pickups: number;
  /** Steps in which a hero took contact damage, by hero slot. */
  readonly hurt: Uint32Array;
  /** Heroes going down, by hero slot. */
  readonly downed: Uint32Array;
  /** Team levels gained. */
  levelUps: number;
  /** 1 once the run is won. */
  won: number;
  /** 1 once the run is lost. */
  lost: number;
}

/**
 * A run's state: the content and its `Rng`, the clock, the team's kills, level and XP, the offers'
 * numbering, the heroes by slot, the horde, the projectiles and the gems in their pools, what the
 * step works in, and the cue counters.
 *
 * **When to use**
 *
 * To read a run in a view, a test or a replay check. Only `step` and the commands' handlers
 * change it.
 *
 * **Details**
 *
 * Each run has its own state object, so a view tells runs apart by identity. An enemy's or a
 * gem's index in its pool moves when another is removed, so a view names one by its id
 * (`EntityPool.idOf`). An enemy's `type` is its index in `enemyDefs`. `World.hash` folds the
 * numbers `World.visit` lists, which leave out the cue counters and the step's scratch.
 *
 * **Example** (A run at its start)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const arena: World.Arena = World.make({ content, heroIds: ["bolter"] }, { seed: 1 });
 * [arena.time, arena.level, arena.xpNext, arena.enemies.count, arena.status]; // => [0, 1, 5, 0, "running"]
 * ```
 *
 * @category models
 */
export interface Arena {
  readonly content: GameContent.GameContent;
  /** The run's seeded random source: what spawns and offers draw from. */
  readonly rng: Rng.Rng;
  /** Seconds the run has played: frozen steps don't count. */
  time: number;
  kills: number;
  /** `running` until the run ends: `won` once its time reaches the rules' `runLength`, `dead` once no hero is playing. */
  status: "running" | "won" | "dead";
  /** The team's level and XP: any hero's gem feeds them. */
  level: number;
  xp: number;
  xpNext: number;
  /** Level-ups not yet offered and closed. */
  pendingLevelUps: number;
  /** Numbers the offers: bumped each time heroes are offered upgrades, so a pick names the offer it answers. */
  offerSeq: number;
  /** The slot the next enemy spawns around, before skipping heroes that aren't playing. */
  spawnCursor: number;
  /** One per player, by slot. Never removed from, so slots stay stable; a hero that leaves is marked `left`. */
  readonly heroes: readonly Hero.Hero[];
  /** The content's enemies, in order: an enemy's `type` is its index here. */
  readonly enemyDefs: readonly GameContent.EnemyDef[];
  readonly enemyTypeById: ReadonlyMap<string, number>;
  /**
   * Identified, as `gems` is, for the view: it keys what it keeps for an enemy or a gem on
   * `idOf`, since removing one moves another into its index. The rules name neither by id, and
   * an id is in no field, so the state hash covers none.
   */
  readonly enemies: EntityPool.Identified<typeof ENEMY_LAYOUT>;
  readonly projectiles: EntityPool.EntityPool<typeof PROJECTILE_LAYOUT>;
  readonly gems: EntityPool.Identified<typeof GEM_LAYOUT>;
  /** Each wave's enemies due but not yet spawned, by wave: a fraction carried to the next step. */
  readonly spawnBudget: Float64Array;
  /** The enemies by where they stand, built again each step. Scratch, so not part of the state hash. */
  readonly grid: SpatialGrid.SpatialGrid;
  /** Where the grid writes what a query found. Scratch, as `grid` is. */
  readonly neighbors: Int32Array;
  /** Each enemy's radius, by pool index: filled before the grid is built from it. Scratch, in no pool, so not part of the state hash. */
  readonly radii: Float64Array;
  /** 1 for an enemy a bolt already aims at, while its targets are picked, and all 0 otherwise. Scratch, as `radii` is. */
  readonly taken: Uint8Array;
  /** The cue counters, which only the sound view reads. Not part of the state hash. */
  readonly cues: Cues;
}

/**
 * Starts a run with one hero per id in `heroIds`, drawing from the run's `seed`: the heroes at
 * their places, the clock at 0, the team at level 1, and the pools empty.
 *
 * **When to use**
 *
 * As the simulation's `create`, which the loop calls on `start`. A test that steps a run by hand
 * calls it too.
 *
 * **Details**
 *
 * A run starts with nothing to report, so of the run's context it takes only the seed. It throws
 * a `RangeError` for no heroes or more than `Hero.maxPerRun`. An unknown hero id plays the
 * content's first hero.
 *
 * **Example** (A run, and one with too many heroes)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * World.make({ content, heroIds: ["bolter"] }, { seed: 7 }).heroes[0]?.def.name; // => "Bolter"
 *
 * let refused = "";
 * try {
 *   World.make({ content, heroIds: ["a", "b", "c", "d", "e"] }, { seed: 7 });
 * } catch (error) {
 *   refused = String(error);
 * }
 * refused; // => "RangeError: A survivors run has 1 to 4 heroes, not 5"
 * ```
 *
 * @category constructors
 */
export const make = (
  { content, heroIds }: Config,
  { seed }: Pick<Game.RunContext<never>, "seed">
): Arena => {
  if (heroIds.length === 0 || heroIds.length > Hero.maxPerRun) {
    throw new RangeError(
      `A survivors run has 1 to ${Hero.maxPerRun} heroes, not ${heroIds.length}`
    );
  }
  const cap = content.rules.maxEnemies;
  return {
    content,
    rng: Rng.make(seed),
    time: 0,
    kills: 0,
    status: "running",
    level: 1,
    xp: 0,
    xpNext: content.rules.xpToLevel2,
    pendingLevelUps: 0,
    offerSeq: 0,
    spawnCursor: 0,
    heroes: heroIds.map((id, slot) => Hero.make(content, id, slot)),
    enemyDefs: content.enemies,
    enemyTypeById: new Map(content.enemies.map((e, i) => [e.id, i])),
    enemies: EntityPool.makeIdentified(cap, ENEMY_LAYOUT),
    projectiles: EntityPool.make(MAX_PROJECTILES, PROJECTILE_LAYOUT),
    gems: EntityPool.makeIdentified(MAX_GEMS, GEM_LAYOUT),
    spawnBudget: new Float64Array(content.waves.length),
    grid: SpatialGrid.make({
      halfSize: content.rules.arenaHalfSize,
      cellSize: 2,
      capacity: cap,
    }),
    neighbors: new Int32Array(NEIGHBOR_BUFFER),
    radii: new Float64Array(cap),
    taken: new Uint8Array(cap),
    cues: {
      shots: new Uint32Array(content.weapons.length),
      hits: 0,
      kills: 0,
      pickups: 0,
      hurt: new Uint32Array(heroIds.length),
      downed: new Uint32Array(heroIds.length),
      levelUps: 0,
      won: 0,
      lost: 0,
    },
  };
};

/**
 * What the `Hud` sample carries: the team's level and XP, the run's time and length, the kills,
 * the enemies alive, and each hero's hit points and status, and whether it holds the pause or is
 * choosing.
 *
 * **When to use**
 *
 * As the simulation's sample `read`, which the loop calls when a run starts, every 100 ms, and
 * right after the frame that ends the run.
 *
 * **Details**
 *
 * It allocates, so no step calls it: the loop reads it on its own clock.
 *
 * **Example** (A run's first HUD)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const hud = World.hudSample(World.make({ content, heroIds: ["bolter"] }, { seed: 1 }));
 * [hud.level, hud.xpNext, hud.runLength, hud.heroes[0]?.hp]; // => [1, 5, 60, 100]
 * ```
 *
 * @category getters
 */
export const hudSample = (self: Arena): Omit<Hud, "_tag"> => ({
  level: self.level,
  xp: self.xp,
  xpNext: self.xpNext,
  time: self.time,
  runLength: self.content.rules.runLength,
  kills: self.kills,
  enemies: self.enemies.count,
  heroes: self.heroes.map((hero) => ({
    heroId: hero.def.id,
    hp: hero.hp,
    maxHp: hero.maxHp,
    status: hero.status,
    paused: hero.paused,
    choosing: hero.offer !== null,
  })),
});

/**
 * Whether some hero has an upgrade offer open: the run is frozen until every one is closed.
 *
 * **When to use**
 *
 * In a sound view, which stops the aura's hum while the run is frozen, and in a test that steps a
 * run to its first level-up.
 *
 * **Example** (A run with no offer open)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * World.isChoosing(World.make({ content, heroIds: ["bolter"] }, { seed: 1 })); // => false
 * ```
 *
 * @category getters
 */
export const isChoosing = (self: Arena): boolean => {
  for (const hero of self.heroes) {
    if (hero.offer !== null) {
      return true;
    }
  }
  return false;
};

const anyPlaying = (arena: Arena): boolean => {
  for (const hero of arena.heroes) {
    if (hero.status === "playing") {
      return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// The step function

/**
 * Advances a run by one step of `dt` seconds: the heroes move, the waves spawn, the horde
 * chases, the weapons fire, the gems fly, and the run reports what happened.
 *
 * **When to use**
 *
 * As the simulation's `step`, which the loop calls once per step. A test that steps a run by hand
 * calls it with a context of its own.
 *
 * **Details**
 *
 * First the heroes in `input.leaving` leave, each reported with `HeroLeft`, and a run with no
 * hero left playing ends there. Then the run stays frozen while any hero has an upgrade offer
 * open, or while any playing hero holds it paused (`HoldPause`). The step's commands were applied
 * before it. A level-up offers every playing hero a choice at the end of the step, each reported
 * with `LeveledUp`, and the run ends, reported with `RunEnded`, when no hero is playing or its
 * time reaches the rules' `runLength`. It does nothing once the run is over. It allocates nothing
 * per entity: only the events it reports and a level-up's offers.
 *
 * **Example** (A hero walking right for a second)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const arena = World.make({ content, heroIds: ["bolter"] }, { seed: 1 });
 * const right = { players: [{ moveX: 1, moveZ: 0 }], leaving: [] };
 * World.step(arena, right, { dt: 0.5, step: 0, report: () => {} });
 * World.step(arena, right, { dt: 0.5, step: 1, report: () => {} });
 * [arena.time, arena.heroes[0]?.x, arena.enemies.count]; // => [1, 6, 1]
 * ```
 *
 * @category mutations
 */
export const step = (
  self: Arena,
  input: Input,
  { dt, report }: Game.StepContext<HeroLeft | LeveledUp | RunEnded>
): void => {
  if (self.status !== "running") {
    return;
  }
  for (const slot of input.leaving) {
    leave(self, slot, report);
  }
  if (!anyPlaying(self)) {
    endRun(self, "dead", report);
    return;
  }
  if (isChoosing(self) || isPauseHeld(self)) {
    return;
  }
  self.time += dt;

  moveHeroes(self, input, dt);
  spawnEnemies(self, dt);
  moveEnemies(self, dt);
  // The grid the rest of the step asks: each enemy where it now is, as a circle of its type's
  // radius. Nothing moves or removes an enemy until `removeDeadEnemies`.
  const { x, z, type } = self.enemies.fields;
  for (let i = 0; i < self.enemies.count; i++) {
    self.radii[i] = self.enemyDefs[type[i]!]!.radius;
  }
  SpatialGrid.build(self.grid, x, z, self.enemies.count, self.radii);
  touchHeroes(self, dt);
  fireWeapons(self, dt);
  moveProjectiles(self, dt);
  removeDeadEnemies(self);
  collectGems(self, dt);

  for (const hero of self.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    hero.hp = Math.min(hero.maxHp, hero.hp + hero.stats.regen * dt);
    if (hero.hp <= 0) {
      hero.hp = 0;
      hero.status = "down";
      // A hero that is down holds no pause. No run reaches this line with one held, since a
      // held pause freezes the step before it; the line keeps the rule true whatever a later
      // one does.
      hero.paused = false;
      self.cues.downed[hero.slot]! += 1;
    }
  }
  if (!anyPlaying(self)) {
    endRun(self, "dead", report);
  } else if (self.time >= self.content.rules.runLength) {
    endRun(self, "won", report);
  } else if (self.pendingLevelUps > 0) {
    offerUpgrades(self, report);
  }
};

const heroInput = (input: Input, hero: Hero.Hero): Hero.Input | null =>
  input.players[hero.slot] ?? null;

/** The hero in `slot` leaves the run: it is no longer drawn or chased, and its open offer closes. */
const leave = (
  arena: Arena,
  slot: number,
  report: (event: HeroLeft) => void
) => {
  const hero = arena.heroes[slot];
  if (!hero || hero.status === "left") {
    return;
  }
  hero.status = "left";
  hero.paused = false;
  closeOffer(arena, hero);
  report(new HeroLeft({ hero: slot }));
};

/**
 * True while a playing hero holds the run paused (`HoldPause`). The handler takes a hold only
 * from a playing hero, and going down or leaving lets go of it; asking for `playing` here as
 * well means no path that forgets to let go can freeze every peer for good.
 */
const isPauseHeld = (arena: Arena): boolean => {
  for (const hero of arena.heroes) {
    if (hero.paused && hero.status === "playing") {
      return true;
    }
  }
  return false;
};

/** Ends the run, and reports it. The HUD's version moves with the status, so the loop samples it next. */
const endRun = (
  arena: Arena,
  status: "won" | "dead",
  report: (event: RunEnded) => void
) => {
  arena.status = status;
  if (status === "won") {
    arena.cues.won += 1;
  } else {
    arena.cues.lost += 1;
  }
  report(
    new RunEnded({
      summaries: arena.heroes.map((hero) => ({
        won: status === "won",
        heroId: hero.def.id,
        heroName: hero.def.name,
        time: arena.time,
        kills: arena.kills,
        level: arena.level,
      })),
    })
  );
};

const moveHeroes = (arena: Arena, input: Input, dt: number) => {
  const limit = arena.content.rules.arenaHalfSize - 1;
  for (const hero of arena.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    const move = heroInput(input, hero);
    // A move longer than 1 is shortened to 1, so a diagonal is no faster.
    const length = Point2.clampLength(
      wish,
      move?.moveX ?? 0,
      move?.moveZ ?? 0,
      1
    );
    if (length > 0.05) {
      hero.faceX = wish.x;
      hero.faceZ = wish.y;
    }
    hero.x = ExactMath.clamp(
      hero.x + wish.x * hero.stats.moveSpeed * dt,
      -limit,
      limit
    );
    hero.z = ExactMath.clamp(
      hero.z + wish.y * hero.stats.moveSpeed * dt,
      -limit,
      limit
    );
    hero.hurtTimer = Timer.countDown(hero.hurtTimer, dt);
  }
};

/** The playing hero the next enemy spawns around: the heroes take turns, in slot order. */
const nextSpawnHero = (arena: Arena): Hero.Hero => {
  const { heroes } = arena;
  for (let k = 0; k < heroes.length; k++) {
    const slot = (arena.spawnCursor + k) % heroes.length;
    const hero = heroes[slot]!;
    if (hero.status === "playing") {
      arena.spawnCursor = (slot + 1) % heroes.length;
      return hero;
    }
  }
  // The step ends a run with no playing hero before anything spawns.
  return heroes[0]!;
};

const spawnEnemies = (arena: Arena, dt: number) => {
  const { waves, rules } = arena.content;
  const { x, z, hp, type } = arena.enemies.fields;
  const limit = rules.arenaHalfSize - 1;
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]!;
    if (arena.time < wave.from || arena.time >= wave.to) {
      continue;
    }
    arena.spawnBudget[w]! += wave.perSecond * dt;
    const due = Timer.takeWhole(arena.spawnBudget[w]!);
    arena.spawnBudget[w]! -= due;
    const enemyType = arena.enemyTypeById.get(wave.enemy)!;
    for (let spawned = 0; spawned < due; spawned++) {
      const i = EntityPool.add(arena.enemies);
      if (i === -1) {
        continue;
      }
      const hero = nextSpawnHero(arena);
      const angle = Rng.next(arena.rng) * Math.PI * 2;
      const distance = Rng.range(
        arena.rng,
        SPAWN_DISTANCE_MIN,
        SPAWN_DISTANCE_MAX
      );
      x[i] = ExactMath.clamp(
        hero.x + ExactMath.cos(angle) * distance,
        -limit,
        limit
      );
      z[i] = ExactMath.clamp(
        hero.z + ExactMath.sin(angle) * distance,
        -limit,
        limit
      );
      hp[i] = arena.enemyDefs[enemyType]!.hp;
      type[i] = enemyType;
    }
  }
};

/**
 * The playing hero nearest (x, z), by squared distance, with exact arithmetic; the lowest slot
 * wins a tie. Null if no hero is playing.
 */
const nearestHero = (arena: Arena, x: number, z: number): Hero.Hero | null => {
  let best: Hero.Hero | null = null;
  let bestD2 = Infinity;
  for (const hero of arena.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    const dx = hero.x - x;
    const dz = hero.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      best = hero;
      bestD2 = d2;
    }
  }
  return best;
};

const moveEnemies = (arena: Arena, dt: number) => {
  const { x, z, type, hitFlash } = arena.enemies.fields;
  const { count } = arena.enemies;
  // Chase the nearest hero.
  for (let i = 0; i < count; i++) {
    const def = arena.enemyDefs[type[i]!]!;
    const hero = nearestHero(arena, x[i]!, z[i]!);
    if (hero !== null) {
      const dx = hero.x - x[i]!;
      const dz = hero.z - z[i]!;
      const d = ExactMath.hypot2(dx, dz) || 1;
      x[i]! += (dx / d) * def.speed * dt;
      z[i]! += (dz / d) * def.speed * dt;
    }
    hitFlash[i] = Timer.countDown(hitFlash[i]!, dt);
  }
  // Push overlapping enemies apart so the horde spreads out instead of stacking.
  SpatialGrid.build(arena.grid, x, z, count);
  for (let i = 0; i < count; i++) {
    const ri = arena.enemyDefs[type[i]!]!.radius;
    const found = SpatialGrid.query(
      arena.grid,
      x[i]!,
      z[i]!,
      ri + 0.8,
      arena.neighbors
    );
    for (let k = 0; k < found; k++) {
      const j = arena.neighbors[k]!;
      if (j <= i) {
        continue;
      }
      const rj = arena.enemyDefs[type[j]!]!.radius;
      const dx = x[j]! - x[i]!;
      const dz = z[j]! - z[i]!;
      const d = ExactMath.hypot2(dx, dz);
      const overlap = ri + rj - d;
      if (overlap <= 0 || d === 0) {
        continue;
      }
      const push = (overlap / d) * 0.5;
      x[i]! -= dx * push;
      z[i]! -= dz * push;
      x[j]! += dx * push;
      z[j]! += dz * push;
    }
  }
};

const touchHeroes = (arena: Arena, dt: number) => {
  const { type } = arena.enemies.fields;
  for (const hero of arena.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    const found = SpatialGrid.within(
      arena.grid,
      hero.x,
      hero.z,
      PLAYER_RADIUS,
      arena.neighbors
    );
    for (let k = 0; k < found; k++) {
      const def = arena.enemyDefs[type[arena.neighbors[k]!]!]!;
      hero.hp -= def.damage * dt;
      hero.hurtTimer = 0.15;
    }
    if (found > 0) {
      arena.cues.hurt[hero.slot]! += 1;
    }
  }
};

const fireWeapons = (arena: Arena, dt: number) => {
  for (const hero of arena.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    for (let w = 0; w < hero.weapons.length; w++) {
      const slot = hero.weapons[w]!;
      slot.sinceFired += dt;
      slot.timer -= dt;
      if (slot.timer > 0) {
        continue;
      }
      const fired =
        slot.def.behavior.kind === "bolt"
          ? fireBolt(arena, hero, slot, hero.slot * Hero.maxWeapons + w)
          : pulseAura(arena, hero, slot);
      if (fired) {
        slot.timer = Hero.weaponCooldown(hero, slot);
        slot.sinceFired = 0;
      }
    }
  }
};

const fireBolt = (
  arena: Arena,
  p: Hero.Hero,
  slot: Hero.WeaponSlot,
  weaponIndex: number
): boolean => {
  const { behavior } = slot.def;
  if (behavior.kind !== "bolt") {
    return false;
  }
  const e = arena.enemies.fields;
  const shots = Math.floor(
    behavior.count + behavior.countPerLevel * (slot.level - 1)
  );
  const range = behavior.range * p.stats.areaMult;
  // Pick the `shots` nearest enemies in range: the nearest not yet taken, once for each shot.
  const targets = arena.neighbors;
  let targetCount = 0;
  for (let s = 0; s < shots && s < targets.length; s++) {
    const best = SpatialGrid.nearest(arena.grid, p.x, p.z, range, arena.taken);
    if (best === -1) {
      break;
    }
    arena.taken[best] = 1;
    targets[targetCount] = best;
    targetCount += 1;
  }
  for (let t = 0; t < targetCount; t++) {
    arena.taken[targets[t]!] = 0;
  }
  if (targetCount === 0) {
    return false;
  }
  const pr = arena.projectiles.fields;
  const damage = Hero.weaponDamage(p, slot);
  const defIndex = arena.content.weapons.indexOf(slot.def);
  for (let t = 0; t < shots; t++) {
    const i = EntityPool.add(arena.projectiles);
    if (i === -1) {
      break;
    }
    // Extra shots beyond the number of targets reuse the nearest ones.
    const target = targets[t % targetCount]!;
    const dx = e.x[target]! - p.x;
    const dz = e.z[target]! - p.z;
    const d = ExactMath.hypot2(dx, dz) || 1;
    pr.x[i] = p.x;
    pr.z[i] = p.z;
    pr.vx[i] = (dx / d) * behavior.projectileSpeed;
    pr.vz[i] = (dz / d) * behavior.projectileSpeed;
    pr.damage[i] = damage;
    pr.life[i] = (range / behavior.projectileSpeed) * 1.3;
    pr.pierce[i] = behavior.pierce;
    pr.weapon[i] = weaponIndex;
    arena.cues.shots[defIndex]! += 1;
  }
  return true;
};

const pulseAura = (
  arena: Arena,
  p: Hero.Hero,
  slot: Hero.WeaponSlot
): boolean => {
  const radius = Hero.auraRadius(p, slot);
  const damage = Hero.weaponDamage(p, slot);
  const found = SpatialGrid.within(
    arena.grid,
    p.x,
    p.z,
    radius,
    arena.neighbors
  );
  for (let k = 0; k < found; k++) {
    hitEnemy(arena, arena.neighbors[k]!, damage);
  }
  return true;
};

const moveProjectiles = (arena: Arena, dt: number) => {
  const pool = arena.projectiles;
  const pr = pool.fields;
  const e = arena.enemies.fields;
  let i = 0;
  while (i < pool.count) {
    pr.x[i]! += pr.vx[i]! * dt;
    pr.z[i]! += pr.vz[i]! * dt;
    pr.life[i]! -= dt;
    pr.rehit[i] = Timer.countDown(pr.rehit[i]!, dt);
    let spent = pr.life[i]! <= 0;
    if (!spent && pr.rehit[i] === 0) {
      const found = SpatialGrid.within(
        arena.grid,
        pr.x[i]!,
        pr.z[i]!,
        PROJECTILE_RADIUS,
        arena.neighbors
      );
      for (let k = 0; k < found; k++) {
        const j = arena.neighbors[k]!;
        if (e.hp[j]! <= 0) {
          continue;
        }
        hitEnemy(arena, j, pr.damage[i]!);
        arena.cues.hits += 1;
        if (pr.pierce[i] === 0) {
          spent = true;
        } else {
          pr.pierce[i]! -= 1;
          pr.rehit[i] = PROJECTILE_REHIT_DELAY;
        }
        break;
      }
    }
    if (spent) {
      EntityPool.remove(pool, i);
    } else {
      i += 1;
    }
  }
};

const hitEnemy = (arena: Arena, i: number, damage: number) => {
  arena.enemies.fields.hp[i]! -= damage;
  arena.enemies.fields.hitFlash[i] = 0.1;
};

const removeDeadEnemies = (arena: Arena) => {
  const e = arena.enemies.fields;
  const g = arena.gems.fields;
  for (let i = arena.enemies.count - 1; i >= 0; i--) {
    if (e.hp[i]! > 0) {
      continue;
    }
    arena.kills += 1;
    arena.cues.kills += 1;
    const { xp } = arena.enemyDefs[e.type[i]!]!;
    if (xp > 0) {
      const k = EntityPool.add(arena.gems);
      if (k === -1) {
        // Too many gems on the floor: grant the XP directly.
        gainXp(arena, xp);
      } else {
        g.x[k] = e.x[i]!;
        g.z[k] = e.z[i]!;
        g.value[k] = xp;
      }
    }
    EntityPool.remove(arena.enemies, i);
  }
};

const collectGems = (arena: Arena, dt: number) => {
  const pool = arena.gems;
  const g = pool.fields;
  let i = 0;
  while (i < pool.count) {
    // Gems fly to, and are collected by, the nearest hero.
    const p = nearestHero(arena, g.x[i]!, g.z[i]!);
    if (p === null) {
      return;
    }
    const d = ExactMath.hypot2(p.x - g.x[i]!, p.z - g.z[i]!);
    if (d < p.stats.pickupRadius) {
      g.magnet[i] = 1;
    }
    if (g.magnet[i] === 1) {
      // Within one step of its hero a gem lands on it, and is picked up below.
      Point2.moveToward(
        flown,
        g.x[i]!,
        g.z[i]!,
        p.x,
        p.z,
        GEM_MAGNET_SPEED * dt
      );
      g.x[i] = flown.x;
      g.z[i] = flown.y;
    }
    if (d < GEM_PICKUP_DISTANCE) {
      arena.cues.pickups += 1;
      gainXp(arena, g.value[i]!);
      EntityPool.remove(pool, i);
    } else {
      i += 1;
    }
  }
};

/** Feeds the team's XP. Each level gained is a pending level-up. */
const gainXp = (arena: Arena, amount: number) => {
  arena.xp += amount;
  while (arena.xp >= arena.xpNext) {
    arena.xp -= arena.xpNext;
    arena.level += 1;
    arena.xpNext = Math.ceil(
      arena.content.rules.xpToLevel2 *
        ExactMath.powInt(arena.content.rules.xpGrowth, arena.level - 1)
    );
    arena.pendingLevelUps += 1;
    arena.cues.levelUps += 1;
  }
};

// ---------------------------------------------------------------------------
// Upgrades

/** Opens a new offer: every playing hero, in slot order, gets its own choices. */
const offerUpgrades = (arena: Arena, report: (event: LeveledUp) => void) => {
  arena.offerSeq += 1;
  for (const hero of arena.heroes) {
    if (hero.status !== "playing") {
      continue;
    }
    hero.offer = Offer.roll(arena.content, arena.rng, hero);
    report(
      new LeveledUp({
        hero: hero.slot,
        offer: arena.offerSeq,
        // A copy, so the event shares nothing with the state.
        choices: hero.offer.map((choice) => ({ ...choice })),
      })
    );
  }
};

/** Closes a hero's offer. Once no hero has one open, that level-up is done and the run resumes. */
const closeOffer = (arena: Arena, hero: Hero.Hero) => {
  if (hero.offer === null) {
    return;
  }
  hero.offer = null;
  if (!isChoosing(arena)) {
    arena.pendingLevelUps -= 1;
  }
};

/**
 * The hero takes the choice at `index` of its open offer, and the offer closes. Returns false,
 * having changed nothing, if it has no open offer or the offer has no such choice.
 *
 * **When to use**
 *
 * Rarely: every pick ends here, through the `ChooseUpgrade` command's handler
 * (`World.chooseUpgrade`), in a single-player run and in a lockstep run alike. A test of the
 * offers calls it to pick without sending a command.
 *
 * **Details**
 *
 * It doesn't check which offer is open: the command's handler does, by its number. The run
 * resumes at the next step once no hero has an offer open.
 *
 * **Example** (Picking from the first offer, once)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 1, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 20, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 2 }],
 * });
 * const arena = World.make({ content, heroIds: ["bolter"] }, { seed: 1 });
 * const still = { players: [{ moveX: 0, moveZ: 0 }], leaving: [] };
 * for (let step = 0; step < 1200 && !World.isChoosing(arena); step++) {
 *   World.step(arena, still, { dt: 1 / 60, step, report: () => {} });
 * }
 * const hero = arena.heroes[0]!;
 * [World.choose(arena, hero, 0), World.choose(arena, hero, 0)]; // => [true, false]
 * hero.weapons[0]?.level; // => 2
 * ```
 *
 * @category mutations
 */
export const choose = (
  self: Arena,
  hero: Hero.Hero,
  index: number
): boolean => {
  const choice = hero.offer?.[index];
  if (!choice) {
    return false;
  }
  Hero.upgrade(hero, self.content, choice);
  closeOffer(self, hero);
  return true;
};

/**
 * The `ChooseUpgrade` command's handler: the sender's hero takes the choice the command names,
 * and its offer closes. It refuses a pick for an offer that isn't the sender's open one with
 * `OfferClosed`, and one for an index the offer lacks with `NoSuchChoice`.
 *
 * **When to use**
 *
 * As the simulation's `apply.ChooseUpgrade`, which the loop calls at the start of the step the
 * command arrives at.
 *
 * **Details**
 *
 * It decides first, then changes: a refused pick leaves the run as it was. The sender's hero is
 * the one at the sender's slot (`player`).
 *
 * **Example** (A pick past the offer's end, then the first choice)
 *
 * ```ts
 * import { ChooseUpgrade, GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 1, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 20, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 2 }],
 * });
 * const arena = World.make({ content, heroIds: ["bolter"] }, { seed: 1 });
 * const still = { players: [{ moveX: 0, moveZ: 0 }], leaving: [] };
 * for (let step = 0; step < 1200 && !World.isChoosing(arena); step++) {
 *   World.step(arena, still, { dt: 1 / 60, step, report: () => {} });
 * }
 * const sender = { player: 0, step: 0, report: () => {} };
 * const offer = arena.offerSeq;
 * World.chooseUpgrade(arena, new ChooseUpgrade({ offer, index: 9 }), sender)?._tag; // => "NoSuchChoice"
 * World.chooseUpgrade(arena, new ChooseUpgrade({ offer, index: 0 }), sender); // => undefined
 * World.isChoosing(arena); // => false
 * ```
 *
 * @category mutations
 */
export const chooseUpgrade = (
  self: Arena,
  { offer, index }: ChooseUpgrade,
  { player }: Game.CommandContext<never>
): OfferClosed | NoSuchChoice | undefined => {
  // Decide first, then change: a refused pick leaves the world as it was.
  const hero = self.heroes[player];
  if (hero === undefined || hero.offer === null || offer !== self.offerSeq) {
    return new OfferClosed({ offer });
  }
  if (hero.offer[index] === undefined) {
    return new NoSuchChoice({ offer, index });
  }
  choose(self, hero, index);
};

/**
 * The `HoldPause` command's handler: the sender's hero holds the run paused (`held: true`) or
 * lets go of it. It refuses the command with `NotPlaying` once the run is over, or when the
 * sender's hero is not playing.
 *
 * **When to use**
 *
 * As the simulation's `apply.HoldPause`, which the loop calls at the start of the step the
 * command arrives at.
 *
 * **Details**
 *
 * It decides first, then changes: a refused pause leaves the run as it was. The heroes of a run
 * that was won are still `playing`, so the run's status is asked too: a run that is over stays as
 * it ended.
 *
 * **Example** (A hold, and one from a slot with no hero)
 *
 * ```ts
 * import { GameContent, HoldPause, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const arena = World.make({ content, heroIds: ["bolter"] }, { seed: 1 });
 * const hold = new HoldPause({ held: true });
 * World.holdPause(arena, hold, { player: 0, step: 0, report: () => {} }); // => undefined
 * arena.heroes[0]?.paused; // => true
 * World.holdPause(arena, hold, { player: 3, step: 0, report: () => {} })?._tag; // => "NotPlaying"
 * ```
 *
 * @category mutations
 */
export const holdPause = (
  self: Arena,
  { held }: HoldPause,
  { player }: Game.CommandContext<never>
): NotPlaying | undefined => {
  // Decide first, then change: a refused pause leaves the world as it was. A run that is
  // over takes none, though the heroes of a run that was won are still "playing": it stays
  // as it ended.
  const hero = self.heroes[player];
  if (
    self.status !== "running" ||
    hero === undefined ||
    hero.status !== "playing"
  ) {
    return new NotPlaying();
  }
  hero.paused = held;
};

// ---------------------------------------------------------------------------
// The state hash

/** One state hash for every hash: `hash` resets it first. */
const stateHash = StateHash.make();
/** Folds a number into it: the `add` `visit` is given, made once. */
const fold = (value: number): void => {
  StateHash.add(stateHash, value);
};

const STATUS_CODE = { playing: 0, down: 1, left: 2 } as const;

/**
 * Passes every number the state hash covers to `add`, in one fixed order: the clock, the kills,
 * the first hero with the team's level and XP, its weapons, and each pool's count and live
 * entities (enemies, projectiles, gems). A run with more than one hero adds the offers, the spawn
 * cursor and the other heroes after that.
 *
 * **When to use**
 *
 * To fold a run's state into a hash of your own, as the long determinism run does after every
 * step. `World.hash` folds it with the kit's `StateHash`.
 *
 * **Details**
 *
 * It visits what it lists and nothing else. A one-hero run visits exactly what the single-player
 * game always has, so its pinned hashes hold. What only a view reads, the cue counters, and the
 * step's scratch (`grid`, `neighbors`, `radii`, `taken`) are left out on purpose, as are the
 * pools' ids, which are in no field.
 *
 * **Example** (The first numbers of a run)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const numbers: number[] = [];
 * World.visit(World.make({ content, heroIds: ["bolter"] }, { seed: 1 }), (n) => numbers.push(n));
 * numbers; // => [0, 0, 0, 0, 100, 100, 1, 0, 5, 0, 1, 0, 1, 0.5, 0, 0, 0]
 * ```
 *
 * @category getters
 */
export const visit = (self: Arena, add: (value: number) => void): void => {
  add(self.time);
  add(self.kills);
  const first = self.heroes[0]!;
  add(first.x);
  add(first.z);
  add(first.hp);
  add(first.maxHp);
  add(self.level);
  add(self.xp);
  add(self.xpNext);
  add(first.faceX);
  add(first.faceZ);
  add(first.hurtTimer);
  for (const slot of first.weapons) {
    add(slot.level);
    add(slot.timer);
  }
  EntityPool.visit(self.enemies, add);
  EntityPool.visit(self.projectiles, add);
  EntityPool.visit(self.gems, add);
  if (self.heroes.length === 1) {
    return;
  }
  add(self.offerSeq);
  add(self.pendingLevelUps);
  add(self.spawnCursor);
  for (const hero of self.heroes) {
    add(STATUS_CODE[hero.status]);
    add(hero.offer === null ? 0 : 1);
    add(hero.paused ? 1 : 0);
    if (hero.slot === 0) {
      continue;
    }
    add(hero.x);
    add(hero.z);
    add(hero.hp);
    add(hero.maxHp);
    add(hero.faceX);
    add(hero.faceZ);
    add(hero.hurtTimer);
    add(hero.weapons.length);
    for (const slot of hero.weapons) {
      add(slot.level);
      add(slot.timer);
    }
  }
};

/**
 * A run's state hash: everything `World.visit` passes, folded with the kit's `StateHash` into
 * one 32-bit number.
 *
 * **When to use**
 *
 * As a co-op game's `hash`, which lockstep peers compare to catch a desync, and in a replay or a
 * determinism test, which pins it.
 *
 * **Details**
 *
 * Two runs with the same content, seed, input and commands give the same hash on every peer and
 * every engine. One `StateHash` is reset and reused for every call.
 *
 * **Example** (Two runs from one seed)
 *
 * ```ts
 * import { GameContent, World } from "@arcadekit/survivors";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 4 }],
 * });
 * const played = (seed: number) => {
 *   const arena = World.make({ content, heroIds: ["bolter"] }, { seed });
 *   const right = { players: [{ moveX: 1, moveZ: 0 }], leaving: [] };
 *   for (let step = 0; step < 120; step++) {
 *     World.step(arena, right, { dt: 1 / 60, step, report: () => {} });
 *   }
 *   return World.hash(arena);
 * };
 * played(1) === played(1); // => true
 * played(1) === played(2); // => false
 * ```
 *
 * @category getters
 */
export const hash = (self: Arena): number => {
  StateHash.reset(stateHash);
  visit(self, fold);
  return StateHash.digest(stateHash);
};
