import type { CommandBuffer } from "../ecs/commands";
import type { Spawned } from "../ecs/spawned";
import type { World } from "../ecs/world";
import type { EventBus } from "../Event";
import type { TickDispatcher } from "../TickScheduler";

/**
 * What an app changes the game with. The package's own modules reach it by
 * the app, and nothing outside them can: an app's type has none of it.
 */
export interface Parts {
  readonly world: World;
  readonly commands: CommandBuffer<Spawned>;
  readonly events: EventBus;
  readonly dispatcher: TickDispatcher;
}

const held = new WeakMap<object, Parts>();

export const hold = (app: object, parts: Parts): void => {
  held.set(app, parts);
};

export const partsOf = (app: object): Parts => {
  const parts = held.get(app);
  if (parts === undefined) {
    throw new Error(
      "An app was given that App.make did not make. Make the app with App.make, and pass it as it was returned."
    );
  }
  return parts;
};
