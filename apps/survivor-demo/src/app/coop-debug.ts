/**
 * The co-op run's debug read, on a global in development: what the end-to-end test and a
 * debugging player read of the Co-op client's current seat, with
 * `globalThis.arcadekitCoop.debug()`.
 *
 * The client's own read (`CoopClient.Debug`) holds the run's arena, which is too big to copy out
 * of the page, so the global gives plain data in its place: the team's level and the run's time.
 * The global's `debug` is a plain function, as the client's is, since a script on the page calls
 * it.
 */
import type { World } from "@arcadekit/survivors";
import { SurvivorsCoop } from "@arcadekit/survivors/browser";
import type { CoopClient } from "arcadekit/net/browser";
import { Effect, Layer } from "effect";

/** What `globalThis.arcadekitCoop.debug()` gives: the client's debug read, with plain data in place of the arena. */
export interface CoopDebug {
  readonly stepIndex: number;
  /** The lockstep session's stop error, or null. */
  readonly error: string | null;
  /** The client's last state hashes, by step. */
  readonly hashes: Readonly<Record<number, number>>;
  /** The local player's slot; -1 with no seat. */
  readonly slot: number;
  /** The team's level, or null with no run. */
  readonly level: number | null;
  /** The run's time in seconds, or null with no run. */
  readonly time: number | null;
}

const fromClient = ({
  state,
  ...rest
}: CoopClient.Debug<World.Arena>): CoopDebug => ({
  ...rest,
  level: state?.level ?? null,
  time: state?.time ?? null,
});

/**
 * In development, puts `arcadekitCoop` on the global object for as long as the Layer's scope (the
 * app) lives: its `debug()` reads the client's current seat afresh on each call. Nothing in a
 * production build. It reads the app's `SurvivorsCoop`, which `resources` provides beside it.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!import.meta.env.DEV) {
      return;
    }
    const coop = yield* SurvivorsCoop;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        Object.assign(globalThis, {
          arcadekitCoop: { debug: () => fromClient(coop.debug()) },
        });
      }),
      () =>
        Effect.sync(() => {
          Reflect.deleteProperty(globalThis, "arcadekitCoop");
        })
    );
  })
);
