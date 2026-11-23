import type {
  ComponentDef,
  Entity,
  Schema,
  SingletonSpec,
  ValueOf,
} from "../ecs/component";
import type { PatchOf, RelationDef } from "../ecs/relation";
import { placed } from "../ecs/spawned";
import type { Spawned } from "../ecs/spawned";
import type { World as EcsWorld } from "../ecs/world";
import type { WritingWorld } from "../Services";

/**
 * The world as a game's code is handed it, by `yield* World` and by
 * `app.read`: an object of its own, which reads and sets the world behind it.
 * No entry exports this class, so no `instanceof` and no public type reaches
 * that world, which spawns, despawns and restores.
 */
class Handed implements WritingWorld<string> {
  readonly #world: EcsWorld;

  constructor(world: EcsWorld) {
    this.#world = world;
  }

  static whole(world: object): EcsWorld | undefined {
    return #world in world ? (world as Handed).#world : undefined;
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

  isAlive(entity: Entity): boolean {
    return this.#world.isAlive(entity);
  }

  placed(id: Spawned): Entity | undefined {
    return placed(this.#world, id);
  }

  singleton<S extends Schema>(spec: SingletonSpec<S>): ValueOf<S> {
    return this.#world.singleton(spec);
  }

  sources(target: Entity, def: RelationDef): Entity[] {
    return this.#world.sources(target, def);
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
 * The same world, to set the components named `N`: what `World.writes` gives.
 */
export const writing = <N extends string>(world: object): WritingWorld<N> => {
  if (!(world instanceof Handed)) {
    throw new Error(
      "The World service was provided something that is not a world. An app provides its own."
    );
  }
  return world;
};

/** The world a game's code is handed, for this world. */
export const handed = (world: EcsWorld): WritingWorld<never> =>
  new Handed(world);

/**
 * The world behind one `handed` made, or the world itself: what the package's
 * own code reads and writes through.
 */
export const whole = (world: object): EcsWorld => {
  const behind = Handed.whole(world);
  if (behind === undefined) {
    throw new Error(
      "The World service was provided something that is not a world. An app provides its own: to read a game from outside one, use app.read(World)."
    );
  }
  return behind;
};
