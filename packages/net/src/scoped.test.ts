import type { GameSimulation } from "@arcadekit/runtime";
import { Clock, Effect, Exit, Fiber, Result } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { jsonCodec } from "./codec";
import { LockstepError } from "./errors";
import { hostLockstep } from "./lockstep";
import type { ConfirmedStep, LockstepOptions } from "./lockstep";
import { createMemoryNetwork } from "./memory-network";
import type { MemoryNetwork } from "./memory-network";
import { hostLockstepScoped, joinLockstepScoped } from "./scoped";
import type { ScopedLockstepSession, Ticker } from "./scoped";
import type { Transport } from "./transport";

// The scoped sessions read Effect's Clock, so every test runs on a TestClock, starting at 0.

interface Count {
  steps: number;
  total: number;
}

const NO_EVENTS: readonly never[] = [];

/** Counts its steps and adds up every player's input. Samples its step count every 100 ms. */
const counting: GameSimulation<null, Count, ConfirmedStep<number>, number> = {
  create: () => ({ steps: 0, total: 0 }),
  step: (state, input) => {
    state.steps += 1;
    for (const { input: n } of input.inputs) {
      state.total += n;
    }
  },
  drainEvents: () => NO_EVENTS,
  sample: { everyMs: 100, read: (state) => state.steps },
};

type Options = LockstepOptions<
  null,
  Count,
  ConfirmedStep<number>,
  number,
  number
>;

const options = (
  transport: Transport,
  overrides: Partial<Options> = {}
): Options => ({
  simulation: counting,
  config: null,
  contentHash: "content-1",
  transport,
  local: { read: () => 1 },
  codec: jsonCodec<number>(),
  combine: (step) => step,
  hash: (state) => state.total,
  // Far enough ahead that a lone host's steps never wait on its own input.
  inputDelay: 20,
  hashEvery: 10,
  ...overrides,
});

/** `transport`, counting the listeners it has. A listener removed twice shows as a negative count. */
const counted = (transport: Transport) => {
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
    } satisfies Transport,
    listening: () => listening,
  };
};

/** A ticker the test fires by hand. */
const manualTicker = () => {
  let onTick: (() => void) | null = null;
  let stops = 0;
  const ticker: Ticker = (tick) => {
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
  if (Result.isFailure(error) || !(error.success instanceof LockstepError)) {
    throw new Error(`Expected a LockstepError, got ${String(exit)}`);
  }
  return error.success;
};

const hostAlone = (
  network: MemoryNetwork,
  overrides: Partial<Options> = {}
): Effect.Effect<ScopedLockstepSession<Count, number>, never, Scope.Scope> =>
  hostLockstepScoped({
    ...options(network.connect("host"), overrides),
    peers: [],
    seed: 1,
  });

/** Delivers `network`'s messages every millisecond of the Clock, until interrupted. */
const deliver = (network: MemoryNetwork) =>
  Effect.forever(
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) => Effect.sync(() => network.advance(nowMs))),
      Effect.andThen(Effect.sleep(1))
    )
  );

describe("scoped lockstep session", () => {
  it("listens to its transport until its scope closes", async () => {
    const network = createMemoryNetwork({ seed: 1 });
    const host = counted(network.connect("host"));
    const peer = counted(network.connect("p1"));
    const exit = await play(
      Effect.gen(function* () {
        yield* hostLockstepScoped({
          ...options(host.transport),
          peers: ["p1"],
          seed: 1,
        });
        yield* joinLockstepScoped({ ...options(peer.transport), host: "host" });
        return [host.listening(), peer.listening()];
      })
    );
    expect(exit).toStrictEqual(Exit.succeed([1, 1]));
    expect([host.listening(), peer.listening()]).toStrictEqual([0, 0]);
  });

  it("dies with what starting throws, with nothing left listening", async () => {
    const network = createMemoryNetwork({ seed: 1 });
    const { transport, listening } = counted(network.connect("host"));
    const thrown = new Error("no content");
    const exit = await play(
      hostLockstepScoped({
        ...options(transport, {
          simulation: {
            ...counting,
            create: () => {
              throw thrown;
            },
          },
        }),
        peers: [],
        seed: 1,
      })
    );
    expect(Exit.findDefect(exit)).toStrictEqual(Result.succeed(thrown));
    expect(listening()).toBe(0);
  });

  it("has the plain host stop listening when starting throws", () => {
    const network = createMemoryNetwork({ seed: 1 });
    const { transport, listening } = counted(network.connect("host"));
    expect(() =>
      hostLockstep(
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
      const network = createMemoryNetwork({ seed: 1 });
      const transport = network.connect("host");
      const sentAt: number[] = [];
      const exit = await play(
        Effect.gen(function* () {
          const clock = yield* Clock.Clock;
          // Each tick tells p1, which never answers, that the run started: one message a tick.
          yield* hostLockstepScoped({
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
      const network = createMemoryNetwork({ seed: 1 });
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network, {
            // 8 ms steps: each 4 ms tick owes exactly half a step.
            simulation: { ...counting, stepSeconds: 1 / 125 },
          });
          yield* Effect.forkScoped(session.run());
          yield* TestClock.adjust("1 second");
          return session.stepIndex;
        })
      );
      expect(exit).toStrictEqual(Exit.succeed(125));
    });

    it("ticks once per tick of its ticker, at the Clock's time, done by the time onTick returns", async () => {
      const network = createMemoryNetwork({ seed: 1 });
      const ticks = manualTicker();
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
      const network = createMemoryNetwork({ seed: 1 });
      const ticks = manualTicker();
      const exit = await play(
        Effect.gen(function* () {
          // No host on the network: nothing is ever heard.
          const session = yield* joinLockstepScoped({
            ...options(network.connect("p1"), { dropAfterMs: 1000 }),
            host: "host",
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
          const again = yield* Effect.exit(session.run(manualTicker().ticker));
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
      const network = createMemoryNetwork({ seed: 1 });
      let stops = 0;
      const eager: Ticker = (onTick) => {
        onTick();
        return () => {
          stops += 1;
        };
      };
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* joinLockstepScoped({
            ...options(network.connect("p1"), { dropAfterMs: 1000 }),
            host: "host",
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

    it("fails every peer with the same desync", async () => {
      const network = createMemoryNetwork({ seed: 1, latencyMs: 20 });
      const exit = await play(
        Effect.gen(function* () {
          const host = yield* hostLockstepScoped({
            ...options(network.connect("host"), { inputDelay: 3 }),
            peers: ["p1"],
            seed: 1,
          });
          const p1 = yield* joinLockstepScoped({
            ...options(network.connect("p1"), {
              inputDelay: 3,
              // p1's state drifts after 25 steps, as an engine that rounds differently would.
              hash: (state) => state.total + (state.steps > 25 ? 1 : 0),
            }),
            host: "host",
          });
          yield* Effect.forkScoped(deliver(network));
          const runs = [
            yield* Effect.forkScoped(host.run()),
            yield* Effect.forkScoped(p1.run()),
          ];
          yield* TestClock.adjust("3 seconds");
          return yield* Effect.all(runs.map((fiber) => Fiber.await(fiber)));
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      const reasons = exit.value.map((run) => lockstepFailure(run).reason);
      expect(reasons[0]).toMatchObject({ kind: "desync", step: 30 });
      expect(reasons[1]).toStrictEqual(reasons[0]);
    });

    it("stops ticking and stops its ticker when interrupted", async () => {
      const network = createMemoryNetwork({ seed: 1 });
      const ticks = manualTicker();
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
      const network = createMemoryNetwork({ seed: 1 });
      const ticks = manualTicker();
      const thrown = new Error("step 3 broke");
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network, {
            simulation: {
              ...counting,
              step: (state, input) => {
                counting.step(state, input, 1 / 60);
                if (state.steps === 3) {
                  throw thrown;
                }
              },
            },
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
      const network = createMemoryNetwork({ seed: 1 });
      const ticks = manualTicker();
      let fiber: Fiber.Fiber<never, LockstepError> | null = null;
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* hostAlone(network, {
            simulation: {
              ...counting,
              // Someone leaves the run from inside a tick (a listener, say), and the tick
              // ends the run too.
              step: () => {
                fiber?.interruptUnsafe();
                throw new Error("after leaving");
              },
            },
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
      const network = createMemoryNetwork({ seed: 1 });
      const thrown = new Error("no worker to stop");
      let onTick: (() => void) | null = null;
      const throwing: Ticker = (tick) => {
        onTick = tick;
        return () => {
          throw thrown;
        };
      };
      const exit = await play(
        Effect.gen(function* () {
          const session = yield* joinLockstepScoped({
            ...options(network.connect("p1"), { dropAfterMs: 1000 }),
            host: "host",
          });
          const fiber = yield* Effect.forkScoped(session.run(throwing), {
            startImmediately: true,
          });
          yield* TestClock.adjust(1000);
          // The stop's throw goes back to the ticker that ticked.
          const fired = Result.try(() => onTick?.());
          return { fired, run: fiber.pollUnsafe() };
        })
      );
      if (!Exit.isSuccess(exit)) {
        throw new Error(String(exit));
      }
      expect(exit.value.fired).toStrictEqual(Result.fail(thrown));
      expect(exit.value.run).toBeDefined();
      expect(lockstepFailure(exit.value.run!).reason.kind).toBe("hostLost");
    });
  });

  it("calls a listener with the run's events while its scope is open", async () => {
    const network = createMemoryNetwork({ seed: 1 });
    const ticks = manualTicker();
    const events: number[] = [];
    const exit = await play(
      Effect.gen(function* () {
        const session = yield* hostAlone(network);
        yield* Effect.forkScoped(session.run(ticks.ticker), {
          startImmediately: true,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* session.listen((event) => events.push(event));
            yield* TestClock.adjust(100);
            ticks.fire();
          })
        );
        yield* TestClock.adjust(100);
        ticks.fire();
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    // The sample at the 100 ms tick: 6 steps. The one at 200 ms came after the listener left.
    expect(events).toStrictEqual([6]);
  });
});
