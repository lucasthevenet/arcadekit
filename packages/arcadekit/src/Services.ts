/**
 * The services that systems and handlers ask for with `yield*`.
 *
 *   const { delta } = yield* Time
 *   const commands = yield* Commands.spawns(Bullet)
 *
 * Which of them a system can require depends on its stage. See `System.tick`,
 * `System.frame` and `System.input`.
 */
import { Context, Effect } from "effect";

import type { Actions } from "./Action.ts";
import type {
  ComponentDef,
  ComponentInput,
  Entity,
  RequiredOf,
  Schema,
  SingletonSpec,
  Storage,
  ValueOf,
} from "./ecs/component.ts";
import type { Rng } from "./ecs/random.ts";
import type { PatchOf, Targeted } from "./ecs/relation.ts";
import type { Spawned } from "./ecs/spawned.ts";
import type { World as EcsWorld } from "./ecs/world.ts";
import type { ReadingEvents } from "./Event.ts";
import type { Devices } from "./Input.ts";
import { writing } from "./internal/handed.ts";
import type { Access, AddsOf, NameOf, WritesOf } from "./Query.ts";
import type * as Singleton from "./Singleton.ts";

/**
 * In a system's requirements, says that the system changes the game other than
 * through a component, by emitting an event, setting a state or writing a
 * singleton. A frame or input system can't require it. A system provides it
 * for itself, so an app never asks for it from outside.
 *
 * @category Type-level
 */
export class Sim extends Context.Service<
  Sim,
  { readonly "~arcadekit/Sim": true }
>()("arcadekit/Services.Sim") {}

/** What `set` is told of a component its world was not asked for. */
type Settable<C extends string, N extends string> = C extends N
  ? unknown
  : `World.writes was not given "${C}". Add it where the world is asked for: yield* World.writes(...), with every component this system sets.`;

/**
 * The world as `yield* World` and `app.read` hand it, which reads and has no
 * `set`. To set a component, a system of the tick asks for
 * `yield* World.writes(...)`, naming each component it sets. The frame stage,
 * the input stage and `app.read` are handed this world alone.
 *
 * @category Models
 */
export interface ReadingWorld extends Pick<
  EcsWorld,
  "entityCount" | "has" | "hash" | "holds" | "isAlive" | "live" | "sources"
> {
  /**
   * Returns the entity of an id that `Commands.spawn` returned, once its spawn
   * is applied, and undefined before. The world's reads take an `Entity`, not
   * a `Spawned` id.
   */
  placed(id: Spawned): Entity | undefined;
  /**
   * Returns a copy of an entity's component, or undefined if it doesn't have
   * it.
   */
  get<S extends Schema>(
    entity: Entity,
    def: ComponentDef<S>
  ): Readonly<ValueOf<S>> | undefined;
  /**
   * Returns a singleton, read-only, as a `Singleton.Read`: the world's own
   * object, the same on every call. A system writes one with
   * `yield* Score.writes`.
   */
  singleton<S extends Schema>(spec: SingletonSpec<S>): Singleton.Read<S>;
}

/**
 * The world as a system or a handler is handed it. It reads, and it sets the
 * components named `N`, those that `World.writes` was given.
 *
 *   const world = yield* World                  // reads
 *   const world = yield* World.writes(Health)   // reads, and sets Health
 *
 * - `get`, `has`, `isAlive` and `sources` read an entity, `singleton` and
 *   `holds` a singleton, and `entityCount` and `hash` the world.
 *   `sources(target, ChildOf)` returns the entities that point at `target` with
 *   a relation, and takes no component that isn't a relation.
 * - `live` returns the entity a `Field.entity` value refers to while it is
 *   alive, and undefined once it is despawned. The world's reads take an
 *   `Entity`, not the `Entity.Ref` a field holds.
 * - `placed` returns the entity of an id that `Commands.spawn` returned, once
 *   its spawn is applied, and undefined before. The world's reads take an
 *   `Entity`, not a `Spawned` id.
 * - `set` writes the given fields of one entity's component, and returns false
 *   for an entity that doesn't have it. A component the world wasn't asked for
 *   doesn't compile, and the error says where to name it. A relation's
 *   `target` doesn't compile either. To change it, add the relation again with
 *   `Commands`.
 * - The set of entities changes through `Commands` alone.
 *
 * @category Models
 */
export interface WritingWorld<N extends string> extends ReadingWorld {
  set<S extends Schema, St extends Storage, C extends string>(
    entity: Entity,
    def: ComponentDef<S, St, C> & Settable<C, N>,
    value: PatchOf<S>
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
 * Naming the components puts them in the system's requirements, as
 * `Query.writes` does, so that the order of a list of systems can be checked.
 * See `System.Misordered`.
 *
 * @category Services
 */
export class World extends Context.Service<World, ReadingWorld>()(
  "arcadekit/Services.World"
) {
  /** Returns the world with a `set` for these components. */
  static readonly writes = <const D extends readonly ComponentDef[]>(
    ..._defs: D
  ): Effect.Effect<
    WritingWorld<NameOf<D[number]>>,
    never,
    World | WritesOf<NameOf<D[number]>>
  > =>
    Effect.map(Effect.service(World), (world) =>
      writing<NameOf<D[number]>>(world)
    );
}

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
 * The game's time. The tick moves it on, not the wall clock, so it is
 * deterministic. The world holds it as the singleton `arcadekit/Time`, so a
 * snapshot, a save and the world's hash cover it.
 *
 * @category Services
 */
export class Time extends Context.Service<Time, Readonly<TimeState>>()(
  "arcadekit/Services.Time"
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
 * The frame a frame-stage system is drawing. It is real time, so a system of
 * the tick or the input stage cannot require it. A system of the tick reads
 * `Time`.
 *
 * @category Services
 */
export class Frame extends Context.Service<Frame, Readonly<FrameState>>()(
  "arcadekit/Services.Frame"
) {}

/**
 * What `spawn` and `add` are told of a component their commands were not asked
 * for. Nothing of a relation given bare: `Targeted` tells that, and two
 * messages would make one `never`.
 */
type Spawnable<I, N extends string> =
  unknown extends Targeted<I>
    ? [N] extends [never]
      ? "These commands were asked for with yield* Commands, which despawn and remove. To spawn or add, ask for them with yield* Commands.spawns(...), naming each component this system spawns or adds."
      : NameOf<I> extends N
        ? unknown
        : `Commands.spawns was not given "${NameOf<I>}". Add it where the commands are asked for: yield* Commands.spawns(...), with every component this system spawns or adds.`
    : unknown;

// One component at a time, so that one whose requirements the compiler only
// knows as `string` doesn't make the union `string` and hide the others'.
/** What a spawn or an add of these components fills in. */
type Filled<D> = D extends unknown
  ? string extends RequiredOf<D>
    ? never
    : RequiredOf<D>
  : never;

/**
 * The commands of a system or a handler, which change the set of entities.
 * They are queued, and applied when the system or handler finishes. They
 * despawn and remove, and they spawn and add the components named `N`, those
 * that `Commands.spawns` was given.
 *
 * @category Models
 */
export interface Spawning<N extends string> {
  /**
   * Queues a new entity with these components, and returns its id at once.
   * The id is a `Spawned` id, since the entity is placed when the system
   * finishes. The commands and a component's value take it, and the world's
   * reads don't.
   */
  spawn<const I extends readonly ComponentInput[]>(
    ...inputs: {
      readonly [K in keyof I]: I[K] & Targeted<I[K]> & Spawnable<I[K], N>;
    }
  ): Spawned;
  /** Queues a component to add to an entity, or a relation to point elsewhere. */
  add<const I extends ComponentInput>(
    entity: Entity | Spawned,
    input: I & Targeted<I> & Spawnable<I, N>
  ): void;
  /** Queues an entity to despawn. */
  despawn(entity: Entity | Spawned): void;
  /** Queues a component to remove from an entity. */
  remove(entity: Entity | Spawned, def: ComponentDef): void;
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
 * order of a list of systems can be checked. A system that watches a component
 * with `Query.added` or `Query.changed` is listed after the systems that spawn
 * it. See `System.Misordered`.
 *
 * @category Services
 */
export class Commands extends Context.Service<Commands, Spawning<never>>()(
  "arcadekit/Services.Commands"
) {
  /**
   * Returns the commands with a `spawn` and an `add` for these components.
   * What the components require is in the system's requirements too, since a
   * spawn or an add fills it in, and a system that watches it is listed after.
   */
  static readonly spawns = <const D extends readonly ComponentDef[]>(
    ..._defs: D
  ): Effect.Effect<
    Spawning<NameOf<D[number]>>,
    never,
    Commands | AddsOf<NameOf<D[number]> | Filled<D[number]>>
  > => Effect.service(Commands);
}

/**
 * The app's event channels, to read. A system usually reaches them through an
 * event's definition, with `yield* SomeEvent` to read and
 * `yield* SomeEvent.emits` to emit, which only the tick may.
 *
 * @category Services
 */
export class Events extends Context.Service<Events, ReadingEvents>()(
  "arcadekit/Services.Events"
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
 * `App.make(game, { seed })`. The same seed produces the same numbers on every
 * machine. The generator's state is part of the world, so the world's hash
 * covers it and a replay draws the same numbers.
 *
 * - It is the only source of randomness in a simulation. The seed defaults to
 *   0, so a game is repeatable until you seed it from outside.
 * - Inside an app, Effect's own `Random` module is seeded from the same
 *   generator, so `Random.next` from `"effect"`, and anything built on it,
 *   replays too. It costs an Effect per draw, so don't use it in loops.
 * - In the frame and input stages it is the app's own generator, separate from
 *   the world, so drawing can be random without changing the game.
 * - It isn't suitable for secrets, since a few outputs reveal the rest.
 *
 * @category Services
 */
export class Random extends Context.Service<Random, Rng>()(
  "arcadekit/Services.Random"
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
  | Events
  | Actions
  | Random
  | Devices
  | Access
  | Sim;
