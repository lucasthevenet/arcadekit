/**
 * The services every system and script can ask for with `yield*`.
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { Actions } from "./Action";
import type { CommandBuffer, World as EcsWorld } from "./ecs/world";
import type { EventBus } from "./Event";

/** The ECS world. Most systems use queries and Commands instead of this. */
export class World extends Context.Service<World, EcsWorld>()("ecs/World") {}

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
  "ecs/Time"
) {}

/** Deferred structural changes, applied when the current system finishes. */
export class Commands extends Context.Service<Commands, CommandBuffer>()(
  "ecs/Commands"
) {}

/** Waiting primitives for long-running scripts (coroutines). */
export class Script extends Context.Service<
  Script,
  {
    /** Suspends the fiber until the next tick. */
    readonly nextTick: Effect.Effect<void>;
    /** Suspends the fiber for a span of game time. */
    readonly sleep: (seconds: number) => Effect.Effect<void>;
  }
>()("ecs/Script") {}

/** The app's event channels. Usually reached by yielding an event definition. */
export class Events extends Context.Service<Events, EventBus>()("ecs/Events") {}

/** Services the app provides itself. */
export type BuiltIn = World | Time | Commands | Script | Events | Actions;
