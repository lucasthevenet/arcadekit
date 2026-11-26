import type {
  ComponentDef,
  Entity,
  Schema,
  SingletonSpec,
  ValueOf,
} from "../ecs/component.ts";
import type { PatchOf, RelationDef } from "../ecs/relation.ts";
import { placed } from "../ecs/spawned.ts";
import type { Spawned } from "../ecs/spawned.ts";
import type { World as EcsWorld } from "../ecs/world.ts";
import type { EventDef, EventReader, ReadingEvents } from "../Event.ts";
import type { ReadingWorld, WritingWorld } from "../Services.ts";
import type * as Singleton from "../Singleton.ts";
import type { EventBus } from "./eventBus.ts";

/**
 * The world as the frame stage, the input stage and `app.read` are handed it:
 * an object of its own, which reads the world behind it and has nothing that
 * changes it. No entry exports this class, so no `instanceof` and no public
 * type reaches that world, which spawns, despawns and restores.
 */
class Read implements ReadingWorld {
  readonly #world: EcsWorld;

  constructor(world: EcsWorld) {
    this.#world = world;
  }

  static whole(world: object): EcsWorld | undefined {
    return #world in world ? (world as Read).#world : undefined;
  }

  get entityCount(): number {
    return this.#world.entityCount;
  }

  get<S extends Schema>(
    entity: Entity,
    def: ComponentDef<S>
  ): ValueOf<S> | undefined {
    return this.#world.get(entity, def);
  }

  has(entity: Entity, def: ComponentDef): boolean {
    return this.#world.has(entity, def);
  }

  hash(): number {
    return this.#world.hash();
  }

  holds<S extends Schema>(spec: SingletonSpec<S>): boolean {
    return this.#world.holds(spec);
  }

  isAlive(entity: Entity.Ref): boolean {
    return this.#world.isAlive(entity);
  }

  live(ref: Entity.Ref): Entity | undefined {
    return this.#world.live(ref);
  }

  placed(id: Spawned): Entity | undefined {
    return placed(this.#world, id);
  }

  singleton<S extends Schema>(spec: SingletonSpec<S>): Singleton.Read<S> {
    return this.#world.singleton(spec) as Singleton.Read<S>;
  }

  sources(target: Entity, def: RelationDef): Entity[] {
    return this.#world.sources(target, def);
  }
}

/** The world as the tick is handed it, by `yield* World`: it reads, and sets. */
class Handed extends Read implements WritingWorld<string> {
  readonly #world: EcsWorld;

  constructor(world: EcsWorld) {
    super(world);
    this.#world = world;
  }

  set<S extends Schema>(
    entity: Entity,
    def: ComponentDef<S>,
    value: PatchOf<S>
  ): boolean {
    return this.#world.set(entity, def, value);
  }
}

/**
 * The same world, to set the components named `N`, as `World.writes` gives it.
 *
 * @internal
 */
export const writing = <N extends string>(world: object): WritingWorld<N> => {
  if (!(world instanceof Handed)) {
    throw new Error(
      "World.writes was asked for outside the tick. The frame stage, the input stage and app.read are handed a world that only reads."
    );
  }
  return world;
};

/**
 * Returns the world the tick is handed, for this world.
 *
 * @internal
 */
export const handed = (world: EcsWorld): WritingWorld<never> =>
  new Handed(world);

/**
 * Returns the world the frame stage, the input stage and `app.read` are
 * handed, for this world.
 *
 * @internal
 */
export const reading = (world: EcsWorld): ReadingWorld => new Read(world);

/**
 * Returns the world behind one that `handed` or `reading` made, which the
 * package's own code reads and writes through.
 *
 * @internal
 */
export const whole = (world: object): EcsWorld => {
  const behind = Read.whole(world);
  if (behind === undefined) {
    throw new Error(
      "The World service was provided something that is not a world. An app provides its own: to read a game from outside one, use app.read(World)."
    );
  }
  return behind;
};

/**
 * The events as the frame stage and the input stage are handed them: an
 * object of its own, which reads the bus behind it and has nothing that
 * emits.
 */
class Heard implements ReadingEvents {
  readonly #bus: EventBus;

  constructor(bus: EventBus) {
    this.#bus = bus;
  }

  handle<P>(def: EventDef<P>): EventReader<P> {
    const handle = this.#bus.handle(def);
    return { read: () => handle.read() };
  }
}

/**
 * Returns the events the frame stage and the input stage are handed, for
 * this bus.
 *
 * @internal
 */
export const hearing = (bus: EventBus): ReadingEvents => new Heard(bus);
