import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { StateHash } from "../../src/core/index";
import * as Game from "../../src/game/index";
import { LockstepSession, MemoryNetwork, Transport } from "../../src/net/index";
import { runNetwork } from "../../src/net/internal/test-harness";

// A command in a lockstep run: it rides its sender's payload for one step, every peer's rules
// take or refuse it alike at that step, and only the sender's peer has a sender to answer.
//
// The game: every player adds a number each step unless someone holds the jar, and a player may
// deposit coins into the jar, which has a capacity. It logs each command it takes, with its step
// and its sender's slot, so a test can compare peers command by command.

const Move = Schema.Struct({ n: Schema.Number });
type Move = typeof Move.Type;

/** The jar has room for `room` more coins: fewer than the deposit. */
class JarFull extends Game.Rejection("JarFull", { room: Schema.Int }) {}

/** The sender puts `amount` coins in the jar. 13 is a bug in the rules: its handler throws. */
class Deposit extends Game.Command(
  "Deposit",
  { amount: Schema.Int },
  { rejects: [JarFull] }
) {}

/** The sender holds the jar, which stops the adding, or lets it go. */
class Hold extends Game.Command("Hold", { held: Schema.Boolean }) {}

/** The sender tilts the jar. Any number: a NaN passes its Schema, and is lost on the wire. */
class Tilt extends Game.Command("Tilt", { by: Schema.Number }) {}

class Deposited extends Game.Event("Deposited", {
  player: Schema.Int,
  amount: Schema.Int,
}) {}

interface Jar {
  readonly capacity: number;
  digest: number;
  coins: number;
  readonly held: boolean[];
  /** Every command taken and every player who left, as "step:slot:what", in order. */
  readonly log: string[];
  /** Every step a slot had no input, as "step:slot". */
  readonly idle: string[];
  /** The digest after each step. */
  readonly history: number[];
}

interface JarConfig {
  readonly capacity: number;
  readonly players: number;
}

class JarGame extends Game.Simulation("JarGame", {
  input: Game.PlayerInputs(Move),
  events: [Deposited],
  commands: [Deposit, Hold, Tilt],
  create: ({ capacity, players }: JarConfig, { seed }): Jar => ({
    capacity,
    digest: seed,
    coins: 0,
    held: Array.from({ length: players }, () => false),
    log: [],
    idle: [],
    history: [],
  }),
  step: (jar, input, { step }) => {
    for (const slot of input.leaving) {
      jar.held[slot] = false;
      jar.log.push(`${step}:${slot}:left`);
    }
    const h = StateHash.make();
    StateHash.add(h, jar.digest);
    StateHash.add(h, jar.coins);
    if (!jar.held.includes(true)) {
      for (let slot = 0; slot < input.players.length; slot++) {
        const move = input.players[slot] ?? null;
        if (move === null) {
          jar.idle.push(`${step}:${slot}`);
        }
        StateHash.add(h, move === null ? -1 : move.n);
      }
    }
    jar.digest = StateHash.digest(h);
    jar.history.push(jar.digest);
  },
  apply: {
    Deposit: (jar, { amount }, { player, step, report }) => {
      if (amount === 13) {
        throw new Error("a bug in the rules");
      }
      if (jar.coins + amount > jar.capacity) {
        return new JarFull({ room: jar.capacity - jar.coins });
      }
      jar.coins += amount;
      jar.log.push(`${step}:${player}:+${amount}`);
      report(new Deposited({ player, amount }));
    },
    Hold: (jar, { held }, { player, step }) => {
      jar.held[player] = held;
      jar.log.push(`${step}:${player}:${held ? "hold" : "release"}`);
    },
    Tilt: (jar, { by }, { player, step }) => {
      jar.log.push(`${step}:${player}:tilt ${by}`);
    },
  },
}) {}

const hashJar = (jar: Jar): number => {
  const h = StateHash.make();
  StateHash.add(h, jar.digest);
  StateHash.add(h, jar.coins);
  for (const held of jar.held) {
    StateHash.add(h, held ? 1 : 0);
  }
  return StateHash.digest(h);
};

const script = (player: string, step: number): Move => ({
  n: (step * 7 + player.codePointAt(player.length - 1)! * 13) % 11,
});

const scripted = (player: string): Game.StepInput<Move> => ({
  read: (step) => script(player, step),
});

type JarCommand = Game.CommandOf<typeof JarGame>;

type JarSession = LockstepSession.LockstepSession<
  Jar,
  Deposited,
  JarCommand,
  (typeof JarGame)["~types"]["Refusals"]
>;

const INPUT_DELAY = 3;

const options = (
  transport: Transport.Transport,
  players: number,
  capacity = 1000,
  local: Game.StepInput<Move | null> = scripted(transport.self)
) => ({
  simulation: JarGame,
  config: { capacity, players },
  contentHash: "content-1",
  transport,
  local,
  hash: hashJar,
  inputDelay: INPUT_DELAY,
  hashEvery: 10,
});

interface StartOptions {
  readonly capacity?: number;
  readonly local?: (id: string) => Game.StepInput<Move | null>;
  readonly dropAfterMs?: number;
  /** A peer's transport, to wrap it. */
  readonly transport?: (transport: Transport.Transport) => Transport.Transport;
}

/** Starts a host and its peers on one network, each on its own tick rate. */
const start = (
  networkOptions: MemoryNetwork.Options,
  peers: readonly string[],
  run: StartOptions = {}
) => {
  const network = MemoryNetwork.make(networkOptions);
  const of = (id: string) => {
    const connected = MemoryNetwork.connect(network, id);
    return {
      ...options(
        run.transport?.(connected) ?? connected,
        peers.length + 1,
        run.capacity,
        run.local?.(id)
      ),
      ...(run.dropAfterMs === undefined
        ? {}
        : { dropAfterMs: run.dropAfterMs }),
    };
  };
  const host: JarSession = LockstepSession.host(
    { ...of("host"), peers, seed: 42 },
    0
  );
  const joined: JarSession[] = peers.map((id) =>
    LockstepSession.join(
      { ...of(id), host: "host", players: ["host", ...peers] },
      0
    )
  );
  const sessions = [host, ...joined];
  const events = sessions.map((session) => {
    const heard: Deposited[] = [];
    session.subscribe((event) => heard.push(event));
    return heard;
  });
  const ticked = sessions.map((session, i) => ({
    session,
    everyMs: [4, 5, 7, 6][i]!,
  }));
  return { network, host, joined, sessions, ticked, events };
};

const LOSSY: MemoryNetwork.Options = {
  seed: 9,
  latencyMs: 20,
  jitterMs: 30,
  loss: 0.2,
};
const GOOD: MemoryNetwork.Options = { seed: 1 };

/** How a command ended, in a word: "taken", a rejection's tag, or the drop with its reason. */
const ended = (outcome: Game.Settled<unknown>): string => {
  if (outcome === undefined) {
    return "taken";
  }
  if (outcome instanceof Game.CommandDropped) {
    return `dropped:${outcome.reason}`;
  }
  return (outcome as { readonly _tag: string })._tag;
};

/** The step a logged line happened at. */
const stepOf = (line: string): number => Number(line.split(":")[0]);

/** What a logged line says happened, without its step. */
const what = (line: string): string => line.slice(line.indexOf(":") + 1);

/** The peers' logs and digests, cut to the steps every one of them has run. */
const common = (sessions: readonly JarSession[]) => {
  const steps = Math.min(...sessions.map((session) => session.stepIndex));
  return sessions.map((session) => ({
    log: session.state!.log.filter((line) => stepOf(line) < steps),
    history: session.state!.history.slice(0, steps),
  }));
};

/** A lockstep message as these tests read and forge one. */
interface WireMessage {
  readonly kind: string;
  readonly from: number;
  inputs?: unknown[];
  steps?: [[string, unknown][], string[]][];
}

/** `transport`, recording the payload of each step it sends in an `inputs` message, once. */
const recording = (transport: Transport.Transport) => {
  const payloads = new Map<number, string>();
  const recorder: Transport.Transport = Transport.make({
    self: transport.self,
    listen: transport.listen,
    send: (to, text) => {
      const message = JSON.parse(text) as WireMessage;
      for (const [i, payload] of (message.inputs ?? []).entries()) {
        payloads.set(message.from + i, JSON.stringify(payload));
      }
      transport.send(to, text);
    },
  });
  return { transport: recorder, payloads };
};

/**
 * A guest whose host the test plays: it starts the run, and confirms steps with whatever the
 * test hands it for the guest's own part of each.
 */
const guestOfForgedHost = () => {
  const sent: WireMessage[] = [];
  let deliver: ((from: string, message: string) => void) | null = null;
  const transport: Transport.Transport = Transport.make({
    self: "a",
    send: (_to, message) => {
      sent.push(JSON.parse(message) as WireMessage);
    },
    listen: (handler) => {
      deliver = handler;
      return () => undefined;
    },
  });
  const guest: JarSession = LockstepSession.join(
    { ...options(transport, 2), host: "host", players: ["host", "a"] },
    0
  );
  let nowMs = 0;
  let confirmedThrough = -1;
  const tickTo = (toMs: number) => {
    for (; nowMs <= toMs; nowMs += 4) {
      guest.tick(nowMs);
    }
  };
  const say = (message: object) => deliver?.("host", JSON.stringify(message));
  say({
    kind: "start",
    seed: 7,
    contentHash: "content-1",
    players: ["host", "a"],
  });
  tickTo(4);
  return {
    guest,
    tickTo,
    /** The payload the guest sent for `step`, or undefined if it has sent none. */
    payloadOf: (step: number): unknown[] | undefined => {
      for (const message of sent) {
        const payload = message.inputs?.[step - message.from];
        if (payload !== undefined) {
          return payload as unknown[];
        }
      }
      return undefined;
    },
    /** Confirms every step through `through`, with `own(step)` as the guest's part of each. */
    confirm: (through: number, own: (step: number) => unknown) => {
      const steps = [];
      for (let step = confirmedThrough + 1; step <= through; step++) {
        steps.push([
          [
            ["host", [script("host", step)]],
            ["a", own(step)],
          ],
          [],
        ]);
      }
      say({
        kind: "steps",
        from: confirmedThrough + 1,
        steps,
        inputsAck: through,
        hashAck: -1,
        hashes: [],
        waiting: [],
      });
      confirmedThrough = through;
    },
  };
};

describe("a command in a lockstep run", () => {
  it("is applied once, at the same step and in the same order on every peer, over a lossy network", () => {
    const run = start(LOSSY, ["a", "b"]);
    const [a, b] = run.joined;
    const told: string[] = [];
    const tell = (who: string) => (outcome: Game.Settled<unknown>) => {
      told.push(`${who}:${ended(outcome)}`);
    };
    runNetwork(run.network, run.ticked, 1, 300);
    run.host.send(new Deposit({ amount: 3 }), tell("host"));
    a!.send(new Deposit({ amount: 5 }), tell("a"));
    b!.send(new Hold({ held: true }), tell("b"));
    runNetwork(run.network, run.ticked, 301, 900);
    b!.send(new Hold({ held: false }), tell("b"));
    a!.send(new Deposit({ amount: 7 }), tell("a"));
    runNetwork(run.network, run.ticked, 901, 3000);
    const [host, ...others] = common(run.sessions);
    expect([
      ...run.sessions.map((session) => session.error),
      host!.history.length > 60,
    ]).toStrictEqual([null, null, null, true]);
    // Five commands, each taken once: the resends over this network bring no second copy.
    expect(host!.log.map(what).toSorted()).toStrictEqual([
      "0:+3",
      "1:+5",
      "1:+7",
      "2:hold",
      "2:release",
    ]);
    // The same commands at the same steps in the same order, and the same state after each step.
    expect(others).toStrictEqual([host, host]);
    // Each sender heard once, on its own peer.
    expect(told.toSorted()).toStrictEqual([
      "a:taken",
      "a:taken",
      "b:taken",
      "b:taken",
      "host:taken",
    ]);
    // What a command reports reaches every peer's listeners, the sender's or not.
    expect(
      run.events.map((heard) => heard.map(({ amount }) => amount))
    ).toStrictEqual([
      [3, 5, 7],
      [3, 5, 7],
      [3, 5, 7],
    ]);
  });

  it("rides the step its sender schedules next, inputDelay ahead, after that step's input in its payload", () => {
    const network = MemoryNetwork.make(GOOD);
    const guest = recording(MemoryNetwork.connect(network, "a"));
    const host: JarSession = LockstepSession.host(
      {
        ...options(MemoryNetwork.connect(network, "host"), 2),
        peers: ["a"],
        seed: 42,
      },
      0
    );
    const a: JarSession = LockstepSession.join(
      { ...options(guest.transport, 2), host: "host", players: ["host", "a"] },
      0
    );
    const ticked = [
      { session: host, everyMs: 4 },
      { session: a, everyMs: 4 },
    ];
    runNetwork(network, ticked, 1, 300);
    const sentAt = a.stepIndex;
    a.send(new Deposit({ amount: 5 }));
    runNetwork(network, ticked, 301, 600);
    const [step, payload] = [...guest.payloads].find(([, sent]) =>
      sent.includes("Deposit")
    )!;
    expect(payload).toBe(
      `[${JSON.stringify(script("a", step))},{"_tag":"Deposit","amount":5}]`
    );
    // The step after the last one scheduled when it was sent.
    expect(step).toBe(sentAt + INPUT_DELAY + 1);
    expect(guest.payloads.get(step - 1)).toBe(
      `[${JSON.stringify(script("a", step - 1))}]`
    );
    expect([host.state!.log, a.state!.log]).toStrictEqual([
      [`${step}:1:+5`],
      [`${step}:1:+5`],
    ]);
  });

  it("is refused alike on every peer, and only its sender hears", () => {
    const run = start(LOSSY, ["a", "b"], { capacity: 10 });
    const [a, b] = run.joined;
    const outcomes: Record<string, Game.Settled<unknown>[]> = {
      host: [],
      a: [],
      b: [],
    };
    runNetwork(run.network, run.ticked, 1, 300);
    // 6, 6 and 4 into a jar of 10: whichever order their steps come in, one doesn't fit.
    run.host.send(new Deposit({ amount: 6 }), (outcome) =>
      outcomes.host!.push(outcome)
    );
    a!.send(new Deposit({ amount: 6 }), (outcome) => outcomes.a!.push(outcome));
    b!.send(new Deposit({ amount: 4 }), (outcome) => outcomes.b!.push(outcome));
    runNetwork(run.network, run.ticked, 301, 2500);
    const [host, ...others] = common(run.sessions);
    const refused = [...outcomes.host!, ...outcomes.a!, ...outcomes.b!].filter(
      (outcome) => outcome !== undefined
    );
    expect(run.sessions.map((session) => session.error)).toStrictEqual([
      null,
      null,
      null,
    ]);
    // Each sender heard once, and exactly one of them a refusal: its own.
    expect([
      outcomes.host!.length,
      outcomes.a!.length,
      outcomes.b!.length,
      refused.map((outcome) => outcome instanceof JarFull),
    ]).toStrictEqual([1, 1, 1, [true]]);
    // A refused command changed nothing and reported nothing, anywhere: the peers still agree.
    expect([
      ...run.sessions.map((session) => session.state!.coins),
      host!.log.length,
    ]).toStrictEqual([10, 10, 10, 2]);
    expect(others).toStrictEqual([host, host]);
    expect(run.events.map((heard) => heard.length)).toStrictEqual([2, 2, 2]);
  });

  it("carries at most four commands a step, the rest on the next, in the order sent", () => {
    const run = start(GOOD, ["a"]);
    const [a] = run.joined;
    runNetwork(run.network, run.ticked, 1, 100);
    const told: number[] = [];
    for (let amount = 1; amount <= 6; amount++) {
      a!.send(new Deposit({ amount }), () => told.push(amount));
    }
    runNetwork(run.network, run.ticked, 101, 400);
    const { log } = run.host.state!;
    const [first] = log.map(stepOf);
    expect(log.map(what)).toStrictEqual([
      "1:+1",
      "1:+2",
      "1:+3",
      "1:+4",
      "1:+5",
      "1:+6",
    ]);
    expect(log.map(stepOf)).toStrictEqual([
      first,
      first,
      first,
      first,
      first! + 1,
      first! + 1,
    ]);
    expect(a!.state!.log).toStrictEqual(log);
    expect(told).toStrictEqual([1, 2, 3, 4, 5, 6]);
  });

  it("applies one step's commands in player order, host first, and each player's in the order sent", () => {
    const network = MemoryNetwork.make(GOOD);
    const host: JarSession = LockstepSession.host(
      {
        ...options(MemoryNetwork.connect(network, "host"), 3),
        peers: ["a", "b"],
        seed: 1,
      },
      0
    );
    // Steps 0 to 3 were scheduled when the run began: the host's commands ride step 4.
    host.send(new Deposit({ amount: 1 }));
    host.send(new Deposit({ amount: 2 }));
    // The other players' payloads for steps 0 to 4, their commands with step 4. b's arrive first.
    const others: [string, object[]][] = [
      ["b", [{ _tag: "Deposit", amount: 5 }]],
      [
        "a",
        [
          { _tag: "Deposit", amount: 3 },
          { _tag: "Deposit", amount: 4 },
        ],
      ],
    ];
    for (const [peer, commands] of others) {
      MemoryNetwork.connect(network, peer).send(
        "host",
        JSON.stringify({
          kind: "inputs",
          from: 0,
          inputs: Array.from({ length: 5 }, (_, step) =>
            step === 4 ? [{ n: 1 }, ...commands] : [{ n: 1 }]
          ),
          stepsAck: -1,
          hashes: [],
          hashAck: -1,
        })
      );
    }
    runNetwork(network, [{ session: host, everyMs: 4 }], 1, 200);
    expect(host.state!.log).toStrictEqual([
      "4:0:+1",
      "4:0:+2",
      "4:1:+3",
      "4:1:+4",
      "4:2:+5",
    ]);
  });

  it("can be taken back only while it waits for a step", () => {
    const run = start(GOOD, ["a"]);
    const [a] = run.joined;
    runNetwork(run.network, run.ticked, 1, 100);
    const told: string[] = [];
    const early = a!.send(new Deposit({ amount: 1 }), () => told.push("early"));
    early();
    const late = a!.send(new Deposit({ amount: 2 }), () => told.push("late"));
    // A step's time later it rides one: every peer applies it, and taking it back now only
    // keeps its sender from being told.
    runNetwork(run.network, run.ticked, 101, 140);
    late();
    runNetwork(run.network, run.ticked, 141, 400);
    expect(run.host.state!.log.map(what)).toStrictEqual(["1:+2"]);
    expect(a!.state!.log).toStrictEqual(run.host.state!.log);
    expect(told).toStrictEqual([]);
  });

  it("waits out a stall, and is still taken back before the run steps again", () => {
    const run = start(GOOD, ["a", "b"], { dropAfterMs: 600 });
    const [a] = run.joined;
    const live = [run.ticked[0]!, run.ticked[1]!];
    runNetwork(run.network, run.ticked, 1, 300);
    MemoryNetwork.cutOff(run.network, "b", true);
    runNetwork(run.network, live, 301, 500);
    const stalledAt = a!.stepIndex;
    const told: string[] = [];
    for (let amount = 1; amount <= 5; amount++) {
      a!.send(new Deposit({ amount }), (outcome) =>
        told.push(`${amount}:${ended(outcome)}`)
      );
    }
    const unsend = a!.send(new Deposit({ amount: 6 }), () => told.push("6"));
    // Nothing is scheduled while no step runs: 100 ms on, all six still wait for a step.
    runNetwork(run.network, live, 501, 600);
    expect(a!.stepIndex).toBe(stalledAt);
    unsend();
    // The host removes b, and the run steps again.
    runNetwork(run.network, live, 601, 3000);
    expect(
      run.host.state!.log.filter((line) => !line.endsWith(":left")).map(what)
    ).toStrictEqual(["1:+1", "1:+2", "1:+3", "1:+4", "1:+5"]);
    expect(a!.state!.log).toStrictEqual(run.host.state!.log);
    expect(told).toStrictEqual([
      "1:taken",
      "2:taken",
      "3:taken",
      "4:taken",
      "5:taken",
    ]);
  });

  it("is held while its session is still joining, and rides the run's first steps", () => {
    const run = start({ seed: 1, latencyMs: 30 }, ["a"]);
    const [a] = run.joined;
    const told: string[] = [];
    expect(a!.status).toBe("joining");
    for (let amount = 1; amount <= 5; amount++) {
      a!.send(new Deposit({ amount }), (outcome) =>
        told.push(`${amount}:${ended(outcome)}`)
      );
    }
    expect(told).toStrictEqual([]);
    runNetwork(run.network, run.ticked, 1, 500);
    expect(run.host.state!.log).toStrictEqual([
      "0:1:+1",
      "0:1:+2",
      "0:1:+3",
      "0:1:+4",
      "1:1:+5",
    ]);
    expect(a!.state!.log).toStrictEqual(run.host.state!.log);
    expect(told).toStrictEqual([
      "1:taken",
      "2:taken",
      "3:taken",
      "4:taken",
      "5:taken",
    ]);
  });

  it("tells its sender once the tick's work is over, so the sender may send again from there", () => {
    const run = start(GOOD, ["a"]);
    runNetwork(run.network, run.ticked, 1, 100);
    const told: string[] = [];
    run.host.send(new Deposit({ amount: 1 }), (first) => {
      told.push(`first:${ended(first)}`);
      run.host.send(new Deposit({ amount: 2 }), (second) =>
        told.push(`second:${ended(second)}`)
      );
    });
    runNetwork(run.network, run.ticked, 101, 600);
    expect(told).toStrictEqual(["first:taken", "second:taken"]);
    expect(run.host.state!.log.map(what)).toStrictEqual(["0:+1", "0:+2"]);
    expect(run.joined[0]!.state!.log).toStrictEqual(run.host.state!.log);
  });

  // A session's listeners hear inside the tick, and its senders once the tick's work is over. So
  // whenever a sender hears the rules' answer, its peer's listeners have heard that step.
  it("tells its sender after its session's listeners heard what the command's step reported", () => {
    const run = start(GOOD, ["a"]);
    const [a] = run.joined;
    runNetwork(run.network, run.ticked, 1, 100);
    const order: Record<"host" | "a", string[]> = { host: [], a: [] };
    for (const [name, session] of [
      ["host", run.host],
      ["a", a!],
    ] as const) {
      session.subscribe(({ player, amount }) =>
        order[name].push(`heard +${amount} from ${player}`)
      );
    }
    run.host.send(new Deposit({ amount: 5 }), (outcome) =>
      order.host.push(`told ${ended(outcome)}`)
    );
    runNetwork(run.network, run.ticked, 101, 400);
    a!.send(new Deposit({ amount: 7 }), (outcome) =>
      order.a.push(`told ${ended(outcome)}`)
    );
    runNetwork(run.network, run.ticked, 401, 700);
    expect(order).toStrictEqual({
      host: ["heard +5 from 0", "told taken", "heard +7 from 1"],
      a: ["heard +5 from 0", "heard +7 from 1", "told taken"],
    });
  });

  describe("that this peer's rules never answer", () => {
    it("is dropped when the session stops: what waited for a step, and what rode one", () => {
      const run = start(GOOD, ["a", "b"], { dropAfterMs: 2000 });
      const [a, b] = run.joined;
      const told: string[] = [];
      runNetwork(run.network, run.ticked, 1, 200);
      // b loses the host with one command riding a step and one still waiting for its step.
      MemoryNetwork.cutOff(run.network, "b", true);
      b!.send(new Deposit({ amount: 2 }), (outcome) =>
        told.push(`rode:${ended(outcome)}`)
      );
      runNetwork(run.network, run.ticked, 201, 500);
      b!.send(new Hold({ held: true }), (outcome) =>
        told.push(`waited:${ended(outcome)}`)
      );
      expect(told).toStrictEqual([]);
      runNetwork(run.network, run.ticked, 501, 6000);
      expect(told).toStrictEqual([
        "rode:dropped:runEnded",
        "waited:dropped:runEnded",
      ]);
      // The others played on without b, and applied nothing of its.
      expect([b!.error?.reason.kind, run.host.error, a!.error]).toStrictEqual([
        "hostLost",
        null,
        null,
      ]);
      expect(run.host.state!.log.map(what)).toStrictEqual(["2:left"]);
      expect(a!.state!.log).toStrictEqual(run.host.state!.log);
    });

    it("is dropped at once when sent after the session stopped", () => {
      const run = start(GOOD, ["a"], { dropAfterMs: 300 });
      const [a] = run.joined;
      runNetwork(run.network, run.ticked, 1, 200);
      MemoryNetwork.cutOff(run.network, "host", true);
      runNetwork(run.network, [run.ticked[1]!], 201, 1200);
      expect(a!.status).toBe("stopped");
      const told: string[] = [];
      const unsend = a!.send(new Deposit({ amount: 1 }), (outcome) =>
        told.push(ended(outcome))
      );
      expect(told).toStrictEqual(["dropped:runEnded"]);
      // Nothing waits, so there is nothing to take back.
      unsend();
    });

    it("is dropped when the session is disposed, and at once when sent after", () => {
      const run = start(GOOD, ["a"]);
      const [a] = run.joined;
      runNetwork(run.network, run.ticked, 1, 100);
      const told: string[] = [];
      a!.send(new Deposit({ amount: 4 }), (outcome) =>
        told.push(`before:${ended(outcome)}`)
      );
      expect(a!.status).toBe("running");
      a!.dispose();
      expect(told).toStrictEqual(["before:dropped:runEnded"]);
      a!.send(new Deposit({ amount: 5 }), (outcome) =>
        told.push(`after:${ended(outcome)}`)
      );
      expect(told).toStrictEqual([
        "before:dropped:runEnded",
        "after:dropped:runEnded",
      ]);
    });

    it("is dropped when a session that was still joining is disposed", () => {
      const run = start(GOOD, ["a"]);
      const [a] = run.joined;
      const told: string[] = [];
      a!.send(new Deposit({ amount: 1 }), (outcome) =>
        told.push(ended(outcome))
      );
      a!.dispose();
      expect(told).toStrictEqual(["dropped:runEnded"]);
    });

    it("is dropped for a player the host removes after confirming its command's step, though the others applied it", () => {
      // Its payload reaches the host, which confirms the step, and then the player hears
      // nothing more: its own peer never runs the step.
      let deaf = false;
      let sent = new Map<number, string>();
      const run = start({ seed: 1, latencyMs: 40 }, ["a", "b"], {
        dropAfterMs: 400,
        transport: (transport) => {
          if (transport.self !== "a") {
            return transport;
          }
          const recorder = recording(transport);
          sent = recorder.payloads;
          return Transport.make({
            self: transport.self,
            send: recorder.transport.send,
            listen: (handler) =>
              transport.listen((from, message) => {
                if (!deaf) {
                  handler(from, message);
                }
              }),
          });
        },
      });
      const [a, b] = run.joined;
      runNetwork(run.network, run.ticked, 1, 600);
      const told: string[] = [];
      a!.send(new Deposit({ amount: 4 }), (outcome) =>
        told.push(ended(outcome))
      );
      // Until the command has left with a step's payload.
      let nowMs = 601;
      const left = () =>
        [...sent.values()].some((payload) => payload.includes("Deposit"));
      for (; !left() && nowMs < 1000; nowMs++) {
        runNetwork(run.network, run.ticked, nowMs, nowMs);
      }
      deaf = true;
      runNetwork(run.network, run.ticked, nowMs, 3000);
      expect(a!.error?.reason.kind).toBe("hostLost");
      expect(told).toStrictEqual(["dropped:runEnded"]);
      const applied = run.host.state!.log.filter((line) =>
        line.endsWith(":1:+4")
      );
      expect(applied).toHaveLength(1);
      expect(b!.state!.log).toStrictEqual(run.host.state!.log);
      expect(a!.state!.log).toStrictEqual([]);
    });

    it("is dropped, with no throw, when the host's step comes back without it", () => {
      const forged = guestOfForgedHost();
      forged.confirm(2, (step) => [script("a", step)]);
      const told: string[] = [];
      forged.guest.send(new Deposit({ amount: 1 }), (outcome) =>
        told.push(ended(outcome))
      );
      forged.tickTo(120);
      // Steps 0 to 3 were scheduled when the run began: the command rode the next, step 4.
      expect(forged.payloadOf(4)).toStrictEqual([
        script("a", 4),
        { _tag: "Deposit", amount: 1 },
      ]);
      // A host on other code confirms the step with the command stripped.
      forged.confirm(6, (step) => [script("a", step)]);
      forged.tickTo(600);
      expect(forged.guest.error).toBeNull();
      expect(forged.guest.stepIndex).toBe(7);
      expect(forged.guest.state!.log).toStrictEqual([]);
      expect(told).toStrictEqual(["dropped:runEnded"]);
    });

    it("answers what the host's step carries of it, and applies the rest with no sender", () => {
      const forged = guestOfForgedHost();
      forged.confirm(2, (step) => [script("a", step)]);
      const told: string[] = [];
      forged.guest.send(new Deposit({ amount: 1 }), (outcome) =>
        told.push(`deposit:${ended(outcome)}`)
      );
      forged.guest.send(new Hold({ held: false }), (outcome) =>
        told.push(`hold:${ended(outcome)}`)
      );
      forged.tickTo(120);
      // The host's step has the deposit twice, then another command where the hold was.
      forged.confirm(6, (step) =>
        step === 4
          ? [
              script("a", step),
              { _tag: "Deposit", amount: 1 },
              { _tag: "Deposit", amount: 1 },
              { _tag: "Tilt", by: 2 },
            ]
          : [script("a", step)]
      );
      forged.tickTo(600);
      expect(forged.guest.error).toBeNull();
      // Every peer applies what the host confirmed, this one too.
      expect(forged.guest.state!.log).toStrictEqual([
        "4:1:+1",
        "4:1:+1",
        "4:1:tilt 2",
      ]);
      // The hold never came, which was known before the step ran. The deposit is where it was
      // sent, so its sender hears the rules.
      expect(told).toStrictEqual(["hold:dropped:runEnded", "deposit:taken"]);
    });

    it("is dropped by the tick that throws, when a step's rules throw", () => {
      const run = start(GOOD, ["a"]);
      runNetwork(run.network, run.ticked, 1, 100);
      const told: string[] = [];
      for (const [name, amount] of [
        ["before", 1],
        ["bug", 13],
        ["after", 2],
      ] as const) {
        run.host.send(new Deposit({ amount }), (outcome) =>
          told.push(`${name}:${ended(outcome)}`)
        );
      }
      // Every peer's rules throw at that step, each out of its own tick: a bug is one
      // everywhere. The host's are the first to run it.
      const threw: string[] = [];
      for (let nowMs = 101; nowMs <= 400 && threw.length === 0; nowMs++) {
        MemoryNetwork.advance(run.network, nowMs);
        if (nowMs % 4 === 0) {
          try {
            run.host.tick(nowMs);
            run.joined[0]!.tick(nowMs);
          } catch (error) {
            threw.push((error as Error).message);
          }
        }
      }
      expect(threw).toStrictEqual(["a bug in the rules"]);
      // All three were in the loop's hands: none is left waiting on rules that won't answer.
      expect(told).toStrictEqual([
        "before:dropped:runEnded",
        "bug:dropped:runEnded",
        "after:dropped:runEnded",
      ]);
      // The first was applied, and reported, before the bug threw. No listener heard that step,
      // and no sender heard that the rules took a command of it: the two agree.
      expect([run.host.state!.coins, run.events[0]]).toStrictEqual([1, []]);
      // Its run is over: a send is answered at once, and disposing tells nobody twice.
      run.host.send(new Deposit({ amount: 3 }), (outcome) =>
        told.push(`late:${ended(outcome)}`)
      );
      run.host.dispose();
      expect(told.slice(3)).toStrictEqual(["late:dropped:runEnded"]);
    });

    it("tells every sender once, even when one of them throws", () => {
      const run = start(GOOD, ["a"]);
      const [a] = run.joined;
      runNetwork(run.network, run.ticked, 1, 100);
      const told: string[] = [];
      a!.send(new Deposit({ amount: 1 }), () => {
        throw new Error("a bug in the sender");
      });
      a!.send(new Deposit({ amount: 2 }), (outcome) =>
        told.push(ended(outcome))
      );
      expect(() => a!.dispose()).toThrow("a bug in the sender");
      expect(told).toStrictEqual(["dropped:runEnded"]);
    });
  });

  describe("that a peer forged", () => {
    const MOVE = { n: 1 };

    it.each([
      {
        what: "a command the simulation doesn't declare",
        payload: [MOVE, { _tag: "Nope" }],
      },
      {
        what: "a command whose field doesn't decode",
        payload: [MOVE, { _tag: "Deposit", amount: 1.5 }],
      },
      {
        what: "five commands in one step",
        payload: [
          MOVE,
          ...Array.from({ length: 5 }, () => ({ _tag: "Hold", held: true })),
        ],
      },
      { what: "its input bare, as the wire once carried it", payload: MOVE },
    ])("has the host remove a peer that sends $what", ({ payload }) => {
      const network = MemoryNetwork.make(GOOD);
      const host: JarSession = LockstepSession.host(
        {
          ...options(MemoryNetwork.connect(network, "host"), 2),
          peers: ["forger"],
          seed: 1,
        },
        0
      );
      const forger = MemoryNetwork.connect(network, "forger");
      const heard: unknown[] = [];
      forger.listen((_from, message) => heard.push(JSON.parse(message)));
      forger.send(
        "host",
        JSON.stringify({
          kind: "inputs",
          from: 0,
          inputs: [payload],
          stepsAck: -1,
          hashes: [],
          hashAck: -1,
        })
      );
      runNetwork(network, [{ session: host, everyMs: 4 }], 1, 200);
      expect(host.error).toBeNull();
      expect(host.players).toStrictEqual(["host"]);
      expect(heard).toContainEqual({
        kind: "removed",
        step: 0,
        why: "badInput",
      });
      // Nothing of the forged step was applied.
      expect(host.state!.log).toStrictEqual(["0:1:left"]);
    });

    it("takes a peer's four commands in one step", () => {
      const network = MemoryNetwork.make(GOOD);
      const host: JarSession = LockstepSession.host(
        {
          ...options(MemoryNetwork.connect(network, "host"), 2),
          peers: ["other"],
          seed: 1,
        },
        0
      );
      const other = MemoryNetwork.connect(network, "other");
      other.send(
        "host",
        JSON.stringify({
          kind: "inputs",
          from: 0,
          inputs: [
            [
              MOVE,
              ...Array.from({ length: 4 }, (_, i) => ({
                _tag: "Deposit",
                amount: i + 1,
              })),
            ],
          ],
          stepsAck: -1,
          hashes: [],
          hashAck: -1,
        })
      );
      runNetwork(network, [{ session: host, everyMs: 4 }], 1, 200);
      expect(host.players).toStrictEqual(["host", "other"]);
      expect(host.state!.log).toStrictEqual([
        "0:1:+1",
        "0:1:+2",
        "0:1:+3",
        "0:1:+4",
      ]);
    });
  });

  describe("that can't be sent", () => {
    it("throws for a command the simulation doesn't declare", () => {
      const run = start(GOOD, ["a"]);
      class Other extends Game.Command("Other") {}
      expect(() =>
        // What a cast gets past the types.
        run.host.send(new Other() as never)
      ).toThrow(
        'Simulation "JarGame" has no command "Other": list it in `commands` and handle it in `apply`'
      );
    });

    it("throws at its sender for a value that can't cross the network, and the run plays on", () => {
      const run = start(GOOD, ["a"]);
      const [a] = run.joined;
      runNetwork(run.network, run.ticked, 1, 100);
      // JSON carries a NaN as null, which is no number: on the wire it would be the sender's
      // bad input, and remove it from the run, or stop the run if the host sent it.
      for (const session of [a!, run.host]) {
        expect(() => session.send(new Tilt({ by: Number.NaN }))).toThrow(
          'Simulation "JarGame": the command "Tilt" can\'t cross the network, so no peer could apply it:'
        );
      }
      runNetwork(run.network, run.ticked, 101, 600);
      expect(run.sessions.map((session) => session.error)).toStrictEqual([
        null,
        null,
      ]);
      expect(run.sessions.map((session) => session.players)).toStrictEqual([
        ["host", "a"],
        ["host", "a"],
      ]);
      expect(run.host.state!.log).toStrictEqual([]);
    });

    it("applies what the wire carries of a command on every peer, the sender's too", () => {
      const run = start(GOOD, ["a"]);
      runNetwork(run.network, run.ticked, 1, 100);
      run.host.send(new Tilt({ by: -0 }));
      runNetwork(run.network, run.ticked, 101, 400);
      const [line] = run.host.state!.log;
      // JSON turns -0 into 0: the host's own rules got what the guest's decoded.
      expect(what(line!)).toBe("0:tilt 0");
      expect(run.joined[0]!.state!.log).toStrictEqual(run.host.state!.log);
    });
  });

  it("gives null to the slot of a player whose peer has nothing attached, on every peer, and still takes its commands", () => {
    const run = start(GOOD, ["a"], {
      local: (id) => (id === "a" ? { read: () => null } : scripted(id)),
    });
    const [a] = run.joined;
    runNetwork(run.network, run.ticked, 1, 100);
    a!.send(new Deposit({ amount: 2 }));
    runNetwork(run.network, run.ticked, 101, 400);
    const steps = Math.min(run.host.stepIndex, a!.stepIndex);
    const idle = run.sessions.map((session) =>
      session.state!.idle.filter((line) => stepOf(line) < steps)
    );
    expect(run.sessions.map((session) => session.error)).toStrictEqual([
      null,
      null,
    ]);
    // Slot 1 at every step, and no other.
    expect(idle[0]).toStrictEqual(
      Array.from({ length: steps }, (_, step) => `${step}:1`)
    );
    expect(idle[1]).toStrictEqual(idle[0]);
    expect(run.host.state!.log.map(what)).toStrictEqual(["1:+2"]);
    expect(a!.state!.log).toStrictEqual(run.host.state!.log);
  });
});
