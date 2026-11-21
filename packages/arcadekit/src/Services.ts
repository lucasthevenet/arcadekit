/**
 * The services every system and handler can access with `yield*`.
 */
import { Context } from "effect";

import type { Actions } from "./Action";
import type { Rng } from "./ecs/random";
import type { CommandBuffer, World as EcsWorld } from "./ecs/world";
import type { EventBus } from "./Event";
import type { Devices } from "./Input";

/**
 * The ECS world. Most systems use queries and `Commands` instead.
 *
 * @category Services
 */
export class World extends Context.Service<World, EcsWorld>()(
  "arcadekit/World"
) {}

/**
 * The game's time, as `Time` provides it to a system.
 *
 * @category Models
 */
export interface TimeState {
  /** The seconds the current tick simulates. */
  delta: number;
  /** The total simulated seconds. */
  elapsed: number;
  /** The number of ticks run so far. */
  tick: number;
}

/**
 * Game time. The tick drives it, not the wall clock, so it is deterministic.
 * The world holds it, as the singleton `arcadekit/Time`, so its snapshot, a
 * save and its hash cover it.
 *
 * @category Services
 */
export class Time extends Context.Service<Time, Readonly<TimeState>>()(
  "arcadekit/Time"
) {}

/**
 * The frame being drawn, as `Frame` provides it to a frame-stage system.
 *
 * @category Models
 */
export interface FrameState {
  /**
   * How far this frame is between the last tick and the next: from 0, just
   * after a tick, up to 1, just before the next.
   */
  alpha: number;
  /** The real seconds since the previous frame. */
  delta: number;
  /** The number of frames run so far, including this one. */
  count: number;
}

/**
 * The frame a frame-stage system is drawing. It is real time, so keep it out of
 * the simulation: a system that runs in the tick reads `Time`, and reading a
 * field of this there throws.
 *
 * @category Services
 */
export class Frame extends Context.Service<Frame, Readonly<FrameState>>()(
  "arcadekit/Frame"
) {}

/**
 * Deferred structural changes, applied when the current system finishes.
 *
 * @category Services
 */
export class Commands extends Context.Service<Commands, CommandBuffer>()(
  "arcadekit/Commands"
) {}

/**
 * Lets a system tell a driver that ticks only when needed that the game has
 * more to do.
 *
 *   const Countdown = System.make("Countdown", function*() {
 *     const clock = yield* Clock
 *     if (clock.left > 0) {
 *       clock.left -= (yield* Time).delta
 *       ;(yield* Ticks).more()     // not at rest: the next tick is needed
 *     }
 *   })
 *
 * A game that moves only when its player does rests when nothing is pending,
 * and the pending work an app can see is actions, state transitions and
 * events. A system that acts every tick while a condition of its own holds,
 * such as a running clock or a body in flight, isn't among them: it requests
 * the next tick itself, each tick it has more to do. The first tick in which no
 * one requests another is the last, and the game rests.
 *
 * - Call it during the tick, from a system or a handler. Between
 *   ticks it throws: the code that draws the game doesn't decide when it ticks.
 * - Under a driver that ticks in real time it does nothing, and costs nothing
 *   to leave in.
 * - Requests aren't saved. An app that was just created, or loaded from a save,
 *   runs one tick before it rests, in which every system can request again.
 *
 * @category Services
 */
export class Ticks extends Context.Service<
  Ticks,
  {
    /** Signals that the game has more to do: the tick after this one is needed. */
    readonly more: () => void;
  }
>()("arcadekit/Ticks") {}

/**
 * The app's event channels. Usually accessed by yielding an event definition.
 *
 * @category Services
 */
export class Events extends Context.Service<Events, EventBus>()(
  "arcadekit/Events"
) {}

/**
 * Seeded randomness from the world's generator, `world.random`.
 *
 *   const random = yield* Random
 *   random.next()          // from 0 up to, but not including, 1
 *   random.int(1, 6)       // an integer, both ends inclusive
 *   random.pick(items)
 *   random.shuffle(items)  // in place
 *
 * Its methods are plain calls, cheap enough for a loop. Seed the app with
 * `App.make({ seed })`; the same seed produces the same numbers on every
 * machine. The generator's state is part of the world, so it is included in the
 * world's hash and a replay draws the same numbers.
 *
 * - It is the only source of randomness in a simulation. The seed defaults to
 *   0, so a game is repeatable until you seed it from outside.
 * - Inside an app, Effect's own `Random` module is seeded from the same
 *   generator, so `Random.next` from `"effect"`, and anything built on it,
 *   replays too. It costs an Effect per draw, so avoid it in loops.
 * - In the frame and input stages it is the app's own generator, separate from
 *   the world, so drawing can be random without changing the game.
 * - It is not suitable for secrets: a few outputs reveal the rest.
 *
 * @category Services
 */
export class Random extends Context.Service<Random, Rng>()(
  "arcadekit/Random"
) {}

/**
 * The services the app provides itself.
 *
 * @category Type-level
 */
export type BuiltIn =
  | World
  | Time
  | Frame
  | Commands
  | Ticks
  | Events
  | Actions
  | Random
  | Devices;
