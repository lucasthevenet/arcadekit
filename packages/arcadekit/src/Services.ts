/**
 * The services every system and script can ask for with `yield*`.
 */
import { Context } from "effect";
import type { Effect, Fiber } from "effect";

import type { Actions } from "./Action";
import type { Rng } from "./ecs/random";
import type { CommandBuffer, World as EcsWorld } from "./ecs/world";
import type { EventBus } from "./Event";

/** The ECS world. Most systems use queries and Commands instead of this. */
export class World extends Context.Service<World, EcsWorld>()(
  "arcadekit/World"
) {}

export interface TimeState {
  /** Seconds simulated by the current tick. */
  delta: number;
  /** Total simulated seconds. */
  elapsed: number;
  /** Number of ticks run so far. */
  tick: number;
}

/** Game time. Driven by the tick, not the wall clock, so it is deterministic. */
export class Time extends Context.Service<Time, Readonly<TimeState>>()(
  "arcadekit/Time"
) {}

/** Deferred structural changes, applied when the current system finishes. */
export class Commands extends Context.Service<Commands, CommandBuffer>()(
  "arcadekit/Commands"
) {}

/** How a long-running script (a coroutine) waits, and how a system starts one. */
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

/** The app's event channels. Usually reached by yielding an event definition. */
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
 */
export class Random extends Context.Service<Random, Rng>()(
  "arcadekit/Random"
) {}

/** Services the app provides itself. */
export type BuiltIn =
  | World
  | Time
  | Commands
  | Script
  | Events
  | Actions
  | Random;
