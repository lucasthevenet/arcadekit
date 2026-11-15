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

export const stages = ["preUpdate", "update", "postUpdate"] as const;
export type Stage = (typeof stages)[number];

export interface System<out E = never, out R = never> extends Pipeable {
  readonly name: string;
  readonly stage: Stage;
  /** Names of systems in the same stage that must run before this one. */
  readonly after: readonly string[];
  /** Names of systems in the same stage that must run after this one. */
  readonly before: readonly string[];
  readonly run: Effect.Effect<void, E, R>;
}

const build = <E, R>(
  name: string,
  stage: Stage,
  after: readonly string[],
  before: readonly string[],
  run: Effect.Effect<void, E, R>
): System<E, R> => ({
  name,
  stage,
  after,
  before,
  run,
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
  build(
    name,
    "update",
    [],
    [],
    Effect.gen(body) as Effect.Effect<
      void,
      Effect.Error<Eff>,
      Effect.Services<Eff>
    >
  );

/** Moves a system to another stage. */
export const inStage: {
  (stage: Stage): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, stage: Stage): System<E, R>;
} = dual(2, <E, R>(self: System<E, R>, stage: Stage): System<E, R> =>
  build(self.name, stage, self.after, self.before, self.run)
);

/** Orders a system after another one in the same stage. */
export const after: {
  (
    other: System<any, any> | string
  ): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R>;
} = dual(
  2,
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R> =>
    build(
      self.name,
      self.stage,
      [...self.after, typeof other === "string" ? other : other.name],
      self.before,
      self.run
    )
);

/**
 * Orders a system before another one in the same stage. This is how a plugin
 * slots a system in ahead of one that belongs to a plugin it depends on.
 */
export const before: {
  (
    other: System<any, any> | string
  ): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R>;
} = dual(
  2,
  <E, R>(self: System<E, R>, other: System<any, any> | string): System<E, R> =>
    build(
      self.name,
      self.stage,
      self.after,
      [...self.before, typeof other === "string" ? other : other.name],
      self.run
    )
);

/** Wraps each run in a tracing span named after the system. Use in dev builds. */
export const withSpan = <E, R>(self: System<E, R>): System<E, R> =>
  build(
    self.name,
    self.stage,
    self.after,
    self.before,
    Effect.withSpan(self.run, self.name) as Effect.Effect<void, E, R>
  );

/**
 * Sorts systems into run order: by stage, then by `after` and `before`
 * constraints, keeping registration order where nothing else decides.
 * @internal
 */
export const order = (
  systems: readonly System<any, any>[]
): System<any, any>[] => {
  const names = new Set<string>();
  for (const system of systems) {
    if (names.has(system.name)) {
      throw new Error(`Duplicate system name "${system.name}"`);
    }
    names.add(system.name);
  }
  const out: System<any, any>[] = [];
  for (const stage of stages) {
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
          throw new Error(
            `System "${system.name}" must run after "${dep}", which is not in the "${stage}" stage`
          );
        }
        mustFollow.get(system.name)!.push(dep);
      }
      for (const later of system.before) {
        if (!stageNames.has(later)) {
          throw new Error(
            `System "${system.name}" must run before "${later}", which is not in the "${stage}" stage`
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
