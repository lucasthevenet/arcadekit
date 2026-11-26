/**
 * The stages a game's code runs in, and what each is given. A system asks for
 * the same services wherever it runs, and gets them by its stage.
 *
 * - In the tick, it gets the world to change, the game's time and the game's
 *   random generator. It gets neither a frame nor the devices.
 * - In the frame stage, it gets the frame being drawn, and a random generator
 *   that isn't the game's.
 * - In the input stage, it gets what the devices say, and no frame.
 *
 * A service a stage may not use is absent there, and the types refuse a
 * request for it. `Loop` runs the stages.
 */
import { Context, Random as EffectRandom, Option } from "effect";

import * as Action from "../Action.ts";
import type { CommandBuffer } from "../ecs/commands.ts";
import { Component, Field } from "../ecs/component.ts";
import { Rng } from "../ecs/random.ts";
import type { Spawned } from "../ecs/spawned.ts";
import type { World as EcsWorld } from "../ecs/world.ts";
import * as Input from "../Input.ts";
import { Commands, Events, Frame, Random, Time, World } from "../Services.ts";
import type { FrameState, TimeState } from "../Services.ts";
import * as System from "../System.ts";
import type { EventBus } from "./eventBus.ts";
import { handed, hearing, reading } from "./handed.ts";
import { Board } from "./input.ts";
import type { Undrawn } from "./input.ts";

/**
 * The prefix of a reader's name in the world's change logs when it is a
 * system of the frame stage or the input stage. Such a reader isn't part of
 * the simulation: its place in what changed isn't saved.
 *
 * @internal
 */
export const READER = "frame:";

/**
 * A game's time, held by its world so that a snapshot, a restore and the
 * world's hash cover it, as Bevy keeps `Time` in its `World`. `Time` reads it.
 *
 * @internal
 */
export const GameTime = Component.singleton(
  "arcadekit/Time",
  { tick: Field.f64, elapsed: Field.f64, delta: Field.f64 },
  { tick: 0, elapsed: 0, delta: 0 }
);

/**
 * What the `Actions` service is.
 *
 * @category Type-level
 */
export type Actions = Context.Service.Shape<typeof Action.Actions>;

/**
 * Effect's own `Random`, drawing from a generator of the package's: so
 * `Random.next` from "effect", or anything built on it, is seeded and
 * replayed as the generator is.
 */
const effectRandom = (
  random: Rng
): Context.Service.Shape<typeof EffectRandom.Random> => ({
  // 53 random bits: the most a number between 0 and 1 can hold.
  nextDoubleUnsafe: () =>
    ((random.bits() >>> 5) * 67_108_864 + (random.bits() >>> 6)) /
    9_007_199_254_740_992,
  // Any safe integer, negative ones included.
  nextIntUnsafe: () => {
    const magnitude = (random.bits() >>> 11) * 4_294_967_296 + random.bits();
    return (random.bits() & 1) === 0 ? magnitude : -magnitude;
  },
});

/**
 * Makes the services an app provides itself, as the tick is given them. A
 * system of the tick, an action's handler and a plugin's setup read them, and
 * a plugin's layer is built on them.
 *
 * @category Constructors
 */
export const tick = (parts: {
  readonly world: EcsWorld;
  readonly time: Readonly<TimeState>;
  readonly commands: CommandBuffer<Spawned>;
  readonly events: EventBus;
  readonly actions: Actions;
}) => {
  const { actions, commands, events, time, world } = parts;
  return Context.empty().pipe(
    Context.add(World, handed(world)),
    Context.add(Time, time),
    Context.add(Commands, commands),
    Context.add(Events, events),
    Context.add(Action.Actions, actions),
    Context.add(Random, world.random),
    Context.add(EffectRandom.Random, effectRandom(world.random))
  );
};

/**
 * An app's values of each `System.local`, made when one of its systems first
 * asks, and let go of when the app is closed.
 *
 * @internal
 */
export class LocalStore {
  /** Each local's value, and what lets go of it. */
  private readonly values = new Map<
    object,
    { readonly value: unknown; readonly release: () => void }
  >();

  readonly get = <A>(local: System.Local<A>): A => {
    const kept = this.values.get(local);
    if (kept !== undefined) {
      return kept.value as A;
    }
    const value = local.make();
    this.values.set(local, {
      value,
      release: () => local.release?.(value),
    });
    return value;
  };

  /** Lets go of every value, each with its local's `release`. */
  release(): void {
    const made = [...this.values.values()];
    this.values.clear();
    for (const { release } of made) {
      release();
    }
  }
}

/**
 * Makes what the two stages between ticks share from what the app's plugins
 * and its caller provide. It is handed a world that reads, events that read,
 * and no `Commands`: an object of their own each, with nothing that changes
 * the game even to a cast. What is random there comes from a generator of its
 * own, seeded with `seed`, which is no part of the world. An action issued
 * there is input from outside.
 *
 * @category Constructors
 */
export const between = (
  context: Context.Context<unknown>,
  parts: {
    readonly world: EcsWorld;
    readonly time: Readonly<TimeState>;
    readonly events: EventBus;
    readonly actions: Actions;
    readonly seed: number;
    /** What the app's systems keep between frames, `System.local`'s values. */
    readonly locals: LocalStore;
  }
): Context.Context<unknown> => {
  const random = new Rng(parts.seed);
  // Omitted last, which leaves one flat map: each service added is a layer
  // that every later lookup walks through first.
  return context.pipe(
    Context.add(System.Locals, parts.locals),
    Context.add(World, reading(parts.world)),
    Context.add(Time, parts.time),
    Context.add(Events, hearing(parts.events)),
    Context.add(Action.Actions, parts.actions),
    Context.add(Random, random),
    Context.add(EffectRandom.Random, effectRandom(random)),
    Context.omit(Commands)
  );
};

/**
 * Makes what the frame stage is given from what the stages between ticks
 * share. It adds the frame being drawn, and with `Input.plugin` the devices
 * and the controls as a frame reads them: what changed since the last frame,
 * not in the last tick.
 *
 * @category Constructors
 */
export const frame = (
  context: Context.Context<unknown>,
  parts: {
    /** The frame being drawn, which the app writes before each run. */
    readonly frame: Readonly<FrameState>;
    /** The ticks no frame has drawn yet, which the loop keeps. */
    readonly undrawn: Readonly<Undrawn>;
  }
): Context.Context<unknown> => {
  const drawn = Context.add(context, Frame, parts.frame);
  const board = Context.getOption(context, Board);
  return Option.isSome(board)
    ? Context.merge(drawn, board.value.frame(parts.undrawn))
    : drawn;
};

/**
 * Makes what the input stage is given from what the stages between ticks
 * share. It adds what the devices say, one sample of them taken when the
 * stage begins, and with `Input.plugin` the devices and the controls as that
 * sample says them, with the app's bindings.
 *
 * @category Constructors
 */
export const input = (
  context: Context.Context<unknown>,
  devices: Input.Sample
): Context.Context<unknown> => {
  const heard = Context.add(context, Input.Devices, devices);
  const board = Context.getOption(context, Board);
  return Option.isSome(board)
    ? Context.merge(
        heard,
        board.value.input(devices, Context.get(context, System.Locals))
      )
    : heard;
};
