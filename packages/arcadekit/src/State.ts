/**
 * States: a game is in the menu, playing or paused, and systems run only in
 * some of those.
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
 *   const phase = yield* Phase      // in a system, a handler or a script
 *   phase.value                     // "menu"
 *   phase.set("playing")            // entered at the start of the next tick
 *
 * A state is a singleton of the world: it is saved with a game, with what
 * was asked for, counted in the world's hash, and put back when the action
 * that set it is refused.
 *
 * A state makes one move a tick, and with several states, the ones asked
 * for are entered in order of name.
 */
import { Effect, Effectable } from "effect";

import { Component, Field } from "./ecs/component";
import type { ComponentDef, FieldDef, SingletonSpec } from "./ecs/component";
import type { World as EcsWorld } from "./ecs/world";
import { World } from "./Services";
import * as System from "./System";

/** What the world holds of a state. */
type Fields = {
  /** The state the game is in. */
  readonly value: FieldDef<string, string[]>;
  /** The state that was asked for and is not entered yet, or null. */
  readonly next: FieldDef<string | null, (string | null)[]>;
  /** 1 once the hooks for entering the first state have run. */
  readonly entered: FieldDef<number, Uint8Array>;
};

/**
 * A system's handle to a state, from `yield* SomeState`: which state the
 * game is in, and a way to ask for another.
 *
 * @category Models
 */
export interface StateHandle<V extends string> {
  /** The state the game is in. */
  readonly value: V;
  /** The state that was asked for and has not been entered yet, if one was. */
  readonly next: V | undefined;
  /** Whether the game is in one of these states. */
  readonly is: (...values: readonly V[]) => boolean;
  /**
   * Asks for a state. The game enters it at the start of the next tick:
   * the hooks for leaving the old state run, then the ones for entering
   * the new, and from that tick on systems run as the new state has them.
   * One move a tick: the last ask before it counts. Asking for the state
   * the game is in already takes back an earlier ask, and is not a move.
   */
  readonly set: (value: V) => void;
}

/**
 * A state's definition. It is an Effect, so `yield*` gives a handle to the
 * world's value of it. It is also the singleton that holds that value, so
 * it is listed in a plugin's `components` like one.
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
  }

  asEffect(): Effect.Effect<StateHandle<V>, never, World> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) => {
      // The handle is kept, so it is here that a system which said what it
      // reads is held to it: the world refuses a singleton it did not say.
      if (world.guard !== undefined) {
        world.singleton(this);
      }
      return handleOf(world, this);
    }));
  }
}

/**
 * Defines a state: its name, the values it can take, and the one a game
 * starts in, which is the first when none is given.
 *
 * The name is one of the world's component names. List the state in a
 * plugin's `components`, so that a save which names it can be loaded.
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
  /** In order of name, so that transitions happen in the same order everywhere. */
  states: State<any>[];
  readonly handles: Map<State<any>, StateHandle<any>>;
}

/** @internal The states of a world that anyone has asked for. */
export const registryOf = (world: EcsWorld): Registry => {
  let registry = known.get(world);
  if (registry === undefined) {
    registry = { states: [], handles: new Map() };
    known.set(world, registry);
  }
  return registry;
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
      return held.value as V;
    },
    get next() {
      return (held.next ?? undefined) as V | undefined;
    },
    is: (...values) => values.includes(held.value as V),
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
 * A state's move from one value to another; from nowhere on a game's first tick.
 *
 * @category Models
 */
export interface Move {
  readonly from: string | undefined;
  readonly to: string;
  /**
   * On a game's first tick: the state that was asked for before it, which
   * is entered next, in the same tick.
   */
  readonly followedBy?: string;
}

/**
 * What the start of a tick has to do with one state: nothing, or a move.
 * On a game's first tick that is entering the state it starts in, and then
 * the move that was asked for before it, if one was.
 * @internal
 */
export const pending = (
  world: EcsWorld,
  state: State<any>
): Move | undefined => {
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
export const enter = (world: EcsWorld, state: State<any>, move: Move): void => {
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
 * A condition for `System.runIf`: the game is in one of these states.
 *
 *   System.make("Movement", ...).pipe(System.runIf(State.is(Phase, "playing")))
 *
 * @category Conditions
 */
export const is = <V extends string>(
  state: State<V>,
  ...values: readonly [NoInfer<V>, ...NoInfer<V>[]]
): Effect.Effect<boolean, never, World> =>
  // What it reads is known, so a system that says what it reads and writes
  // need not say it of its condition.
  System.reading(
    Effect.map(state, (handle) => handle.is(...values)),
    [state]
  );

/**
 * Makes a system a hook: it runs once when the game enters a state, at the
 * start of the tick in which it does, before that tick's other systems. It
 * no longer runs every tick.
 *
 * The hooks of the state a game starts in run on its first tick, before
 * any move that was asked for ahead of it, which is made in the same tick.
 * They do not run again when a saved game is loaded: the save holds what
 * they did.
 *
 * Hooks of one moment run in the order they were given, or as
 * `System.after` and `System.before` say, and the commands of each are
 * applied before the next. What a hook asks for, with `set`, waits for the
 * next tick.
 *
 * @category Combinators
 */
export const onEnter =
  <V extends string>(state: State<V>, value: NoInfer<V>) =>
  <E, R>(self: System.System<E, R>): System.System<E, R> =>
    System.triggered(self, { state, on: "enter", value });

/**
 * Makes a system a hook: it runs once when the game leaves a state, at the
 * start of the tick in which it does, before the hooks for the state it
 * enters. `yield*` on the state still gives the one being left.
 *
 * @category Combinators
 */
export const onExit =
  <V extends string>(state: State<V>, value: NoInfer<V>) =>
  <E, R>(self: System.System<E, R>): System.System<E, R> =>
    System.triggered(self, { state, on: "exit", value });
