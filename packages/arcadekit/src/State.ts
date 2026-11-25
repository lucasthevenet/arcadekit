/**
 * States model the mode a game is in, such as the menu, playing or paused, and
 * let systems run only in some of them.
 *
 *   const Phase = State.define("game/Phase", ["menu", "playing", "paused"])
 *
 *   const Movement = System.tick("Movement", function*() { ... }).pipe(
 *     System.runIf(State.is(Phase, "playing"))
 *   )
 *   const StartLevel = State.onEnter(Phase, "playing", "StartLevel", function*() {
 *     ...
 *   })
 *
 *   const phase = yield* Phase           // value, next, is
 *   const writing = yield* Phase.sets    // a tick system or a handler
 *   writing.set("playing")               // entered at the start of the next tick
 *
 *   commands.spawn(Wall.of({ x: 0 }), State.scoped(Phase, "playing"))
 *                                        // despawned when the game leaves "playing"
 *
 * A state is a singleton of the world. A save holds it with any pending
 * transition, the world's hash covers it, and a refused action that set it
 * rolls it back.
 *
 * A state makes at most one transition per tick. When several states have
 * pending transitions, they are entered in order of name.
 */
import { Effect, Effectable, Exit } from "effect";

import { Component, Field, entityIndex } from "./ecs/component.ts";
import type {
  ComponentDef,
  FieldDef,
  LiteralName,
  SingletonSpec,
} from "./ecs/component.ts";
import type { World as EcsWorld } from "./ecs/world.ts";
import * as Query from "./Query.ts";
import { LoadRefused } from "./Save.ts";
import { World } from "./Services.ts";
import type { Sim } from "./Services.ts";
import { whole } from "./services/handed.ts";
import * as System from "./System.ts";

/** What the world stores for a state. */
type Fields = {
  /** The current state. */
  readonly value: FieldDef<string, string[]>;
  /** The requested state that hasn't been entered yet, or null. */
  readonly next: FieldDef<string | null, (string | null)[]>;
  /** 1 once the enter hooks of the first state have run. */
  readonly entered: FieldDef<number, Uint8Array>;
};

/**
 * What `yield* SomeState` returns in any stage: the current value, the value
 * requested next, and whether it is one of a list. Only a system of the tick
 * or a handler can set the state, with `yield* SomeState.sets`.
 *
 * @category Models
 */
export interface StateView<V extends string> {
  /** The current state. */
  readonly value: V;
  /** The requested state that hasn't been entered yet, if any. */
  readonly next: V | undefined;
  // A method, so that a view of any state is a `StateView<string>`.
  /** Returns whether the game is in one of these states. */
  is(...values: readonly V[]): boolean;
}

/**
 * A tick system's handle to a state, from `yield* SomeState.sets`. It reads the
 * current value, and requests another.
 *
 * @category Models
 */
export interface StateHandle<V extends string> extends StateView<V> {
  // A method, so that a handle of any state is a `StateHandle<string>`.
  /**
   * Requests a state. The game enters it at the start of the next tick. The
   * exit hooks of the old state run, the entities scoped to it are despawned,
   * then the enter hooks of the new one run, and from that tick on systems run
   * according to the new state. There is one transition per tick, so the last
   * request before it wins. Requesting the current state cancels an earlier
   * request, and isn't a transition.
   */
  set(value: V): void;
}

/** A value's tag, and the query of the entities that have it. */
interface Scope<V extends string, N extends string> {
  readonly tag: ComponentDef<{}, "table", `${N}.Scoped.${V}`, never>;
  readonly holders: Query.Query<
    readonly [ComponentDef<{}, "table", `${N}.Scoped.${V}`, never>],
    never
  >;
}

// Every state this program has defined, by name, the newest of each: an app
// loaded from a save goes on with the states it holds.
const definitions = new Map<string, State<string>>();

// The state that made each scope tag, by the tag's name. A state defined
// again without a value leaves that value's tag here, made by the older one.
const scopeMakers = new Map<string, State<string>>();

/** @internal The states this program has defined, the newest of each name. */
export const defined = (): Iterable<State<string>> => definitions.values();

/**
 * A state's definition. It is an Effect, and `yield*` on it returns a
 * `StateView` of the world's value. It is also the singleton that holds that
 * value.
 *
 * @category Models
 */
export class State<V extends string, N extends string = string>
  extends Effectable.Class<StateView<V>, never, World>
  implements SingletonSpec<Fields>
{
  readonly component: ComponentDef<Fields>;
  readonly initial: { value: string; next: string | null; entered: number };
  /** @internal Each value's tag, which `scoped` gives out, and its holders. */
  readonly scopes: ReadonlyMap<V, Scope<V, N>>;
  private effect: Effect.Effect<StateView<V>, never, World> | undefined;
  private writing:
    | Effect.Effect<StateHandle<V>, never, World | Sim>
    | undefined;

  constructor(
    readonly name: N,
    readonly values: readonly V[],
    first: V
  ) {
    super();
    const spec = Component.singleton(
      name,
      {
        value: Field.json<string>(),
        next: Field.json<string | null>(),
        entered: Field.u8,
      },
      { value: first, next: null, entered: 0 }
    );
    this.component = spec.component;
    this.initial = spec.initial;
    this.scopes = new Map(
      values.map((value) => {
        const tag = Component.tag(`${name}.Scoped.${value}` as const);
        return [value, { tag, holders: Query.all(tag) }];
      })
    );
    const made = this as unknown as State<string>;
    for (const { tag } of this.scopes.values()) {
      scopeMakers.set(tag.name, made);
    }
    definitions.set(name, made);
  }

  asEffect(): Effect.Effect<StateView<V>, never, World> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) => {
      const handle = handleOf(whole(world), this);
      return {
        get value() {
          return handle.value;
        },
        get next() {
          return handle.next;
        },
        is: (...values: readonly V[]) => handle.is(...values),
      };
    }));
  }

  /**
   * The state's `StateHandle`, which can also `set` it. Requiring it puts `Sim`
   * in the system's requirements, which a frame or input system doesn't
   * accept.
   */
  get sets(): Effect.Effect<StateHandle<V>, never, World | Sim> {
    return (this.writing ??= Effect.map(Effect.service(World), (world) =>
      handleOf(whole(world), this)
    ));
  }
}

/**
 * Defines a state from its name, its possible values, and the value a game
 * starts in, which defaults to the first.
 *
 * The name is one of the world's component names, a literal the compiler
 * reads, as `Component.define`'s is: a name typed `string` doesn't compile. A
 * save that holds the state finds it by that name.
 *
 * @category Constructors
 */
export const define = <const N extends string, const V extends string>(
  name: LiteralName<N>,
  values: readonly [V, ...V[]],
  initial?: NoInfer<V>
): State<V, N> => {
  const first = initial ?? values[0];
  if (!values.includes(first)) {
    throw new Error(
      `The state "${name}" cannot start in "${first}". Its values are: ${values.join(", ")}.`
    );
  }
  return new State(name, values, first);
};

// A world's states: the ones a handle was asked for, in order of name. An
// app goes through them at the start of every tick.
const known = new WeakMap<EcsWorld, Registry>();

/** @internal */
export interface Registry {
  /** Sorted by name, so transitions happen in the same order everywhere. */
  states: State<string>[];
  readonly handles: Map<State<string>, StateHandle<string>>;
  /** The states a hook waits for, which are entered on the first tick. */
  readonly hooked: Set<State<string>>;
}

/** @internal The states of a world that anyone has asked for. */
export const registryOf = (world: EcsWorld): Registry => {
  let registry = known.get(world);
  if (registry === undefined) {
    registry = { states: [], handles: new Map(), hooked: new Set() };
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
      `The state "${state.name}" holds "${held}", which is not one of its values: ${state.values.join(", ")}. A migration renames a state's values in a save.`
    );
  }
  return value;
};

/** @internal A world's handle to a state. */
export const handleOf = <V extends string>(
  world: EcsWorld,
  state: State<V>
): StateHandle<V> => {
  const registry = registryOf(world);
  const found = registry.handles.get(state);
  if (found !== undefined) {
    return found as StateHandle<V>;
  }
  const held = world.singleton(state);
  const handle: StateHandle<V> = {
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

/**
 * A state's transition from one value to another, or from nothing on a game's
 * first tick.
 *
 * @category Models
 */
export interface Move {
  /** The value the state leaves, or undefined on a game's first tick. */
  readonly from: string | undefined;
  /** The value the state enters. */
  readonly to: string;
  /**
   * On a game's first tick, the state requested before it, which is entered
   * next in the same tick.
   */
  readonly followedBy?: string;
}

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
  const leaving = state.scopes.get(move.from);
  const entering = state.scopes.get(move.to);
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
          message: `The save holds "${name}", the tag of a value the state "${maker.name}" no longer has. Its values are: ${newest?.values.join(", ")}. A migration renames or removes a component in a save.`,
        })
      );
    }
  }
  return Exit.void;
};

/**
 * Returns the tag of an entity that lives only while the game is in this
 * state. When the game leaves the state, the entities that have the tag are
 * despawned, unless they also have the tag of the state it enters.
 *
 * **When to use**
 *
 * Use to tag what a level or a screen spawns, so that leaving it cleans it
 * up, in place of a `State.onExit` hook that despawns each kind of entity.
 *
 * **Details**
 *
 * The entities are despawned after the exit hooks run and before the enter
 * hooks, in order of index, and each despawn takes its relations with it as
 * `Component.relation` says. The tag is a component named
 * `"<state>.Scoped.<value>"`: it is saved, hashed and rewound as any other,
 * and `Commands.spawns` names it, as any component a system spawns.
 *
 * **Gotchas**
 *
 * - An entity with the tags of two values of a state stays while the game
 *   moves between them: tag a level with `"playing"` and `"paused"` to keep
 *   it through a pause.
 * - An entity with the tags of two states is despawned when the game leaves
 *   either.
 * - A save that holds the tag of a value the state no longer has fails to
 *   load with `Save.LoadRefused`, `"unknown component"`. A migration renames
 *   or removes the tag.
 *
 *   const playing = State.scoped(Phase, "playing")
 *   const commands = yield* Commands.spawns(Wall, playing)
 *   commands.spawn(Wall.of({ x: 0 }), playing)
 *
 * @category Components
 */
export const scoped = <V extends string, N extends string, S extends V>(
  state: State<V, N>,
  value: S
): ComponentDef<{}, "table", `${N}.Scoped.${S}`, never> => {
  const scope = state.scopes.get(value);
  if (scope === undefined) {
    throw new Error(
      `The state "${state.name}" has no value "${value}". Its values are: ${state.values.join(", ")}.`
    );
  }
  return scope.tag as ComponentDef<{}, "table", `${N}.Scoped.${S}`, never>;
};

/**
 * Returns a condition for `System.runIf` that holds while the game is in one of
 * these states.
 *
 *   System.tick("Movement", ...).pipe(System.runIf(State.is(Phase, "playing")))
 *
 * @category Conditions
 */
export const is = <V extends string>(
  state: State<V>,
  ...values: readonly [NoInfer<V>, ...NoInfer<V>[]]
): Effect.Effect<boolean, never, World> =>
  Effect.map(state, (handle) => handle.is(...values));

const hook = <
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  V extends string,
>(
  state: State<V>,
  value: NoInfer<V>,
  on: "enter" | "exit",
  name: N,
  body: System.TickBody<Eff>
): System.System<
  System.GenError<Eff>,
  Exclude<System.GenServices<Eff>, Sim>,
  N,
  "update",
  System.Trigger
> => System.triggered(System.tick(name, body), { state, on, value });

/**
 * Makes a system that runs once when the game enters a state, at the start of
 * that tick, before the tick's other systems.
 *
 * The enter hooks of the initial state run on the game's first tick. A
 * transition requested before that tick happens in the same tick, after them.
 * The hooks don't run again when a saved game is loaded, since the save holds
 * their effects.
 *
 * Hooks for the same transition run in the order they are listed, and each
 * hook's commands are applied before the next runs. A state a hook requests
 * with `set` waits for the next tick.
 *
 * @category Constructors
 */
export const onEnter = <
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  V extends string,
>(
  state: State<V>,
  value: NoInfer<V>,
  name: N,
  body: System.TickBody<Eff>
): System.System<
  System.GenError<Eff>,
  Exclude<System.GenServices<Eff>, Sim>,
  N,
  "update",
  System.Trigger
> => hook(state, value, "enter", name, body);

/**
 * Makes a system that runs once when the game leaves a state, at the start of
 * that tick, before the enter hooks of the next state. `yield*` on the state
 * still returns the one being left, and the entities scoped to it, which
 * `State.scoped` tags, are still there.
 *
 * @category Constructors
 */
export const onExit = <
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  V extends string,
>(
  state: State<V>,
  value: NoInfer<V>,
  name: N,
  body: System.TickBody<Eff>
): System.System<
  System.GenError<Eff>,
  Exclude<System.GenServices<Eff>, Sim>,
  N,
  "update",
  System.Trigger
> => hook(state, value, "exit", name, body);

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
