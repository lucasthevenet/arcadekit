/**
 * Systems: one Effect per system per tick, with plain synchronous loops inside.
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

/** The stages of a tick, in the order they run. */
export const stages = ["preUpdate", "update", "postUpdate"] as const;
/**
 * The stages of a frame, in the order they run, as a tick has three:
 * `"preFrame"` for what a frame's systems stand on, such as which assets
 * are loaded; `"frame"`, where the game is drawn and heard; and
 * `"postFrame"` for what has to come after all of that, such as putting
 * the picture on the screen.
 */
export const frameStages = ["preFrame", "frame", "postFrame"] as const;
/**
 * A stage of the tick, or one of those that run between ticks and must not
 * change the world: `"input"`, which reads the devices and turns what they
 * say into actions, just before a tick, when `app.input` is called; and
 * the three of a frame, `"preFrame"`, `"frame"` and `"postFrame"`, which
 * draw the game, when `app.frame` is called.
 */
export type Stage =
  | (typeof stages)[number]
  | "input"
  | (typeof frameStages)[number];

/** Whether a stage is one of a frame's. */
export const isFrameStage = (
  stage: Stage
): stage is (typeof frameStages)[number] =>
  (frameStages as readonly string[]).includes(stage);

/** Every stage, in the order they run where more than one is run together. */
const everyStage: readonly Stage[] = [...stages, "input", ...frameStages];

/**
 * What sets a hook off: a state being entered or left. `State.onEnter` and
 * `State.onExit` make one.
 */
export interface Trigger {
  /** The state, as `State.define` gave it. */
  readonly state: { readonly name: string };
  readonly on: "enter" | "exit";
  readonly value: string;
}

export interface System<out E = never, out R = never> extends Pipeable {
  readonly name: string;
  readonly stage: Stage;
  /** Names of systems in the same stage that must run before this one. */
  readonly after: readonly string[];
  /** Names of systems in the same stage that must run after this one. */
  readonly before: readonly string[];
  readonly run: Effect.Effect<void, E, R>;
  /**
   * Whether the system runs this tick, asked just before it would: every
   * condition given with `runIf`, in the order given. Undefined for a
   * system that runs every tick, which is asked nothing.
   */
  readonly condition: Effect.Effect<boolean, E, R> | undefined;
  /**
   * What the system does in place of running, each time its condition does
   * not hold: `System.otherwise` gives it. Undefined for a system that then
   * does nothing, as most do.
   */
  readonly idle: Effect.Effect<void, E, R> | undefined;
  /**
   * For a hook, what sets it off. A hook runs when that happens, at the
   * start of a tick, and not with the tick's other systems.
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
 * Defines a system from a generator.
 *
 * The body is wrapped with `Effect.gen` once, and the same Effect value is
 * re-run every tick. `Effect.fn` is deliberately not used here: it captures a
 * stack trace on every call, which is fine for request handlers but not for
 * something that runs sixty times a second.
 */
export const make = <Eff extends Effect.Effect<any, any, any>>(
  name: string,
  body: () => Generator<Eff, void, never>
): System<Effect.Error<Eff>, Effect.Services<Eff>> =>
  build({
    name,
    stage: "update",
    after: [],
    before: [],
    run: Effect.gen(body) as Effect.Effect<
      void,
      Effect.Error<Eff>,
      Effect.Services<Eff>
    >,
    condition: undefined,
    idle: undefined,
    trigger: undefined,
  });

/**
 * Moves a system to another stage.
 *
 * `System.inStage("frame")` makes it a system of the frame stage, which is
 * for drawing: it runs once per `app.frame`, between ticks, with the world
 * frozen. It reads the world through queries, events and change queries,
 * each from a place of its own, and `yield* Frame` tells it how far the
 * frame is between two ticks. Whatever would change the game there throws.
 *
 * A frame has two more stages, around that one, as a tick has three.
 * `"preFrame"` runs before every system of `"frame"`, for what they stand
 * on: `Assets.during` is there, so that a frame's systems all find the
 * same assets loaded. `"postFrame"` runs after them all, for what needs
 * everything drawn: a renderer puts the picture on the screen there. All
 * three are the frame stage as far as what a system may do goes.
 *
 * `System.inStage("input")` makes it a system of the input stage, which is
 * for bringing the outside in: it runs once per `app.input`, just before a
 * tick, with the world frozen. `yield* Input.Devices` tells it what the
 * keyboard, the pointer and the gamepads say now, and what it makes of
 * that it issues as actions with `Actions.enqueue`, which are logged and
 * applied at the start of the tick. A replay runs no input stage: the
 * actions are in its log.
 */
export const inStage: {
  (stage: Stage): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, stage: Stage): System<E, R>;
} = dual(2, <E, R>(self: System<E, R>, stage: Stage): System<E, R> =>
  build({ ...self, stage })
);

/**
 * Orders a system after another one in the same stage. One in an earlier
 * stage has run already, and naming it is no error; one in a later stage
 * is.
 */
export const after: {
  (
    other: System<any, any> | string
  ): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R>;
} = dual(
  2,
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R> =>
    build({
      ...self,
      after: [...self.after, typeof other === "string" ? other : other.name],
    })
);

/**
 * Orders a system before another one in the same stage. This is how a plugin
 * slots a system in ahead of one that belongs to a plugin it depends on.
 * One in a later stage runs after it already, and naming it is no error;
 * one in an earlier stage is.
 */
export const before: {
  (
    other: System<any, any> | string
  ): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R>;
} = dual(
  2,
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R> =>
    build({
      ...self,
      before: [...self.before, typeof other === "string" ? other : other.name],
    })
);

/**
 * Runs a system only on the ticks when a condition holds:
 *
 *   System.make("Movement", ...).pipe(System.runIf(State.is(Phase, "playing")))
 *
 * The condition is an Effect that gives a boolean, asked each tick just
 * before the system would run. `State.is` makes one from a state; any
 * other can read whatever a system can. Given several, the system runs
 * when all of them hold, and they are asked in order until one does not.
 *
 * - A system with no condition is asked nothing, and costs what it did.
 * - A system that does not run does not read. The events of the ticks it
 *   sat out are gone when it runs again, as they are for any system an
 *   event is older than; what its change queries have yet to visit is
 *   kept, however long it was away.
 * - What the condition needs and can fail with are the system's too.
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
 * Gives a system something to do in place of running, each time its
 * condition does not hold:
 *
 *   const Hud = System.make("Hud", drawHud).pipe(
 *     System.inStage("frame"),
 *     System.runIf(State.is(Phase, "playing")),
 *     System.otherwise(hideHud)
 *   )
 *
 * A system that keeps something outside itself as it should be, a picture
 * on the screen, a track that plays, leaves it as it last was when it is
 * not run. This is how it says what that thing should be then.
 *
 * - It runs in the system's place, in its stage and as the system: with
 *   its place in events and changes, and in a tick its commands are
 *   applied.
 * - It is not asked for while the system has no condition, or while every
 *   condition holds. Given twice, both run, in the order given.
 * - What it needs and can fail with are the system's too.
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

/** Wraps each run in a tracing span named after the system. Use in dev builds. */
export const withSpan = <E, R>(self: System<E, R>): System<E, R> =>
  build({
    ...self,
    run: Effect.withSpan(self.run, self.name) as Effect.Effect<void, E, R>,
  });

/**
 * A system's name is its place in events and in what changed, so two
 * systems cannot share one.
 * @internal
 */
export const unique = (systems: readonly System<any, any>[]): void => {
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
  systems: readonly System<any, any>[]
): System<any, any>[] => {
  unique(systems);
  const out: System<any, any>[] = [];
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
    const place = (system: System<any, any>): void => {
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
