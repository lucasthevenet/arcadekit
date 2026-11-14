import type { World } from "@arcadekit/survivors";
import { SurvivorsCoop } from "@arcadekit/survivors/browser";
import type { CoopDebug } from "arcadekit/net/browser";
import { Effect, Layer } from "effect";

// Co-op survivors (#25) as the app runs it: the genre's `SurvivorsCoop`, whose class is the key
// of the Co-op client the app's Commands and Subscriptions drive, over the app's rooms.

/** What the end-to-end test and a debugging player read of a run: plain data, no World. */
export interface CoopDebugSample {
  readonly stepIndex: number;
  readonly error: string | null;
  readonly hashes: Readonly<Record<number, number>>;
  readonly slot: number;
  /** The team's level and the run's time in seconds, or null with no run. */
  readonly level: number | null;
  readonly time: number | null;
}

/** The client's debug read without the World, which is too big to copy out of the page. */
export const debugSample = ({
  state,
  ...rest
}: CoopDebug<World>): CoopDebugSample => ({
  ...rest,
  level: state?.level ?? null,
  time: state?.time ?? null,
});

/**
 * In development, the run's step, error and recent state hashes on a global, for the end-to-end
 * test and for debugging. Nothing otherwise.
 */
const DebugGlobal = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!import.meta.env.DEV) {
      return;
    }
    const coop = yield* SurvivorsCoop;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        Object.assign(globalThis, {
          arcadekitCoop: { debug: () => debugSample(coop.debug()) },
        });
      }),
      () =>
        Effect.sync(() => {
          Reflect.deleteProperty(globalThis, "arcadekitCoop");
        })
    );
  })
);

/**
 * The app's co-op: the genre's `SurvivorsCoop`, which plays its sounds through the app's audio
 * system (`AudioSystem.AudioSystem`), loads the run's content from `SurvivorsContent` and draws from the app's
 * `SurvivorsSheet`, as the single-player engine does: one sheet, one load. It needs the app's
 * rooms (`CoopRooms`): the signalling worker's in the app, fake ones in a test. The layer's
 * scope (the app) owns the client: when it closes, the client leaves, and its socket, peer
 * links, session and tick worker close.
 */
export const CoopLayer = DebugGlobal.pipe(
  Layer.provideMerge(SurvivorsCoop.layer)
);
