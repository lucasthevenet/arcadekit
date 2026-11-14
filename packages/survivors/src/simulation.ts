/**
 * Survivors' rules, declared: what `Game.Loop` steps in a browser, a Worker, on a server or in a
 * test, for one hero or for several.
 *
 * The declaration names the parts the `World` module holds: the step input, how a run starts,
 * the step, the handlers of the two commands, and the HUD's sample. `SurvivorsEngine`
 * (`@arcadekit/survivors/browser`) adds the input, the view and the sound for one player, and
 * `SurvivorsCoop` plays that engine for several, in lockstep.
 */
import * as Game from "arcadekit/game";

import { ChooseUpgrade, HoldPause } from "./commands";
import { HeroLeft, Hud, LeveledUp, RunEnded } from "./events";
import * as World from "./world";

/**
 * Survivors' rules: heroes, one per player, hold out against waves of enemies for a run's length,
 * with weapons that fire on their own, gems that feed the team's XP, and an upgrade to pick at
 * each level-up. A run reports `LeveledUp`, `HeroLeft` and `RunEnded`, and takes the commands
 * `ChooseUpgrade` and `HoldPause`.
 *
 * **When to use**
 *
 * To step a run without a browser: a replay or a benchmark makes a loop of it
 * (`Game.makeLoop(Survivors)`), and a test a scenario (`Scenario.make(Survivors)`). An app reads
 * its events through `Survivors.match`, and its state's type is `World.Arena`.
 *
 * **Details**
 *
 * A step is 1/60 s. Its config is a `World.Config` and its step input a `World.Input`, every
 * player's by slot. Its randomness comes from the run's seed. The `Hud` sample is read when a run
 * starts, every 100 ms, and right after the frame that ends the run.
 *
 * **Example** (Hearing a run in a loop)
 *
 * ```ts
 * import { GameContent, Survivors } from "@arcadekit/survivors";
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 1,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 1, enemy: "grunt", perSecond: 1 }],
 * });
 * const heard: string[] = [];
 * const loop = Game.makeLoop(Survivors);
 * loop.subscribe(
 *   Survivors.match({
 *     Hud: ({ time }) => heard.push(`HUD at ${Math.round(time)} s`),
 *     LeveledUp: () => heard.push("leveled up"),
 *     HeroLeft: () => heard.push("left"),
 *     RunEnded: ({ summaries }) => heard.push(summaries[0]?.won ? "won" : "lost"),
 *   })
 * );
 * loop.start({ content, heroIds: ["bolter"] }, 1, 0);
 * loop.frame(Game.soloInput({ read: () => ({ moveX: 0, moveZ: 0 }) }), { steps: 70 }, 50);
 * heard; // => ["HUD at 0 s", "won", "HUD at 1 s"]
 * ```
 *
 * @category declarations
 */
export class Survivors extends Game.Simulation("Survivors", {
  stepSeconds: 1 / 60,
  input: World.Input,
  events: [LeveledUp, HeroLeft, RunEnded],
  commands: [ChooseUpgrade, HoldPause],
  create: World.make,
  step: World.step,
  apply: {
    ChooseUpgrade: World.chooseUpgrade,
    HoldPause: World.holdPause,
  },
  // The HUD changes all the time, so it is read every 100 ms; its version moves when the run
  // ends, so the last read comes right after the frame that ended it and the HUD shows the run's
  // last numbers.
  sample: {
    event: Hud,
    every: "100 millis",
    version: (arena) => (arena.status === "running" ? 0 : 1),
    read: World.hudSample,
  },
}) {}
