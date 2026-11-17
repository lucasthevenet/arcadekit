/**
 * The services every system and script can ask for with `yield*`.
 */
import { Context } from "effect";
import type { Effect, Fiber } from "effect";

import type { Actions } from "./Action";
import type { Rng } from "./ecs/random";
import type { CommandBuffer, World as EcsWorld } from "./ecs/world";
import type { EventBus } from "./Event";
import type { Devices } from "./Input";

/**
 * The ECS world. Most systems use queries and Commands instead of this.
 *
 * @category Services
 */
export class World extends Context.Service<World, EcsWorld>()(
  "arcadekit/World"
) {}

/**
 * The game's time, as `Time` gives it to a system.
 *
 * @category Models
 */
export interface TimeState {
  /** Seconds simulated by the current tick. */
  delta: number;
  /** Total simulated seconds. */
  elapsed: number;
  /** Number of ticks run so far. */
  tick: number;
}

/**
 * Game time. Driven by the tick, not the wall clock, so it is deterministic.
 *
 * @category Services
 */
export class Time extends Context.Service<Time, Readonly<TimeState>>()(
  "arcadekit/Time"
) {}

/**
 * The frame being drawn, as `Frame` gives it to a system of the frame stage.
 *
 * @category Models
 */
export interface FrameState {
  /**
   * How far this frame is between the last tick and the next: from 0, just
   * after a tick, up to 1, just before the next.
   */
  alpha: number;
  /** Real seconds since the frame before this one. */
  delta: number;
  /** Number of frames run so far, this one included. */
  count: number;
}

/**
 * What a system of the frame stage is told about the frame it draws. Real
 * time, so not for the simulation: a system that runs in the tick reads
 * `Time`, and asking for a field of this there throws.
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
 * How a long-running script (a coroutine) waits, and how a system starts one.
 *
 * @category Services
 */
export class Script extends Context.Service<
  Script,
  {
    /** Suspends the fiber until the next tick. */
    readonly nextTick: Effect.Effect<void>;
    /** Suspends the fiber for a span of game time. */
    readonly sleep: (seconds: number) => Effect.Effect<void>;
    /**
     * Starts a script from a system, a handler or another script. It first
     * runs when the tick flushes its scheduler, after the systems.
     *
     * The app watches it as it does one started with `app.spawnScript`: a
     * failure is reported, and it is interrupted when the app's scope closes.
     * A fiber started with `Effect.forkDetach` is not watched.
     */
    readonly spawn: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>;
  }
>()("arcadekit/Script") {}

/**
 * How a system says that the game has more to do, to a driver that ticks
 * only when needed.
 *
 *   const Countdown = System.make("Countdown", function*() {
 *     const clock = yield* Clock
 *     if (clock.left > 0) {
 *       clock.left -= (yield* Time).delta
 *       ;(yield* Ticks).more()     // not at rest: the next tick is needed
 *     }
 *   })
 *
 * A game that moves when its player does rests when nothing is waiting,
 * and what an app can see waiting is actions, states, scripts and events.
 * A system that does something every tick for as long as a condition of
 * its own holds, a clock that runs, a body in flight, is not among them:
 * it asks for the next tick itself, each tick it has more to do. The tick
 * in which nobody asks is the last, and the game rests.
 *
 * - It is asked in the tick, by a system, a handler or a script. Between
 *   ticks it throws: what draws the game does not decide when it ticks.
 * - Under a driver that ticks in real time it does nothing, and costs
 *   nothing to leave in.
 * - What was asked is not saved. An app that has just been made, or loaded
 *   from a save, runs one tick before it rests, in which every system can
 *   ask again.
 *
 * @category Services
 */
export class Ticks extends Context.Service<
  Ticks,
  {
    /** The game has more to do: the tick after this one is needed. */
    readonly more: () => void;
  }
>()("arcadekit/Ticks") {}

/**
 * The app's event channels. Usually reached by yielding an event definition.
 *
 * @category Services
 */
export class Events extends Context.Service<Events, EventBus>()(
  "arcadekit/Events"
) {}

/**
 * Seeded randomness: the world's generator, `world.random`.
 *
 *   const random = yield* Random
 *   random.next()          // from 0 up to, not including, 1
 *   random.int(1, 6)       // a whole number, both ends included
 *   random.pick(items)
 *   random.shuffle(items)  // in place
 *
 * Its methods are plain calls, fine inside a loop. The app is seeded with
 * `App.make({ seed })`, and the same seed gives the same numbers on every
 * machine. The generator's state is part of the world, so it is in the
 * world's hash and a replay draws the same numbers.
 *
 * @category Services
 */
export class Random extends Context.Service<Random, Rng>()(
  "arcadekit/Random"
) {}

/**
 * Services the app provides itself.
 *
 * @category Type-level
 */
export type BuiltIn =
  | World
  | Time
  | Frame
  | Commands
  | Script
  | Ticks
  | Events
  | Actions
  | Random
  | Devices;
