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
 *   const commands = yield* Commands.spawns(Wall).pipe(State.scoping(Phase, "playing"))
 *   commands.spawn(Wall.of({ x: 0 }))    // despawned when the game leaves "playing"
 *
 * A state is a singleton of the world. A save holds it with any pending
 * transition, the world's hash covers it, and a refused action that set it
 * rolls it back.
 *
 * A state makes at most one transition per tick. When several states have
 * pending transitions, they are entered in order of name.
 */
import { Effect, Effectable } from "effect";

import { Component, Field } from "./ecs/component.ts";
import type {
  ComponentDef,
  FieldDef,
  LiteralName,
  SingletonSpec,
} from "./ecs/component.ts";
import { whole } from "./internal/handed.ts";
import { defining, handleOf, scopeOf, scopingOf } from "./internal/state.ts";
import { triggered } from "./internal/system.ts";
import type { AddsOf } from "./Query.ts";
import { World } from "./Services.ts";
import type { Sim, Spawning } from "./Services.ts";
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
export interface Reader<V extends string> {
  /** The current state. */
  readonly value: V;
  /** The requested state that hasn't been entered yet, if any. */
  readonly next: V | undefined;
  // A method, so that a view of any state is a `Reader<string>`.
  /** Returns whether the game is in one of these states. */
  is(...values: readonly V[]): boolean;
}

/**
 * A tick system's handle to a state, from `yield* SomeState.sets`. It reads the
 * current value, and requests another.
 *
 * @category Models
 */
export interface Setter<V extends string> extends Reader<V> {
  // A method, so that a handle of any state is a `Setter<string>`.
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

/**
 * A state's definition. It is an Effect, and `yield*` on it returns a
 * `State.Reader` of the world's value. It is also the singleton that holds that
 * value.
 *
 * @category Models
 */
export class State<V extends string, N extends string = string>
  extends Effectable.Class<Reader<V>, never, World>
  implements SingletonSpec<Fields>
{
  readonly component: ComponentDef<Fields>;
  readonly initial: { value: string; next: string | null; entered: number };
  private effect: Effect.Effect<Reader<V>, never, World> | undefined;
  private writing: Effect.Effect<Setter<V>, never, World | Sim> | undefined;

  constructor(
    readonly name: N,
    readonly values: readonly V[],
    first: V
  ) {
    super();
    const spec = Component.singleton(
      name,
      {
        value: Field.json<string>(first),
        next: Field.json<string | null>(null),
        entered: Field.u8,
      },
      { value: first, next: null, entered: 0 }
    );
    this.component = spec.component;
    this.initial = spec.initial;
    defining(this as unknown as State<string>);
  }

  asEffect(): Effect.Effect<Reader<V>, never, World> {
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
   * The state's `Setter`, which can also `set` it. Requiring it puts `Sim`
   * in the system's requirements, which a frame or input system doesn't
   * accept.
   */
  get sets(): Effect.Effect<Setter<V>, never, World | Sim> {
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
 * A system that spawns all it spawns in a scope names it once instead, with
 * `State.scoping`.
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
 *   the value with `renameStateValue`, and the tag with it.
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
  const scope = scopeOf(state, value);
  if (scope === undefined) {
    throw new Error(
      `The state "${state.name}" has no value "${value}". Its values are: ${state.values.join(", ")}.`
    );
  }
  return scope.tag as ComponentDef<{}, "table", `${N}.Scoped.${S}`, never>;
};

/**
 * Gives every entity a system's commands spawn the tags of these values of a
 * state, as `State.scoped` returns them, so that they are named once and no
 * spawn leaves them off.
 *
 *   const commands = yield* Commands.spawns(Player, Wall, Coin).pipe(
 *     State.scoping(Phase, "playing", "paused")
 *   )
 *   commands.spawn(Wall.of({ x: 0 }))    // despawned when the run ends, kept through a pause
 *
 * **When to use**
 *
 * Use for a system or a hook that spawns what belongs to a level, a run or a
 * screen. A spawn of a tag given by hand, `State.scoped`, is for a system
 * that spawns some of its entities in a scope and some not.
 *
 * **Details**
 *
 * - It pipes on `Commands.spawns`. The commands add, despawn and remove as
 *   they did, and only what they spawn gets the tags.
 * - The tags are in the system's requirements, as those `Commands.spawns`
 *   names, so a system that watches one with `Query.added` is listed after.
 * - A value known only when the system runs, such as the level a state is
 *   in, works as a literal does: `State.scoping(Level, (yield* Level).value)`.
 * - Piped twice, the commands give the tags of both.
 *
 * @category Combinators
 */
export const scoping = <V extends string, N extends string, const S extends V>(
  state: State<V, N>,
  ...values: readonly [S, ...S[]]
): (<C extends string, E, R>(
  self: Effect.Effect<Spawning<C>, E, R>
) => Effect.Effect<
  Spawning<C | `${N}.Scoped.${S}`>,
  E,
  R | AddsOf<`${N}.Scoped.${S}`>
>) => {
  const tags = values.map((value) => scoped(state, value));
  return (self) => Effect.map(self, (commands) => scopingOf(commands, tags));
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
 * Makes a system that runs once when the game enters a state from one of
 * some others, as `State.onEnter` does, and not when it comes from anywhere
 * else.
 *
 *   const StartRun = State.onTransition(Phase, { from: ["menu", "over"], to: "playing" }, "StartRun", function*() {
 *     ...                                // a new run, and not a resume from "paused"
 *   })
 *
 * **When to use**
 *
 * Use when entering a state means one thing from one place and another from
 * another, such as starting a run from the menu and resuming it from a pause.
 * A hook that runs on every entry is `State.onEnter`. An exit hook can tell
 * where the game goes without one: `(yield* Phase).next` is the value it
 * enters.
 *
 * **Details**
 *
 * It is an enter hook of `to`: it runs with the others, in the order they are
 * listed, after the entities scoped to the value the game left are
 * despawned. It never runs on a game's first tick, which comes from no value.
 *
 * @category Constructors
 */
export const onTransition = <
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  V extends string,
>(
  state: State<V>,
  move: {
    readonly from: NoInfer<V> | readonly [NoInfer<V>, ...NoInfer<V>[]];
    readonly to: NoInfer<V>;
  },
  name: N,
  body: System.TickBody<Eff>
): System.System<
  System.GenError<Eff>,
  Exclude<System.GenServices<Eff>, Sim>,
  N,
  "update",
  System.Trigger
> =>
  triggered(System.tick(name, body), {
    state,
    on: "enter",
    value: move.to,
    from: typeof move.from === "string" ? [move.from] : move.from,
  });

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
