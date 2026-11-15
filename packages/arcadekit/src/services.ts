/**
 * The services every system and script can ask for with `yield*`.
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { Actions } from "./action";
import type { CommandBuffer, World as EcsWorld } from "./ecs/world";
import type { EventBus } from "./event";

// Each service is a typed constant plus a class that extends it. Written in
// one expression, `class X extends Context.Service<...>()("key") {}`, the
// class's type could not be worked out one file at a time, which the build's
// declaration generator requires (isolatedDeclarations).

const WorldService: Context.ServiceClass<World, "ecs/World", EcsWorld> =
  Context.Service<World, EcsWorld>()("ecs/World");

/** The ECS world. Most systems use queries and Commands instead of this. */
export class World extends WorldService {}

export interface TimeState {
  /** Seconds simulated by the current tick. */
  delta: number;
  /** Total simulated seconds. */
  elapsed: number;
  /** Number of ticks run so far. */
  tick: number;
}

const TimeService: Context.ServiceClass<
  Time,
  "ecs/Time",
  Readonly<TimeState>
> = Context.Service<Time, Readonly<TimeState>>()("ecs/Time");

/** Game time. Driven by the tick, not the wall clock, so it is deterministic. */
export class Time extends TimeService {}

const CommandsService: Context.ServiceClass<
  Commands,
  "ecs/Commands",
  CommandBuffer
> = Context.Service<Commands, CommandBuffer>()("ecs/Commands");

/** Deferred structural changes, applied when the current system finishes. */
export class Commands extends CommandsService {}

export interface ScriptApi {
  /** Suspends the fiber until the next tick. */
  readonly nextTick: Effect.Effect<void>;
  /** Suspends the fiber for a span of game time. */
  readonly sleep: (seconds: number) => Effect.Effect<void>;
}

const ScriptService: Context.ServiceClass<Script, "ecs/Script", ScriptApi> =
  Context.Service<Script, ScriptApi>()("ecs/Script");

/** Waiting primitives for long-running scripts (coroutines). */
export class Script extends ScriptService {}

const EventsService: Context.ServiceClass<Events, "ecs/Events", EventBus> =
  Context.Service<Events, EventBus>()("ecs/Events");

/** The app's event channels. Usually reached by yielding an event definition. */
export class Events extends EventsService {}

/** Services the app provides itself. */
export type BuiltIn = World | Time | Commands | Script | Events | Actions;
