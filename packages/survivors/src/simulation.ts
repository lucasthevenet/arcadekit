import type { GameSimulation } from "@gamekit/runtime";

import type { SurvivorsEvent } from "./events";
import { createWorld, hudSample, step } from "./world";
import type { SurvivorsConfig, SurvivorsInput, World } from "./world";

/**
 * The survivors genre as a @gamekit/runtime simulation: what a GameLoop steps, in a browser,
 * a Worker, on a server or in a test. `./browser`'s `survivorsGame` adds input and the view.
 */
export const survivorsSimulation: GameSimulation<
  SurvivorsConfig,
  World,
  SurvivorsInput,
  SurvivorsEvent
> = {
  stepSeconds: 1 / 60,
  create: createWorld,
  step,
  drainEvents: (world) => world.events.drain(),
  sample: {
    everyMs: 100,
    read: (world) => ({ type: "hud", hud: hudSample(world) }),
  },
};
