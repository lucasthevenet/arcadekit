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
 * What a system's access declaration can name: a component, a singleton or a
 * state, or an event.
 *
 * @category Models
 */
export type Touched = ComponentDef<any> | SingletonSpec<any> | EventDef<any>;

/**
 * What a system declares it reads and writes, as `System.access` takes it. It
 * covers everything the system does to the game: once a system declares it, the
 * app enforces it, and anything left out throws where it happens and names what
 * to add.
 *
 * @category Models
 */
export interface Access {
  /**
   * The queries it iterates: `Query.all(...)` and similar, and
   * `Query.removed(...)`. A query's terms count as written, except the ones it
   * declares read-only (`Query.reads`); what it requires, excludes or watches
   * for changes counts as read.
   */
  readonly queries?: readonly (
    | QuerySpec<any>
    | { readonly component: ComponentDef<any> }
  )[];
  /**
   * What it reads without changing: a component it reads through `World`, a
   * singleton or a state, or an event it reads.
   */
  readonly reads?: readonly Touched[];
  /**
   * What it changes: a component it sets through `World` or spawns, adds or
   * removes through `Commands`, a singleton or a state it writes, or an event
   * it emits. A despawn changes whatever components of the entity are named
   * here: a system that despawns bullets writes `Bullet`.
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
 * How a system touches something: it reads it, reads it through a change query
 * and so reacts to whoever writes it, or writes it.
 *
 * @category Models
 */
export type Touch = "reads" | "watches" | "writes";

/**
 * A system's resolved access: everything it touches, by name.
 *
 * @category Models
 */
export interface Resolved {
  /** Components, singletons and states. */
  readonly components: ReadonlyMap<
    string,
    { readonly def: ComponentDef<any>; readonly touch: Touch }
  >;
  /** Events: read, or emitted, which counts as `"writes"`. */
  readonly events: ReadonlyMap<string, Touch>;
  /** The queries it declared, which it may request exactly as declared. */
  readonly queries: readonly QuerySpec<any>[];
  readonly random: boolean;
  readonly actions: boolean;
  readonly scripts: boolean;
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
  /**
   * What the system declared it reads and writes, with `System.access`.
   * Undefined for a system that declared nothing: it may do anything, and
   * nothing is known about it.
   */
  readonly access: Access | undefined;
  /** What its conditions read, which it doesn't need to declare again. */
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
 * undeclared system listed between the two. It may then run before a system it
 * reads from, with no error. `app.conflicts` finds such a pair when both have
 * declared their access.
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
 * inserts a system ahead of one from a plugin it depends on. Naming a system in
 * a later stage, which already runs after it, isn't an error; naming one in an
 * earlier stage is.
 *
 * **Gotchas**
 *
 * A system listed after the other moves forward to just ahead of it, and so
 * ahead of every undeclared system listed between the two, and a plugin's
 * systems are listed before the app's own. It may then run before a system it
 * reads from, with no error. `app.conflicts` finds such a pair when both have
 * declared their access.
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

/** What a condition reads, when its creator declared it: see `reading`. */
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
 * Declares what a system reads and writes:
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
 * It mostly lists the system's queries. Alongside them, it names what the
 * system reads and changes in other ways: a singleton or a state, an event, a
 * component it reaches through `World` or `Commands`; and whether it draws from
 * `Random`, issues actions or starts scripts.
 *
 * - It covers everything the system does. The app enforces it: a query, a
 *   singleton, an event, a read or write through the world, a command, an
 *   action or a script that was left out throws where it happens, names the
 *   system and says what to add. A draw from `Random` is detected after the
 *   system has run. So the declaration can be relied on, by `app.conflicts` and
 *   anything else.
 * - What a system may write, it may also read. An undeclared query is allowed
 *   when everything it touches is within the declaration.
 * - What a `System.runIf(State.is(...))` condition reads is known, and needn't
 *   be declared. A condition of your own must be declared by the system, as
 *   must what `System.otherwise` does.
 * - `Time` and `Ticks` aren't declared, nor are the input views,
 *   `Input.Keyboard` and similar.
 * - A system without a declaration may do anything, and is listed in
 *   `app.undeclared`. Scripts and handlers aren't systems, and aren't held to
 *   anything.
 * - Given twice, both declarations apply.
 *
 * **Gotchas**
 *
 * Enforcement happens as the system runs, not earlier. A system that touches
 * something it left out only under some game condition is refused in the first
 * tick where that happens, which may be deep into a game and never in a test.
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
 * Returns a system's resolved access, from what it declared: undefined for a
 * system without a declaration.
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
 * Wraps each run in a tracing span named after the system. Use it in
 * development builds.
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
 * Two systems whose order matters, decided only by the order they happen to be
 * listed in.
 *
 * @category Models
 */
export interface Conflict {
  /** The one that currently runs first. */
  readonly first: string;
  /** The one that runs after it. */
  readonly second: string;
  /** What both touch, with at least one writing it, sorted by name. */
  readonly over: readonly {
    /** The name of a component, singleton, state, event, or service. */
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
   * The tick's systems, hooks included, that haven't declared their access.
   * Nothing is known about them, and none appears in a conflict.
   */
  readonly undeclared: readonly string[];
}

/** Returns what two systems both touch, with at least one writing it. */
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
 * Checks systems for ordering conflicts: pairs that touch the same thing, at
 * least one of them writing it, in an order nothing specifies.
 *
 * Systems run in the order they are listed unless `System.after` or
 * `System.before` says otherwise, and a plugin's systems are listed before the
 * app's own. So which of two systems runs first is often accidental, and where
 * one writes what the other reads, the accident decides what the game does:
 * whether a system sees this tick's positions or last tick's, or reacts to a
 * change in the same tick or the next. This finds those pairs, among the
 * systems that declared their access with `System.access`.
 *
 * - A pair conflicts when both touch a component, a singleton, a state or an
 *   event and one writes it; or both draw from `Random`, both issue actions, or
 *   both start scripts.
 * - A pair doesn't conflict when its order is specified: one is `after` or
 *   `before` the other, directly or transitively; or they are in different
 *   stages, which run in sequence; or one is a hook, which runs before a tick's
 *   systems. Hooks for the same transition are checked among themselves.
 * - Frame-stage and input-stage systems change nothing, and are excluded.
 *
 * `app.conflicts` runs this on an app's systems. Resolve a conflict by
 * specifying the order, which changes nothing when it is already the order they
 * run in.
 *
 * **Gotchas**
 *
 * - It doesn't say which order is right. A system that `"watches"`, listed
 *   ahead of the one that writes what it watches, reacts a tick late; the pair
 *   is reported until its order is specified, and an order specified the wrong
 *   way round is trusted.
 * - A despawn is declared through one component, but the entity's other
 *   components go with it, as does anything attached to it by a relation. A
 *   system that reaches those through components the first never named isn't
 *   detected as conflicting with it.
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

    /** Returns whether `first` was specified to run before `second`, directly or transitively. */
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

    for (let i = 0; i < ordered.length; i += 1) {
      const first = resolved[i];

      if (first === undefined) {
        undeclared.push(ordered[i]!.name);
        continue;
      }

      for (let j = i + 1; j < ordered.length; j += 1) {
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
