import { Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  EcsWorld,
  EntityId,
  Field,
  Input,
  Lockstep,
  Query,
  Random,
  Singleton,
  System,
  Time,
  World,
} from "../src/index";
import type { Entity } from "../src/index";

// --- a small game: players drop coins, which drift about, and take them --------

const Coin = Component.define("ls/Coin", { value: Field.i32, x: Field.f32 });
const Coins = Query.all(Coin);
const Purse = Singleton.define(
  "ls/Purse",
  { ada: Field.i32, grace: Field.i32, taken: Field.i32 },
  { ada: 0, grace: 0, taken: 0 }
);

const Player = Schema.Literals(["ada", "grace", "edsger"]);
const Drop = Action.define(
  "ls/Drop",
  Schema.Struct({ by: Player, value: Schema.Int })
);
const Take = Action.define(
  "ls/Take",
  Schema.Struct({ by: Player, coin: EntityId })
);
const Fire = Action.define("ls/Fire", Schema.Struct({}));
const Mint = Action.define("ls/Mint", Schema.Struct({ on: Schema.Date }));
const Whisper = Action.define<{ readonly to: string }>()("ls/Whisper");

class NoSuchCoin extends Data.TaggedError("NoSuchCoin")<{
  readonly coin: Entity;
}> {}

const drop = Action.handler(Drop, function* ({ value }) {
  const random = yield* Random;
  return (yield* Commands).spawn(Coin.of({ value, x: random.next() }));
});
const take = Action.handler(Take, function* ({ by, coin }) {
  const world = yield* World;
  const held = world.get(coin, Coin);
  if (held === undefined) {
    return yield* Effect.fail(new NoSuchCoin({ coin }));
  }
  (yield* Commands).despawn(coin);
  const purse = yield* Purse;
  purse.taken += 1;
  if (by === "ada") {
    purse.ada += held.value;
  } else {
    purse.grace += held.value;
  }
  return held.value;
});
const fire = Action.handler(Fire, function* () {
  (yield* Commands).spawn(Coin.of({ value: 100, x: 0 }));
});
const mint = Action.handler(Mint, function* ({ on }) {
  (yield* Commands).spawn(Coin.of({ value: on.getUTCFullYear(), x: 0 }));
});
const whisper = Action.handler(Whisper, function* () {
  // Nothing: it is here to be enqueued.
});

const Drift = System.make("ls/Drift", function* () {
  const random = yield* Random;
  (yield* Coins).each((coin) => {
    coin.x += random.next() - 0.5;
  });
});
/** The simulation's own player: it drops a coin now and then. */
const Bot = System.make("ls/Bot", function* () {
  if ((yield* Time).tick % 7 === 3) {
    (yield* Action.Actions).enqueue(Drop, {
      by: "edsger" as const,
      value: 1,
    });
  }
});
/** What each app's input stage heard refused, in the order it heard it. */
const refusals: string[] = [];
const Hear = System.make("ls/Hear", function* () {
  for (const refusal of (yield* Action.Rejected).read()) {
    refusals.push(refusal.action);
  }
}).pipe(System.inStage("input"));
const Controls = Input.bind("ls/Controls", Input.onPress("Space", Fire, {}));

const DELTA = 1 / 30;

const game = (seed = 5) =>
  App.make({
    systems: [Drift, Bot, Controls, Hear],
    handlers: [drop, take, fire, mint, whisper],
    components: [Coin, Purse],
    seed,
    checkpointEvery: 1,
  });
type Game = Effect.Success<ReturnType<typeof game>>;

interface Peer {
  readonly name: string;
  readonly app: Game;
  readonly session: Lockstep.Session;
  /** The world's hash after each tick this peer ran: `hashes[0]` is after the first. */
  readonly hashes: number[];
  readonly source: Input.ManualSource;
}

interface Setup {
  readonly delay?: number;
  /** The seed of each peer's game, by name: all the same unless told. */
  readonly seeds?: Readonly<Record<string, number>>;
  /** Whether each peer is given the names the other way round from the last. */
  readonly shuffled?: boolean;
}

const withPeers = <A>(
  names: readonly string[],
  setup: Setup,
  use: (peers: Peer[]) => A
): A =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const peers: Peer[] = [];
        for (const name of names) {
          const source = Input.makeManualSource();
          const app = yield* game(setup.seeds?.[name]).pipe(
            Effect.provideService(Input.Source, source)
          );
          const session = Lockstep.make(app, {
            peer: name,
            peers:
              setup.shuffled === true && peers.length % 2 === 1
                ? names.toReversed()
                : names,
            delta: DELTA,
            ...(setup.delay === undefined ? {} : { delay: setup.delay }),
          });
          peers.push({ name, app, session, hashes: [], source });
        }
        return use(peers);
      })
    )
  );

const withApp = <T, A>(
  make: Effect.Effect<T, never, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

/**
 * A network that is nothing like a wire: every message takes a random
 * number of rounds to arrive, so they overtake each other, and the ones
 * that arrive together arrive shuffled. Nothing is lost. Messages travel
 * as text.
 */
const network = (seed: number, lag: { min: number; max: number }) => {
  const dice = new EcsWorld({ seed }).random;
  let now = 0;
  let inFlight: { at: number; to: string; text: string }[] = [];
  return {
    get inFlight() {
      return inFlight.length;
    },
    round(): void {
      now++;
    },
    send(to: readonly string[], messages: readonly Lockstep.Message[]): void {
      for (const message of messages) {
        for (const name of to) {
          inFlight.push({
            at: now + dice.int(lag.min, lag.max),
            to: name,
            text: Lockstep.encode(message),
          });
        }
      }
    },
    arrivals(to: string): Lockstep.Message[] {
      const due = inFlight.filter((m) => m.to === to && m.at <= now);
      inFlight = inFlight.filter((m) => !(m.to === to && m.at <= now));
      return dice.shuffle(due).map((m) => {
        const message = Lockstep.decode(m.text);
        if (Exit.isFailure(message)) {
          throw new Error("a message did not survive the wire");
        }
        return message.value;
      });
    },
  };
};
type Network = ReturnType<typeof network>;

/** One round: every peer is handed what arrived, tries its tick, and sends. */
const round = (
  peers: readonly Peer[],
  net: Network,
  only: readonly Peer[] = peers
): void => {
  net.round();
  for (const peer of only) {
    for (const message of net.arrivals(peer.name)) {
      peer.session.receive(message);
    }
    if (peer.session.tick()) {
      peer.hashes.push(peer.app.world.hash());
    }
    net.send(
      peers.filter((other) => other !== peer).map((other) => other.name),
      peer.session.outgoing()
    );
  }
};

/** Brings every peer to the tick the furthest has reached. */
const catchUp = (peers: readonly Peer[], net: Network): number => {
  const furthest = Math.max(...peers.map((peer) => peer.app.time.tick));
  for (let i = 0; i < 1000; i++) {
    const behind = peers.filter((peer) => peer.app.time.tick < furthest);
    if (behind.length === 0) {
      return furthest;
    }
    round(peers, net, behind);
  }
  throw new Error("the peers never caught up with each other");
};

const coinsOf = (peer: Peer): Entity[] => peer.app.world.view(Coins).entities();

/** Each peer's player does something at random, from what its own world holds. */
const players = (seed: number) => {
  const dice = new EcsWorld({ seed }).random;
  return (peer: Peer): void => {
    const by = peer.name as "ada" | "grace";
    const roll = dice.int(1, 6);
    if (roll <= 2) {
      peer.app.enqueue(Drop, { by, value: dice.int(1, 9) });
    } else if (roll === 3) {
      const coins = coinsOf(peer);
      if (coins.length > 0) {
        // Both players go for the oldest coin: one of them is refused.
        peer.app.enqueue(Take, { by, coin: coins[0]! });
      }
    }
  };
};

const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

describe("a lockstep session", () => {
  it("keeps two peers hash-equal at every tick, over a network that delays and reorders", () => {
    for (const [seed, lag] of [
      [1, { min: 0, max: 0 }],
      [2, { min: 1, max: 4 }],
      [3, { min: 0, max: 9 }],
    ] as const) {
      withPeers(["ada", "grace"], {}, (peers) => {
        const net = network(seed, lag);
        const act = players(seed + 100);
        for (let i = 0; i < 300; i++) {
          for (const peer of peers) {
            act(peer);
          }
          round(peers, net);
        }
        const [ada, grace] = peers as [Peer, Peer];
        // They got somewhere, and not by one of them running ahead alone.
        const common = Math.min(ada.hashes.length, grace.hashes.length);
        expect(common).toBeGreaterThan(lag.max === 0 ? 290 : 40);
        expect(ada.hashes.slice(0, common)).toEqual(
          grace.hashes.slice(0, common)
        );
        // The hashes are of a game in which things happened.
        expect(new Set(ada.hashes).size).toBeGreaterThan(common / 2);

        const ticks = catchUp(peers, net);
        // A tick that has run is let go of: what a peer holds is what the
        // others have said ahead of it, however long the game has gone on.
        expect(ada.session.held).toBeLessThanOrEqual(2 * (2 * 2 + 2));
        expect(ada.app.time.tick).toBe(ticks);
        expect(grace.app.time.tick).toBe(ticks);
        expect(ada.app.world.hash()).toBe(grace.app.world.hash());
        // The same actions, on the same ticks, in the same order, and the
        // same ones refused.
        expect(ada.app.actionLog).toEqual(grace.app.actionLog);
        const logged = moves(ada.app.actionLog);
        expect(logged.some((entry) => entry.refused !== undefined)).toBe(true);
        expect(
          logged.filter((entry) => entry.refused === undefined).length
        ).toBeGreaterThan(20);
        expect(ada.app.world.singleton(Purse).taken).toBeGreaterThan(0);
      });
    }
  });

  it("leaves a log that replays into a game of one", () => {
    withPeers(["ada", "grace"], {}, (peers) => {
      const net = network(8, { min: 0, max: 5 });
      const act = players(9);
      for (let i = 0; i < 120; i++) {
        for (const peer of peers) {
          act(peer);
        }
        round(peers, net);
      }
      const ticks = catchUp(peers, net);
      const [ada] = peers as [Peer];
      withApp(game(), (alone) => {
        App.replay(alone, ada.app.actionLog, { delta: DELTA, ticks });
        expect(alone.world.hash()).toBe(ada.app.world.hash());
      });
    });
  });

  it("keeps three peers hash-equal", () => {
    withPeers(["grace", "ada", "edsger"], { delay: 3 }, (peers) => {
      const net = network(4, { min: 0, max: 6 });
      const act = players(5);
      for (let i = 0; i < 200; i++) {
        act(peers[0]!);
        act(peers[1]!);
        round(peers, net);
      }
      catchUp(peers, net);
      const [first, ...others] = peers as [Peer, Peer, Peer];
      expect(first.app.time.tick).toBeGreaterThan(30);
      for (const other of others) {
        expect(other.hashes).toEqual(first.hashes);
        expect(other.app.actionLog).toEqual(first.app.actionLog);
      }
      // In the order of their names, whatever order they were given in.
      expect(first.session.peers).toEqual(["ada", "edsger", "grace"]);
    });
  });

  it("applies an action on the tick it is stamped with, on every peer", () => {
    withPeers(["ada", "grace"], { delay: 3 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      while (ada.app.time.tick < 4) {
        round(peers, net);
      }
      ada.app.enqueue(Drop, { by: "ada", value: 7 });
      // Nothing of it yet: not in the queue, and not in the log.
      expect(moves(ada.app.actionLog)).toEqual([]);
      for (let i = 0; i < 8; i++) {
        round(peers, net);
      }
      // Issued when 4 ticks had run, so stamped 4 + 3.
      const expected = [
        {
          tick: 7,
          name: "ls/Drop",
          payload: { by: "ada", value: 7 },
          queued: true,
        },
      ];
      expect(moves(ada.app.actionLog)).toEqual(expected);
      expect(moves(grace.app.actionLog)).toEqual(expected);
    });
  });

  it("sends one message per tick, stamped, with what was issued for it", () => {
    withPeers(["ada", "grace"], {}, (peers) => {
      const [ada] = peers as [Peer];
      // Two ticks, unless it is told otherwise.
      expect(ada.session.delay).toBe(2);
      expect(ada.session.delta).toBe(DELTA);
      expect(ada.session.peer).toBe("ada");
      ada.app.enqueue(Drop, { by: "ada", value: 1 });
      ada.app.enqueue(Drop, { by: "ada", value: 2 });
      expect(ada.session.tick()).toBe(false);
      // Its first tick speaks for every tick up to the one its delay
      // reaches, and what was issued is in the last of them.
      expect(ada.session.outgoing()).toEqual([
        { from: "ada", tick: 0, actions: [] },
        { from: "ada", tick: 1, actions: [] },
        {
          from: "ada",
          tick: 2,
          actions: [
            { name: "ls/Drop", payload: { by: "ada", value: 1 } },
            { name: "ls/Drop", payload: { by: "ada", value: 2 } },
          ],
        },
      ]);
      // Taken: asked again, there is nothing.
      expect(ada.session.outgoing()).toEqual([]);
      // A tick that waits says nothing twice.
      expect(ada.session.tick()).toBe(false);
      expect(ada.session.outgoing()).toEqual([]);
    });
  });

  it("applies what two peers issued for one tick in the order of their names", () => {
    for (const first of ["ada", "grace"]) {
      // Each peer was given the two names in an order of its own.
      withPeers(["grace", "ada"], { shuffled: true }, (given) => {
        const peers = given.toReversed();
        const net = network(1, { min: 0, max: 0 });
        const [ada, grace] = peers as [Peer, Peer];
        // Issued in either order, and ticked in either order.
        const order = first === "ada" ? [ada, grace] : [grace, ada];
        for (const peer of order) {
          peer.app.enqueue(Drop, {
            by: peer.name as "ada" | "grace",
            value: 1,
          });
        }
        for (let i = 0; i < 6; i++) {
          round(order, net);
        }
        for (const peer of peers) {
          expect(
            moves(peer.app.actionLog).map(
              (entry) => (entry.payload as { by: string }).by
            )
          ).toEqual(["ada", "grace"]);
        }
      });
    }
  });

  it("waits for a peer's message, and says for whom", () => {
    withPeers(["ada", "grace", "edsger"], { delay: 1 }, (peers) => {
      const [ada, grace, edsger] = peers as [Peer, Peer, Peer];
      expect(ada.session.waitingFor).toEqual(["edsger", "grace"]);
      expect(ada.session.tick()).toBe(false);
      expect(ada.app.time.tick).toBe(0);
      expect(grace.session.tick()).toBe(false);
      for (const message of grace.session.outgoing()) {
        ada.session.receive(message);
      }
      expect(ada.session.waitingFor).toEqual(["edsger"]);
      expect(ada.session.tick()).toBe(false);
      expect(edsger.session.tick()).toBe(false);
      for (const message of edsger.session.outgoing()) {
        ada.session.receive(message);
      }
      expect(ada.session.waitingFor).toEqual([]);
      // It holds their messages for ticks 0 and 1, and runs both.
      expect(ada.session.tick()).toBe(true);
      expect(ada.session.tick()).toBe(true);
      expect(ada.session.waitingFor).toEqual(["edsger", "grace"]);
      expect(ada.session.tick()).toBe(false);
      expect(ada.app.time.tick).toBe(2);
    });
  });

  it("drops a message it holds already, one for a tick that ran, and one from a stranger", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      const [ada, grace] = peers as [Peer, Peer];
      const action = { name: "ls/Drop", payload: { by: "grace", value: 9 } };
      ada.session.receive({ from: "grace", tick: 0, actions: [] });
      // The first word for a tick stands.
      ada.session.receive({ from: "grace", tick: 0, actions: [action] });
      ada.session.receive({ from: "mallory", tick: 0, actions: [action] });
      // Nobody speaks for this peer but itself.
      ada.session.receive({ from: "ada", tick: 1, actions: [action] });
      expect(ada.session.tick()).toBe(true);
      // For a tick that has run: it is not kept.
      const before = ada.session.held;
      ada.session.receive({ from: "grace", tick: 0, actions: [action] });
      expect(ada.session.held).toBe(before);
      ada.session.receive({ from: "grace", tick: 1, actions: [] });
      expect(ada.session.tick()).toBe(true);
      expect(moves(ada.app.actionLog)).toEqual([]);
      expect(grace.app.time.tick).toBe(0);
    });
  });

  it("has every peer refuse a payload that does not pass its schema, or a name nobody handles", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      // As data, which is how a tool or another program issues one.
      ada.app.enqueueByName("ls/Drop", { by: "nobody", value: 1.5 });
      ada.app.enqueueByName("ls/Nothing", {});
      for (let i = 0; i < 5; i++) {
        round(peers, net);
      }
      catchUp(peers, net);
      const logged = moves(grace.app.actionLog);
      expect(logged.map((entry) => entry.name)).toEqual([
        "ls/Drop",
        "ls/Nothing",
      ]);
      expect(logged.every((entry) => entry.refused !== undefined)).toBe(true);
      expect(ada.app.actionLog).toEqual(grace.app.actionLog);
      expect(ada.app.world.entityCount).toBe(grace.app.world.entityCount);
    });
  });

  it("carries what a key is bound to, to every peer", () => {
    withPeers(["ada", "grace"], { delay: 2 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      while (ada.app.time.tick < 2) {
        round(peers, net);
      }
      ada.source.tap("Space");
      for (let i = 0; i < 6; i++) {
        round(peers, net);
      }
      catchUp(peers, net);
      // Heard before the tick that ran when 2 had, so stamped 2 + 2.
      const expected = [
        { tick: 4, name: "ls/Fire", payload: {}, queued: true },
      ];
      expect(moves(ada.app.actionLog)).toEqual(expected);
      expect(moves(grace.app.actionLog)).toEqual(expected);
      expect(ada.app.world.hash()).toBe(grace.app.world.hash());
    });
  });

  it("hears a key that is pressed while it waits for a peer", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      ada.session.tick();
      const said = ada.session.outgoing();
      ada.source.tap("Space");
      // Still waiting, and the press is not lost: it is in its next message.
      expect(ada.session.tick()).toBe(false);
      expect(ada.session.outgoing()).toEqual([]);
      net.send(["grace"], said);
      for (let i = 0; i < 6; i++) {
        round(peers, net);
      }
      catchUp(peers, net);
      expect(moves(grace.app.actionLog)).toEqual([
        { tick: 2, name: "ls/Fire", payload: {}, queued: true },
      ]);
      expect(ada.app.actionLog).toEqual(grace.app.actionLog);
    });
  });

  it("sends a payload in its JSON form, and hands every handler the value", () => {
    withPeers(["ada", "grace"], { delay: 0 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      ada.app.enqueue(Mint, { on: new Date("2026-11-17T00:00:00.000Z") });
      ada.session.tick();
      const said = ada.session.outgoing();
      expect(said).toEqual([
        {
          from: "ada",
          tick: 0,
          actions: [
            { name: "ls/Mint", payload: { on: "2026-11-17T00:00:00.000Z" } },
          ],
        },
      ]);
      net.send(["grace"], said);
      for (let i = 0; i < 3; i++) {
        round(peers, net);
      }
      catchUp(peers, net);
      for (const peer of peers) {
        const coins = coinsOf(peer);
        expect(coins).toHaveLength(1);
        expect(peer.app.world.get(coins[0]!, Coin)?.value).toBe(2026);
      }
      expect(grace.app.world.hash()).toBe(ada.app.world.hash());
    });
  });

  it("leaves a payload its schema refuses to the peer that issued it", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      refusals.length = 0;
      // The compiler takes 1.5 for a number; the schema wants a whole one.
      ada.app.enqueue(Drop, { by: "ada", value: 1.5 });
      for (let i = 0; i < 5; i++) {
        round(peers, net);
      }
      catchUp(peers, net);
      // It has no JSON form to send, so it is refused here when its turn
      // comes, as in a game of one: one app heard of it, and it is in
      // nobody's log.
      expect(refusals).toEqual(["ls/Drop"]);
      expect(moves(ada.app.actionLog)).toEqual([]);
      expect(moves(grace.app.actionLog)).toEqual([]);
      expect(ada.app.world.hash()).toBe(grace.app.world.hash());
    });
  });

  it("returns a system's failure, and throws it from tick", () => {
    class Blown extends Data.TaggedError("Blown")<{ readonly at: number }> {}
    const Fuse = System.make("ls/Fuse", function* () {
      const { tick } = yield* Time;
      if (tick === 2) {
        return yield* Effect.fail(new Blown({ at: tick }));
      }
    });
    withApp(App.make({ systems: [Fuse] }), (app) => {
      const session = Lockstep.make(app, {
        peer: "ada",
        peers: ["ada"],
        delta: DELTA,
        delay: 0,
      });
      expect(session.tickExit()).toEqual(Exit.succeed(true));
      expect(session.tickExit()).toEqual(Exit.fail(new Blown({ at: 2 })));
      expect(session.tick()).toBe(true);
      expect(app.time.tick).toBe(3);
    });
    withApp(App.make({ systems: [Fuse] }), (app) => {
      const session = Lockstep.make(app, {
        peer: "ada",
        peers: ["ada"],
        delta: DELTA,
        delay: 0,
      });
      session.tick();
      expect(() => session.tick()).toThrow(Blown);
    });
  });

  it("does not run a tick whose input stage failed", () => {
    class Jammed extends Data.TaggedError("Jammed")<{}> {}
    let jam = true;
    const Keys = System.make("ls/Keys", function* () {
      if (jam) {
        return yield* Effect.fail(new Jammed());
      }
    }).pipe(System.inStage("input"));
    withApp(App.make({ systems: [Keys] }), (app) => {
      const session = Lockstep.make(app, {
        peer: "ada",
        peers: ["ada"],
        delta: DELTA,
        delay: 0,
      });
      expect(session.tickExit()).toEqual(Exit.fail(new Jammed()));
      expect(app.time.tick).toBe(0);
      // It said nothing for a tick it did not get to.
      expect(session.outgoing()).toEqual([]);
      jam = false;
      expect(session.tickExit()).toEqual(Exit.succeed(true));
      expect(app.time.tick).toBe(1);
    });
  });

  it("runs with no delay at all when messages arrive at once", () => {
    withPeers(["ada", "grace"], { delay: 0 }, (peers) => {
      const [ada, grace] = peers as [Peer, Peer];
      ada.app.enqueue(Drop, { by: "ada", value: 3 });
      for (let i = 0; i < 10; i++) {
        // Each says its piece, then both run.
        ada.session.tick();
        grace.session.tick();
        for (const message of ada.session.outgoing()) {
          grace.session.receive(message);
        }
        for (const message of grace.session.outgoing()) {
          ada.session.receive(message);
        }
        expect(ada.session.tick()).toBe(true);
        expect(grace.session.tick()).toBe(true);
        expect(ada.app.world.hash()).toBe(grace.app.world.hash());
      }
      expect(moves(grace.app.actionLog)).toEqual([
        {
          tick: 0,
          name: "ls/Drop",
          payload: { by: "ada", value: 3 },
          queued: true,
        },
      ]);
    });
  });

  it("is stepped by a driver, as an app is", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      const [ada, grace] = peers as [Peer, Peer];
      const steps = peers.map((peer) =>
        Driver.fixedStep(peer.session, { hz: 30 })
      );
      ada.app.enqueue(Drop, { by: "ada", value: 3 });
      for (let i = 0; i < 20; i++) {
        steps[0]!(DELTA);
        steps[1]!(DELTA);
        for (const message of ada.session.outgoing()) {
          grace.session.receive(message);
        }
        for (const message of grace.session.outgoing()) {
          ada.session.receive(message);
        }
      }
      expect(ada.app.time.tick).toBeGreaterThan(15);
      expect(ada.app.time.elapsed).toBeCloseTo(ada.app.time.tick * DELTA, 9);
      expect(moves(grace.app.actionLog)).toHaveLength(1);
      // A driver at another rate would have the peers simulate different
      // lengths of time.
      expect(() => Driver.fixedStep(ada.session, { hz: 60 })(1)).toThrow(
        /ticks 0\.0333\d* seconds at a time.*hz: 30/u
      );
    });
  });

  it("refuses what would apply an action on this machine alone", () => {
    withPeers(["ada", "grace"], {}, (peers) => {
      const [ada] = peers as [Peer];
      expect(() => ada.app.dispatch(Drop, { by: "ada", value: 1 })).toThrow(
        /on this machine alone.*Use enqueue/u
      );
      expect(() =>
        ada.app.dispatchByName("ls/Drop", { by: "ada", value: 1 })
      ).toThrow(/on this machine alone/u);
      // Nor is it stepped by anything but its session.
      expect(() => ada.app.tick(DELTA)).toThrow(
        /a tick ahead of the other peers.*call the session's tick/u
      );
      expect(() => ada.app.tickExit(DELTA)).toThrow(/taken over/u);
      expect(ada.app.time.tick).toBe(0);
      // An action with no schema has no form to be sent in.
      expect(() => ada.app.enqueue(Whisper, { to: "grace" })).toThrow(
        /"ls\/Whisper" was defined with a type and no schema.*cannot be sent/u
      );
      expect(() =>
        Lockstep.make(ada.app, { peer: "ada", peers: ["ada"], delta: DELTA })
      ).toThrow(/taken over already/u);
      expect(ada.app.actionLog).toEqual([]);
    });
  });

  it("is handed the reins of its app: a tick that reads no device", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const source = Input.makeManualSource();
          const app = yield* game().pipe(
            Effect.provideService(Input.Source, source)
          );
          const taken: string[] = [];
          const reins = app.divert((name) => {
            taken.push(name);
          });
          source.tap("Space");
          // The tick is the session's to run, and the session has heard
          // the devices already when it does.
          expect(reins.tickExit(DELTA)).toEqual(Exit.void);
          expect(app.time.tick).toBe(1);
          expect(taken).toEqual([]);
          app.input();
          expect(taken).toEqual(["ls/Fire"]);
          reins.deliver("ls/Fire", {});
          expect(moves(app.actionLog)).toEqual([
            { tick: 1, name: "ls/Fire", payload: {}, queued: true },
          ]);
        })
      )
    );
  });

  it("refuses options that could not be a game", () => {
    const attempt = (options: Partial<Lockstep.Options>) =>
      withApp(game(), (app) =>
        Lockstep.make(app, {
          peer: "ada",
          peers: ["ada", "grace"],
          delta: DELTA,
          ...options,
        })
      );
    expect(() => attempt({ peer: "linus" })).toThrow(
      /"linus" is not among the peers of its own session: ada, grace/u
    );
    expect(() => attempt({ peers: ["ada", "grace", "ada"] })).toThrow(
      /same name: ada, ada, grace/u
    );
    expect(() => attempt({ delay: -1 })).toThrow(/delay.*-1/u);
    expect(() => attempt({ delay: 1.5 })).toThrow(/delay.*1\.5/u);
    expect(() => attempt({ delta: 0 })).toThrow(/delta.*0/u);
    expect(() => attempt({ delta: Number.NaN })).toThrow(/delta.*NaN/u);
  });

  it("starts from wherever its app is", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          // Two copies of a game that has been going for a while.
          const apps = [yield* game(), yield* game()] as const;
          for (const app of apps) {
            app.dispatch(Drop, { by: "ada", value: 2 });
            for (let i = 0; i < 9; i++) {
              app.tick(DELTA);
            }
          }
          const [ada, grace] = apps.map((app, index) =>
            Lockstep.make(app, {
              peer: ["ada", "grace"][index]!,
              peers: ["ada", "grace"],
              delta: DELTA,
              delay: 1,
            })
          ) as [Lockstep.Session, Lockstep.Session];
          expect(ada.tick()).toBe(false);
          expect(ada.outgoing().map((message) => message.tick)).toEqual([
            9, 10,
          ]);
          grace.tick();
          for (const message of grace.outgoing()) {
            ada.receive(message);
          }
          expect(ada.tick()).toBe(true);
          expect(apps[0].time.tick).toBe(10);
        })
      )
    );
  });
});

describe("a message between peers", () => {
  it("goes to text and comes back", () => {
    const message: Lockstep.Message = {
      from: "ada",
      tick: 12,
      actions: [{ name: "ls/Drop", payload: { by: "ada", value: 1 } }],
    };
    expect(Lockstep.decode(Lockstep.encode(message))).toEqual(
      Exit.succeed(message)
    );
  });

  it("is refused when it is not one", () => {
    for (const text of [
      "",
      "{",
      "null",
      JSON.stringify({ from: "ada", tick: 1 }),
      JSON.stringify({ from: 7, tick: 1, actions: [] }),
      JSON.stringify({ from: "ada", tick: -1, actions: [] }),
      JSON.stringify({ from: "ada", tick: 1.5, actions: [] }),
      JSON.stringify({ from: "ada", tick: 1, actions: [{ payload: 1 }] }),
    ]) {
      expect(Exit.isFailure(Lockstep.decode(text)), text).toBe(true);
    }
  });
});
