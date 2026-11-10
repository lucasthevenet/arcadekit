import { EventBuffer } from "arcadekit/core";
import * as Game from "arcadekit/game";
import type { GameSimulation } from "arcadekit/runtime";

import { ChooseUpgrade, NoSuchChoice, OfferClosed } from "./commands";
import { HeroLeft, Hud, LeveledUp, RunEnded } from "./events";
import type { SurvivorsEvent } from "./events";
import { SurvivorsInput } from "./input";
import { choose, createWorld, hudSample, hudVersion, step } from "./world";
import type { SurvivorsConfig, World } from "./world";

/**
 * The survivors genre's rules: what `Game.Loop` steps in a browser, a Worker, on a server or in
 * a test, for one hero or for several.
 */
export class Survivors extends Game.Simulation("Survivors", {
  stepSeconds: 1 / 60,
  input: SurvivorsInput,
  events: [LeveledUp, HeroLeft, RunEnded],
  commands: [ChooseUpgrade],
  create: createWorld,
  step,
  apply: {
    ChooseUpgrade: (world, { offer, index }, { player }) => {
      // Decide first, then change: a refused pick leaves the world as it was.
      const hero = world.heroes[player];
      if (
        hero === undefined ||
        hero.offer === null ||
        offer !== world.offerSeq
      ) {
        return new OfferClosed({ offer });
      }
      if (hero.offer[index] === undefined) {
        return new NoSuchChoice({ offer, index });
      }
      choose(world, hero, index);
    },
  },
  // The HUD changes all the time, so it is read every 100 ms; its version moves when the run
  // ends, so the last read comes right after the frame that ended it.
  sample: {
    event: Hud,
    every: "100 millis",
    version: hudVersion,
    read: hudSample,
  },
}) {}

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
 * The survivors rules as an arcadekit/runtime `GameSimulation`: the same `createWorld`, `step`
 * and HUD sample, for the hosts still on the older contract, which are the lockstep run of the
 * Co-op rules and `./browser`'s single-player engine. It goes when they have moved (ADR-0020).
 */
export const survivorsSimulation: GameSimulation<
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
