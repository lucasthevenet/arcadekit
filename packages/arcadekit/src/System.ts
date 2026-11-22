/**
 * Systems are one Effect per system per tick, with plain synchronous loops
 * inside.
 *
 *   const Movement = System.make("Movement", function*() {
 *     const moving = yield* Moving
 *     const { delta } = yield* Time
 *     moving.each((pos, vel) => { pos.x += vel.x * delta })
 *   })
 *
 * Systems run stage by stage, and within a stage in the order they are listed:
 * those of a plugin's dependencies, then the plugin's own, then the app's.
 *
 * A system declares nothing of what it reads and writes. What its queries write
 * and watch is in its requirements, from each query it yields, and `App.define`
 * and `Plugin.make` read it there: a list in which a system would react a tick
 * late to another doesn't compile. See `System.Misordered`.
 */
import { Effect } from "effect";
import { dual } from "effect/Function";
import { pipeArguments } from "effect/Pipeable";
import type { Pipeable } from "effect/Pipeable";

import type { Access, Watches, Writes } from "./Query";

/**
 * The stages of a tick, in the order they run.
 *
 * @category Constants
 */
export const stages = ["preUpdate", "update", "postUpdate"] as const;
/**
 * The stages of a frame, in the order they run, mirroring the three of a tick:
 * `"preFrame"` for what a frame's systems depend on, such as which assets are
 * loaded; `"frame"`, where the game is drawn and heard; and `"postFrame"` for
 * what must come after all of that, such as presenting the image on screen.
 *
 * @category Constants
 */
export const frameStages = ["preFrame", "frame", "postFrame"] as const;
/**
 * A stage of the tick, or one of the stages that run between ticks and must not
 * change the world: `"input"`, which reads the devices and turns their input
 * into actions just before a tick, when `app.input` is called; and the three
 * frame stages, `"preFrame"`, `"frame"` and `"postFrame"`, which draw the game
 * when `app.frame` is called.
 *
 * @category Models
 */
export type Stage =
  | (typeof stages)[number]
  | "input"
  | (typeof frameStages)[number];

/**
 * Returns whether a stage is a frame stage.
 *
 * @category Guards
 */
export const isFrameStage = (
  stage: Stage
): stage is (typeof frameStages)[number] =>
  (frameStages as readonly string[]).includes(stage);

/** Every stage, in the order they run when several run together. */
type FrameStage = (typeof frameStages)[number];

const everyStage: readonly Stage[] = [...stages, "input", ...frameStages];

/**
 * What triggers a hook: entering or leaving a state. `State.onEnter` and
 * `State.onExit` create one.
 *
 * @category Models
 */
export interface Trigger {
  /** The state, as `State.define` returned it. */
  readonly state: { readonly name: string };
  readonly on: "enter" | "exit";
  readonly value: string;
}

/**
 * A system: one Effect that runs once per tick, or once per frame, in its
 * stage. Made with `System.make`; `E` is its error and `R` its requirements.
 *
 * `N` is its name, `St` its stage and `Tr` what triggers it if it is a hook,
 * each as the compiler knows it, so that the order of a list of systems can be
 * checked: see `System.Misordered`.
 *
 * @category Models
 */
export interface System<
  out E = never,
  out R = never,
  out N extends string = string,
  out St extends Stage = Stage,
  out Tr extends Trigger | undefined = Trigger | undefined,
> extends Pipeable {
  readonly name: N;
  readonly stage: St;
  readonly run: Effect.Effect<void, E, R>;
  /**
   * Whether the system runs this tick, checked just before it would: every
   * condition given with `runIf`, in order. Undefined for a system that runs
   * every tick, which checks nothing.
   */
  readonly condition: Effect.Effect<boolean, E, R> | undefined;
  /**
   * What the system does instead of running, each time its condition doesn't
   * hold, as `System.otherwise` sets it. Undefined for a system that does
   * nothing then, as most do.
   */
  readonly idle: Effect.Effect<void, E, R> | undefined;
  /**
   * For a hook, what triggers it. A hook runs when that happens, at the start
   * of a tick, separately from the tick's other systems.
   */
  readonly trigger: Tr;
}

const build = <
  E,
  R,
  N extends string,
  St extends Stage,
  Tr extends Trigger | undefined,
>(
  parts: Omit<System<E, R, N, St, Tr>, "pipe">
): System<E, R, N, St, Tr> => ({
  ...parts,
  pipe() {
    return pipeArguments(this, arguments);
  },
});

/**
 * What a generator's effects can fail with, as `Effect.gen` says it.
 *
 * @category Type-level
 */
export type GenError<Eff> = [Eff] extends [never]
  ? never
  : [Eff] extends [Effect.Effect<infer _A, infer E, infer _R>]
    ? E
    : never;

/**
 * What a generator's effects need, as `Effect.gen` says it.
 *
 * @category Type-level
 */
export type GenServices<Eff> = [Eff] extends [never]
  ? never
  : [Eff] extends [Effect.Effect<infer _A, infer _E, infer R>]
    ? R
    : never;

/**
 * Defines a system from a generator.
 *
 * The body is wrapped with `Effect.gen` once, and the same Effect value runs
 * again every tick. It doesn't use `Effect.fn`, which captures a stack trace on
 * every call: that suits a request handler, but not something that runs sixty
 * times a second.
 *
 * A system must finish within its tick: one that waits throws, and the error
 * names it. Work that spans many ticks keeps its place in the world, in a
 * component or a state, and a system moves it on each tick.
 *
 * @category Constructors
 */
export const make = <
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  body: () => Generator<Eff, void, never>
): System<GenError<Eff>, GenServices<Eff>, N, "update", undefined> =>
  build({
    name,
    stage: "update",
    run: Effect.gen(body),
    condition: undefined,
    idle: undefined,
    trigger: undefined,
  });

/**
 * Moves a system to another stage.
 *
 * `System.inStage("frame")` makes it a frame-stage system, for drawing: it runs
 * once per `app.frame`, between ticks, with the world frozen. It reads the
 * world through queries, events and change queries, each tracking its own
 * position, and `yield* Frame` tells it how far the frame is between two ticks.
 * Anything that would change the game throws there.
 *
 * Like a tick, a frame has three stages. `"preFrame"` runs before every
 * `"frame"` system, for what they depend on: `Assets.during` runs there, so all
 * of a frame's systems see the same assets loaded. `"postFrame"` runs after
 * them all, for what needs everything drawn: a renderer presents the image
 * there. All three follow the frame stage's rules for what a system may do.
 *
 * `System.inStage("input")` makes it an input-stage system, for bringing
 * outside input in: it runs once per `app.input`, just before a tick, with the
 * world frozen. `yield* Input.Devices` gives it the current state of the
 * keyboard, the pointer and gamepads, and it issues whatever it derives from
 * that as actions with `Actions.enqueue`, which are logged and applied at the
 * start of the tick. A replay runs no input stage, since the actions are in its
 * log.
 *
 * Write the stage out, `System.inStage("postUpdate")`. The stage is part of the
 * system's type, which is how the order of a list is checked, and a system
 * whose stage the compiler can't read is refused beside one that writes what
 * it watches, or watches what it writes: see `System.Misordered`.
 *
 * @category Combinators
 */
export const inStage: {
  <const S extends Stage>(
    stage: S
  ): <E, R, N extends string, Tr extends Trigger | undefined>(
    self: System<E, R, N, Stage, Tr>
  ) => System<E, R, N, S, Tr>;
  <
    E,
    R,
    N extends string,
    Tr extends Trigger | undefined,
    const S extends Stage,
  >(
    self: System<E, R, N, Stage, Tr>,
    stage: S
  ): System<E, R, N, S, Tr>;
} = dual(
  2,
  <
    E,
    R,
    N extends string,
    Tr extends Trigger | undefined,
    const S extends Stage,
  >(
    self: System<E, R, N, Stage, Tr>,
    stage: S
  ): System<E, R, N, S, Tr> => build({ ...self, stage })
);

/**
 * Runs a system only on ticks when a condition holds:
 *
 *   System.make("Movement", ...).pipe(System.runIf(State.is(Phase, "playing")))
 *
 * The condition is an Effect that returns a boolean, checked each tick just
 * before the system would run. `State.is` creates one from a state; any other
 * condition can read whatever a system can. Given several, the system runs when
 * all of them hold, and they are checked in order until one fails.
 *
 * - A system without a condition checks nothing, and costs nothing extra.
 * - A system that doesn't run doesn't read, and sees nothing of what happened
 *   while it was off. The events from the ticks it skipped are gone when it
 *   runs again, and its change queries and `Query.removed` readers skip what
 *   changed in them: they see what changed after its last skipped turn. A
 *   change query it has never visited still visits everything that matches.
 * - The condition's requirements and errors become the system's.
 *
 * @category Combinators
 */
export const runIf: {
  <E2, R2>(
    condition: Effect.Effect<boolean, E2, R2>
  ): <E, R, N extends string, St extends Stage, Tr extends Trigger | undefined>(
    self: System<E, R, N, St, Tr>
  ) => System<E | E2, R | R2, N, St, Tr>;
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    E2,
    R2,
  >(
    self: System<E, R, N, St, Tr>,
    condition: Effect.Effect<boolean, E2, R2>
  ): System<E | E2, R | R2, N, St, Tr>;
} = dual(
  2,
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    E2,
    R2,
  >(
    self: System<E, R, N, St, Tr>,
    condition: Effect.Effect<boolean, E2, R2>
  ): System<E | E2, R | R2, N, St, Tr> => {
    const earlier = self.condition;
    return build<E | E2, R | R2, N, St, Tr>({
      ...self,
      condition:
        earlier === undefined
          ? condition
          : Effect.flatMap(
              earlier,
              (holds): Effect.Effect<boolean, E | E2, R | R2> =>
                holds ? condition : Effect.succeed(false)
            ),
    });
  }
);

/**
 * Makes a system a hook, set off by `trigger` in place of the tick.
 * @internal
 */
export const triggered = <E, R, N extends string, St extends Stage>(
  self: System<E, R, N, St>,
  trigger: Trigger
): System<E, R, N, St, Trigger> => build({ ...self, trigger });

/**
 * Gives a system something to do instead of running, each time its condition
 * doesn't hold:
 *
 *   const Hud = System.make("Hud", drawHud).pipe(
 *     System.inStage("frame"),
 *     System.runIf(State.is(Phase, "playing")),
 *     System.otherwise(hideHud)
 *   )
 *
 * A system that maintains something outside itself, such as an image on screen
 * or a playing track, leaves it as it last was when it doesn't run. This sets
 * what that thing should be instead.
 *
 * - It runs in the system's place, in its stage and as the system, with its
 *   positions in events and changes. In a tick its commands are applied, and in
 *   a frame it can't change anything.
 * - It doesn't run while the system has no condition, or while every condition
 *   holds. Given twice, both run, in order.
 * - Its requirements and errors become the system's.
 *
 * @category Combinators
 */
export const otherwise: {
  <E2, R2>(
    idle: Effect.Effect<void, E2, R2>
  ): <E, R, N extends string, St extends Stage, Tr extends Trigger | undefined>(
    self: System<E, R, N, St, Tr>
  ) => System<E | E2, R | R2, N, St, Tr>;
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    E2,
    R2,
  >(
    self: System<E, R, N, St, Tr>,
    idle: Effect.Effect<void, E2, R2>
  ): System<E | E2, R | R2, N, St, Tr>;
} = dual(
  2,
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    E2,
    R2,
  >(
    self: System<E, R, N, St, Tr>,
    idle: Effect.Effect<void, E2, R2>
  ): System<E | E2, R | R2, N, St, Tr> =>
    build<E | E2, R | R2, N, St, Tr>({
      ...self,
      idle: self.idle === undefined ? idle : Effect.andThen(self.idle, idle),
    })
);

// --- the order of a list, as the compiler sees it ---------------------------

/** A system of any type. */
type Any = System<unknown, unknown>;

// A name the compiler only knows as `string` says nothing of which component
// it is, as in the requirements of a system typed as any system: left out.
type Named<C extends string> = string extends C ? never : C;
type WrittenBy<R> = R extends Writes<infer C> ? Named<C> : never;
type WatchedBy<R> = R extends Watches<infer C> ? Named<C> : never;

/** Each component a system writes, with the system's name. */
type Wrote<R, N extends string> =
  WrittenBy<R> extends infer C extends string ? readonly [C, N] : never;

/** The systems of a union that write or watch something. */
type Touching<U> =
  U extends System<unknown, infer R>
    ? [Extract<R, Access>] extends [never]
      ? never
      : U
    : never;

/** The systems of a union that the tick runs in the order of the list. */
type Ticking<U> = U extends Any
  ? [U["trigger"]] extends [Trigger]
    ? never
    : [U["stage"]] extends [FrameStage | "input"]
      ? never
      : U
  : never;

/**
 * A list whose order the compiler knows, or one that says nothing of order:
 * a list that isn't a tuple is left out when none of its systems writes or
 * watches anything, and is otherwise kept as it is, in no order.
 */
type Listed<S extends readonly Any[]> = number extends S["length"]
  ? [Touching<S[number]>] extends [never]
    ? readonly []
    : S
  : S;

/** The systems of a tuple, each name once: the first to be listed stays. */
type Once<
  T extends readonly Any[],
  Seen extends string = never,
  Out extends readonly Any[] = readonly [],
> = T extends readonly [
  infer H extends Any,
  ...infer Rest extends readonly Any[],
]
  ? string extends H["name"]
    ? Once<Rest, Seen, readonly [...Out, H]>
    : H["name"] extends Seen
      ? Once<Rest, Seen, Out>
      : Once<Rest, Seen | H["name"], readonly [...Out, H]>
  : Out;

/**
 * The systems of a tuple in the order a tick runs them: stage by stage, as
 * listed. A hook and a system of the frame or input stage run at another
 * moment and are left out, and `loose` holds those whose stage the compiler
 * doesn't know.
 */
type Staged<
  T extends readonly Any[],
  Pre extends readonly Any[] = readonly [],
  Upd extends readonly Any[] = readonly [],
  Post extends readonly Any[] = readonly [],
  Loose = never,
> = T extends readonly [
  infer H extends Any,
  ...infer Rest extends readonly Any[],
]
  ? [H["trigger"]] extends [Trigger]
    ? Staged<Rest, Pre, Upd, Post, Loose>
    : [H["stage"]] extends ["preUpdate"]
      ? Staged<Rest, readonly [...Pre, H], Upd, Post, Loose>
      : [H["stage"]] extends ["update"]
        ? Staged<Rest, Pre, readonly [...Upd, H], Post, Loose>
        : [H["stage"]] extends ["postUpdate"]
          ? Staged<Rest, Pre, Upd, readonly [...Post, H], Loose>
          : [H["stage"]] extends [FrameStage | "input"]
            ? Staged<Rest, Pre, Upd, Post, Loose>
            : Staged<Rest, Pre, Upd, Post, Loose | H>
  : {
      readonly order: readonly [...Pre, ...Upd, ...Post];
      readonly loose: Loose;
    };

/** What is said of a system that watches what a later one writes. */
type Late<
  N extends string,
  C extends string,
  By extends string,
> = `"${N}" watches "${C}" with Query.changed, and "${By}" writes it later in the tick, so "${N}" would react a tick late. List "${N}" after "${By}", or place it in a later stage.`;

type Clash<N extends string, Watched, Later> = Later extends readonly [
  infer C extends string,
  infer By extends string,
]
  ? C extends Watched
    ? Late<N, C, By>
    : never
  : never;

/** From the last system to the first, with what those after it write. */
type Behind<
  T extends readonly Any[],
  Later = never,
  Found = never,
> = T extends readonly [
  ...infer Init extends readonly Any[],
  infer Last extends Any,
]
  ? Last extends System<unknown, infer R, infer N>
    ? Behind<Init, Later | Wrote<R, N>, Found | Clash<N, WatchedBy<R>, Later>>
    : never
  : Found;

type SameName<A extends string, B extends string> = string extends A
  ? false
  : [A] extends [B]
    ? [B] extends [A]
      ? true
      : false
    : false;

/** What is said of two systems whose order the compiler doesn't know. */
type Unknown<
  N extends string,
  C extends string,
  By extends string,
> = `One of "${N}" and "${By}" watches "${C}" with Query.changed and the other writes it, and the compiler cannot tell which runs first. Write the list of systems out where it is given, and give System.inStage a stage it can read.`;

/** A system whose place isn't known, against every other. */
type Unplaced<U, All> =
  U extends System<unknown, infer R, infer N>
    ? All extends System<unknown, infer R2, infer N2>
      ? SameName<N, N2> extends true
        ? never
        :
              | Extract<WatchedBy<R>, WrittenBy<R2>>
              | Extract<WrittenBy<R>, WatchedBy<R2>> extends infer C
          ? C extends string
            ? Unknown<N, C, N2>
            : never
          : never
      : never
    : never;

/**
 * What is wrong with the order of a list of systems, as a union of messages,
 * and `never` when nothing is: a system that watches a component with
 * `Query.changed`, listed ahead of one that writes it in the same tick, sees
 * the write a tick late. `App.define` and `Plugin.make` refuse such a list
 * with this message, so the mistake doesn't compile.
 *
 * What a system writes and watches is in its requirements, from the queries it
 * yields: nothing is declared. Hooks and systems of the frame and input stages
 * run at another moment, and are not checked against the tick's.
 *
 * @category Type-level
 */
export type Misordered<S extends readonly Any[]> =
  Listed<S> extends infer L extends readonly Any[]
    ? number extends L["length"]
      ? Unplaced<Ticking<L[number]>, Ticking<L[number]>>
      : Staged<Once<L>> extends {
            readonly order: infer O extends readonly Any[];
            readonly loose: infer Loose;
          }
        ? Behind<O> | Unplaced<Loose, O[number] | Loose>
        : never
    : never;

/**
 * Two lists of systems, one after the other, as `Misordered` takes them: a
 * list that isn't a tuple and whose systems write and watch nothing is left
 * out.
 *
 * @internal
 */
export type Listing<
  A extends readonly Any[],
  B extends readonly Any[],
> = readonly [...Listed<A>, ...Listed<B>];

/**
 * What `App.define` and `Plugin.make` add to their options: nothing for a list
 * in an order that works, and otherwise a property nobody can give, whose type
 * is the message.
 *
 * @internal
 */
export type Ordered<S extends readonly Any[]> = [Misordered<S>] extends [never]
  ? unknown
  : { readonly order: Misordered<S> };

/**
 * The level of the spans an app makes, as a program's
 * `Tracer.MinimumTraceLevel` sees them.
 * @internal
 */
export const spanLevel = "Debug";

/**
 * A system's name is its place in events and in what changed, so two
 * systems cannot share one.
 * @internal
 */
export const unique = (systems: readonly System<unknown, unknown>[]): void => {
  const names = new Set<string>();
  for (const system of systems) {
    if (names.has(system.name)) {
      throw new Error(`Duplicate system name "${system.name}"`);
    }
    names.add(system.name);
  }
};

/**
 * Sorts systems into run order: by stage, and within a stage in the order they
 * are listed.
 * @internal
 */
export const order = (
  systems: readonly System<unknown, unknown>[]
): System<unknown, unknown>[] => {
  unique(systems);
  return everyStage.flatMap((stage) =>
    systems.filter((system) => system.stage === stage)
  );
};
