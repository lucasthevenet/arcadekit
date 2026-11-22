/**
 * The stages a game's code runs in, and what each is given. A system asks
 * for the same services wherever it runs, and gets them by its stage:
 *
 * - in the tick, the world to change, the game's time and the game's random
 *   generator, and neither a frame nor the devices;
 * - in the frame stage, the frame being drawn, and a random generator that is
 *   not the game's;
 * - in the input stage, what the devices say, and no frame.
 *
 * A service a stage may not read is there all the same, and throws when it
 * is read, with what to do instead.
 */
import { Context, Random as EffectRandom } from "effect";

import * as Action from "./Action";
import type { CommandBuffer } from "./ecs/commands";
import { Rng } from "./ecs/random";
import type { World as EcsWorld } from "./ecs/world";
import type { EventBus } from "./Event";
import * as Input from "./Input";
import {
  Commands,
  Events,
  Frame,
  Random,
  Ticks,
  Time,
  World,
} from "./Services";
import type { FrameState, TimeState } from "./Services";

/** What the `Actions` service is. */
type Actions = Context.Service.Shape<typeof Action.Actions>;

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

/** A frame for a stage that has none: reading a field of it throws `message`. */
const noFrame = (message: string): Readonly<FrameState> => {
  const refuse = (): never => {
    throw new Error(message);
  };
  return {
    get alpha() {
      return refuse();
    },
    get delta() {
      return refuse();
    },
    get count() {
      return refuse();
    },
  };
};

/** The devices, for a stage that may not read them. */
const noDevices = (): Input.Sample => {
  const refuse = (): never => {
    throw new Error(
      'Input.Devices was read outside the input stage. It is what the devices say now, which is no part of the game. A system that runs in the tick reads the picture the game has of them, Input.Keyboard, Input.Pointer or Input.Gamepad, and what turns the devices into actions is a system of the input stage, System.inStage("input").'
    );
  };
  return {
    get down() {
      return refuse();
    },
    get pressed() {
      return refuse();
    },
    get released() {
      return refuse();
    },
    get axes() {
      return refuse();
    },
    get moved() {
      return refuse();
    },
  };
};

/**
 * The services an app provides itself, as the tick is given them: what a
 * system of the tick, an action's handler and a plugin's setup read. A
 * plugin's layer is built on them.
 *
 * @category Constructors
 */
export const tick = (parts: {
  readonly world: EcsWorld;
  readonly time: Readonly<TimeState>;
  readonly commands: CommandBuffer;
  readonly events: EventBus;
  /** Where `Ticks.more` says the game wants its next tick. */
  readonly intake: Action.Intake;
  readonly actions: Actions;
}) => {
  const { actions, commands, events, intake, time, world } = parts;
  return Context.empty().pipe(
    Context.add(World, world),
    Context.add(Time, time),
    Context.add(Input.Devices, noDevices()),
    Context.add(
      Frame,
      noFrame(
        'Frame was read by a system that runs in the tick. It tells the frame stage how far a frame is between two ticks, in real time, which a simulation must not depend on: read Time instead, or move the system to the frame stage with System.inStage("frame").'
      )
    ),
    Context.add(Commands, commands),
    Context.add(Ticks, {
      more() {
        intake.wanted = true;
      },
    }),
    Context.add(Events, events),
    Context.add(Action.Actions, actions),
    Context.add(Random, world.random),
    Context.add(EffectRandom.Random, effectRandom(world.random))
  );
};

/**
 * What the frame stage is given, from what the tick is: its systems get the
 * world to read and nothing to change it with. What is random there comes
 * from a generator of its own, seeded with `seed`, which is no part of the
 * world; and an action issued there is input from outside.
 *
 * @category Constructors
 */
export const frame = (
  context: Context.Context<unknown>,
  parts: {
    /** The frame being drawn, which the app writes before each run. */
    readonly frame: Readonly<FrameState>;
    readonly actions: Actions;
    readonly seed: number;
  }
): Context.Context<unknown> => {
  const random = new Rng(parts.seed);
  return context.pipe(
    Context.add(Frame, parts.frame),
    Context.add(Random, random),
    Context.add(EffectRandom.Random, effectRandom(random)),
    Context.add(Action.Actions, parts.actions),
    Context.add(Ticks, {
      more() {
        throw new Error(
          "Ticks.more was called in the frame stage or the input stage. Whether the game ticks again is the game's to say, from a system of the tick: what draws it, or reads the devices, runs between ticks and decides nothing of it. A key that should wake the game issues an action."
        );
      },
    })
  );
};

/**
 * What the input stage is given, from what the frame stage is: what the
 * devices say, one picture of them that the app takes when the stage begins,
 * and no frame.
 *
 * @category Constructors
 */
export const input = (
  context: Context.Context<unknown>,
  devices: Input.Sample
): Context.Context<unknown> =>
  context.pipe(
    Context.add(Input.Devices, devices),
    Context.add(
      Frame,
      noFrame(
        "Frame was read by a system of the input stage. It tells the frame stage how far a frame is between two ticks; the input stage runs before a tick, and no frame is being drawn."
      )
    )
  );
