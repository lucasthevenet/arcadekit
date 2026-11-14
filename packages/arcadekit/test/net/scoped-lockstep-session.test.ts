import { Clock, Effect, Exit, Fiber, Result, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as Game from "../../src/game/index";
import {
  LockstepSession,
  MemoryNetwork,
  ScopedLockstepSession,
} from "../../src/net/index";
import type { Ticker, Transport } from "../../src/net/index";

// The scoped sessions read Effect's Clock, so every test runs on a TestClock, starting at 0.

interface Count {
  steps: number;
  total: number;
}

/** The run's sample: how many steps it has run. */
class Stepped extends Game.Event("Stepped", { steps: Schema.Int }) {}

/** Every player's input for a step: a number each. */
const Adds = Game.PlayerInputs(Schema.Number);
type Adds = typeof Adds.Type;

const createCount = (_config: null): Count => ({ steps: 0, total: 0 });

const count = (state: Count, input: Adds) => {
  state.steps += 1;
  for (const n of input.players) {
    state.total += n ?? 0;
  }
};

/** The step count, every 100 ms. */
const SAMPLE = {
  event: Stepped,
  every: "100 millis",
  read: (state: Count) => ({ steps: state.steps }),
} as const;

/** Counts its steps and adds up every player's input. Samples its step count every 100 ms. */
class Counting extends Game.Simulation("Counting", {
  input: Adds,
  create: createCount,
  step: count,
  sample: SAMPLE,
}) {}

/** The counting game in 8 ms steps: each 4 ms tick owes exactly half a step. */
class CountingEveryEightMs extends Game.Simulation("CountingEveryEightMs", {
  stepSeconds: 1 / 125,
  input: Adds,
  create: createCount,
  step: count,
  sample: SAMPLE,
}) {}

/** More than a player may add at once. */
class TooMuch extends Game.Rejection("TooMuch", { most: Schema.Int }) {}

/** The sender adds `n` to the total, 10 at most. */
class Add extends Game.Command(
  "Add",
  { n: Schema.Int },
  { rejects: [TooMuch] }
) {}

/** The counting game with a command a player may send. */
class Adding extends Game.Simulation("Adding", {
  input: Adds,
  commands: [Add],
  create: createCount,
  step: count,
  apply: {
    Add: (state, { n }) => {
      if (n > 10) {
        return new TooMuch({ most: 10 });
      }
      state.total += n;
    },
  },
  sample: SAMPLE,
}) {}

type Options = LockstepSession.Options<
  null,
  Count,
  Adds,
  Stepped,
  never,
  unknown
>;

const options = (
  transport: Transport.Transport,
  overrides: Partial<Options> = {}
): Options => ({
  simulation: Counting,
  config: null,
  contentHash: "content-1",
  transport,
  local: { read: () => 1 },
  hash: (state) => state.total,
  // Far enough ahead that a lone host's steps never wait on its own input.
  inputDelay: 20,
  hashEvery: 10,
  ...overrides,
});

/** `transport`, counting the listeners it has. A listener removed twice shows as a negative count. */
const counted = (transport: Transport.Transport) => {
  let listening = 0;
  return {
    transport: {
      ...transport,
      listen: (handler) => {
        listening += 1;
        const stop = transport.listen(handler);
        return () => {
          listening -= 1;
          stop();
        };
      },
    } satisfies Transport.Transport,
    listening: () => listening,
  };
};

/** `transport`, losing the first desync message it sends, as a lossy network can. */
const losingFirstDesync = (
  transport: Transport.Transport,
  clock: Clock.Clock
) => {
  let firstAtMs: number | null = null;
  return {
    transport: {
      ...transport,
      send: (to, message) => {
        if (firstAtMs === null && JSON.parse(message).kind === "desync") {
          firstAtMs = clock.currentTimeMillisUnsafe();
          return;
        }
        transport.send(to, message);
      },
    } satisfies Transport.Transport,
    /** When it lost that message, or null. */
    firstDesyncAtMs: () => firstAtMs,
  };
};

/** A state hash that drifts after 25 steps, as an engine that rounds differently would make. */
const drifting = (state: Count) => state.total + (state.steps > 25 ? 1 : 0);

/** A ticker the test fires by hand. */
const tickedByHand = () => {
  let onTick: (() => void) | null = null;
  let stops = 0;
  const ticker: Ticker.Ticker = (tick) => {
    onTick = tick;
    return () => {
      stops += 1;
    };
  };
  return {
    ticker,
    /** Ticks, even once stopped: a tick already on its way, as a worker's message can be. */
    fire: () => onTick?.(),
    stops: () => stops,
  };
};

const play = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.scoped, Effect.provide(TestClock.layer()))
  );

const lockstepFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = Exit.findError(exit);
  if (
    Result.isFailure(error) ||
    !(error.success instanceof LockstepSession.LockstepError)
  ) {
    throw new Error(`Expected a LockstepError, got ${String(exit)}`);
  }
  return error.success;
};

const hostAlone = (
  network: MemoryNetwork.MemoryNetwork,
  overrides: Partial<Options> = {}
): Effect.Effect<
  ScopedLockstepSession.ScopedLockstepSession<Count, Stepped, never, unknown>,
  never,
  Scope.Scope
> =>
  ScopedLockstepSession.host({
    ...options(MemoryNetwork.connect(network, "host"), overrides),
    peers: [],
    seed: 1,
  });

/** A lone host of the game with a command, its input scheduled 2 steps ahead. */
const adding = (network: MemoryNetwork.MemoryNetwork) =>
  ScopedLockstepSession.host({
    ...options(MemoryNetwork.connect(network, "host")),
    simulation: Adding,
    inputDelay: 2,
    peers: [],
    seed: 1,
  });

/** Delivers `network`'s messages every millisecond of the Clock, until interrupted. */
const deliver = (network: MemoryNetwork.MemoryNetwork) =>
  Effect.forever(
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) =>
        Effect.sync(() => MemoryNetwork.advance(network, nowMs))
      ),
      Effect.andThen(Effect.sleep(1))
    )
  );

describe("scoped lockstep session", () => {
  it("listens to its transport until its scope closes", async () => {
    const network = MemoryNetwork.make({ seed: 1 });
    const host = counted(MemoryNetwork.connect(network, "host"));
    const peer = counted(MemoryNetwork.connect(network, "p1"));
    const exit = await play(
      Effect.gen(function* () {
        yield* ScopedLockstepSession.host({
          ...options(host.transport),
          peers: ["p1"],
          seed: 1,
        });
        yield* ScopedLockstepSession.join({
          ...options(peer.transport),
          host: "host",
          players: ["host", "p1"],
        });
        return [host.listening(), peer.listening()];
      })
    );
    expect(exit).toStrictEqual(Exit.succeed([1, 1]));
    expect([host.listening(), peer.listening()]).toStrictEqual([0, 0]);
  });

  it("dies with what starting throws, with nothing left listening", async () => {
    const network = MemoryNetwork.make({ seed: 1 });
    const { transport, listening } = counted(
      MemoryNetwork.connect(network, "host")
    );
    const thrown = new Error("no content");
    class NoContent extends Game.Simulation("NoContent", {
      input: Adds,
      create: (_config: null): Count => {
        throw thrown;
      },
      step: count,
      sample: SAMPLE,
    }) {}
    const exit = await play(
      ScopedLockstepSession.host({
        ...options(transport, { simulation: NoContent }),
        peers: [],
        seed: 1,
      })
    );
    expect(Exit.findDefect(exit)).toStrictEqual(Result.succeed(thrown));
    expect(listening()).toBe(0);
  });

  it("has the plain host stop listening when starting throws", () => {
    const network = MemoryNetwork.make({ seed: 1 });
    const { transport, listening } = counted(
      MemoryNetwork.connect(network, "host")
    );
    expect(() =>
      LockstepSession.host(
        {
          ...options(transport, {
            local: {
              read: () => {
                throw new Error("no device");
              },
            },
          }),
          peers: [],
          seed: 1,
        },
        0
      )
    ).toThrow("no device");
    expect(listening()).toBe(0);
  });

  describe("run", () => {
    it("ticks every 4 ms of the Clock by default", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const transport = MemoryNetwork.connect(network, "host");
      const sentAt: number[] = [];
      const exit = await play(
        Effect.gen(function* () {
          const clock = yield* Clock.Clock;
          // Each tick tells p1, which never answers, that the run started: one message a tick.
          yield* ScopedLockstepSession.host({
            ...options({
              ...transport,
              send: (to, message) => {
                sentAt.push(clock.currentTimeMillisUnsafe());
                transport.send(to, message);
              },
            }),
            peers: ["p1"],
            seed: 1,
          }).pipe(
            Effect.flatMap((session) => Effect.forkScoped(session.run()))
          );
          yield* TestClock.adjust(10);
          const early = [...sentAt];
          yield* TestClock.adjust(990);
          return early;
        })
      );
      expect(exit).toStrictEqual(Exit.succeed([0, 4, 8]));
      expect(sentAt).toStrictEqual(
        Array.from({ length: 251 }, (_, i) => i * 4)
      );
    });

    it("steps by the Clock's time", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network, {
            simulation: CountingEveryEightMs,
          });
          yield* Effect.forkScoped(session.run());
          yield* TestClock.adjust("1 second");
          return session.stepIndex;
        })
      );
      expect(exit).toStrictEqual(Exit.succeed(125));
    });

    it("ticks once per tick of its ticker, at the Clock's time, done by the time onTick returns", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network);
          yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          const seen: number[] = [];
          for (const ms of [100, 100, 50]) {
            yield* TestClock.adjust(ms);
            ticks.fire();
            seen.push(session.stepIndex);
          }
          // Time alone steps nothing: only a tick does.
          yield* TestClock.adjust("1 second");
          seen.push(session.stepIndex);
          return seen;
        })
      );
      // 6 steps per 100 ms at 60 Hz.
      expect(exit).toStrictEqual(Exit.succeed([6, 12, 15, 15]));
    });

    it("fails with the session's error when it stops, and stops its ticker", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      const exit = await play(
        Effect.gen(function* () {
          // No host on the network: nothing is ever heard.
          const session = yield* ScopedLockstepSession.join({
            ...options(MemoryNetwork.connect(network, "p1"), {
              dropAfterMs: 1000,
            }),
            host: "host",
            players: ["host", "p1"],
          });
          const fiber = yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          yield* TestClock.adjust(999);
          ticks.fire();
          const runningAt999 = fiber.pollUnsafe() === undefined;
          yield* TestClock.adjust(1);
          ticks.fire();
          const failure = yield* Fiber.await(fiber);
          // A late tick does nothing more.
          ticks.fire();
          // Run again, it fails at once: the session stopped for good.
          const again = yield* Effect.exit(session.run(tickedByHand().ticker));
          return { runningAt999, failure, again, error: session.error };
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      const { runningAt999, failure, again, error } = exit.value;
      expect(runningAt999).toBe(true);
      expect(lockstepFailure(failure).reason).toStrictEqual({
        kind: "hostLost",
        host: "host",
        silentMs: 1000,
      });
      expect(lockstepFailure(failure)).toBe(error);
      expect(lockstepFailure(again)).toBe(error);
      expect(ticks.stops()).toBe(1);
    });

    it("stops a ticker that ticks at once, when the session stops in that tick", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      let stops = 0;
      const eager: Ticker.Ticker = (onTick) => {
        onTick();
        return () => {
          stops += 1;
        };
      };
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* ScopedLockstepSession.join({
            ...options(MemoryNetwork.connect(network, "p1"), {
              dropAfterMs: 1000,
            }),
            host: "host",
            players: ["host", "p1"],
          });
          yield* TestClock.adjust(1000);
          return yield* Effect.exit(session.run(eager));
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      expect(lockstepFailure(exit.value).reason.kind).toBe("hostLost");
      expect(stops).toBe(1);
    });

    it("fails every peer with the same desync, on a lossy network", async () => {
      // The plain sessions' bad network, on a seed where a desync sent once reaches no other peer.
      const network = MemoryNetwork.make({
        seed: 2,
        latencyMs: 30,
        jitterMs: 25,
        loss: 0.15,
      });
      const exit = await play(
        Effect.gen(function* () {
          const host = yield* ScopedLockstepSession.host({
            ...options(MemoryNetwork.connect(network, "host"), {
              inputDelay: 3,
            }),
            peers: ["p1", "p2"],
            seed: 1,
          });
          const players = ["host", "p1", "p2"];
          const p1 = yield* ScopedLockstepSession.join({
            ...options(MemoryNetwork.connect(network, "p1"), { inputDelay: 3 }),
            host: "host",
            players,
          });
          const p2 = yield* ScopedLockstepSession.join({
            ...options(MemoryNetwork.connect(network, "p2"), {
              inputDelay: 3,
              hash: drifting,
            }),
            host: "host",
            players,
          });
          yield* Effect.forkScoped(deliver(network));
          const runs = yield* Effect.forEach([host, p1, p2], (session) =>
            Effect.forkScoped(session.run())
          );
          yield* TestClock.adjust("5 seconds");
          // Polled, not awaited: a peer that never hears of the desync runs on.
          return runs.map((fiber) => fiber.pollUnsafe());
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      const reasons = exit.value.map(
        (run) => run && lockstepFailure(run).reason
      );
      expect(reasons[0]).toMatchObject({ kind: "desync", step: 30 });
      expect(reasons).toStrictEqual([reasons[0], reasons[0], reasons[0]]);
    });

    it("resends a desync for a second after it stops, then fails", async () => {
      const network = MemoryNetwork.make({ seed: 1, latencyMs: 20 });
      const exit = await play(
        Effect.gen(function* () {
          const clock = yield* Clock.Clock;
          // Each side loses the first desync it sends: only a resend tells the other.
          const links = [
            losingFirstDesync(MemoryNetwork.connect(network, "host"), clock),
            losingFirstDesync(MemoryNetwork.connect(network, "p1"), clock),
          ] as const;
          const host = yield* ScopedLockstepSession.host({
            ...options(links[0].transport, { inputDelay: 3 }),
            peers: ["p1"],
            seed: 1,
          });
          const p1 = yield* ScopedLockstepSession.join({
            ...options(links[1].transport, { inputDelay: 3, hash: drifting }),
            host: "host",
            players: ["host", "p1"],
          });
          yield* Effect.forkScoped(deliver(network));
          const runs = yield* Effect.forEach([host, p1], (session) =>
            Effect.forkScoped(
              Effect.exit(session.run()).pipe(
                Effect.flatMap((run) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.map((endedAtMs) => ({ run, endedAtMs }))
                  )
                )
              )
            )
          );
          yield* TestClock.adjust("3 seconds");
          // Polled, not awaited: a peer that never hears of the desync runs on.
          return {
            ended: runs.map((fiber) => fiber.pollUnsafe()),
            lostAtMs: links.map((link) => link.firstDesyncAtMs()),
          };
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      const { ended, lostAtMs } = exit.value;
      const runs = ended.map((run) =>
        run && Exit.isSuccess(run) ? run.value : undefined
      );
      const reasons = runs.map((run) => run && lockstepFailure(run.run).reason);
      expect(reasons[0]).toMatchObject({ kind: "desync", step: 30 });
      expect(reasons[1]).toStrictEqual(reasons[0]);
      // Each run fails a second after its session stopped, which is when it lost its first desync.
      expect(
        runs.map((run, i) => run && run.endedAtMs - (lostAtMs[i] ?? Number.NaN))
      ).toStrictEqual([1000, 1000]);
    });

    it("stops ticking and stops its ticker when interrupted", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network);
          const timed = yield* Effect.forkScoped(session.run());
          const ticked = yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          yield* TestClock.adjust(100);
          const interrupted = yield* Effect.forEach([timed, ticked], (fiber) =>
            Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
          );
          const { stepIndex } = session;
          yield* TestClock.adjust("1 second");
          // A late tick doesn't reach the session.
          ticks.fire();
          return {
            interrupted: interrupted.every(Exit.hasInterrupts),
            stepped: session.stepIndex - stepIndex,
            stops: ticks.stops(),
          };
        })
      );
      expect(exit).toStrictEqual(
        Exit.succeed({ interrupted: true, stepped: 0, stops: 1 })
      );
    });

    it("dies with what a tick throws, and stops its ticker", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      const thrown = new Error("step 3 broke");
      class BreaksAtStepThree extends Game.Simulation("BreaksAtStepThree", {
        input: Adds,
        create: createCount,
        step: (state, input) => {
          count(state, input);
          if (state.steps === 3) {
            throw thrown;
          }
        },
        sample: SAMPLE,
      }) {}
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network, {
            simulation: BreaksAtStepThree,
          });
          const fiber = yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          yield* TestClock.adjust(100);
          // The throw ends up in the run, not in the ticker's callback: `fire` returns.
          ticks.fire();
          const run = yield* Fiber.await(fiber);
          return { run, stops: ticks.stops() };
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      expect(Exit.findDefect(exit.value.run)).toStrictEqual(
        Result.succeed(thrown)
      );
      expect(exit.value.stops).toBe(1);
    });

    it("stops its ticker once when a tick interrupts the run", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      let fiber: Fiber.Fiber<never, LockstepSession.LockstepError> | null =
        null;
      class LeftInAStep extends Game.Simulation("LeftInAStep", {
        input: Adds,
        create: createCount,
        // Someone leaves the run from inside a tick (a listener, say), and the tick ends the
        // run too.
        step: () => {
          fiber?.interruptUnsafe();
          throw new Error("after leaving");
        },
        sample: SAMPLE,
      }) {}
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network, {
            simulation: LeftInAStep,
          });
          fiber = yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          yield* TestClock.adjust(100);
          ticks.fire();
          return yield* Fiber.await(fiber);
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      expect(Exit.hasInterrupts(exit.value)).toBe(true);
      expect(ticks.stops()).toBe(1);
    });

    it("ends the run when its ticker's stop throws", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const thrown = new Error("no worker to stop");
      let onTick: (() => void) | null = null;
      const throwing: Ticker.Ticker = (tick) => {
        onTick = tick;
        return () => {
          throw thrown;
        };
      };
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* ScopedLockstepSession.join({
            ...options(MemoryNetwork.connect(network, "p1"), {
              dropAfterMs: 1000,
            }),
            host: "host",
            players: ["host", "p1"],
          });
          const fiber = yield* Effect.forkScoped(session.run(throwing), {
            startImmediately: true,
          });
          yield* TestClock.adjust(1000);
          // The stop's throw goes back to the ticker that ticked.
          const fired = Result.try(() => onTick?.());
          return { fired, run: yield* Fiber.await(fiber) };
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      expect(exit.value.fired).toStrictEqual(Result.fail(thrown));
      expect(lockstepFailure(exit.value.run).reason.kind).toBe("hostLost");
    });

    it("ends the run after onTick returns, so the ticker's tick is done before the run's scope closes", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const log: string[] = [];
      let disposed = false;
      let fire: (() => void) | null = null;
      // Ticks, then draws with what the run's scope holds.
      const drawing: Ticker.Ticker = (onTick) => {
        fire = () => {
          onTick();
          log.push(disposed ? "drew disposed" : "drew");
        };
        return () => {
          log.push("stopped");
        };
      };
      const exit = await play(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => {
                  disposed = true;
                  log.push("disposed");
                })
              );
              const session = yield* ScopedLockstepSession.join({
                ...options(MemoryNetwork.connect(network, "p1"), {
                  dropAfterMs: 1000,
                }),
                host: "host",
                players: ["host", "p1"],
              });
              return yield* session.run(drawing);
            }).pipe(Effect.scoped),
            { startImmediately: true }
          );
          yield* TestClock.adjust(1000);
          // The session stops in this tick.
          fire?.();
          return yield* Fiber.await(fiber);
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      expect(lockstepFailure(exit.value).reason.kind).toBe("hostLost");
      expect(log).toStrictEqual(["stopped", "drew", "disposed"]);
    });

    it("dies on its next tick when it runs on after its scope closes, and sends nothing more", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const transport = MemoryNetwork.connect(network, "host");
      const ticks = tickedByHand();
      let sent = 0;
      const exit = await play(
        Effect.gen(function* () {
          // The runs are the program fiber's children, not the session scope's: they outlive it.
          const { session, runs } = yield* Effect.scoped(
            Effect.gen(function* () {
              const opened = yield* ScopedLockstepSession.host({
                ...options({
                  ...transport,
                  send: (to, message) => {
                    sent += 1;
                    transport.send(to, message);
                  },
                }),
                peers: ["p1"],
                seed: 1,
              });
              const forked = [
                yield* Effect.forkChild(opened.run()),
                yield* Effect.forkChild(opened.run(ticks.ticker), {
                  startImmediately: true,
                }),
              ];
              yield* TestClock.adjust(100);
              return { session: opened, runs: forked };
            })
          );
          const { stepIndex } = session;
          const sentAtClose = sent;
          yield* TestClock.adjust("1 second");
          ticks.fire();
          const ended = yield* Effect.all(
            runs.map((fiber) => Fiber.await(fiber))
          );
          // Run again, it dies at once.
          ended.push(yield* Effect.exit(session.run()));
          return {
            defects: ended.map((run) =>
              Result.map(Exit.findDefect(run), String)
            ),
            stepped: session.stepIndex - stepIndex,
            sent: sent - sentAtClose,
            stops: ticks.stops(),
          };
        })
      );
      const died = Result.succeed(
        "Error: A lockstep session ran after its scope closed"
      );
      expect(exit).toStrictEqual(
        Exit.succeed({
          defects: [died, died, died],
          stepped: 0,
          sent: 0,
          stops: 1,
        })
      );
    });
  });

  describe("send", () => {
    it("succeeds once this peer's rules took the command, at the step it rode", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* adding(network);
          yield* Effect.forkScoped(session.run());
          yield* TestClock.adjust(100);
          const before = session.state?.total;
          const sent = yield* Effect.forkChild(
            session.send(new Add({ n: 7 })),
            { startImmediately: true }
          );
          // It waits for a step: scheduled at the next tick, 2 steps ahead of the run.
          const waiting = sent.pollUnsafe() === undefined;
          yield* TestClock.adjust(100);
          const after = session.state?.total;
          return [
            waiting,
            yield* Fiber.await(sent),
            // Seven more than the input alone adds: one a step.
            (after ?? 0) - (before ?? 0) - 6,
          ];
        })
      );
      expect(exit).toStrictEqual(Exit.succeed([true, Exit.void, 7]));
    });

    it("fails with the rejection this peer's rules refused the command with", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* adding(network);
          yield* Effect.forkScoped(session.run());
          const sent = yield* Effect.forkChild(
            session.send(new Add({ n: 11 })).pipe(Effect.flip),
            { startImmediately: true }
          );
          yield* TestClock.adjust(100);
          return [
            yield* Fiber.join(sent),
            session.stepIndex > 0,
            // The input alone, one a step: the refused command changed nothing.
            session.state?.total === session.stepIndex,
          ];
        })
      );
      expect(exit).toStrictEqual(
        Exit.succeed([new TooMuch({ most: 10 }), true, true])
      );
    });

    it("completes after the tick that ran the command's step, not inside it", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* adding(network);
          yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          const seen: string[] = [];
          yield* Effect.forkChild(
            session
              .send(new Add({ n: 1 }))
              .pipe(
                Effect.andThen(
                  Effect.sync(() =>
                    seen.push(`answered at ${session.stepIndex}`)
                  )
                )
              ),
            { startImmediately: true }
          );
          // The first tick gives the command its step; the second runs it.
          for (const ms of [50, 50]) {
            yield* TestClock.adjust(ms);
            ticks.fire();
            seen.push(`ticked to ${session.stepIndex}`);
          }
          yield* Effect.yieldNow;
          return seen;
        })
      );
      expect(exit).toStrictEqual(
        Exit.succeed(["ticked to 3", "ticked to 6", "answered at 6"])
      );
    });

    it("completes after a listener heard what the tick of the command's step reported: its events, then its sample", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      class Added extends Game.Event("Added", { n: Schema.Int }) {}
      /** The counting game, whose command reports what it added. */
      class Telling extends Game.Simulation("Telling", {
        input: Adds,
        events: [Added],
        commands: [Add],
        create: createCount,
        step: count,
        apply: {
          Add: (state, { n }, { report }) => {
            state.total += n;
            report(new Added({ n }));
          },
        },
        sample: SAMPLE,
      }) {}
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* ScopedLockstepSession.host({
            ...options(MemoryNetwork.connect(network, "host")),
            simulation: Telling,
            inputDelay: 2,
            peers: [],
            seed: 1,
          });
          const seen: string[] = [];
          yield* session.listen((event) =>
            seen.push(
              event._tag === "Added"
                ? `heard: added ${event.n}`
                : `heard: sample at ${event.steps}`
            )
          );
          yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          yield* Effect.forkChild(
            session
              .send(new Add({ n: 1 }))
              .pipe(Effect.andThen(Effect.sync(() => seen.push("answered")))),
            { startImmediately: true }
          );
          // The first tick tells the start and gives the command its step; the second runs it,
          // and is due a sample.
          for (const ms of [50, 50]) {
            yield* TestClock.adjust(ms);
            ticks.fire();
            seen.push(`ticked to ${session.stepIndex}`);
          }
          yield* Effect.yieldNow;
          return seen;
        })
      );
      expect(exit).toStrictEqual(
        Exit.succeed([
          "heard: sample at 0",
          "ticked to 3",
          "heard: added 1",
          "heard: sample at 6",
          "ticked to 6",
          "answered",
        ])
      );
    });

    it("fails with CommandDropped when the session's scope closes first", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const exit = await play(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const session = yield* adding(network).pipe(Scope.provide(scope));
          const sent = yield* Effect.forkChild(
            session.send(new Add({ n: 1 })).pipe(Effect.flip),
            { startImmediately: true }
          );
          yield* Scope.close(scope, Exit.void);
          const late = yield* Effect.flip(session.send(new Add({ n: 2 })));
          return [yield* Fiber.join(sent), late];
        })
      );
      const dropped = new Game.CommandDropped({
        command: "Add",
        reason: "runEnded",
      });
      expect(exit).toStrictEqual(Exit.succeed([dropped, dropped]));
    });

    it("takes the command back when interrupted before it rides a step", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      const ticks = tickedByHand();
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* adding(network);
          yield* Effect.forkScoped(session.run(ticks.ticker), {
            startImmediately: true,
          });
          const sent = yield* Effect.forkChild(
            session.send(new Add({ n: 5 })),
            { startImmediately: true }
          );
          yield* Fiber.interrupt(sent);
          yield* TestClock.adjust(100);
          ticks.fire();
          yield* TestClock.adjust(100);
          ticks.fire();
          // The input alone, one a step.
          return [
            session.stepIndex > 3,
            session.state?.total === session.stepIndex,
          ];
        })
      );
      expect(exit).toStrictEqual(Exit.succeed([true, true]));
    });

    it("dies for a command the simulation doesn't declare", async () => {
      const network = MemoryNetwork.make({ seed: 1 });
      class Other extends Game.Command("Other") {}
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* adding(network);
          // What a cast gets past the types.
          return yield* session.send(new Other() as never);
        })
      );
      expect(
        Result.map(Exit.findDefect(exit), (defect) => (defect as Error).message)
      ).toStrictEqual(
        Result.succeed(
          'Simulation "Adding" has no command "Other": list it in `commands` and handle it in `apply`'
        )
      );
    });
  });

  it("calls a listener with the run's events while its scope is open", async () => {
    const network = MemoryNetwork.make({ seed: 1 });
    const ticks = tickedByHand();
    const events: number[] = [];
    const exit = await play(
      Effect.gen(function* () {
        const session = yield* hostAlone(network);
        yield* Effect.forkScoped(session.run(ticks.ticker), {
          startImmediately: true,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* session.listen((event) => events.push(event.steps));
            yield* TestClock.adjust(100);
            ticks.fire();
          })
        );
        yield* TestClock.adjust(100);
        ticks.fire();
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    // The start's sample, which the session tells at its first tick: no step yet. Then that
    // tick's own, at 100 ms: 6 steps. The one at 200 ms came after the listener left.
    expect(events).toStrictEqual([0, 6]);
  });

  it("tells a listener in place before the run's first tick what the host's start reported: create's events, then the first sample", async () => {
    const network = MemoryNetwork.make({ seed: 1 });
    const ticks = tickedByHand();
    class Began extends Game.Event("Began", { seed: Schema.Int }) {}
    class Beginning extends Game.Simulation("Beginning", {
      input: Adds,
      events: [Began],
      create: (_config: null, { seed, report }): Count => {
        report(new Began({ seed }));
        return { steps: 0, total: 0 };
      },
      step: count,
      sample: SAMPLE,
    }) {}
    const heard: (Began | Stepped)[] = [];
    const exit = await play(
      Effect.gen(function* () {
        const session = yield* ScopedLockstepSession.host({
          ...options(MemoryNetwork.connect(network, "host")),
          simulation: Beginning,
          peers: [],
          seed: 7,
        });
        yield* session.listen((event) => heard.push(event));
        // The run has started, and nothing is told before a tick.
        const before = [session.state?.steps, heard.length];
        yield* Effect.forkScoped(session.run(ticks.ticker), {
          startImmediately: true,
        });
        ticks.fire();
        ticks.fire();
        return before;
      })
    );
    expect(exit).toStrictEqual(Exit.succeed([0, 0]));
    // Told once, by the first tick: the second, at the same time, has nothing new.
    expect(heard).toStrictEqual([
      new Began({ seed: 7 }),
      new Stepped({ steps: 0 }),
    ]);
  });

  it("keeps a listener while its scope is open, when another scope listens with the same callback", async () => {
    const network = MemoryNetwork.make({ seed: 1 });
    const ticks = tickedByHand();
    const events: number[] = [];
    const onEvent = (event: Stepped) => {
      events.push(event.steps);
    };
    const exit = await play(
      Effect.gen(function* () {
        const session = yield* hostAlone(network);
        yield* Effect.forkScoped(session.run(ticks.ticker), {
          startImmediately: true,
        });
        yield* session.listen(onEvent);
        // A screen listens with the same callback, then leaves.
        yield* Effect.scoped(session.listen(onEvent));
        yield* TestClock.adjust(100);
        ticks.fire();
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    // Each sample once: the start's, told at the first tick, then that tick's own.
    expect(events).toStrictEqual([0, 6]);
  });
});
