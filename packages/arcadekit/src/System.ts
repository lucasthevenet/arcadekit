/**
 * Systems are one Effect per system per tick, with plain synchronous loops
 * inside.
 *
 *   const Movement = System.tick("Movement", function*() {
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

import type { Store } from "./Assets";
import type { Devices } from "./Input";
import type { Adds, Writes } from "./Query";
import { Sim } from "./Services";
import type { Commands, Frame } from "./Services";
import type { Player } from "./Sound";
import type { Intake, Port } from "./View";

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
type TickStage = (typeof stages)[number];
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
 * stage. Made with `System.tick`, `System.frame` or `System.input`; `E` is its
 * error and `R` its requirements.
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

type TickBan = Frame | Player | Port | Intake | Store | Devices;
type FrameBan =
  | Sim
  | Commands
  | Writes<string>
  | Adds<string>
  | Devices
  | Intake;
type InputBan =
  | Sim
  | Commands
  | Writes<string>
  | Adds<string>
  | Frame
  | Player
  | Port;

const TICK_MSG =
  "A tick reads and changes the simulation. Frame, Sound, View, Assets and Input.Devices are real time: draw and play with System.frame, read the devices with System.input." as const;
const FRAME_MSG =
  "A frame system draws and plays. It cannot change the game: no commands, world.set, query writes, event emit or state set. Read Input.Devices from System.input." as const;
const INPUT_MSG =
  "An input system reads the devices and enqueues actions. It cannot change the game, and it cannot read Frame, play sound or publish a view." as const;

type Body<Eff, Ban, Msg extends string, A = void> = [
  Extract<GenServices<Eff>, Ban>,
] extends [never]
  ? () => Generator<Eff, A, never>
  : { readonly [K in Msg]: Extract<GenServices<Eff>, Ban> };

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
  Extract<GenServices<Eff>, Ban>,
] extends [never]
  ? Eff
  : { readonly [K in Msg]: Extract<GenServices<Eff>, Ban> };

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
 * The body is wrapped with `Effect.gen` once, and the same Effect value runs
 * again every tick. It doesn't use `Effect.fn`, which captures a stack trace on
 * every call: that suits a request handler, but not something that runs sixty
 * times a second.
 *
 * A system must finish within its tick: one that waits throws, and the error
 * names it. Work that spans many ticks keeps its place in the world, in a
 * component or a state, and a system moves it on each tick.
 *
 * The body can require anything a tick provides, and a plugin's own services.
 * Requiring `Frame`, `Sound`, `View`, `Assets` or `Input.Devices` does not
 * compile: those are real time, and belong to `System.frame` or `System.input`.
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
 * Defines a system of the frame, in the `"frame"` stage. It draws and plays,
 * between ticks, and leaves the world as it found it.
 *
 * `System.inStage("preFrame")` or `"postFrame"` moves it within the frame.
 * Requiring commands, a writing query, an event's `emits`, a state's `sets`,
 * a singleton's `writes` or `Input.Devices` does not compile.
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
 * actions, just before a tick, and leaves the world as it found it.
 *
 * Requiring commands, a writing query, an event's `emits`, a state's `sets`,
 * a singleton's `writes`, `Frame`, `Sound` or `View` does not compile.
 * Loading assets does: an input system can issue an action once they are there.
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
 * Moves a system within the group it was made in.
 *
 * A tick system moves among `"preUpdate"`, `"update"` and `"postUpdate"`. A
 * frame system moves among `"preFrame"`, `"frame"` and `"postFrame"`. The
 * input stage is `System.input`. Write the stage out: a stage the compiler
 * can't read is refused beside a system that writes what this one watches, or
 * watches what this one writes. See `System.Misordered`.
 *
 * `"preFrame"` runs before every `"frame"` system, for what they depend on:
 * `Assets.during` runs there, so all of a frame's systems see the same assets
 * loaded. `"postFrame"` runs after them all, for what needs everything drawn.
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

/**
 * Runs a system only on ticks when a condition holds:
 *
 *   System.tick("Movement", ...).pipe(System.runIf(State.is(Phase, "playing")))
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
type Gate<R, Ban, Msg extends string> =
  Extract<R, Ban> extends never
    ? unknown
    : { readonly [K in Msg]: Extract<R, Ban> };

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
 * Gives a system something to do instead of running, each time its condition
 * doesn't hold:
 *
 *   const Hud = System.frame("Hud", drawHud).pipe(
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
