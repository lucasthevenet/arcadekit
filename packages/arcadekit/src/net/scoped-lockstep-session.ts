/**
 * Scoped lockstep sessions: a lockstep session in an Effect program, owned by a scope and timed
 * by Effect's Clock.
 *
 * It is the Effect shell of the plain `LockstepSession`: its scope owns the session's listener on
 * the transport, its time is the Clock it was made on, `run` ticks it until it stops and then
 * fails with its `LockstepError`, and `send` waits for the rules' answer as an engine's does. The
 * protocol stays the plain session: a tick here calls it once, inside the call that ticks it, and
 * runs no Effect. That is on purpose (ADR-0024): a ticker that also draws ticks the session and
 * then draws, in one frame, and reads the session right after the tick.
 *
 * @since 0.7.0
 */
import { Duration, Effect, Inspectable, Predicate } from "effect";
import type { Clock, Scope } from "effect";
import { pipeArguments } from "effect/Pipeable";
import type { Pipeable } from "effect/Pipeable";

import type { CommandDropped, RefusalFor } from "../game/index";
import { host as hostSession, join as joinSession } from "./lockstep-session";
import type * as LockstepSession from "./lockstep-session";
import type * as Ticker from "./ticker";

const TypeId = "~arcadekit/net/ScopedLockstepSession";

/**
 * A lockstep session its scope owns, as an Effect program runs one.
 *
 * **When to use**
 *
 * In an Effect program that plays a lockstep run: the Co-op client runs one per seat, and a
 * bench or a server runs one on the Clock. A test of the protocol itself ticks a plain
 * `LockstepSession` by hand.
 *
 * **Details**
 *
 * Its reads (`status`, `error`, `waitingFor`, `players`, `state`, `stepIndex`) are the plain
 * session's. Its Effects are traced under `ScopedLockstepSession.run`, `.listen` and `.send`:
 *
 * - `run(ticker?)` ticks the session on every tick of `ticker`, or every 4 ms of the Clock without
 *   one, until it stops: then it fails with its `LockstepError`, and at once if it has already
 *   stopped. After a desync it fails a second after the stop, which `status` and `error` show at
 *   once: until then its ticks resend the desync, which the transport may lose, so that every
 *   peer stops with it. Interrupting the run, or its failing, stops the ticker. `onTick` ticks
 *   the session before it returns, and the run ends after the tick it stops in, once `onTick`
 *   has returned. Run it in the session's scope: a run still going once that closes dies on its
 *   next tick, and one started after dies at once. It dies with what a tick throws, a bug in the
 *   simulation, `hash` or the input source.
 * - `listen(onEvent)` calls `onEvent` with the run's events and samples, in the tick that tells
 *   them, while its scope is open: the plain session's `subscribe`. Listen before `run` to hear
 *   the run from its start.
 * - `send(command)` sends a command as this peer's player and waits for this peer's rules: it
 *   succeeds when they took it, fails with the rejection they refused it with, and fails with
 *   `CommandDropped` when they gave no answer, the session stopped first, or its scope closed.
 *   It completes after the tick that ran the command's step, when a `listen` callback has heard
 *   what that tick reported. Interrupt it to take the command back while it has no step yet. It
 *   dies for a command the plain session's `send` throws on.
 *
 * In the browser, run it on a ticker timed by a dedicated worker: a hidden tab throttles the main
 * thread's timers, the Clock's too. The Clock's ticks are for tests and servers.
 *
 * **Example** (A guest that never hears its host)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { MemoryNetwork, ScopedLockstepSession } from "arcadekit/net";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const program = Effect.gen(function* () {
 *   const guest = yield* ScopedLockstepSession.join({
 *     simulation: Sum,
 *     config: null,
 *     contentHash: "content-v1",
 *     transport: MemoryNetwork.connect(network, "guest"),
 *     local: { read: () => 2 },
 *     hash: (state) => state.total,
 *     inputDelay: 3,
 *     hashEvery: 30,
 *     host: "host",
 *     players: ["host", "guest"],
 *     dropAfterMs: 0,
 *   });
 *   return yield* Effect.flip(guest.run());
 * }).pipe(Effect.scoped);
 * Effect.runSync(program).reason.kind; // => "hostLost"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ScopedLockstepSession<State, Event, Command, Refusals>
  extends
    Pick<
      LockstepSession.LockstepSession<State, Event, Command, Refusals>,
      "status" | "error" | "waitingFor" | "players" | "state" | "stepIndex"
    >,
    Pipeable,
    Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** Ticks the session until it stops, then fails with its `LockstepError`. */
  readonly run: (
    ticker?: Ticker.Ticker
  ) => Effect.Effect<never, LockstepSession.LockstepError>;
  /** Hears the run's events and samples, in the ticks that tell them, while the scope is open. */
  readonly listen: (
    onEvent: (event: Event) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Sends a command as this peer's player, and waits for this peer's rules to answer. */
  readonly send: <C extends Command>(
    command: C
  ) => Effect.Effect<void, RefusalFor<Refusals, C> | CommandDropped>;
}

/**
 * Checks whether a value is a scoped lockstep session.
 *
 * **When to use**
 *
 * Narrow an unknown value before running it.
 *
 * **Example** (Recognising a scoped session)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { MemoryNetwork, ScopedLockstepSession } from "arcadekit/net";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const program = ScopedLockstepSession.join({
 *   simulation: Sum,
 *   config: null,
 *   contentHash: "content-v1",
 *   transport: MemoryNetwork.connect(network, "guest"),
 *   local: { read: () => 2 },
 *   hash: (state) => state.total,
 *   inputDelay: 3,
 *   hashEvery: 30,
 *   host: "host",
 *   players: ["host", "guest"],
 * }).pipe(Effect.map(ScopedLockstepSession.isScopedLockstepSession), Effect.scoped);
 * Effect.runSync(program); // => true
 * ScopedLockstepSession.isScopedLockstepSession({ run: () => Effect.never }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isScopedLockstepSession = (
  value: unknown
): value is ScopedLockstepSession<unknown, unknown, unknown, unknown> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Starts a run as its host, now on the Clock, as `LockstepSession.host` does, with the session
 * owned by the scope.
 *
 * **When to use**
 *
 * On the host's peer of a run an Effect program plays, once the lobby has agreed on who plays.
 *
 * **Details**
 *
 * The run's state is there at once, and what its start reports is told at the first tick of
 * `run`: `listen` before running it. Closing the scope stops the session listening to its
 * transport, and drops the commands its rules haven't answered. It dies with what starting
 * throws (more players than a run holds, a simulation whose step input is not a
 * `Game.PlayerInputs`, a simulation that can't start), with nothing left listening. A trace
 * shows it as `ScopedLockstepSession.host`.
 *
 * **Example** (A host whose run has started)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { MemoryNetwork, ScopedLockstepSession } from "arcadekit/net";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const program = Effect.gen(function* () {
 *   const host = yield* ScopedLockstepSession.host({
 *     simulation: Sum,
 *     config: null,
 *     contentHash: "content-v1",
 *     transport: MemoryNetwork.connect(network, "host"),
 *     local: { read: () => 1 },
 *     hash: (state) => state.total,
 *     inputDelay: 3,
 *     hashEvery: 30,
 *     peers: ["guest"],
 *     seed: 7,
 *   });
 *   return [host.status, host.state?.total];
 * }).pipe(Effect.scoped);
 * Effect.runSync(program); // => ["running", 0]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const host: <Config, State, Input, Event, Command, Refusals>(
  options: LockstepSession.HostOptions<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >
) => Effect.Effect<
  ScopedLockstepSession<State, Event, Command, Refusals>,
  never,
  Scope.Scope
> = Effect.fn("ScopedLockstepSession.host")(function* <
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
>(
  options: LockstepSession.HostOptions<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >
) {
  return yield* scoped((nowMs) => hostSession(options, nowMs));
});

/**
 * Joins the run `host` starts, as `LockstepSession.join` does, with the session owned by the
 * scope.
 *
 * **When to use**
 *
 * On each guest's peer of a run an Effect program plays.
 *
 * **Details**
 *
 * The session is `joining` until the host's start message arrives: the tick of `run` that has it
 * starts the run. A trace shows it as `ScopedLockstepSession.join`.
 *
 * **Example** (A guest before the host's start)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { MemoryNetwork, ScopedLockstepSession } from "arcadekit/net";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const program = ScopedLockstepSession.join({
 *   simulation: Sum,
 *   config: null,
 *   contentHash: "content-v1",
 *   transport: MemoryNetwork.connect(network, "guest"),
 *   local: { read: () => 2 },
 *   hash: (state) => state.total,
 *   inputDelay: 3,
 *   hashEvery: 30,
 *   host: "host",
 *   players: ["host", "guest"],
 * }).pipe(Effect.map((guest) => guest.status), Effect.scoped);
 * Effect.runSync(program); // => "joining"
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const join: <Config, State, Input, Event, Command, Refusals>(
  options: LockstepSession.JoinOptions<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >
) => Effect.Effect<
  ScopedLockstepSession<State, Event, Command, Refusals>,
  never,
  Scope.Scope
> = Effect.fn("ScopedLockstepSession.join")(function* <
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
>(
  options: LockstepSession.JoinOptions<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >
) {
  return yield* scoped((nowMs) => joinSession(options, nowMs));
});

/** How often `run` ticks without a ticker. Browsers clamp shorter timers to about 4 ms anyway. */
const TICK_MS = 4;

/**
 * How long `run` goes on ticking a session a desync stopped before it fails: each of those ticks
 * resends the desync, which the transport may lose, and the other peers stop only on hearing it.
 */
const DESYNC_RESEND_MS = 1000;

/** The Clock's monotonic time in milliseconds: a wall clock's jump would stall or end the run. */
const millis = (clock: Clock.Clock): number =>
  Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;

/** A session, and whether the scope that owns it has closed. */
interface Owned<State, Event, Command, Refusals> {
  readonly session: LockstepSession.LockstepSession<
    State,
    Event,
    Command,
    Refusals
  >;
  closed: boolean;
}

/** A run going on after its session's scope closed: a bug in the program that forked it. */
const ranAfterClose = () =>
  new Error("A lockstep session ran after its scope closed");

const scoped = <State, Event, Command, Refusals>(
  open: (
    nowMs: number
  ) => LockstepSession.LockstepSession<State, Event, Command, Refusals>
): Effect.Effect<
  ScopedLockstepSession<State, Event, Command, Refusals>,
  never,
  Scope.Scope
> =>
  Effect.clockWith((clock) =>
    Effect.acquireRelease(
      Effect.sync((): Owned<State, Event, Command, Refusals> => ({
        session: open(millis(clock)),
        closed: false,
      })),
      (owned) =>
        Effect.sync(() => {
          owned.closed = true;
          owned.session.dispose();
        })
    ).pipe(Effect.map((owned) => new ScopedImpl(owned, clock)))
  );

/**
 * The value `host` and `join` give. A class, as the plain session's is: no game names it or
 * calls `new` on it.
 */
class ScopedImpl<State, Event, Command, Refusals>
  extends Inspectable.Class
  implements ScopedLockstepSession<State, Event, Command, Refusals>
{
  readonly [TypeId]: typeof TypeId = TypeId;
  readonly run: (
    ticker?: Ticker.Ticker
  ) => Effect.Effect<never, LockstepSession.LockstepError>;
  readonly listen: (
    onEvent: (event: Event) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly send: <C extends Command>(
    command: C
  ) => Effect.Effect<void, RefusalFor<Refusals, C> | CommandDropped>;
  private readonly session: LockstepSession.LockstepSession<
    State,
    Event,
    Command,
    Refusals
  >;

  constructor(
    owned: Owned<State, Event, Command, Refusals>,
    clock: Clock.Clock
  ) {
    super();
    const { session } = owned;
    this.session = session;
    /** When a desync stopped the session, on the Clock, or null. */
    let desyncAtMs: number | null = null;

    /**
     * Ticks now on the Clock; the error the run fails with, or null to go on. A tick of a stopped
     * session only resends its desync, if it has one. Throws once the session's scope has closed.
     */
    const tickNow = (): LockstepSession.LockstepError | null => {
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
    const timed: Effect.Effect<never, LockstepSession.LockstepError> =
      Effect.forever(
        Effect.suspend(() => {
          const error = tickNow();
          return error === null ? Effect.void : Effect.fail(error);
        }).pipe(Effect.andThen(clock.sleep(Duration.millis(TICK_MS))))
      );

    // One callback for the whole run, whose ticks are plain calls: a tick runs the session inside
    // the ticker's own call, so a ticker that draws ticks and then draws in one frame, and reads
    // the session right after its tick. A tick on a stream or a fiber would run a task later,
    // after the frame had drawn.
    const ticked = (ticker: Ticker.Ticker) =>
      Effect.callback<never, LockstepSession.LockstepError>((resume) => {
        let ended = false;
        let stop: (() => void) | null = null;
        const end = (
          result: Effect.Effect<never, LockstepSession.LockstepError>
        ) => {
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
          let stopped: LockstepSession.LockstepError | null;
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

    this.run = Effect.fn("ScopedLockstepSession.run")(function* (
      ticker?: Ticker.Ticker
    ) {
      if (owned.closed) {
        return yield* Effect.die(ranAfterClose());
      }
      if (session.error !== null) {
        return yield* Effect.fail(session.error);
      }
      return yield* ticker === undefined ? timed : ticked(ticker);
    });

    this.listen = Effect.fn("ScopedLockstepSession.listen")(function* (
      onEvent: (event: Event) => void
    ) {
      yield* Effect.acquireRelease(
        // A listener of its own: the session's listeners are a set, so another `listen` with the
        // same callback would otherwise share it, and leaving would remove both.
        Effect.sync(() => session.subscribe((event) => onEvent(event))),
        (unsubscribe) => Effect.sync(unsubscribe)
      );
    });

    // The session tells the sender how the command ended: that is this Effect's result. It
    // resumes after a yield, so the sender's next line never runs on the tick's stack, nor on
    // that of the scope's close, which drops what still waits. Interrupted, it takes the command
    // back.
    this.send = Effect.fn("ScopedLockstepSession.send")(function* (
      command: Command
    ) {
      yield* Effect.callback<undefined, unknown>((resume) => {
        const unsend = session.send(command, (outcome) =>
          resume(
            Effect.andThen(
              Effect.yieldNow,
              outcome === undefined ? Effect.undefined : Effect.fail(outcome)
            )
          )
        );
        return Effect.sync(unsend);
      });
    }) as ScopedLockstepSession<State, Event, Command, Refusals>["send"];
  }

  get status(): LockstepSession.Status {
    return this.session.status;
  }

  get error(): LockstepSession.LockstepError | null {
    return this.session.error;
  }

  get waitingFor(): readonly string[] {
    return this.session.waitingFor;
  }

  get players(): readonly string[] {
    return this.session.players;
  }

  get state(): State | null {
    return this.session.state;
  }

  get stepIndex(): number {
    return this.session.stepIndex;
  }

  pipe() {
    // oxlint-disable-next-line prefer-rest-params -- Effect's own `pipe` reads its arguments so, with no array made per call.
    return pipeArguments(this, arguments);
  }

  toJSON(): unknown {
    return {
      _id: "ScopedLockstepSession",
      status: this.session.status,
      stepIndex: this.session.stepIndex,
      players: this.session.players,
    };
  }
}
