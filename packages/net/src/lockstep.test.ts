import type { GameSimulation, StepInput } from "@arcadekit/runtime";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { jsonCodec, schemaCodec } from "./codec";
import type { InputCodec } from "./codec";
import { hostLockstep, joinLockstep } from "./lockstep";
import type {
  ConfirmedStep,
  LockstepOptions,
  LockstepSession,
} from "./lockstep";
import { createMemoryNetwork } from "./memory-network";
import type { MemoryNetwork, MemoryNetworkOptions } from "./memory-network";
import { hasher, runNetwork } from "./test-harness";
import type { Transport } from "./transport";

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

/** `transport`, sending `junk` before each of its messages. */
const junkFirst = (transport: Transport, junk: string): Transport => ({
  self: transport.self,
  listen: transport.listen,
  send: (to, message) => {
    transport.send(to, junk);
    transport.send(to, message);
  },
});

/**
 * A transport that, with each `inputs` message carrying hashes, also sends a desync claim for
 * the first hash's step: its own hash, honestly, and a made-up one for the host.
 */
const claimsDesync = (transport: Transport): Transport => ({
  self: transport.self,
  listen: transport.listen,
  send: (to, message) => {
    transport.send(to, message);
    const sent = JSON.parse(message) as {
      kind: string;
      hashes?: [number, number][];
    };
    const [first] = sent.hashes ?? [];
    if (sent.kind === "inputs" && first !== undefined) {
      const [step, hash] = first;
      transport.send(
        to,
        JSON.stringify({
          kind: "desync",
          step,
          hashes: { [to]: (hash + 1) >>> 0, [transport.self]: hash },
        })
      );
    }
  },
});

/** A three-player run on a fair network, with p1's transport wrapped by `wrap`. */
const runWithP1 = (wrap: (transport: Transport) => Transport) => {
  const network = createMemoryNetwork({
    seed: 3,
    latencyMs: 20,
    jitterMs: 5,
  });
  const host = hostLockstep(
    { ...options(network, "host"), peers: ["p1", "p2"], seed: SEED },
    0
  );
  const p1Options = options(network, "p1");
  const p1 = joinLockstep(
    { ...p1Options, transport: wrap(p1Options.transport), host: "host" },
    0
  );
  const p2 = joinLockstep({ ...options(network, "p2"), host: "host" }, 0);
  const sessions = [host, p1, p2];
  runNetwork(
    network,
    sessions.map((session, i) => ({ session, everyMs: [4, 5, 7][i]! })),
    0,
    2000
  );
  return { host, p1, p2, sessions };
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

    it("tells a removed peer it was removed when it is heard from again", () => {
      // p2 waits on a silent host longer than the host waits on it.
      const run = startRun(BAD_NETWORK, ["p1", "p2"], (id) =>
        id === "p2" ? { dropAfterMs: 30_000 } : {}
      );
      runNetwork(run.network, run.ticked, 0, 1000);
      run.network.cutOff("p2", true);
      runNetwork(run.network, run.ticked, 1001, 12_000);
      expect(run.host.players).toStrictEqual(["host", "p1"]);
      run.network.cutOff("p2", false);
      runNetwork(run.network, run.ticked, 12_001, 13_000);
      expect(run.joined[1]!.error?.reason.kind).toBe("removed");
    });

    it("stops the silent peer itself once it hasn't heard the host for dropAfterMs", () => {
      const run = silenced();
      runNetwork(run.network, run.ticked, 1001, 12_000);
      const p2 = run.joined[1]!;
      expect(p2.status).toBe("stopped");
      expect(p2.error?.reason.kind).toBe("hostLost");
    });
  });

  it("removes a peer that still sends but can't keep up, as a throttled hidden tab", () => {
    const run = startRun({ seed: 1, latencyMs: 20, jitterMs: 5 }, ["p1"]);
    runNetwork(run.network, run.ticked, 0, 1000);
    // From here p1's timer fires once a second, as a hidden tab's does.
    const hidden = [run.ticked[0]!, { session: run.joined[0]!, everyMs: 1000 }];
    runNetwork(run.network, hidden, 1001, 10_500);
    expect(run.host.players).toStrictEqual(["host", "p1"]);
    expect(run.host.waitingFor).toStrictEqual(["p1"]);
    const stalledAt = run.host.stepIndex;
    runNetwork(run.network, hidden, 10_501, 13_000);
    expect(run.host.players).toStrictEqual(["host"]);
    expect(run.host.stepIndex).toBeGreaterThan(stalledAt + 100);
  });

  it("keeps the hashes it compares bounded over a long run", () => {
    const run = startRun(BAD_NETWORK, ["p1", "p2"]);
    runNetwork(run.network, run.ticked, 0, 30_000);
    expect(run.host.error).toBeNull();
    // White-box: the host's per-step store of peers' hashes, which once kept every hash step.
    const { peerHashes } = (
      run.host as unknown as { host: { peerHashes: Map<number, unknown> } }
    ).host;
    expect(peerHashes.size).toBeLessThan(10);
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

  describe("when a peer claims a desync", () => {
    it.each([
      {
        what: "names no hash of its own",
        junk: '{"kind":"desync","step":0,"hashes":{}}',
      },
      {
        what: "is about a step it can't have reached",
        junk: '{"kind":"desync","step":1000000,"hashes":{"p1":1}}',
      },
      {
        what: "is about a step no hash is kept for",
        junk: '{"kind":"desync","step":3,"hashes":{"p1":1}}',
      },
    ])("runs on when the claim $what", ({ junk }) => {
      const { sessions } = runWithP1((transport) => junkFirst(transport, junk));
      const expected = expectedHistory(["host", "p1", "p2"], SEED, 100);
      for (const session of sessions) {
        expect(session.error).toBeNull();
        expect(session.players).toStrictEqual(["host", "p1", "p2"]);
        expect(history(session).slice(0, 100)).toStrictEqual(expected);
      }
    });

    it("runs on when the claim says the host's hash differs, but the peer's matches it", () => {
      const { sessions } = runWithP1(claimsDesync);
      for (const session of sessions) {
        expect(session.error).toBeNull();
        expect(session.stepIndex).toBeGreaterThan(100);
      }
    });

    it("keeps no hashes for steps no peer can have reached", () => {
      const { host } = runWithP1((transport) => ({
        ...transport,
        send: (to, message) => {
          transport.send(to, message);
          for (let step = 1; step <= 20; step++) {
            transport.send(
              to,
              JSON.stringify({
                kind: "desync",
                step: 1_000_000 + step * HASH_EVERY,
                hashes: { p1: step },
              })
            );
          }
        },
      }));
      const { peerHashes } = (
        internals(host) as { host: { peerHashes: Map<number, unknown> } }
      ).host;
      expect(host.error).toBeNull();
      expect(
        [...peerHashes.keys()].every((step) => step <= host.stepIndex + 1)
      ).toBe(true);
    });
  });

  describe("when what arrives doesn't decode", () => {
    const moveCodec: InputCodec<Move> = schemaCodec(
      Schema.Struct({ n: Schema.Finite })
    );
    const BAD_AT = 40;
    /** Scripted input, but at step BAD_AT a value that isn't a Move. */
    const badAt = (player: string): StepInput<Move> => ({
      read: (step) =>
        step === BAD_AT
          ? ({ n: "x" } as unknown as Move)
          : script(player, step),
    });

    it("has the host remove a peer whose input doesn't decode, and the others run on", () => {
      // p1 sends its bad input as is (jsonCodec); the host and p2 check every input.
      const run = startRun(BAD_NETWORK, ["p1", "p2"], (id) =>
        id === "p1" ? { local: badAt(id) } : { codec: moveCodec }
      );
      runNetwork(run.network, run.ticked, 0, 5000);
      const [p1, p2] = run.joined;
      expect([run.host.error, p2!.error]).toStrictEqual([null, null]);
      expect([run.host.players, p2!.players]).toStrictEqual([
        ["host", "p2"],
        ["host", "p2"],
      ]);
      expect(run.host.stepIndex).toBeGreaterThan(BAD_AT + 100);
      expect(p1!.error?.reason).toStrictEqual({
        kind: "removed",
        peer: "p1",
        step: expect.any(Number),
        why: "badInput",
      });
      const steps = Math.min(run.host.stepIndex, p2!.stepIndex);
      expect(history(p2!).slice(0, steps)).toStrictEqual(
        history(run.host).slice(0, steps)
      );
    });

    it("never throws out of the host's tick for a forged input", () => {
      const network = createMemoryNetwork({ seed: 1 });
      const host = hostLockstep(
        {
          ...options(network, "host", { codec: moveCodec }),
          peers: ["evil"],
          seed: SEED,
        },
        0
      );
      const evil = network.connect("evil");
      const inputs = Array.from({ length: 64 }, (_, i) =>
        i === 20 ? { n: "x" } : { n: 1 }
      );
      const ticked = [{ session: host, everyMs: 4 }];
      for (let now = 0; now <= 1000; now += 5) {
        evil.send(
          "host",
          JSON.stringify({
            kind: "inputs",
            from: 0,
            inputs,
            stepsAck: -1,
            hashes: [],
            hashAck: -1,
          })
        );
        runNetwork(network, ticked, now, now + 4);
      }
      expect(host.error).toBeNull();
      expect(host.players).toStrictEqual(["host"]);
      expect(host.stepIndex).toBeGreaterThan(30);
    });

    it("stops a peer with badInput when the host's steps don't decode on it", () => {
      // The host passes its own bad input (jsonCodec); p1 checks every input.
      const run = startRun(
        { seed: 1, latencyMs: 20, jitterMs: 5 },
        ["p1"],
        (id) => (id === "host" ? { local: badAt(id) } : { codec: moveCodec })
      );
      runNetwork(run.network, run.ticked, 0, 2000);
      const p1 = run.joined[0]!;
      expect(p1.status).toBe("stopped");
      const reason = p1.error?.reason;
      expect(reason).toMatchObject({
        kind: "badInput",
        player: "host",
        step: BAD_AT,
      });
      expect(p1.stepIndex).toBeLessThanOrEqual(BAD_AT);
      expect(p1.error?.message).toContain(`step ${BAD_AT}`);
    });

    it("stops the host with badInput when its own input doesn't decode", () => {
      const network = createMemoryNetwork({ seed: 1 });
      const host = hostLockstep(
        {
          ...options(network, "host", {
            local: badAt("host"),
            // Encodes without checking, so only the decode catches it.
            codec: {
              encode: jsonCodec<Move>().encode,
              decode: moveCodec.decode,
            },
          }),
          peers: [],
          seed: SEED,
        },
        0
      );
      runNetwork(network, [{ session: host, everyMs: 4 }], 0, 2000);
      expect(host.status).toBe("stopped");
      expect(host.error?.reason).toMatchObject({
        kind: "badInput",
        player: "host",
        step: BAD_AT,
      });
      expect(host.stepIndex).toBeLessThanOrEqual(BAD_AT);
    });
  });

  describe("when a message isn't one the protocol knows", () => {
    it.each([
      { what: "a kind and nothing else", junk: '{"kind":"inputs"}' },
      { what: "not JSON", junk: "{kind" },
      { what: "null", junk: "null" },
      {
        what: "a step that isn't an integer",
        junk: '{"kind":"inputs","from":0.5,"inputs":[],"stepsAck":-1,"hashes":[],"hashAck":-1}',
      },
      {
        what: "a string for the inputs",
        junk: '{"kind":"inputs","from":0,"inputs":"abc","stepsAck":-1,"hashes":[],"hashAck":-1}',
      },
      {
        what: "a hash that isn't a pair",
        junk: '{"kind":"inputs","from":0,"inputs":[],"stepsAck":-1,"hashes":[[10]],"hashAck":-1}',
      },
      {
        what: "a desync without hashes",
        junk: '{"kind":"desync","step":10}',
      },
      {
        what: "too many inputs",
        junk: JSON.stringify({
          kind: "inputs",
          from: 0,
          inputs: Array.from({ length: 10_000 }, () => ({ n: 1 })),
          stepsAck: -1,
          hashes: [],
          hashAck: -1,
        }),
      },
    ])(
      "drops one with $what, and handles the rest of what arrived",
      ({ junk }) => {
        const network = createMemoryNetwork({
          seed: 1,
          latencyMs: 20,
          jitterMs: 5,
        });
        const host = hostLockstep(
          { ...options(network, "host"), peers: ["p1"], seed: SEED },
          0
        );
        const p1Options = options(network, "p1");
        const p1 = joinLockstep(
          {
            ...p1Options,
            transport: junkFirst(p1Options.transport, junk),
            host: "host",
          },
          0
        );
        runNetwork(
          network,
          [
            { session: host, everyMs: 4 },
            { session: p1, everyMs: 5 },
          ],
          0,
          2000
        );
        for (const session of [host, p1]) {
          expect(session.error).toBeNull();
          expect(session.players).toStrictEqual(["host", "p1"]);
          expect(session.stepIndex).toBeGreaterThan(100);
        }
      }
    );

    it("keeps the inputs it holds for a peer bounded, whatever steps it claims", () => {
      const network = createMemoryNetwork({ seed: 1 });
      const host = hostLockstep(
        { ...options(network, "host"), peers: ["evil"], seed: SEED },
        0
      );
      const evil = network.connect("evil");
      for (let i = 0; i < 200; i++) {
        evil.send(
          "host",
          JSON.stringify({
            kind: "inputs",
            from: 1000 + i * 64,
            inputs: Array.from({ length: 64 }, () => ({ n: 1 })),
            stepsAck: -1,
            hashes: [],
            hashAck: -1,
          })
        );
      }
      runNetwork(network, [{ session: host, everyMs: 4 }], 0, 100);
      // White-box: the host's store of each player's inputs not yet confirmed.
      const { pending } = (
        internals(host) as {
          host: { pending: Map<string, Map<number, unknown>> };
        }
      ).host;
      expect(pending.get("evil")!.size).toBe(0);
    });
  });

  it("refuses to host more players than the wire carries", () => {
    const network = createMemoryNetwork({ seed: 1 });
    const peers = Array.from({ length: 16 }, (_, i) => `p${i}`);
    expect(() =>
      hostLockstep({ ...options(network, "host"), peers, seed: SEED }, 0)
    ).toThrow(RangeError);
  });
});

const internals = (session: LockstepSession<Tiny, never>) => session as unknown;
