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

import type { ComponentDef, SingletonSpec } from "./ecs/component";
import type { QuerySpec } from "./ecs/world";
import type { EventDef } from "./Event";

/**
 * The stages of a tick, in the order they run.
 *
 * @category Constants
 */
export const stages = ["preUpdate", "update", "postUpdate"] as const;
/**
 * The stages of a frame, in the order they run, as a tick has three:
 * `"preFrame"` for what a frame's systems stand on, such as which assets
 * are loaded; `"frame"`, where the game is drawn and heard; and
 * `"postFrame"` for what has to come after all of that, such as putting
 * the picture on the screen.
 *
 * @category Constants
 */
export const frameStages = ["preFrame", "frame", "postFrame"] as const;
/**
 * A stage of the tick, or one of those that run between ticks and must not
 * change the world: `"input"`, which reads the devices and turns what they
 * say into actions, just before a tick, when `app.input` is called; and
 * the three of a frame, `"preFrame"`, `"frame"` and `"postFrame"`, which
 * draw the game, when `app.frame` is called.
 *
 * @category Models
 */
export type Stage =
  | (typeof stages)[number]
  | "input"
  | (typeof frameStages)[number];

/**
 * Whether a stage is one of a frame's.
 *
 * @category Guards
 */
export const isFrameStage = (
  stage: Stage
): stage is (typeof frameStages)[number] =>
  (frameStages as readonly string[]).includes(stage);

/** Every stage, in the order they run where more than one is run together. */
const everyStage: readonly Stage[] = [...stages, "input", ...frameStages];

/**
 * What sets a hook off: a state being entered or left. `State.onEnter` and
 * `State.onExit` make one.
 *
 * @category Models
 */
export interface Trigger {
  /** The state, as `State.define` gave it. */
  readonly state: { readonly name: string };
  readonly on: "enter" | "exit";
  readonly value: string;
}

/**
 * What a system's access is said of: a component, a singleton or a state,
 * or an event.
 *
 * @category Models
 */
export type Touched = ComponentDef<any> | SingletonSpec<any> | EventDef<any>;

/**
 * What a system says it reads and writes: `System.access` takes one. It is
 * all of what the system does to the game: once a system has said it, the
 * app holds the system to it, and whatever it left out throws where it is
 * done and names what to add.
 *
 * @category Models
 */
export interface Access {
  /**
   * The queries it visits: `Query.all(...)` and its kind, and
   * `Query.removed(...)`. A query's terms are written, but for the ones it
   * says it only reads (`Query.reads`); what it requires, excludes or
   * watches for changes is read.
   */
  readonly queries?: readonly (
    | QuerySpec<any>
    | { readonly component: ComponentDef<any> }
  )[];
  /**
   * What it reads and does not change: a component it reads through
   * `World`, a singleton or a state, an event it reads.
   */
  readonly reads?: readonly Touched[];
  /**
   * What it changes: a component it sets through `World` or spawns, adds
   * or removes through `Commands`, a singleton or a state it writes, an
   * event it emits. A despawn is a change of whatever the entity has that
   * is named here: a system that despawns bullets writes `Bullet`.
   */
  readonly writes?: readonly Touched[];
  /** Whether it draws from `Random`. */
  readonly random?: boolean;
  /** Whether it issues actions, with `Actions.enqueue`. */
  readonly actions?: boolean;
  /** Whether it starts scripts, with `Script.spawn`. */
  readonly scripts?: boolean;
}

/**
 * How a system touches a thing: it reads it, it reads it through a change
 * query and so reacts to whoever writes it, or it writes it.
 *
 * @category Models
 */
export type Touch = "reads" | "watches" | "writes";

/**
 * A system's access, worked out: every thing it touches, by name.
 *
 * @category Models
 */
export interface Resolved {
  /** Components, singletons and states. */
  readonly components: ReadonlyMap<
    string,
    { readonly def: ComponentDef<any>; readonly touch: Touch }
  >;
  /** Events: read, or emitted, which is `"writes"`. */
  readonly events: ReadonlyMap<string, Touch>;
  /** The queries it named, which it may ask for as they are. */
  readonly queries: readonly QuerySpec<any>[];
  readonly random: boolean;
  readonly actions: boolean;
  readonly scripts: boolean;
}

/**
 * A system: one Effect that runs once per tick, or once per frame, in its
 * stage. Made with `System.make`; `E` is what it can fail with and `R` what
 * it needs.
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
  /**
   * What the system said it reads and writes, with `System.access`.
   * Undefined for one that has not said: it may do anything, and nothing
   * is known of it.
   */
  readonly access: Access | undefined;
  /** What its conditions read, which it need not say again. */
  readonly implied: readonly Touched[];
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
 *
 * @category Constructors
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
    access: undefined,
    implied: [],
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
 * Orders a system after another one in the same stage. One in an earlier
 * stage has run already, and naming it is no error; one in a later stage
 * is.
 *
 * @category Combinators
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
 *
 * @category Combinators
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
      implied: [...self.implied, ...(conditionReads.get(condition) ?? [])],
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

/** What a condition reads, when whoever made it said: see `reading`. */
const conditionReads = new WeakMap<object, readonly Touched[]>();

/**
 * Says what a condition made for `System.runIf` reads, so that a system
 * which declares its access need not name it again: `State.is` says so of
 * its state. It gives the condition back.
 * @internal
 */
export const reading = <A, E, R>(
  condition: Effect.Effect<A, E, R>,
  reads: readonly Touched[]
): Effect.Effect<A, E, R> => {
  conditionReads.set(condition, reads);
  return condition;
};

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
 * Says what a system reads and writes:
 *
 *   const Movement = System.make("Movement", function* () {
 *     const moving = yield* Moving
 *     ...
 *   }).pipe(System.access({ queries: [Moving] }))
 *
 *   const Scoring = System.make("Scoring", ...).pipe(
 *     System.access({ queries: [Coins], reads: [Collided], writes: [Score] })
 *   )
 *
 * Most of it is the system's queries. Beside them it names what it reads
 * and what it changes some other way: a singleton or a state, an event, a
 * component it reaches through `World` or `Commands`; and whether it draws
 * from `Random`, issues actions or starts scripts.
 *
 * - It is all of what the system does. The app holds a system that said
 *   it to it: a query, a singleton, an event, a command or a draw that
 *   was left out throws where it is made, and names what to add. So what
 *   is said can be relied on, by `app.conflicts` and by what comes after.
 * - What a condition given with `System.runIf(State.is(...))` reads is
 *   known, and need not be said.
 * - A system that has not said may do anything, as before, and is told of
 *   in `app.undeclared`.
 * - Given twice, both hold.
 *
 * @category Combinators
 */
export const access: {
  (access: Access): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, access: Access): System<E, R>;
} = dual(2, <E, R>(self: System<E, R>, given: Access): System<E, R> => {
  const earlier = self.access;
  return build({
    ...self,
    access:
      earlier === undefined
        ? given
        : {
            queries: [...(earlier.queries ?? []), ...(given.queries ?? [])],
            reads: [...(earlier.reads ?? []), ...(given.reads ?? [])],
            writes: [...(earlier.writes ?? []), ...(given.writes ?? [])],
            random: earlier.random === true || given.random === true,
            actions: earlier.actions === true || given.actions === true,
            scripts: earlier.scripts === true || given.scripts === true,
          },
  });
});

const STRENGTH: Readonly<Record<Touch, number>> = {
  reads: 0,
  watches: 1,
  writes: 2,
};

/**
 * A system's access, worked out from what it said: undefined for a system
 * that has not said.
 *
 * @category Utilities
 */
export const accessOf = (system: System<any, any>): Resolved | undefined => {
  const said = system.access;
  if (said === undefined) {
    return undefined;
  }
  const components = new Map<
    string,
    { readonly def: ComponentDef<any>; readonly touch: Touch }
  >();
  const events = new Map<string, Touch>();
  const component = (def: ComponentDef<any>, touch: Touch): void => {
    const known = components.get(def.name);
    if (known === undefined || STRENGTH[touch] > STRENGTH[known.touch]) {
      components.set(def.name, { def, touch });
    }
  };
  const touched = (thing: Touched, touch: Touch): void => {
    if ("initial" in thing) {
      // A singleton, or a state, which is one.
      component(thing.component, touch);
    } else if ("id" in thing) {
      component(thing, touch);
    } else {
      const known = events.get(thing.name);
      if (known === undefined || STRENGTH[touch] > STRENGTH[known]) {
        events.set(thing.name, touch);
      }
    }
  };
  const queries: QuerySpec<any>[] = [];
  for (const query of said.queries ?? []) {
    if (!("terms" in query)) {
      // Query.removed: it hears of whoever takes the component away.
      component(query.component, "watches");
      continue;
    }
    queries.push(query);
    for (const def of query.terms as readonly ComponentDef<any>[]) {
      component(
        def,
        query.readDefs?.includes(def) === true ? "reads" : "writes"
      );
    }
    for (const def of [...query.withDefs, ...query.withoutDefs]) {
      component(def, "reads");
    }
    for (const def of [
      ...(query.changedDefs ?? []),
      ...(query.addedDefs ?? []),
    ]) {
      component(def, "watches");
    }
  }
  for (const thing of [...(said.reads ?? []), ...system.implied]) {
    touched(thing, "reads");
  }
  for (const thing of said.writes ?? []) {
    touched(thing, "writes");
  }
  return {
    components,
    events,
    queries,
    random: said.random === true,
    actions: said.actions === true,
    scripts: said.scripts === true,
  };
};

/**
 * Wraps each run in a tracing span named after the system. Use in dev builds.
 *
 * @category Combinators
 */
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

/**
 * Two systems whose order matters, and that nothing decides but the order
 * they happened to be listed in.
 *
 * @category Models
 */
export interface Conflict {
  /** The one that runs first, as things stand. */
  readonly first: string;
  /** The one that runs after it. */
  readonly second: string;
  /** What both touch, one of them at least to write it, in order of name. */
  readonly over: readonly {
    /** A component's, a singleton's, a state's or an event's name, or a service's. */
    readonly what: string;
    readonly kind: "component" | "event" | "service";
    readonly first: Touch;
    readonly second: Touch;
  }[];
}

/**
 * What `System.conflicts` finds in a list of systems.
 *
 * @category Models
 */
export interface Report {
  /** In the order the systems run in. */
  readonly conflicts: readonly Conflict[];
  /**
   * The systems of the tick, hooks among them, that have not said what
   * they read and write. Nothing is known of them, and none is in a
   * conflict.
   */
  readonly undeclared: readonly string[];
}

/** What two systems both touch, one at least to write it. */
const overlap = (first: Resolved, second: Resolved): Conflict["over"] => {
  const over: Conflict["over"][number][] = [];
  const clash = (
    what: string,
    kind: Conflict["over"][number]["kind"],
    a: Touch | undefined,
    b: Touch | undefined
  ): void => {
    if (
      a !== undefined &&
      b !== undefined &&
      (a === "writes" || b === "writes")
    ) {
      over.push({ what, kind, first: a, second: b });
    }
  };
  for (const [name, { touch }] of first.components) {
    clash(name, "component", touch, second.components.get(name)?.touch);
  }
  for (const [name, touch] of first.events) {
    clash(name, "event", touch, second.events.get(name));
  }
  // What comes of either depends on which went first: the numbers drawn,
  // the order the actions are applied in and the scripts started.
  for (const [what, a, b] of [
    ["Random", first.random, second.random],
    ["Actions", first.actions, second.actions],
    ["Script", first.scripts, second.scripts],
  ] as const) {
    if (a && b) {
      over.push({ what, kind: "service", first: "writes", second: "writes" });
    }
  }
  const kinds = ["component", "event", "service"];
  return over.toSorted(
    (a, b) =>
      kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
      (a.what < b.what ? -1 : a.what > b.what ? 1 : 0)
  );
};

/**
 * Checks the order of systems for conflicts: the pairs that touch the same
 * thing, one of them at least to write it, in an order that nothing says.
 *
 * Systems run in the order they are listed in unless `System.after` or
 * `System.before` says otherwise, and a plugin's are listed before the
 * app's own. So which of two systems runs first is often an accident, and
 * where one writes what the other reads, the accident decides what the
 * game does: whether a system sees this tick's positions or the last
 * tick's, or reacts to a change in the tick it was made in or the one
 * after. This finds those, among the systems that said what they read and
 * write with `System.access`.
 *
 * - A pair is in conflict when both touch a component, a singleton, a
 *   state or an event and one writes it; or both draw from `Random`, both
 *   issue actions, or both start scripts.
 * - It is not one when its order is said: one is `after` or `before` the
 *   other, directly or through others; or they are in different stages,
 *   which run one after the other; or one is a hook, which runs before a
 *   tick's systems. Hooks of one moment are checked among themselves.
 * - The systems of the frame stage and of the input stage change nothing,
 *   and are left out.
 *
 * `app.conflicts` is this for an app's systems. A game settles a conflict
 * by saying the order, which changes nothing when it is the order they run
 * in already.
 *
 * @category Utilities
 */
export const conflicts = (systems: readonly System<any, any>[]): Report => {
  const found: Conflict[] = [];
  const undeclared: string[] = [];
  const check = (group: readonly System<any, any>[]): void => {
    const ordered = order(group);
    const stageOf = new Map(
      ordered.map((system) => [system.name, system.stage])
    );
    // Who has to have run before whom, as it was said.
    const follows = new Map<string, string[]>(
      ordered.map((system) => [system.name, []])
    );
    for (const system of ordered) {
      for (const earlier of system.after) {
        if (stageOf.get(earlier) === system.stage) {
          follows.get(system.name)!.push(earlier);
        }
      }
      for (const later of system.before) {
        if (stageOf.get(later) === system.stage) {
          follows.get(later)!.push(system.name);
        }
      }
    }
    /** Whether it was said, directly or through others, that `first` runs before `second`. */
    const said = (first: string, second: string): boolean => {
      const seen = new Set<string>();
      const pending = [second];
      while (pending.length > 0) {
        for (const earlier of follows.get(pending.pop()!)!) {
          if (earlier === first) {
            return true;
          }
          if (!seen.has(earlier)) {
            seen.add(earlier);
            pending.push(earlier);
          }
        }
      }
      return false;
    };
    const resolved = ordered.map((system) => accessOf(system));
    for (let i = 0; i < ordered.length; i++) {
      const first = resolved[i];
      if (first === undefined) {
        undeclared.push(ordered[i]!.name);
        continue;
      }
      for (let j = i + 1; j < ordered.length; j++) {
        const second = resolved[j];
        // Stages run one after the other: that order is said.
        if (
          second === undefined ||
          ordered[i]!.stage !== ordered[j]!.stage ||
          said(ordered[i]!.name, ordered[j]!.name)
        ) {
          continue;
        }
        const over = overlap(first, second);
        if (over.length > 0) {
          found.push({
            first: ordered[i]!.name,
            second: ordered[j]!.name,
            over,
          });
        }
      }
    }
  };
  // Hooks run when their state is entered or left, each moment's among
  // themselves; the rest of the tick's systems, stage by stage.
  const hooks = new Map<string, System<any, any>[]>();
  for (const system of systems) {
    if (system.trigger !== undefined) {
      const { on, state, value } = system.trigger;
      const key = `${state.name}\n${on}\n${value}`;
      hooks.set(key, [...(hooks.get(key) ?? []), system]);
    }
  }
  for (const group of hooks.values()) {
    check(group);
  }
  check(
    systems.filter(
      (system) =>
        system.trigger === undefined &&
        (stages as readonly string[]).includes(system.stage)
    )
  );
  return { conflicts: found, undeclared };
};
