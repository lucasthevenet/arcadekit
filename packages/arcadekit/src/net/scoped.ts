import { Duration, Effect } from "effect";
import type { Clock, Scope } from "effect";

import type { LockstepError } from "./errors";
import { hostLockstep, joinLockstep } from "./lockstep";
import type { HostOptions, JoinOptions, LockstepSession } from "./lockstep";

// The Effect shell of a lockstep session: its scope owns the transport listener, its time is
// Effect's Clock, and how it stops is the typed failure of `run`. The protocol stays the plain
// session in lockstep.ts; a tick here calls it once and never runs an Effect inside it.

/**
 * Calls `onTick` on every tick until the returned function stops it: a timer, a dedicated
 * worker's timer (which a hidden tab doesn't throttle), animation frames, or all of those.
 */
export type Ticker = (onTick: () => void) => () => void;

/** How often `run` ticks without a ticker. Browsers clamp shorter timers to about 4 ms anyway. */
const TICK_MS = 4;

/**
 * How long `run` goes on ticking a session a desync stopped before it fails: each of those ticks
 * resends the desync, which the transport may lose, and the other peers stop only on hearing it.
 */
const DESYNC_RESEND_MS = 1000;

/**
 * A lockstep session its scope owns, made with `hostLockstepScoped` or `joinLockstepScoped`.
 * Closing the scope stops it listening to the transport. Its time is the Effect `Clock` it was
 * made on (a `TestClock` in tests): the start and every tick read it, so they always agree.
 */
export interface ScopedLockstepSession<State, Event> extends Pick<
  LockstepSession<State, Event>,
  "status" | "error" | "waitingFor" | "players" | "state" | "stepIndex"
> {
  /**
   * Ticks the session on every tick of `ticker`, or every 4 ms of the Clock without one, until it
   * stops: then fails with its `LockstepError` (a desync, a lost host, removal…), and at once if it
   * has already stopped. After a desync it fails a second after the stop (its `status` and
   * `error` show the stop at once): until then its ticks resend the desync, which the transport
   * may lose, so that every peer stops with it. Interrupting the run, or its failing, stops the
   * ticker. Run it in the session's scope: a run still going once that closes dies on its next
   * tick, and one started after dies at once.
   *
   * A tick is plain: `onTick` ticks the session before it returns, so a ticker can read the
   * session right after, or tick before drawing. The run ends after the tick it stops in, once
   * `onTick` has returned, so the ticker's own code for that tick runs before the program's
   * handlers and finalizers. Dies with what a tick throws (a bug in the simulation, `hash` or
   * the input source).
   *
   * In the browser, pass a ticker timed by a dedicated worker: a hidden tab throttles the main
   * thread's timers, the Clock's too. The Clock's ticks are for tests and servers.
   */
  readonly run: (ticker?: Ticker) => Effect.Effect<never, LockstepError>;
  /** Calls `onEvent` with the run's events and samples, in the tick that makes them, while the scope is open. */
  readonly listen: (
    onEvent: (event: Event) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Starts a run as its host, now on the Clock, as `hostLockstep` does. Dies with what starting
 * throws (more players than a run holds, a simulation whose step input is not a
 * `Game.PlayerInputs`, a simulation that can't start), with nothing left listening.
 */
export const hostLockstepScoped = <
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
>(
  options: HostOptions<Config, State, Input, Event, Command, Refusals>
): Effect.Effect<ScopedLockstepSession<State, Event>, never, Scope.Scope> =>
  scoped((nowMs) => hostLockstep(options, nowMs));

/** Joins the run `host` starts, as `joinLockstep` does. The session is `joining` until the host's start message arrives. */
export const joinLockstepScoped = <
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
>(
  options: JoinOptions<Config, State, Input, Event, Command, Refusals>
): Effect.Effect<ScopedLockstepSession<State, Event>, never, Scope.Scope> =>
  scoped((nowMs) => joinLockstep(options, nowMs));

/** The Clock's monotonic time in milliseconds: a wall clock's jump would stall or end the run. */
const millis = (clock: Clock.Clock): number =>
  Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;

/** A session, and whether the scope that owns it has closed. */
interface Owned<State, Event> {
  readonly session: LockstepSession<State, Event>;
  closed: boolean;
}

/** A run going on after its session's scope closed: a bug in the program that forked it. */
const ranAfterClose = () =>
  new Error("A lockstep session ran after its scope closed");

const scoped = <State, Event>(
  open: (nowMs: number) => LockstepSession<State, Event>
): Effect.Effect<ScopedLockstepSession<State, Event>, never, Scope.Scope> =>
  Effect.clockWith((clock) =>
    Effect.acquireRelease(
      Effect.sync((): Owned<State, Event> => ({
        session: open(millis(clock)),
        closed: false,
      })),
      (owned) =>
        Effect.sync(() => {
          owned.closed = true;
          owned.session.dispose();
        })
    ).pipe(Effect.map((owned) => shell(owned, clock)))
  );

const shell = <State, Event>(
  owned: Owned<State, Event>,
  clock: Clock.Clock
): ScopedLockstepSession<State, Event> => {
  const { session } = owned;
  /** When a desync stopped the session, on the Clock, or null. */
  let desyncAtMs: number | null = null;

  /**
   * Ticks now on the Clock; the error the run fails with, or null to go on. A tick of a stopped
   * session only resends its desync, if it has one. Throws once the session's scope has closed.
   */
  const tickNow = (): LockstepError | null => {
    if (owned.closed) {
      throw ranAfterClose();
    }
    const nowMs = millis(clock);
    session.tick(nowMs);
    const { error } = session;
    if (error === null || error.reason.kind !== "desync") {
      return error;
    }
    desyncAtMs ??= nowMs;
    return nowMs - desyncAtMs >= DESYNC_RESEND_MS ? error : null;
  };

  // Sleeps on the Clock between ticks, so a TestClock drives it.
  const timed: Effect.Effect<never, LockstepError> = Effect.forever(
    Effect.suspend(() => {
      const error = tickNow();
      return error === null ? Effect.void : Effect.fail(error);
    }).pipe(Effect.andThen(clock.sleep(Duration.millis(TICK_MS))))
  );

  // One callback for the whole run, not an Effect per tick: a tick every 4 ms through a Stream
  // or a fiber resumed per tick makes 1.5 to 3 KB of garbage each; this, 40 B more than ticking
  // the plain session.
  const ticked = (ticker: Ticker) =>
    Effect.callback<never, LockstepError>((resume) => {
      let ended = false;
      let stop: (() => void) | null = null;
      const end = (result: Effect.Effect<never, LockstepError>) => {
        // Interrupting the run inside a tick (a listener leaving) has already ended it.
        if (ended) {
          return;
        }
        ended = true;
        try {
          stop?.();
        } finally {
          // On the scheduler: resumed here, the rest of the program (its handlers, its scopes'
          // finalizers) would run inside `onTick`, before the ticker's own code for this tick.
          resume(Effect.andThen(Effect.yieldNow, result));
        }
      };
      const stopTicker = ticker(() => {
        if (ended) {
          return;
        }
        let stopped: LockstepError | null;
        try {
          stopped = tickNow();
        } catch (error) {
          end(Effect.die(error));
          return;
        }
        if (stopped !== null) {
          end(Effect.fail(stopped));
        }
      });
      if (ended) {
        // The session stopped in a tick the ticker made before it returned.
        stopTicker();
      } else {
        stop = stopTicker;
      }
      return Effect.sync(() => {
        if (!ended) {
          ended = true;
          stopTicker();
        }
      });
    });

  return {
    get status() {
      return session.status;
    },
    get error() {
      return session.error;
    },
    get waitingFor() {
      return session.waitingFor;
    },
    get players() {
      return session.players;
    },
    get state() {
      return session.state;
    },
    get stepIndex() {
      return session.stepIndex;
    },
    run: (ticker) =>
      Effect.suspend(() => {
        if (owned.closed) {
          return Effect.die(ranAfterClose());
        }
        if (session.error !== null) {
          return Effect.fail(session.error);
        }
        return ticker === undefined ? timed : ticked(ticker);
      }),
    listen: (onEvent) =>
      Effect.acquireRelease(
        // A listener of its own: the session's listeners are a set, so another `listen` with the
        // same callback would otherwise share it, and leaving would remove both.
        Effect.sync(() => session.subscribe((event) => onEvent(event))),
        (unsubscribe) => Effect.sync(unsubscribe)
      ).pipe(Effect.asVoid),
  };
};
