import type { GameSimulation } from "@arcadekit/runtime";

import type { SurvivorsEvent } from "./events";
import type { SurvivorsInput } from "./input";
import { createWorld, hudSample, step } from "./world";
import type { SurvivorsConfig, World } from "./world";

/**
 * The survivors genre as a @arcadekit/runtime simulation: what a GameLoop steps, in a browser,
 * a Worker, on a server or in a test. `./browser`'s `makeSurvivorsGame` adds input, the view and sound.
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
