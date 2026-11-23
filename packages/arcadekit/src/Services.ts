/**
 * The services every system and handler can access with `yield*`.
 */
import { Context, Effect } from "effect";

import type { Actions } from "./Action";
import type {
  ComponentDef,
  ComponentInput,
  Entity,
  Schema,
  Storage,
  ValueOf,
} from "./ecs/component";
import type { Rng } from "./ecs/random";
import { World as EcsWorld } from "./ecs/world";
import type { EventBus } from "./Event";
import type { Devices } from "./Input";
import type { Access, AddsOf, NameOf, WritesOf } from "./Query";

/** What `set` is told of a component its world was not asked for. */
type Settable<C extends string, N extends string> = [N] extends [never]
  ? "This world was asked for with yield* World, which reads. To set a component, ask for it with yield* World.writes(...), naming each component this system sets."
  : C extends N
    ? unknown
    : `World.writes was not given "${C}". Add it where the world is asked for: yield* World.writes(...), with every component this system sets.`;

/**
 * What every world a system or a handler is handed can do: read.
 *
 * @category Models
 */
export interface ReadingWorld extends Pick<
  EcsWorld,
  | "entityCount"
  | "get"
  | "has"
  | "hash"
  | "holds"
  | "isAlive"
  | "singleton"
  | "sources"
> {}

/**
 * The world as a system or a handler is handed it: it reads, and it sets the
 * components named `N`, those `World.writes` was given.
 *
 *   const world = yield* World                  // reads
 *   const world = yield* World.writes(Health)   // reads, and sets Health
 *
 * - `get`, `has`, `isAlive` and `sources` read an entity, `singleton` and
 *   `holds` a singleton, and `entityCount` and `hash` the world.
 * - `set` writes the fields given of one entity's component, and returns false
 *   for an entity that doesn't have it. A component the world was not asked for
 *   doesn't compile, and the error says where to name it.
 * - The set of entities changes through `Commands` alone.
 *
 * @category Models
 */
export interface WritingWorld<N extends string> extends ReadingWorld {
  set<S extends Schema, St extends Storage, C extends string>(
    entity: Entity,
    def: ComponentDef<S, St, C> & Settable<C, N>,
    value: Partial<ValueOf<S>>
  ): boolean;
}

/**
 * The world, for reading. Most systems use queries and `Commands` instead.
 *
 *   const world = yield* World
 *   world.get(target, Health)?.hp
 *
 * `World.writes` gives the same world with a `set` for the components it is
 * given, for writing one entity whose id a system holds:
 *
 *   const world = yield* World.writes(Health)
 *   world.set(target, Health, { hp: 3 })
 *
 * Naming the components puts them in the system's requirements, as a query's
 * `Query.writes` does, so that the order of a list of systems can be checked:
 * see `System.Misordered`.
 *
 * @category Services
 */
export class World extends Context.Service<World, WritingWorld<never>>()(
  "arcadekit/World"
) {
  static readonly writes = <const D extends readonly ComponentDef[]>(
    ..._defs: D
  ): Effect.Effect<
    WritingWorld<NameOf<D[number]>>,
    never,
    World | WritesOf<NameOf<D[number]>>
  > => Effect.map(Effect.service(World), whole);
}

/**
 * The whole world behind the one a system is handed: they are one object, and
 * the type of the second is what a game's code may do with it.
 * @internal
 */
export const whole = (world: ReadingWorld): EcsWorld => {
  if (world instanceof EcsWorld) {
    return world;
  }
  throw new Error(
    "The World service was provided something that is not a world. An app provides its own: to read a game from outside one, use app.world."
  );
};

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

/** What `spawn` and `add` are told of a component their commands were not asked for. */
type Spawnable<C extends string, N extends string> = [N] extends [never]
  ? "These commands were asked for with yield* Commands, which despawn and remove. To spawn or add, ask for them with yield* Commands.spawns(...), naming each component this system spawns or adds."
  : C extends N
    ? unknown
    : `Commands.spawns was not given "${C}". Add it where the commands are asked for: yield* Commands.spawns(...), with every component this system spawns or adds.`;

/**
 * The commands of a system or a handler: changes to the set of entities,
 * queued, and applied when it finishes. They despawn and remove, and they
 * spawn and add the components named `N`, those `Commands.spawns` was given.
 *
 * @category Models
 */
export interface Spawning<N extends string> {
  /**
   * Queues a new entity with these components, and returns its id at once. The
   * entity receives its components when the system finishes.
   */
  spawn<const I extends readonly ComponentInput[]>(
    ...inputs: {
      readonly [K in keyof I]: I[K] & Spawnable<NameOf<I[K]>, N>;
    }
  ): Entity;
  /** Queues a component to add to an entity, or a relation to point elsewhere. */
  add<const I extends ComponentInput>(
    entity: Entity,
    input: I & Spawnable<NameOf<I>, N>
  ): void;
  /** Queues an entity to despawn. */
  despawn(entity: Entity): void;
  /** Queues a component to remove from an entity. */
  remove(entity: Entity, def: ComponentDef): void;
}

/**
 * Deferred changes to the set of entities, applied when the current system
 * finishes.
 *
 *   const commands = yield* Commands
 *   commands.despawn(entity)
 *
 * `Commands.spawns` gives the same commands with a `spawn` and an `add` for the
 * components it is given:
 *
 *   const commands = yield* Commands.spawns(Bullet, Position)
 *   commands.spawn(Bullet, Position.of({ x: 0, y: 0 }))
 *
 * Naming the components puts them in the system's requirements, so that the
 * order of a list of systems can be checked: a system that watches a component
 * with `Query.added` or `Query.changed` is listed after the ones that spawn it.
 * See `System.Misordered`.
 *
 * @category Services
 */
export class Commands extends Context.Service<Commands, Spawning<never>>()(
  "arcadekit/Commands"
) {
  static readonly spawns = <const D extends readonly ComponentDef[]>(
    ..._defs: D
  ): Effect.Effect<
    Spawning<NameOf<D[number]>>,
    never,
    Commands | AddsOf<NameOf<D[number]>>
  > => Effect.service(Commands);
}

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
 * `App.make(game, { seed })`; the same seed produces the same numbers on every
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
 * The services the app provides itself, and what a query's `yield*` says of
 * what it writes and watches, which stands for nothing at run time.
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
  | Devices
  | Access;
