/**
 * States model the mode a game is in, such as the menu, playing or paused, and
 * let systems run only in some of them.
 *
 *   const Phase = State.define("game/Phase", ["menu", "playing", "paused"])
 *
 *   const Movement = System.make("Movement", function*() { ... }).pipe(
 *     System.runIf(State.is(Phase, "playing"))
 *   )
 *   const StartLevel = System.make("StartLevel", function*() { ... }).pipe(
 *     State.onEnter(Phase, "playing")
 *   )
 *
 *   const phase = yield* Phase      // in a system or a handler
 *   phase.value                     // "menu"
 *   phase.set("playing")            // entered at the start of the next tick
 *
 * A state is a singleton of the world: it is saved with the game, including any
 * pending transition, included in the world's hash, and rolled back when the
 * action that set it is refused.
 *
 * A state makes at most one transition per tick, and when several states have
 * pending transitions, they are entered in order of name.
 */
import { Effect, Effectable } from "effect";

import { Component, Field } from "./ecs/component";
import type { ComponentDef, FieldDef, SingletonSpec } from "./ecs/component";
import type { World as EcsWorld } from "./ecs/world";
import { World } from "./Services";
import * as System from "./System";

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
 * A system's handle to a state, from `yield* SomeState`: the current state, and
 * a way to request another.
 *
 * @category Models
 */
export interface StateHandle<V extends string> {
  /** The current state. */
  readonly value: V;
  /** The requested state that hasn't been entered yet, if any. */
  readonly next: V | undefined;
  // `is` and `set` are methods, so that a handle of any state is a
  // `StateHandle<string>`.
  /** Returns whether the game is in one of these states. */
  is(...values: readonly V[]): boolean;
  /**
   * Requests a state. The game enters it at the start of the next tick: the
   * exit hooks of the old state run, then the enter hooks of the new one, and
   * from that tick on systems run according to the new state. There is one
   * transition per tick, so the last request before it wins. Requesting the
   * current state cancels an earlier request, and isn't a transition.
   */
  set(value: V): void;
}

// Every state this program has defined, by name, the newest of each: an app
// loaded from a save goes on with the states it holds.
const definitions = new Map<string, State<string>>();

/** @internal The states this program has defined, the newest of each name. */
export const defined = (): Iterable<State<string>> => definitions.values();

/**
 * A state's definition. It is an Effect, so `yield*` returns a handle to the
 * world's value. It is also the singleton that holds that value.
 *
 * @category Models
 */
export class State<V extends string>
  extends Effectable.Class<StateHandle<V>, never, World>
  implements SingletonSpec<Fields>
{
  readonly component: ComponentDef<Fields>;
  readonly initial: { value: string; next: string | null; entered: number };
  private effect: Effect.Effect<StateHandle<V>, never, World> | undefined;

  constructor(
    readonly name: string,
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
    definitions.set(name, this as unknown as State<string>);
  }

  asEffect(): Effect.Effect<StateHandle<V>, never, World> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      handleOf(world, this)
    ));
  }
}

/**
 * Defines a state: its name, its possible values, and the one a game starts in,
 * which defaults to the first.
 *
 * The name is one of the world's component names, and a save that holds the
 * state finds it by that name.
 *
 * @category Constructors
 */
export const define = <const V extends string>(
  name: string,
  values: readonly [V, ...V[]],
  initial?: NoInfer<V>
): State<V> => {
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
  readonly from: string | undefined;
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
 * Returns a condition for `System.runIf` that holds while the game is in one of
 * these states.
 *
 *   System.make("Movement", ...).pipe(System.runIf(State.is(Phase, "playing")))
 *
 * @category Conditions
 */
export const is = <V extends string>(
  state: State<V>,
  ...values: readonly [NoInfer<V>, ...NoInfer<V>[]]
): Effect.Effect<boolean, never, World> =>
  Effect.map(state, (handle) => handle.is(...values));

/**
 * Turns a system into an enter hook: it runs once when the game enters a state,
 * at the start of that tick, before the tick's other systems. It no longer runs
 * every tick.
 *
 * The enter hooks of the initial state run on the game's first tick, before any
 * transition requested ahead of it, which happens in the same tick. They don't
 * run again when a saved game is loaded, since the save holds their effects.
 *
 * Hooks for the same transition run in the order given, or as `System.after`
 * and `System.before` specify, and each hook's commands are applied before the
 * next runs. A state a hook requests with `set` waits for the next tick.
 *
 * @category Combinators
 */
export const onEnter =
  <V extends string>(state: State<V>, value: NoInfer<V>) =>
  <E, R>(self: System.System<E, R>): System.System<E, R> =>
    System.triggered(self, { state, on: "enter", value });

/**
 * Turns a system into an exit hook: it runs once when the game leaves a state,
 * at the start of that tick, before the enter hooks of the next state. `yield*`
 * on the state still returns the one being left.
 *
 * @category Combinators
 */
export const onExit =
  <V extends string>(state: State<V>, value: NoInfer<V>) =>
  <E, R>(self: System.System<E, R>): System.System<E, R> =>
    System.triggered(self, { state, on: "exit", value });

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
