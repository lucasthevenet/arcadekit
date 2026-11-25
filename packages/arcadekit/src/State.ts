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
import { Effect, Effectable } from "effect";

import { Component, Field } from "./ecs/component";
import type {
  ComponentDef,
  FieldDef,
  LiteralName,
  SingletonSpec,
} from "./ecs/component";
import { definitions, handleOf, scopeMakers } from "./internal/state";
import { triggered } from "./internal/system";
import * as Query from "./Query";
import { World } from "./Services";
import type { Sim } from "./Services";
import { whole } from "./services/handed";
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
> => triggered(System.tick(name, body), { state, on, value });

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
