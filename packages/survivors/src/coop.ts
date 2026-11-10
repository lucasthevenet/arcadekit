import { EventBuffer } from "arcadekit/core";
import type * as Game from "arcadekit/game";
import { schemaCodec } from "arcadekit/net";
import type { CoopRules, CoopTypes } from "arcadekit/net";
import type { GameSimulation } from "arcadekit/runtime";

import { Hud } from "./events";
import type { RunSummary, SurvivorsEvent, UpgradeChoice } from "./events";
import { hashWorld } from "./hash-world";
import { MAX_HEROES } from "./hero";
import { HeroInput } from "./input";
import type { SurvivorsInput, UpgradePick } from "./input";
import type { GameContent } from "./schema";
import { createWorld, hudSample, hudVersion, step } from "./world";
import type { SurvivorsConfig, World } from "./world";

// Survivors as a Co-op game's lockstep parts (ADR-0013): what `arcadekit/net/browser`'s Co-op
// client runs. DOM-free, so it is tested in Node. `./browser`'s `makeSurvivorsCoopGame` adds the
// content, the input and the views. Everything here that runs between steps is plain code.
//
// Co-op is still on the older contract (ADR-0020): its lockstep run steps a `GameSimulation`,
// which this file builds from the rules `Survivors` declares, and a pick and a pause ride the
// step input.

/**
 * What the local player's app hears of a co-op run: the team's HUD, the local hero's own
 * upgrade offer (answer it with an `UpgradePick` naming `offer`), and the local hero's summary
 * when the run ends.
 */
export type SurvivorsCoopEvent =
  | { readonly type: "hud"; readonly hud: Hud }
  | {
      readonly type: "levelUp";
      readonly offer: number;
      readonly choices: readonly UpgradeChoice[];
    }
  | { readonly type: "runEnded"; readonly summary: RunSummary };

/** Co-op survivors' types. A lobby pick is a hero id; an answer is an upgrade pick. */
export interface SurvivorsCoop extends CoopTypes {
  readonly Config: SurvivorsConfig;
  readonly State: World;
  readonly Event: SurvivorsEvent;
  readonly PlayerInput: HeroInput;
  readonly Answer: UpgradePick;
  readonly LocalEvent: SurvivorsCoopEvent;
  readonly Content: GameContent;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What the older simulation keeps for one run: the events its steps reported, and their context. */
interface Run {
  readonly events: EventBuffer<SurvivorsEvent>;
  /** One context for all of the run's steps, refilled in place, so a step allocates nothing for it. */
  readonly context: Mutable<Game.StepContext<SurvivorsEvent>>;
}

// Kept by World, never one for the module: every lockstep peer of a process steps its own run
// through this one object, and each run's events are its own.
const runs = new WeakMap<World, Run>();

const runOf = (world: World): Run => {
  const known = runs.get(world);
  if (known !== undefined) {
    return known;
  }
  const events = new EventBuffer<SurvivorsEvent>();
  const run: Run = {
    events,
    context: { dt: 0, step: 0, report: (event) => events.push(event) },
  };
  runs.set(world, run);
  return run;
};

/**
 * The survivors rules as an arcadekit/runtime `GameSimulation`: the `createWorld`, `step` and
 * HUD sample that `Survivors` declares, for the lockstep run, which doesn't host a declared
 * simulation yet. It goes when co-op has moved (ADR-0020).
 */
const survivorsSimulation: GameSimulation<
  SurvivorsConfig,
  World,
  SurvivorsInput,
  SurvivorsEvent
> = {
  stepSeconds: 1 / 60,
  create: (config, seed) => createWorld(config, { seed }),
  step: (world, input, dt) => {
    const { context } = runOf(world);
    context.dt = dt;
    step(world, input, context);
    context.step += 1;
  },
  drainEvents: (world) => runOf(world).events.drain(),
  sample: {
    everyMs: 100,
    version: hudVersion,
    read: (world) => new Hud(hudSample(world)),
  },
};

/**
 * Survivors' lockstep parts: one hero per player, by slot.
 *
 * - `picks`: the content's hero ids. `config` plays them in player order.
 * - `choosing`: the slot's hero has an upgrade offer open.
 * - `settled`: the pick's offer closed, because it was applied or the level-up ended without it.
 * - `localInput`: the device's movement, the held pick and the held pause, as one `HeroInput`.
 * - `localEvent`: the HUD, the local hero's own offer and its own summary.
 */
export const survivorsCoopRules: CoopRules<SurvivorsCoop> = {
  simulation: survivorsSimulation,
  codec: schemaCodec(HeroInput),
  hash: hashWorld,
  picks: (content) => content.heroes.map((hero) => hero.id),
  config: (content, heroIds) => ({ content, heroIds }),
  maxPlayers: MAX_HEROES,
  localInput: () => {
    // One object for the run, refilled each step.
    const input: Mutable<HeroInput> = { moveX: 0, moveZ: 0 };
    return (device, pick, paused) => {
      input.moveX = device === null ? 0 : device.moveX;
      input.moveZ = device === null ? 0 : device.moveZ;
      if (pick === null) {
        delete input.pick;
      } else {
        input.pick = pick;
      }
      if (paused) {
        input.paused = true;
      } else {
        delete input.paused;
      }
      return input;
    };
  },
  settled: (pick, world, slot) =>
    world.offerSeq !== pick.offer || world.heroes[slot]?.offer === null,
  choosing: (world, slot) => {
    const hero = world.heroes[slot];
    return hero !== undefined && hero.offer !== null;
  },
  localEvent: (event, slot) => {
    switch (event._tag) {
      case "Hud": {
        return { type: "hud", hud: event };
      }
      case "LeveledUp": {
        return event.hero === slot
          ? { type: "levelUp", offer: event.offer, choices: event.choices }
          : null;
      }
      case "RunEnded": {
        const summary = event.summaries[slot];
        return summary === undefined ? null : { type: "runEnded", summary };
      }
      case "HeroLeft": {
        return null;
      }
    }
  },
  runEnded: (event) => event._tag === "RunEnded",
};
