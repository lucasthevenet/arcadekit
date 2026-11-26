import { Effect } from "effect";
import { pipeArguments } from "effect/Pipeable";

import { Sim } from "../Services.ts";
import { frameStages, stages } from "../System.ts";
import type {
  GenError,
  GenServices,
  Stage,
  System,
  Trigger,
} from "../System.ts";

/** @internal Gives a system's parts the `pipe` every system has. */
export const build = <
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

/** What `Sim` stands for. A system provides it, and nothing reads it. */
const simulation = { "~arcadekit/Sim": true } as const;

/** @internal Provides `Sim` to what a system runs, which provides it for itself. */
export const simulating = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Sim>> =>
  Effect.provideService(effect, Sim, simulation);

/** @internal A system of a stage, made from its body: run as it is, and set off by nothing. */
export const make = <
  const N extends string,
  const St extends Stage,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  name: N,
  stage: St,
  body: () => Generator<Eff, void, never>
): System<GenError<Eff>, Exclude<GenServices<Eff>, Sim>, N, St, undefined> =>
  build({
    name,
    stage,
    run: simulating(Effect.gen(body)),
    condition: undefined,
    idle: undefined,
    trigger: undefined,
  });

/** @internal Makes a system a hook, set off by `trigger` in place of the tick. */
export const triggered = <E, R, N extends string, St extends Stage>(
  self: System<E, R, N, St>,
  trigger: Trigger
): System<E, R, N, St, Trigger> => build({ ...self, trigger });

/**
 * @internal The level of the spans an app makes, as a program's
 * `Tracer.MinimumTraceLevel` sees them.
 */
export const spanLevel = "Debug";

/**
 * @internal A system's name is its place in events and in what changed, so two systems cannot
 * share one.
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
 * @internal Sorts systems into run order: by stage, and within a stage in the order they are
 * listed.
 */
export const order = (
  systems: readonly System<unknown, unknown>[]
): System<unknown, unknown>[] => {
  unique(systems);
  const everyStage: readonly Stage[] = [...stages, "input", ...frameStages];
  return everyStage.flatMap((stage) =>
    systems.filter((system) => system.stage === stage)
  );
};
