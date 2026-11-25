import { Effect } from "effect";
import { pipeArguments } from "effect/Pipeable";

import { Sim } from "../Services";
import type { GenError, GenServices, Stage, System, Trigger } from "../System";

/**
 * Makes a system from its parts, which pipes as a system does.
 *
 * @internal
 */
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

/**
 * What `Sim` stands for. A system provides it, and nothing reads it.
 *
 * @internal
 */
export const simulation = { "~arcadekit/Sim": true } as const;

/**
 * Runs a system's body as the system, with `Sim` provided.
 *
 * @internal
 */
export const generate = <Eff extends Effect.Effect<unknown, unknown, unknown>>(
  body: () => Generator<Eff, void, never>
): Effect.Effect<void, GenError<Eff>, Exclude<GenServices<Eff>, Sim>> =>
  Effect.provideService(Effect.gen(body), Sim, simulation);

/**
 * Makes a system of a stage that runs `run`, with no condition.
 *
 * @internal
 */
export const define = <
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
): System<GenError<Eff>, Exclude<GenServices<Eff>, Sim>, N, St, undefined> =>
  define<GenError<Eff>, Exclude<GenServices<Eff>, Sim>, N, St, undefined>(
    name,
    stage,
    generate(body),
    undefined
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
 * The level of the spans an app makes, as a program's
 * `Tracer.MinimumTraceLevel` sees them.
 * @internal
 */
export const spanLevel = "Debug";
