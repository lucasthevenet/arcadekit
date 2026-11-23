/**
 * Systems are a game's logic. Each is one Effect that runs once per tick, or
 * once per frame, with plain synchronous loops inside.
 *
 *   const Movement = System.tick("Movement", function*() {
 *     const moving = yield* Moving
 *     const { delta } = yield* Time
 *     moving.each((pos, vel) => { pos.x += vel.x * delta })
 *   })
 *
 * Systems run stage by stage. Within a stage they run in the order they are
 * listed, those of a plugin's dependencies first, then the plugin's own, then
 * the app's.
 *
 * A system declares nothing of what it reads and writes. Each query it yields
 * puts what the query writes and watches in the system's requirements.
 * `App.define` and `Plugin.make` read them there, and a list in which one
 * system would react a tick late to another doesn't compile. See
 * `System.Misordered`.
 */
import { Effect } from "effect";
import type { Scope } from "effect";
import { dual } from "effect/Function";
import { pipeArguments } from "effect/Pipeable";
import type { Pipeable } from "effect/Pipeable";

import type { Actions } from "./Action";
import type { Devices } from "./Input";
import type { Access, Adds, Writes } from "./Query";
import { Sim } from "./Services";
import type { Commands, Events, Frame, Random, Time, World } from "./Services";
import type { Player } from "./Sound";
import type { Intake, Port } from "./View";

/**
 * The stages of a tick, in the order they run.
 *
 * @category Constants
 */
export const stages = ["preUpdate", "update", "postUpdate"] as const;
/**
 * The stages of a frame, in the order they run. `"preFrame"` is for what a
 * frame's systems depend on, such as which assets are loaded. `"frame"` is
 * where the game is drawn and heard. `"postFrame"` is for what needs
 * everything drawn first, such as presenting the image on screen.
 *
 * @category Constants
 */
export const frameStages = ["preFrame", "frame", "postFrame"] as const;
/**
 * A stage that systems run in. The tick's stages are `"preUpdate"`,
 * `"update"` and `"postUpdate"`. The other stages run between ticks and must
 * not change the world. `"input"` reads the devices and turns their input into
 * actions just before a tick, when `app.input` is called. `"preFrame"`,
 * `"frame"` and `"postFrame"` draw the game when `app.frame` is called.
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
type TickStage = (typeof stages)[number];
type FrameStage = (typeof frameStages)[number];

const everyStage: readonly Stage[] = [...stages, "input", ...frameStages];

/**
 * What triggers a hook, the game entering or leaving one value of a state.
 * `State.onEnter` and `State.onExit` make one.
 *
 * @category Models
 */
export interface Trigger {
  /** The state, as `State.define` returned it. */
  readonly state: { readonly name: string };
  /** Whether the hook runs when the game enters the value or leaves it. */
  readonly on: "enter" | "exit";
  /** The value of the state that the hook is for. */
  readonly value: string;
}

/**
 * A system, one Effect that runs once per tick or once per frame, in its
 * stage. `System.tick`, `System.frame` and `System.input` make one.
 *
 * The compiler knows a system's name, stage and trigger from its type, and
 * `App.define` and `Plugin.make` check the order of a list of systems with
 * them. See `System.Misordered`.
 *
 * @typeParam E what its run can fail with
 * @typeParam R what its run requires
 * @typeParam N its name
 * @typeParam St its stage
 * @typeParam Tr what triggers it, for a hook, and `undefined` for any other
 *   system
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
  /** Its name, which no other system of the app has. */
  readonly name: N;
  readonly stage: St;
  /** The Effect that runs on each of its turns. */
  readonly run: Effect.Effect<void, E, R>;
  /**
   * Whether the system runs, checked each time just before it would. It checks
   * every condition given to `System.runIf`, in order. It is undefined for a
   * system that always runs, which checks nothing.
   */
  readonly condition: Effect.Effect<boolean, E, R> | undefined;
  /**
   * What the system does in place of running, each time its condition doesn't
   * hold, as `System.otherwise` sets it. It is undefined for a system that does
   * nothing then, as most do.
   */
  readonly idle: Effect.Effect<void, E, R> | undefined;
  /**
   * What triggers the system, for a hook. A hook runs when that happens, at
   * the start of a tick, before the tick's other systems.
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

/** A gate that refuses everything but `A`. */
interface Only<out A> {
  readonly "~arcadekit/Only": A;
}

/**
 * What a gate refuses of `R`: what `Ban` names, or all but what `Only` names.
 * `unknown` is what is required before inference has found it, and is refused
 * by neither.
 */
type Refused<R, Ban> =
  Ban extends Only<infer A>
    ? unknown extends R
      ? never
      : Exclude<R, A>
    : Extract<R, Ban>;

/**
 * What the tick may require: the built-in services of the simulation, and
 * what yielding a query, a singleton, a state or an event puts there. A
 * resource requires nothing. A service of the game's own would keep what no
 * save, rewind or refused action sees.
 */
type TickBan = Only<
  World | Time | Commands | Events | Actions | Random | Access | Sim
>;
type FrameBan =
  | Sim
  | Commands
  | Writes<string>
  | Adds<string>
  | Devices
  | Intake
  | Scope.Scope;
type InputBan =
  | Sim
  | Commands
  | Writes<string>
  | Adds<string>
  | Frame
  | Player
  | Port
  | Scope.Scope;

const TICK_MSG =
  "A tick reads and changes the simulation, and requires only its built-in services, queries, singletons, states, events and resources. Keep the game's state in the world (a cache that is rebuilt in a transient field of a singleton), make configuration a Resource, draw and play with System.frame, and read the devices with System.input." as const;
const FRAME_MSG =
  "A frame system draws and plays. It cannot change the game: no commands, world.set, query writes, event emit or state set. Read Input.Devices from System.input. It has no scope to load into: hold a bundle with Assets.during." as const;
const INPUT_MSG =
  "An input system reads the devices and enqueues actions. It cannot change the game, and it cannot read Frame, play sound or publish a view. It has no scope to load into: hold a bundle with Assets.during." as const;

type Body<Eff, Ban, Msg extends string, A = void> = [
  Refused<GenServices<Eff>, Ban>,
] extends [never]
  ? () => Generator<Eff, A, never>
  : { readonly [K in Msg]: Refused<GenServices<Eff>, Ban> };

/**
 * `Ok` when a tick may require `Eff`, and the refusal otherwise. `System.tick`,
 * `State.onEnter`, `Action.handler` and a plugin's `setup` use it.
 *
 * @internal
 */
export type TickGated<
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  Ok,
> =
  Body<Eff, TickBan, typeof TICK_MSG> extends () => Generator<Eff, void, never>
    ? Ok
    : Body<Eff, TickBan, typeof TICK_MSG>;

/**
 * The body of a system of the tick.
 *
 * @internal
 */
export type TickBody<Eff extends Effect.Effect<unknown, unknown, unknown>> =
  TickGated<Eff, () => Generator<Eff, void, never>>;

type Open<R> = Exclude<R, Sim>;

type Checked<R, Ban, Msg extends string> =
  Extract<R, Ban> extends never
    ? unknown
    : { readonly [K in Msg]: Extract<R, Ban> };

/**
 * An effect a frame system may yield. A requirement the frame refuses is an
 * error at the argument, which is how `Assets.during` checks its condition.
 *
 * @internal
 */
export type FrameOk<A, E, R> = Effect.Effect<A, E, R> &
  Checked<R, FrameBan, typeof FRAME_MSG>;

/**
 * The body of a frame system, as `Sound.music` and `View.publish` take it.
 *
 * @internal
 */
export type FrameBody<
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  A = void,
> = Body<Eff, FrameBan, typeof FRAME_MSG, A>;

type EffectBody<Eff, Ban, Msg extends string> = [
  Refused<GenServices<Eff>, Ban>,
] extends [never]
  ? Eff
  : { readonly [K in Msg]: Refused<GenServices<Eff>, Ban> };

/**
 * A plugin's `setup`, or any other Effect that runs as the tick does.
 *
 * @internal
 */
export type TickEffect<Eff extends Effect.Effect<unknown, unknown, unknown>> =
  EffectBody<Eff, TickBan, typeof TICK_MSG>;

/** What `Sim` stands for. A system provides it, and nothing reads it. */
const simulation = { "~arcadekit/Sim": true } as const;

const generate = <Eff extends Effect.Effect<unknown, unknown, unknown>>(
  body: () => Generator<Eff, void, never>
): Effect.Effect<void, GenError<Eff>, Open<GenServices<Eff>>> =>
  Effect.provideService(Effect.gen(body), Sim, simulation);

const define = <
  E,
  R,
  N extends string,
  St extends Stage,
  Tr extends Trigger | undefined,
>(
  name: N,
  stage: St,
  run: Effect.Effect<void, E, R>,
  trigger: Tr
): System<E, R, N, St, Tr> =>
  build({
    name,
    stage,
    run,
    condition: undefined,
    idle: undefined,
    trigger,
  });

/**
 * Defines a system of the tick, in the `"update"` stage.
 *
 * The body can require what a tick provides: `World`, `Time`, `Commands`,
 * `Events`, `Actions` and `Random`, and the queries, singletons, states,
 * events and resources it yields. Anything else does not compile. `Frame`,
 * `Sound`, `View`, `Assets` and `Input.Devices` are real time, and belong to
 * `System.frame` or `System.input`. A service of the game's own would hold
 * what no save, rewind or refused action sees. Keep the game's state in the
 * world, and a cache rebuilt from it in a `Field.transient` field of a
 * singleton.
 *
 * The body is wrapped with `Effect.gen` once, and the same Effect runs on
 * every tick.
 *
 * **Gotchas**
 *
 * - A system must finish within its tick. One that waits throws, and the error
 *   names it. Work that spans many ticks keeps its place in the world, in a
 *   component or a state, and a system moves it on each tick.
 *
 * @category Constructors
 */
export function tick<
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  body: TickBody<Eff>
): System<GenError<Eff>, Open<GenServices<Eff>>, N, "update", undefined>;
export function tick<
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  body: () => Generator<Eff, void, never>
): System<GenError<Eff>, Open<GenServices<Eff>>, N, "update", undefined> {
  return define(name, "update", generate(body), undefined);
}

/**
 * Defines a system of the frame, in the `"frame"` stage. It draws and plays
 * between ticks, and leaves the world as it found it.
 *
 * `System.inStage("preFrame")` or `System.inStage("postFrame")` moves it
 * within the frame. Requiring `Commands`, `World.writes`, a writing query, an
 * event's `emits`, a state's `sets`, a singleton's `writes`, `Input.Devices`
 * or a `Scope` does not compile. A system has no scope of its own, so what it
 * would open, such as with `Assets.load`, has nowhere to be released.
 *
 * @category Constructors
 */
export function frame<
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  body: Body<Eff, FrameBan, typeof FRAME_MSG>
): System<GenError<Eff>, Open<GenServices<Eff>>, N, "frame", undefined>;
export function frame<
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  body: () => Generator<Eff, void, never>
): System<GenError<Eff>, Open<GenServices<Eff>>, N, "frame", undefined> {
  return define(name, "frame", generate(body), undefined);
}

/**
 * A system whose body was checked by the caller. `Assets.during`,
 * `Sound.music` and `View.publish` check a generic effect, then build the
 * system here so the check is not repeated on the type parameter.
 *
 * @internal
 */
export const raw = <
  const N extends string,
  const St extends Stage,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  stage: St,
  body: () => Generator<Eff, void, never>
): System<GenError<Eff>, Open<GenServices<Eff>>, N, St, undefined> =>
  define<GenError<Eff>, Open<GenServices<Eff>>, N, St, undefined>(
    name,
    stage,
    generate(body),
    undefined
  );

/**
 * Defines a system of the input stage. It reads `Input.Devices` and enqueues
 * actions just before a tick, and leaves the world as it found it.
 *
 * Requiring `Commands`, `World.writes`, a writing query, an event's `emits`, a
 * state's `sets`, a singleton's `writes`, `Frame`, `Sound`, `View` or a
 * `Scope` does not compile. Reading a bundle of `Assets` does, so an input system can issue an
 * action once the assets are there.
 *
 * @category Constructors
 */
export function input<
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  body: Body<Eff, InputBan, typeof INPUT_MSG>
): System<GenError<Eff>, Open<GenServices<Eff>>, N, "input", undefined>;
export function input<
  const N extends string,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  body: () => Generator<Eff, void, never>
): System<GenError<Eff>, Open<GenServices<Eff>>, N, "input", undefined> {
  return define(name, "input", generate(body), undefined);
}

type Group<St> = St extends TickStage
  ? TickStage
  : St extends FrameStage
    ? FrameStage
    : never;

type StageArg<S extends string> = S extends TickStage | FrameStage
  ? S
  : `The input stage is System.input(name, body). System.inStage only moves a system within the tick or within the frame.`;

type SameGroup<St extends string, S extends string> =
  S extends Group<St>
    ? unknown
    : `System.inStage("${S}") cannot move a system of "${St}". System.inStage stays inside the tick or inside the frame. A frame system is System.frame, an input system is System.input.`;

/**
 * Moves a system to another stage of the group it was made in.
 *
 * A tick system moves among `"preUpdate"`, `"update"` and `"postUpdate"`. A
 * frame system moves among `"preFrame"`, `"frame"` and `"postFrame"`. A system
 * of the input stage is made with `System.input`, and doesn't move.
 *
 * `"preFrame"` runs before every `"frame"` system, for what they depend on.
 * `Assets.during` runs there, so all of a frame's systems see the same assets
 * loaded. `"postFrame"` runs after them all, for what needs everything drawn.
 *
 * **Gotchas**
 *
 * - Write the stage out. A system whose stage the compiler can't read is
 *   refused in a list where another system writes what it watches, or watches
 *   what it writes. See `System.Misordered`.
 *
 * @category Combinators
 */
export const inStage: {
  <const S extends string>(
    stage: StageArg<S>
  ): <E, R, N extends string, St extends Stage, Tr extends Trigger | undefined>(
    self: System<E, R, N, St, Tr> & SameGroup<St, S>
  ) => System<E, R, N, S extends Group<St> ? S : never, Tr>;
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    const S extends string,
  >(
    self: System<E, R, N, St, Tr> & SameGroup<St, S>,
    stage: StageArg<S>
  ): System<E, R, N, S extends Group<St> ? S : never, Tr>;
} = dual(
  2,
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    const S extends TickStage | FrameStage,
  >(
    self: System<E, R, N, St, Tr>,
    stage: S
  ): System<E, R, N, S, Tr> => build({ ...self, stage })
);

type Gate<R, Ban, Msg extends string> = [Refused<R, Ban>] extends [never]
  ? unknown
  : { readonly [K in Msg]: Refused<R, Ban> };

type StageGate<St, R2> = St extends TickStage
  ? [R2] extends [Gate<R2, TickBan, typeof TICK_MSG>]
    ? unknown
    : Gate<R2, TickBan, typeof TICK_MSG>
  : St extends FrameStage
    ? [R2] extends [Gate<R2, FrameBan, typeof FRAME_MSG>]
      ? unknown
      : Gate<R2, FrameBan, typeof FRAME_MSG>
    : [R2] extends [Gate<R2, InputBan, typeof INPUT_MSG>]
      ? unknown
      : Gate<R2, InputBan, typeof INPUT_MSG>;

/**
 * Runs a system only when a condition holds.
 *
 *   System.tick("Movement", ...).pipe(System.runIf(State.is(Phase, "playing")))
 *
 * The condition is an Effect that returns a boolean, checked each time just
 * before the system would run. `State.is` makes one from a state, and any
 * other condition can read whatever the system can. Given several, the system
 * runs when all of them hold, and they are checked in order until one fails.
 *
 * - A system without a condition checks nothing, and costs nothing extra.
 * - The condition's requirements and errors become the system's.
 *
 * **Gotchas**
 *
 * - A system that doesn't run reads nothing, and sees nothing of what happened
 *   while it was off. The events of the ticks it skipped are gone when it runs
 *   again. Its change queries and `Query.removed` readers skip what changed in
 *   those ticks, and see only what changed after its last skipped turn. A
 *   change query it has never visited still visits everything that matches.
 *
 * @category Combinators
 */
export const runIf: {
  <E2, R2>(
    condition: Effect.Effect<boolean, E2, R2>
  ): <E, R, N extends string, St extends Stage, Tr extends Trigger | undefined>(
    self: System<E, R, N, St, Tr> & StageGate<St, R2>
  ) => System<E | E2, R | Open<R2>, N, St, Tr>;
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    E2,
    R2,
  >(
    self: System<E, R, N, St, Tr> & StageGate<St, R2>,
    condition: Effect.Effect<boolean, E2, R2>
  ): System<E | E2, R | Open<R2>, N, St, Tr>;
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
  ): System<E | E2, R | Open<R2>, N, St, Tr> => {
    const earlier = self.condition;
    const opened = Effect.provideService(condition, Sim, simulation);
    return build<E | E2, R | Open<R2>, N, St, Tr>({
      ...self,
      condition:
        earlier === undefined
          ? opened
          : Effect.flatMap(earlier, (holds) =>
              holds ? opened : Effect.succeed(false)
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
 * Gives a system something to do in place of running, each time its condition
 * doesn't hold.
 *
 *   const Hud = System.frame("Hud", drawHud).pipe(
 *     System.runIf(State.is(Phase, "playing")),
 *     System.otherwise(hideHud)
 *   )
 *
 * **When to use**
 *
 * Use when a system keeps something outside itself up to date, such as an
 * image on screen or a playing track. A system that doesn't run leaves that
 * thing as it last was, and `System.otherwise` sets what it should be instead.
 *
 * **Details**
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
    self: System<E, R, N, St, Tr> & StageGate<St, R2>
  ) => System<E | E2, R | Open<R2>, N, St, Tr>;
  <
    E,
    R,
    N extends string,
    St extends Stage,
    Tr extends Trigger | undefined,
    E2,
    R2,
  >(
    self: System<E, R, N, St, Tr> & StageGate<St, R2>,
    idle: Effect.Effect<void, E2, R2>
  ): System<E | E2, R | Open<R2>, N, St, Tr>;
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
  ): System<E | E2, R | Open<R2>, N, St, Tr> => {
    const opened = Effect.provideService(idle, Sim, simulation);
    return build<E | E2, R | Open<R2>, N, St, Tr>({
      ...self,
      idle:
        self.idle === undefined ? opened : Effect.andThen(self.idle, opened),
    });
  }
);

export type { Duplicated, Listing, Misordered, Ordered } from "./system/order";

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
