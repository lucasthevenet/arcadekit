import type { GameSimulation, StepInput } from "@gamekit/runtime";
import { describe, expect, it } from "vitest";

import { jsonCodec } from "./codec";
import { hostLockstep, joinLockstep } from "./lockstep";
import type {
  ConfirmedStep,
  LockstepOptions,
  LockstepSession,
} from "./lockstep";
import { createMemoryNetwork } from "./memory-network";
import type { MemoryNetwork, MemoryNetworkOptions } from "./memory-network";
import { hasher, runNetwork } from "./test-harness";

// A tiny deterministic game: its state is a running digest of every input it has stepped on, and
// it keeps that digest after each step so tests can compare runs step by step.

interface Tiny {
  digest: number;
  /** The digest after each step: history[n] is the state after n + 1 steps. */
  readonly history: number[];
}

interface Move {
  readonly n: number;
}

type TinyInput = ConfirmedStep<Move>;

const tinyStep = (state: Tiny, input: TinyInput) => {
  const h = hasher();
  h.add(state.digest);
  for (const { player, input: move } of input.inputs) {
    h.add(player.length);
    h.add(player.codePointAt(player.length - 1)!);
    h.add(move.n);
  }
  h.add(input.removed.length);
  state.digest = h.value;
  state.history.push(state.digest);
};

const tinySimulation: GameSimulation<null, Tiny, TinyInput, never> = {
  create: (_config, seed) => ({ digest: seed, history: [] }),
  step: tinyStep,
  drainEvents: () => [],
};

/** Each player's scripted input for a step: different per player, the same on every run. */
const script = (player: string, step: number): Move => ({
  n: (step * 7 + player.codePointAt(player.length - 1)! * 13) % 11,
});

const scripted = (player: string): StepInput<Move> => ({
  read: (step) => script(player, step),
});

/** The run every peer should play: all players' scripted input at every step, no one removed. */
const expectedHistory = (
  players: readonly string[],
  seed: number,
  steps: number
) => {
  const state = tinySimulation.create(null, seed);
  for (let step = 0; step < steps; step++) {
    tinyStep(state, {
      inputs: players.map((player) => ({
        player,
        input: script(player, step),
      })),
      removed: [],
    });
  }
  return state.history;
};

const HASH_EVERY = 10;

const options = (
  network: MemoryNetwork,
  id: string,
  overrides: Partial<LockstepOptions<null, Tiny, TinyInput, never, Move>> = {}
): LockstepOptions<null, Tiny, TinyInput, never, Move> => ({
  simulation: tinySimulation,
  config: null,
  contentHash: "content-1",
  transport: network.connect(id),
  local: scripted(id),
  codec: jsonCodec<Move>(),
  combine: (step) => step,
  hash: (state) => state.digest,
  inputDelay: 3,
  hashEvery: HASH_EVERY,
  ...overrides,
});

const SEED = 42;

/** Starts a host and its peers on one network, each peer on its own tick rate. */
const startRun = (
  networkOptions: MemoryNetworkOptions,
  peers: readonly string[],
  overrides: (
    id: string
  ) => Partial<LockstepOptions<null, Tiny, TinyInput, never, Move>> = () => ({})
) => {
  const network = createMemoryNetwork(networkOptions);
  const host = hostLockstep(
    { ...options(network, "host", overrides("host")), peers, seed: SEED },
    0
  );
  const joined = peers.map((id) =>
    joinLockstep({ ...options(network, id, overrides(id)), host: "host" }, 0)
  );
  const sessions = [host, ...joined];
  const ticked = sessions.map((session, i) => ({
    session,
    everyMs: [4, 5, 7, 6][i]!,
  }));
  return { network, host, joined, sessions, ticked };
};

const history = (session: LockstepSession<Tiny, never>) =>
  session.state!.history;

const BAD_NETWORK: MemoryNetworkOptions = {
  seed: 9,
  latencyMs: 30,
  jitterMs: 25,
  loss: 0.15,
};

/** A three-player run in which p2 goes silent after 1 s. */
const silenced = () => {
  const run = startRun(BAD_NETWORK, ["p1", "p2"]);
  runNetwork(run.network, run.ticked, 0, 1000);
  run.network.cutOff("p2", true);
  return run;
};

describe("lockstep session", () => {
  it.each([
    { players: 2, peers: ["p1"] },
    { players: 3, peers: ["p1", "p2"] },
  ])(
    "keeps $players players in lockstep over a lossy, jittery network",
    ({ peers }) => {
      const run = startRun(BAD_NETWORK, peers);
      runNetwork(run.network, run.ticked, 0, 5000);
      const expected = expectedHistory(["host", ...peers], SEED, 400);
      for (const session of run.sessions) {
        expect(session.error).toBeNull();
        expect(session.players).toStrictEqual(["host", ...peers]);
        // Five seconds at 60 Hz, less the waits for input.
        expect(session.stepIndex).toBeGreaterThan(200);
        const steps = Math.min(session.stepIndex, expected.length);
        expect(history(session).slice(0, steps)).toStrictEqual(
          expected.slice(0, steps)
        );
      }
    }
  );

  it("steps every peer at about real time on a good network", () => {
    const run = startRun({ seed: 1, latencyMs: 20, jitterMs: 5 }, ["p1"]);
    runNetwork(run.network, run.ticked, 0, 2000);
    for (const session of run.sessions) {
      expect(session.stepIndex).toBeGreaterThan(110);
      expect(session.status).toBe("running");
    }
  });

  it("reads local input inputDelay steps ahead, once per step", () => {
    const network = createMemoryNetwork({ seed: 1 });
    const reads: [number, number][] = [];
    let host: LockstepSession<Tiny, never> | null = null;
    host = hostLockstep(
      {
        ...options(network, "host", {
          local: {
            read: (step) => {
              reads.push([step, host?.stepIndex ?? 0]);
              return script("host", step);
            },
          },
        }),
        peers: [],
        seed: SEED,
      },
      0
    );
    runNetwork(network, [{ session: host, everyMs: 4 }], 0, 500);
    expect(reads.map(([step]) => step)).toStrictEqual(reads.map((_, i) => i));
    // Each read after the start is for the step inputDelay ahead of the next one to run.
    for (const [step, stepIndex] of reads.slice(4)) {
      expect(step - stepIndex).toBe(3);
    }
  });

  describe("when one peer's state diverges", () => {
    const DIVERGE_AT = 50;
    const diverged = () => {
      const run = startRun(BAD_NETWORK, ["p1", "p2"], (id) =>
        id === "p2"
          ? {
              simulation: {
                ...tinySimulation,
                step: (state, input) => {
                  tinyStep(state, input);
                  // A last-bit difference, as an engine that rounds differently would make.
                  if (state.history.length === DIVERGE_AT) {
                    state.digest += 1;
                  }
                },
              },
            }
          : {}
      );
      runNetwork(run.network, run.ticked, 0, 5000);
      return run;
    };

    it("stops every peer with the same desync, within hashEvery steps", () => {
      const run = diverged();
      const reasons = run.sessions.map((session) => session.error?.reason);
      const [reason] = reasons;
      expect(reason?.kind).toBe("desync");
      expect(reasons).toStrictEqual([reason, reason, reason]);
      const step = reason?.kind === "desync" ? reason.step : -1;
      expect(step).toBeGreaterThanOrEqual(DIVERGE_AT);
      expect(step).toBeLessThanOrEqual(DIVERGE_AT + HASH_EVERY);
    });

    it("names the step and every peer's hash in the error", () => {
      const { error } = diverged().host;
      const reason = error?.reason;
      if (reason?.kind !== "desync") {
        throw new Error(`Expected a desync, got ${error?.message}`);
      }
      // The first mismatch stops the run, so p1's hash may not be in yet; host's and p2's are.
      expect(reason.hashes.host).not.toBe(reason.hashes.p2);
      expect(error?.message).toContain(`step ${reason.step}`);
      expect(error?.message).toContain(
        `p2 ${reason.hashes.p2!.toString(16).padStart(8, "0")}`
      );
    });
  });

  describe("when a peer goes silent", () => {
    it("has every peer wait for it, without stepping, until dropAfterMs", () => {
      const run = silenced();
      runNetwork(run.network, run.ticked, 1001, 2000);
      const stalledAt = run.host.stepIndex;
      const waiting = () =>
        [run.host, run.joined[0]!].map((s) => [s.status, s.waitingFor]);
      expect(waiting()).toStrictEqual([
        ["waiting", ["p2"]],
        ["waiting", ["p2"]],
      ]);
      // Still within the 10 s since p2 was last heard.
      runNetwork(run.network, run.ticked, 2001, 10_500);
      expect(waiting()).toStrictEqual([
        ["waiting", ["p2"]],
        ["waiting", ["p2"]],
      ]);
      expect(run.host.stepIndex).toBe(stalledAt);
      expect(run.host.players).toStrictEqual(["host", "p1", "p2"]);
    });

    it("has the host remove it after dropAfterMs, and the others run on in step", () => {
      const run = silenced();
      runNetwork(run.network, run.ticked, 1001, 10_500);
      const stalledAt = run.host.stepIndex;
      runNetwork(run.network, run.ticked, 10_501, 14_000);
      const p1 = run.joined[0]!;
      expect([run.host.players, p1.players]).toStrictEqual([
        ["host", "p1"],
        ["host", "p1"],
      ]);
      // Over this network the host still waits on p1 now and then, but never on p2 again.
      expect(run.host.waitingFor).not.toContain("p2");
      expect(run.host.stepIndex).toBeGreaterThan(stalledAt + 100);
      expect(p1.error).toBeNull();
      const steps = Math.min(run.host.stepIndex, p1.stepIndex);
      expect(history(p1).slice(0, steps)).toStrictEqual(
        history(run.host).slice(0, steps)
      );
    });

    it("stops the silent peer itself once it hasn't heard the host for dropAfterMs", () => {
      const run = silenced();
      runNetwork(run.network, run.ticked, 1001, 12_000);
      const p2 = run.joined[1]!;
      expect(p2.status).toBe("stopped");
      expect(p2.error?.reason.kind).toBe("hostLost");
    });
  });

  it("refuses to start with content that differs from the host's", () => {
    const run = startRun({ seed: 1, latencyMs: 10 }, ["p1"], (id) =>
      id === "p1" ? { contentHash: "content-2" } : {}
    );
    runNetwork(run.network, run.ticked, 0, 200);
    const { error } = run.joined[0]!;
    expect(error?.reason).toStrictEqual({
      kind: "contentMismatch",
      hostContentHash: "content-1",
      localContentHash: "content-2",
    });
    expect(error?.message).toContain("content-1");
    expect(run.host.waitingFor).toStrictEqual(["p1"]);
  });
});
