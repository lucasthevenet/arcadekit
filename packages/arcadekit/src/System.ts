/**
 * Systems are one Effect per system per tick, with plain synchronous loops
 * inside.
 *
 *   const Movement = System.make("Movement", function*() {
 *     const moving = yield* Moving
 *     const { delta } = yield* Time
 *     moving.each((pos, vel) => { pos.x += vel.x * delta })
 *   })
 */
import { Effect } from "effect";
import { dual } from "effect/Function";
import { pipeArguments } from "effect/Pipeable";
import type { Pipeable } from "effect/Pipeable";

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
 * @category Models
 */
export interface System<out E = never, out R = never> extends Pipeable {
  readonly name: string;
  readonly stage: Stage;
  /** Names of systems in the same stage that must run before this one. */
  readonly after: readonly string[];
  /** Names of systems in the same stage that must run after this one. */
  readonly before: readonly string[];
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
  readonly trigger: Trigger | undefined;
}

const build = <E, R>(parts: Omit<System<E, R>, "pipe">): System<E, R> => ({
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
 * names it. Work that spans many ticks belongs in a script, started with
 * `Script.spawn`.
 *
 * @category Constructors
 */
export const make = <Eff extends Effect.Effect<unknown, unknown, unknown>>(
  name: string,
  body: () => Generator<Eff, void, never>
): System<GenError<Eff>, GenServices<Eff>> =>
  build({
    name,
    stage: "update",
    after: [],
    before: [],
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
 * @category Combinators
 */
export const inStage: {
  (stage: Stage): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, stage: Stage): System<E, R>;
} = dual(2, <E, R>(self: System<E, R>, stage: Stage): System<E, R> =>
  build({ ...self, stage })
);

/**
 * Orders a system after another one in the same stage. Naming a system in an
 * earlier stage, which has already run, isn't an error; naming one in a later
 * stage is.
 *
 * **Gotchas**
 *
 * A system keeps its position in the list unless another must run before it, in
 * which case that one moves forward to just ahead of it, and so ahead of every
 * system listed between the two. It may then run before a system it reads
 * from, with no error: order that pair too.
 *
 * @category Combinators
 */
export const after: {
  (
    other: System<unknown, unknown> | string
  ): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(
    self: System<E, R>,
    other: System<unknown, unknown> | string
  ): System<E, R>;
} = dual(
  2,
  <E, R>(
    self: System<E, R>,
    other: System<unknown, unknown> | string
  ): System<E, R> =>
    build({
      ...self,
      after: [...self.after, typeof other === "string" ? other : other.name],
    })
);

/**
 * Orders a system before another one in the same stage. This is how a plugin
 * inserts a system ahead of one from a plugin it depends on. Naming a system in
 * a later stage, which already runs after it, isn't an error; naming one in an
 * earlier stage is.
 *
 * **Gotchas**
 *
 * A system listed after the other moves forward to just ahead of it, and so
 * ahead of every system listed between the two, and a plugin's systems are
 * listed before the app's own. It may then run before a system it reads from,
 * with no error: order that pair too.
 *
 * @category Combinators
 */
export const before: {
  (
    other: System<unknown, unknown> | string
  ): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(
    self: System<E, R>,
    other: System<unknown, unknown> | string
  ): System<E, R>;
} = dual(
  2,
  <E, R>(
    self: System<E, R>,
    other: System<unknown, unknown> | string
  ): System<E, R> =>
    build({
      ...self,
      before: [...self.before, typeof other === "string" ? other : other.name],
    })
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
 * - A system that doesn't run doesn't read. The events from the ticks it
 *   skipped are gone when it runs again, as for any system that falls behind an
 *   event; what its change queries haven't visited is kept, however long it was
 *   disabled.
 * - The condition's requirements and errors become the system's.
 *
 * @category Combinators
 */
export const runIf: {
  <E2, R2>(
    condition: Effect.Effect<boolean, E2, R2>
  ): <E, R>(self: System<E, R>) => System<E | E2, R | R2>;
  <E, R, E2, R2>(
    self: System<E, R>,
    condition: Effect.Effect<boolean, E2, R2>
  ): System<E | E2, R | R2>;
} = dual(
  2,
  <E, R, E2, R2>(
    self: System<E, R>,
    condition: Effect.Effect<boolean, E2, R2>
  ): System<E | E2, R | R2> => {
    const earlier = self.condition;
    return build<E | E2, R | R2>({
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
export const triggered = <E, R>(
  self: System<E, R>,
  trigger: Trigger
): System<E, R> => build({ ...self, trigger });

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
  ): <E, R>(self: System<E, R>) => System<E | E2, R | R2>;
  <E, R, E2, R2>(
    self: System<E, R>,
    idle: Effect.Effect<void, E2, R2>
  ): System<E | E2, R | R2>;
} = dual(
  2,
  <E, R, E2, R2>(
    self: System<E, R>,
    idle: Effect.Effect<void, E2, R2>
  ): System<E | E2, R | R2> =>
    build<E | E2, R | R2>({
      ...self,
      idle: self.idle === undefined ? idle : Effect.andThen(self.idle, idle),
    })
);

/**
 * The system as an app made with `trace` runs it: one span, named after the
 * system, around its condition and whichever of its run or idle follows.
 * @internal
 */
export const traced = <E, R>(self: System<E, R>): System<E, R> =>
  build({
    ...self,
    run: Effect.withSpan(
      self.condition === undefined
        ? self.run
        : Effect.flatMap(self.condition, (holds) =>
            holds ? self.run : (self.idle ?? Effect.void)
          ),
      self.name
    ) as Effect.Effect<void, E, R>,
    condition: undefined,
    idle: undefined,
  });

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
 * Sorts systems into run order: by stage, then by `after` and `before`
 * constraints, keeping registration order where nothing else decides.
 * @internal
 */
export const order = (
  systems: readonly System<unknown, unknown>[]
): System<unknown, unknown>[] => {
  unique(systems);
  const out: System<unknown, unknown>[] = [];
  const stageOf = new Map(systems.map((s) => [s.name, s.stage]));
  for (const stage of everyStage) {
    const inStage = systems.filter((s) => s.stage === stage);
    const stageNames = new Set(inStage.map((s) => s.name));
    // "A before B" is the same constraint as "B after A", so fold both into
    // one map of what must already have run.
    const mustFollow = new Map<string, string[]>();
    for (const system of inStage) {
      mustFollow.set(system.name, []);
    }
    for (const system of inStage) {
      for (const dep of system.after) {
        if (!stageNames.has(dep)) {
          const other = stageOf.get(dep);
          if (other === undefined) {
            throw new Error(
              `System "${system.name}" must run after "${dep}", which is not in the "${stage}" stage`
            );
          }
          // A stage that runs earlier has run: there is nothing to order.
          if (everyStage.indexOf(other) < everyStage.indexOf(stage)) {
            continue;
          }
          throw new Error(
            `System "${system.name}" must run after "${dep}", which is in the "${other}" stage: that stage runs after every system of the "${stage}" stage, this one among them`
          );
        }
        mustFollow.get(system.name)!.push(dep);
      }
      for (const later of system.before) {
        if (!stageNames.has(later)) {
          const other = stageOf.get(later);
          if (other === undefined) {
            throw new Error(
              `System "${system.name}" must run before "${later}", which is not in the "${stage}" stage`
            );
          }
          // A stage that runs later has yet to run: there is nothing to order.
          if (everyStage.indexOf(other) > everyStage.indexOf(stage)) {
            continue;
          }
          throw new Error(
            `System "${system.name}" must run before "${later}", which is in the "${other}" stage: that stage runs before every system of the "${stage}" stage, this one among them`
          );
        }
        mustFollow.get(later)!.push(system.name);
      }
    }
    // Each system keeps its registered position unless something has to run
    // first, in which case those systems are pulled forward to just before it.
    const byName = new Map(inStage.map((system) => [system.name, system]));
    const done = new Set<string>();
    const visiting: string[] = [];
    const place = (system: System<unknown, unknown>): void => {
      if (done.has(system.name)) {
        return;
      }
      if (visiting.includes(system.name)) {
        const cycle = visiting.slice(visiting.indexOf(system.name));
        throw new Error(
          `Circular ordering constraints among: ${cycle.join(", ")}`
        );
      }
      visiting.push(system.name);
      for (const dep of mustFollow.get(system.name)!) {
        place(byName.get(dep)!);
      }
      visiting.pop();
      done.add(system.name);
      out.push(system);
    };
    for (const system of inStage) {
      place(system);
    }
  }
  return out;
};
