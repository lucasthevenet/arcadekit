import type { CommandBuffer } from "../ecs/commands.ts";
import type { Spawned } from "../ecs/spawned.ts";
import type { World } from "../ecs/world.ts";
import type { EventBus } from "./eventBus.ts";
import type { TickDispatcher } from "./tickScheduler.ts";

/**
 * What an app changes the game with. The package's own modules reach it
 * through the app, and nothing outside them can, since an app's type has none
 * of it.
 *
 * @internal
 */
export interface Parts {
  readonly world: World;
  readonly commands: CommandBuffer<Spawned>;
  readonly events: EventBus;
  readonly dispatcher: TickDispatcher;
}

const held = new WeakMap<object, Parts>();

/**
 * Keeps the parts of an app that `App.make` made, for `partsOf` to find.
 *
 * @internal
 */
export const hold = (app: object, parts: Parts): void => {
  held.set(app, parts);
};

/**
 * Returns the parts of an app, and throws for an app `App.make` didn't make.
 *
 * @internal
 */
export const partsOf = (app: object): Parts => {
  const parts = held.get(app);
  if (parts === undefined) {
    throw new Error(
      "An app was given that App.make did not make. Make the app with App.make, and pass it as it was returned."
    );
  }
  return parts;
};
