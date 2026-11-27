import { Exit } from "effect";

import { CommandBuffer } from "../ecs/commands.ts";
import { Component, entityIndex } from "../ecs/component.ts";
import type { ComponentDef, ComponentInput, Entity } from "../ecs/component.ts";
import type { Spawned } from "../ecs/spawned.ts";
import type { World as EcsWorld } from "../ecs/world.ts";
import * as Query from "../Query.ts";
import { LoadRefused } from "../Save.ts";
import type { Spawning } from "../Services.ts";
import type { Move, Reader, Setter, State } from "../State.ts";

/** A value's tag, and the query of the entities that have it. */
interface Scope<V extends string, N extends string> {
  readonly tag: ComponentDef<{}, "table", `${N}.Scoped.${V}`, never>;
  readonly holders: Query.Query<readonly [], never>;
}

// Every state this program has defined, by name, the newest of each: an app
// loaded from a save goes on with the states it holds.
const definitions = new Map<string, State<string>>();

// The state that made each scope tag, by the tag's name. A state defined
// again without a value leaves that value's tag here, made by the older one.
const scopeMakers = new Map<string, State<string>>();

// Each state's scopes, by value: the tag `State.scoped` gives out, and its holders.
const scopes = new WeakMap<
  State<string>,
  ReadonlyMap<string, Scope<string, string>>
>();

/**
 * @internal Notes a state that was just defined: the newest of its name, and the maker of a tag
 * for each of its values.
 */
export const defining = (state: State<string>): void => {
  const made = new Map(
    state.values.map((value) => {
      const tag = Component.tag(`${state.name}.Scoped.${value}` as const);
      return [value, { tag, holders: Query.all().pipe(Query.with(tag)) }];
    })
  );
  scopes.set(state, made);
  for (const { tag } of made.values()) {
    scopeMakers.set(tag.name, state);
  }
  definitions.set(state.name, state);
};

/** @internal The tag of the entities a state's value holds, and their query, if it has the value. */
export const scopeOf = <V extends string, N extends string>(
  state: State<V, N>,
  value: string
): Scope<V, N> | undefined =>
  scopes.get(state as unknown as State<string>)?.get(value) as
    | Scope<V, N>
    | undefined;

/** @internal The states this program has defined, the newest of each name. */
export const defined = (): Iterable<State<string>> => definitions.values();

// A world's states: the ones a handle was asked for, in order of name. An
// app goes through them at the start of every tick.
const known = new WeakMap<EcsWorld, Registry>();

/** @internal */
export interface Registry {
  /** Sorted by name, so transitions happen in the same order everywhere. */
  states: State<string>[];
  readonly handles: Map<State<string>, Setter<string>>;
  readonly readers: Map<State<string>, Reader<string>>;
  /** The states a hook waits for, which are entered on the first tick. */
  readonly hooked: Set<State<string>>;
}

/** @internal The states of a world that anyone has asked for. */
export const registryOf = (world: EcsWorld): Registry => {
  let registry = known.get(world);
  if (registry === undefined) {
    registry = {
      states: [],
      handles: new Map(),
      readers: new Map(),
      hooked: new Set(),
    };
    known.set(world, registry);
  }
  return registry;
};

/**
 * One of the state's values, as the world holds it: a value that isn't one, as
 * a save from an older game could hold, throws and says which.
 */
const valueOf = <V extends string>(state: State<V>, held: string): V => {
  const value = state.values.find((one) => one === held);
  if (value === undefined) {
    throw new Error(
      `The state "${state.name}" holds "${held}", which is not one of its values: ${state.values.join(", ")}. A step of \`Migrate.step\` renames a value with \`renameStateValue\`.`
    );
  }
  return value;
};

/** @internal A world's handle to a state. */
export const handleOf = <V extends string>(
  world: EcsWorld,
  state: State<V>
): Setter<V> => {
  const registry = registryOf(world);
  const found = registry.handles.get(state);
  if (found !== undefined) {
    return found as Setter<V>;
  }
  const held = world.singleton(state);
  const handle: Setter<V> = {
    get value() {
      return valueOf(state, held.value);
    },
    get next() {
      return held.next === null ? undefined : valueOf(state, held.next);
    },
    is: (...values) => values.some((value) => value === held.value),
    set: (value) => {
      if (!state.values.includes(value)) {
        throw new Error(
          `The state "${state.name}" has no value "${value}". Its values are: ${state.values.join(", ")}.`
        );
      }
      // Only a write when something changes: a write is what puts a
      // singleton in the world's hash.
      const next = value === held.value ? null : value;
      if (held.next !== next) {
        held.next = next;
      }
    },
  };
  registry.handles.set(state, handle);
  registry.states = [...registry.states, state].toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  return handle;
};

/** @internal A world's reader of a state: its handle, without `set`. */
export const readerOf = <V extends string>(
  world: EcsWorld,
  state: State<V>
): Reader<V> => {
  const { readers } = registryOf(world);
  const found = readers.get(state);
  if (found !== undefined) {
    return found as Reader<V>;
  }
  const handle = handleOf(world, state);
  const reader: Reader<V> = {
    get value() {
      return handle.value;
    },
    get next() {
      return handle.next;
    },
    is: (...values) => handle.is(...values),
  };
  readers.set(state, reader);
  return reader;
};

/**
 * What the start of a tick has to do with one state: nothing, or a move.
 * On a game's first tick that is entering the state it starts in, and then
 * the move that was asked for before it, if one was.
 *
 * A state moves once the world holds it, written or loaded, or once a hook
 * waits for it. Until then it is the value it starts in and nothing has to
 * happen: so a look at it from anywhere, the frame stage included, which a
 * replay doesn't run, changes nothing.
 * @internal
 */
export const pending = (
  world: EcsWorld,
  state: State<string>
): Move | undefined => {
  if (!world.holds(state) && !registryOf(world).hooked.has(state)) {
    return undefined;
  }
  const held = world.singleton(state);
  if (held.entered === 0) {
    return held.next === null
      ? { from: undefined, to: held.value }
      : { from: undefined, to: held.value, followedBy: held.next };
  }
  return held.next === null ? undefined : { from: held.value, to: held.next };
};

/**
 * Makes a move: the state has the new value from here on. It is called
 * between the hooks for leaving the old value and the ones for entering
 * the new. What a hook asks for waits for the next tick.
 * @internal
 */
export const enter = (
  world: EcsWorld,
  state: State<string>,
  move: Move
): void => {
  const held = world.singleton(state);
  if (move.from === undefined) {
    held.entered = 1;
    return;
  }
  held.value = move.to;
  if (held.next === move.to) {
    held.next = null;
  }
};

/**
 * Despawns, in order of index, the entities scoped to the value a move leaves
 * and not to the one it enters. It runs after the exit hooks and before the
 * state has its new value.
 * @internal
 */
export const despawnScoped = (
  world: EcsWorld,
  state: State<string>,
  move: Move
): void => {
  if (move.from === undefined) {
    return;
  }
  const leaving = scopeOf(state, move.from);
  const entering = scopeOf(state, move.to);
  // A tag the world never met is held by nothing.
  if (
    leaving === undefined ||
    entering === undefined ||
    world.component(leaving.tag.name) !== leaving.tag
  ) {
    return;
  }
  const doomed = world
    .view(leaving.holders)
    .entities()
    .filter((entity) => !world.has(entity, entering.tag))
    .toSorted((a, b) => entityIndex(a) - entityIndex(b));
  for (const entity of doomed) {
    world.despawn(entity);
  }
};

/**
 * Refuses a world loaded from a save that holds the scope tag of a value its
 * state no longer has, which would otherwise never be despawned.
 * @internal
 */
export const refuseRemovedScopes = (
  world: EcsWorld
): Exit.Exit<void, LoadRefused> => {
  for (const [name, maker] of scopeMakers) {
    const newest = definitions.get(maker.name);
    if (newest !== maker && world.component(name) !== undefined) {
      return Exit.fail(
        new LoadRefused({
          problem: "unknown component",
          message: `The save holds "${name}", the tag of a value the state "${maker.name}" no longer has. Its values are: ${newest?.values.join(", ")}. A step of \`Migrate.step\` renames the value, and its tag with it, with \`renameStateValue\`.`,
        })
      );
    }
  }
  return Exit.void;
};

/**
 * Has a world hold the states its app runs with: those a hook waits for,
 * which are entered on the first tick, and, in a world a save filled, those
 * the save holds, which go on from where they were, transitions included,
 * whether or not anything has looked at them yet.
 * @internal
 */
export const prepare = (
  world: EcsWorld,
  hooked: readonly State<string>[],
  loaded: boolean
): void => {
  const registry = registryOf(world);
  if (loaded) {
    for (const state of defined()) {
      if (world.component(state.name) === state.component) {
        handleOf(world, state);
      }
    }
  }
  for (const state of hooked) {
    handleOf(world, state);
    registry.hooked.add(state);
  }
};

/**
 * Commands that give every entity they spawn the tags of a state's values, as
 * `State.scoping` makes them. They add, despawn, remove and say what is
 * despawning as the commands they wrap do.
 */
class Scoping implements Spawning<string> {
  constructor(
    readonly buffer: CommandBuffer<Spawned>,
    readonly tags: readonly ComponentDef[]
  ) {}

  spawn(...inputs: readonly ComponentInput[]): Spawned {
    return this.buffer.spawn(...inputs, ...this.tags);
  }

  add(entity: Entity | Spawned, input: ComponentInput): void {
    this.buffer.add(entity, input);
  }

  despawn(entity: Entity | Spawned): void {
    this.buffer.despawn(entity);
  }

  despawning(entity: Entity | Spawned): boolean {
    return this.buffer.despawning(entity);
  }

  remove(entity: Entity | Spawned, def: ComponentDef): void {
    this.buffer.remove(entity, def);
  }
}

/**
 * @internal The same commands, giving what they spawn these tags too, beside
 * those of any scoping they already had.
 */
export const scopingOf = (
  commands: object,
  tags: readonly ComponentDef[]
): Spawning<string> => {
  if (commands instanceof Scoping) {
    return new Scoping(commands.buffer, [
      ...commands.tags,
      ...tags.filter((tag) => !commands.tags.includes(tag)),
    ]);
  }
  if (!(commands instanceof CommandBuffer)) {
    throw new Error(
      "State.scoping was given something that is not an app's commands. Pipe it on yield* Commands.spawns(...), in the code of the tick."
    );
  }
  return new Scoping(commands, tags);
};
