import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  App,
  Component,
  Field,
  Journal,
  Lockstep,
  Query,
  Rollback,
  Save,
  System,
  Time,
} from "../src/index";
import {
  Coin,
  CoinGame,
  DELTA,
  Drop,
  Purse,
  Take,
  catchUp,
  coinsOf,
  game,
  moves,
  network,
  players,
  round,
  setGlitch,
  untilStopped,
  withApp,
  withPeers,
} from "./peers";
import type { Network, Peer } from "./peers";

/**
 * Lets a game come to rest: rounds in which nobody issues anything, long
 * enough for every message that had something to say to arrive, and then
 * every peer brought to the same tick. Returns that tick.
 */
const settle = (peers: readonly Peer[], net: Network, lag: number): number => {
  for (let i = 0; i < 3 * lag + 12; i++) {
    round(peers, net);
  }
  return catchUp(peers, net);
};

describe("a rollback session", () => {
  afterEach(() => {
    setGlitch(undefined);
  });

  it("has a player's own move in the very next tick, whatever the network takes", () => {
    withPeers(["ada", "grace"], { ahead: 10 }, (peers) => {
      const net = network(3, { min: 4, max: 6 });
      const [ada, grace] = peers as [Peer, Peer];
      for (let i = 0; i < 5; i++) {
        round(peers, net);
      }
      // Nobody waited: a tick a round, with messages four rounds away.
      expect(ada.app.time.tick).toBe(5);
      expect(grace.app.time.tick).toBe(5);
      ada.app.enqueue(Drop, { by: "ada", value: 9 });
      round(peers, net);
      // It is in ada's world, applied on the tick it was issued for.
      const move = {
        tick: 5,
        name: "ls/Drop",
        payload: { by: "ada", value: 9 },
        from: "ada",
        queued: true,
      };
      expect(moves(ada.app.actionLog).at(-1)).toEqual(move);
      const coin = coinsOf(ada).at(-1)!;
      expect(ada.app.world.get(coin, Coin)?.value).toBe(9);
      // Grace has run that tick too, and has not heard of it.
      expect(grace.app.time.tick).toBe(6);
      expect(moves(grace.app.actionLog)).not.toContainEqual(move);
      const before = grace.session.rewinds;
      settle(peers, net, 6);
      // When she hears, it is put where it belongs: on tick 5, not on the
      // tick the message arrived in.
      expect(moves(grace.app.actionLog)).toContainEqual(move);
      expect(grace.session.rewinds).toBeGreaterThan(before);
      expect(grace.app.world.hash()).toBe(ada.app.world.hash());
    });
  });

  it("ends hash-equal with the other peers, and with a game of one that was given the same actions", () => {
    for (const [seed, lag, ahead, delay] of [
      [1, { min: 0, max: 3 }, 8, 0],
      [2, { min: 2, max: 7 }, 12, 0],
      [3, { min: 1, max: 5 }, 8, 1],
      [4, { min: 0, max: 0 }, 4, 0],
    ] as const) {
      const where = `seed ${seed}`;
      withPeers(["ada", "grace"], { ahead, delay }, (peers) => {
        const net = network(seed, lag);
        const act = players(seed + 200);
        for (let i = 0; i < 300; i++) {
          for (const peer of peers) {
            act(peer);
          }
          round(peers, net);
        }
        const [ada, grace] = peers as [Peer, Peer];
        const ticks = settle(peers, net, lag.max);
        expect(ada.app.time.tick, where).toBe(ticks);
        expect(grace.app.time.tick, where).toBe(ticks);
        // It was a game: moves were made and refused, and unless the
        // network took no time, ticks were run a second time.
        const logged = moves(ada.app.actionLog);
        expect(
          logged.filter((entry) => entry.refused === undefined).length,
          where
        ).toBeGreaterThan(40);
        expect(
          logged.some((entry) => entry.refused !== undefined),
          where
        ).toBe(true);
        const purse = ada.app.world.singleton(Purse);
        expect(purse.taken, where).toBeGreaterThan(0);
        expect(purse.tallied, where).toBeGreaterThan(0);
        expect(purse.born, where).toBeGreaterThan(40);
        // Over a network that takes no time, the peer that runs first in a
        // round hears of the other's moves late, and the other on time.
        expect(
          [ada.session.rewinds > 5, grace.session.rewinds > 5],
          where
        ).toEqual(lag.max > 0 ? [true, true] : [true, false]);
        expect(ada.session.resimulated, where).toBeGreaterThanOrEqual(
          ada.session.rewinds
        );
        // What it keeps to go back to is what it is not sure of, however
        // long the game has gone on; at rest, with everything said, that
        // is next to nothing.
        expect(ada.session.kept, where).toBeLessThanOrEqual(ahead);
        expect(ada.session.kept, where).toBeLessThanOrEqual(lag.max + 1);
        // The same game on both.
        expect(ada.app.world.hash(), where).toBe(grace.app.world.hash());
        expect(ada.app.actionLog, where).toEqual(grace.app.actionLog);
        expect(ada.session.drifted, where).toBeUndefined();
        expect(grace.session.drifted, where).toBeUndefined();
        // And the game a single app plays when it is given those actions
        // on those ticks and never goes back: the replay holds every
        // tick's hash against the log's, and ends on the same one.
        const played = ada.app.record();
        withApp(
          Journal.replay(played, (start) =>
            App.make(CoinGame, { ...start, checkpointEvery: 1 })
          ),
          (alone) => {
            expect(alone.world.hash(), where).toBe(ada.app.world.hash());
            expect({ ...alone.world.singleton(Purse) }, where).toEqual({
              ...purse,
            });
          }
        );
      });
    }
  });

  it("keeps three peers the same game", () => {
    withPeers(["ada", "grace", "edsger"], { ahead: 10 }, (peers) => {
      const net = network(9, { min: 0, max: 6 });
      const act = players(10);
      for (let i = 0; i < 200; i++) {
        act(peers[0]!);
        act(peers[1]!);
        round(peers, net);
      }
      const ticks = settle(peers, net, 6);
      const [first, ...others] = peers as [Peer, Peer, Peer];
      for (const other of others) {
        expect(other.app.world.hash()).toBe(first.app.world.hash());
        expect(other.app.actionLog).toEqual(first.app.actionLog);
        expect(other.session.drifted).toBeUndefined();
      }
      expect(first.session.rewinds).toBeGreaterThan(5);
      const recording = first.app.record();
      expect(recording.end).toBe(ticks);
      withApp(
        Journal.replay(recording, (start) =>
          App.make(CoinGame, { ...start, checkpointEvery: 1 })
        ),
        (alone) => {
          expect(alone.world.hash()).toBe(first.app.world.hash());
        }
      );
    });
  });

  it("runs a tick every round where a lockstep session under the same network waits", () => {
    const ticksAfter = (ahead: number | undefined): number =>
      withPeers(
        ["ada", "grace"],
        ahead === undefined ? {} : { ahead },
        (peers) => {
          const net = network(5, { min: 3, max: 6 });
          const act = players(6);
          for (let i = 0; i < 120; i++) {
            act(peers[0]!);
            round(peers, net);
          }
          return peers[0]!.app.time.tick;
        }
      );
    expect(ticksAfter(10)).toBe(120);
    expect(ticksAfter(undefined)).toBeLessThan(80);
  });

  it("goes back only for a message that had something to say", () => {
    withPeers(["ada", "grace"], { ahead: 10 }, (peers) => {
      const net = network(7, { min: 2, max: 5 });
      const [ada, grace] = peers as [Peer, Peer];
      for (let i = 0; i < 60; i++) {
        round(peers, net);
      }
      // Sixty ticks ahead of the network, every one predicted right.
      expect(ada.app.time.tick).toBe(60);
      expect(ada.session.rewinds).toBe(0);
      expect(grace.session.resimulated).toBe(0);
      ada.app.enqueue(Drop, { by: "ada", value: 1 });
      for (let i = 0; i < 20; i++) {
        round(peers, net);
      }
      // One move: grace went back once, and ada, who made it, never.
      expect(grace.session.rewinds).toBe(1);
      expect(grace.session.resimulated).toBeGreaterThanOrEqual(2);
      expect(grace.session.resimulated).toBeLessThanOrEqual(6);
      expect(ada.session.rewinds).toBe(0);
    });
  });

  it("counts as final only the ticks it has run with everything that was said", () => {
    withPeers(["ada", "grace"], { ahead: 10 }, (peers) => {
      const [ada] = peers as [Peer];
      for (let i = 0; i < 5; i++) {
        ada.session.tick();
      }
      expect(ada.session.confirmed).toBe(0);
      expect(ada.session.kept).toBe(5);
      // Grace's word for those five ticks, with a move on the third.
      for (let tick = 0; tick < 5; tick++) {
        ada.session.receive({
          from: "grace",
          tick,
          actions:
            tick === 2
              ? [{ name: "ls/Drop", payload: { by: "grace", value: 2 } }]
              : [],
        });
      }
      // Everything is said, and the game ada holds was run without that
      // move: it is right up to the tick the move is for, and no further.
      expect(ada.session.confirmed).toBe(2);
      expect(ada.session.rewinds).toBe(0);
      ada.session.tick();
      expect(ada.session.rewinds).toBe(1);
      expect(ada.session.resimulated).toBe(3);
      expect(ada.session.confirmed).toBe(5);
      expect(ada.app.time.tick).toBe(6);
      // Sure of every tick but the one it has just run.
      expect(ada.session.kept).toBe(1);
      expect(moves(ada.app.actionLog)).toEqual([
        {
          tick: 2,
          name: "ls/Drop",
          payload: { by: "grace", value: 2 },
          from: "grace",
          queued: true,
        },
      ]);
    });
  });

  it("captures the game only before a tick it is not sure of", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const counted = (app: Effect.Success<ReturnType<typeof game>>) => {
            const count = { captures: 0 };
            // A capture of the game is one of its world.
            const capture = app.world._capture.bind(app.world);
            app.world._capture = () => {
              count.captures++;
              return capture();
            };
            const session = Rollback.make(app, {
              peer: "ada",
              peers: ["ada", "grace"],
              delta: DELTA,
            });
            return { count, session };
          };
          // Grace says everything before ada runs: ada is sure of every tick.
          const sure = counted(yield* game());
          const start = sure.session.peers.length;
          expect(start).toBe(2);
          for (let tick = 0; tick < 20; tick++) {
            sure.session.receive({ from: "grace", tick, actions: [] });
            expect(sure.session.tick()).toBe(true);
          }
          expect(sure.count.captures).toBe(0);
          expect(sure.session.confirmed).toBe(20);
          // Grace says nothing: every tick is a guess, and is captured.
          const unsure = counted(yield* game());
          for (let tick = 0; tick < 5; tick++) {
            expect(unsure.session.tick()).toBe(true);
          }
          expect(unsure.count.captures).toBe(5);
          expect(unsure.session.confirmed).toBe(0);
        })
      )
    );
  });

  it("waits once it is as far ahead of the peers as it may be", () => {
    withPeers(["ada", "grace"], { ahead: 3 }, (peers) => {
      const [ada, grace] = peers as [Peer, Peer];
      expect(ada.session.ahead).toBe(3);
      expect(ada.session.delay).toBe(0);
      for (let i = 0; i < 3; i++) {
        expect(ada.session.waitingFor).toEqual([]);
        expect(ada.session.tick()).toBe(true);
      }
      // Three ticks past what grace has said, which is nothing.
      expect(ada.session.waitingFor).toEqual(["grace"]);
      expect(ada.session.tick()).toBe(false);
      expect(ada.app.time.tick).toBe(3);
      expect(ada.session.confirmed).toBe(0);
      grace.session.tick();
      for (const message of grace.session.outgoing()) {
        ada.session.receive(message);
      }
      // Grace has said tick 0: one more may run.
      expect(ada.session.confirmed).toBe(1);
      expect(ada.session.tick()).toBe(true);
      expect(ada.session.tick()).toBe(false);
      expect(ada.app.time.tick).toBe(4);
    });
  });

  it("runs eight ticks ahead unless told, and none with a delay of its own", () => {
    withApp(game(), (app) => {
      const session = Rollback.make(app, {
        peer: "ada",
        peers: ["ada", "grace"],
        delta: DELTA,
      });
      expect(session.ahead).toBe(8);
      expect(session.delay).toBe(0);
      let ran = 0;
      while (session.tick()) {
        ran++;
      }
      expect(ran).toBe(8);
    });
    for (const ahead of [-1, 1.5, Number.NaN]) {
      expect(() =>
        withApp(game(), (app) =>
          Rollback.make(app, {
            peer: "ada",
            peers: ["ada"],
            delta: DELTA,
            ahead,
          })
        )
      ).toThrow(/runs ahead is a whole number of ticks, 0 or more/u);
    }
  });

  it("is a lockstep session when it runs no tick ahead", () => {
    withPeers(["ada", "grace"], { ahead: 0, delay: 1 }, (peers) => {
      const net = network(2, { min: 1, max: 4 });
      const act = players(3);
      for (let i = 0; i < 150; i++) {
        act(peers[0]!);
        act(peers[1]!);
        round(peers, net);
      }
      catchUp(peers, net);
      const [ada, grace] = peers as [Peer, Peer];
      expect(ada.session.rewinds).toBe(0);
      expect(ada.session.confirmed).toBe(ada.app.time.tick);
      expect(ada.app.time.tick).toBeGreaterThan(20);
      expect(ada.app.time.tick).toBeLessThan(140);
      expect(ada.hashes).toEqual(grace.hashes);
    });
  });

  it("puts a peer's two moves for one tick, and two peers' for one tick, in the order every peer has them", () => {
    withPeers(["ada", "grace"], { ahead: 10 }, (peers) => {
      const net = network(4, { min: 3, max: 5 });
      const [ada, grace] = peers as [Peer, Peer];
      round(peers, net);
      // All for the tick that runs next, on each peer before it hears the other.
      grace.app.enqueue(Drop, { by: "grace", value: 1 });
      grace.app.enqueue(Drop, { by: "grace", value: 2 });
      ada.app.enqueue(Drop, { by: "ada", value: 3 });
      settle(peers, net, 5);
      const order = (peer: Peer) =>
        moves(peer.app.actionLog).map(
          (entry) => (entry.payload as { value: number }).value
        );
      expect(order(ada)).toEqual([3, 1, 2]);
      expect(order(grace)).toEqual([3, 1, 2]);
      expect(ada.app.world.hash()).toBe(grace.app.world.hash());
    });
  });

  it("refuses the same move on every peer, though one of them had first seen it accepted", () => {
    withPeers(["ada", "grace"], { ahead: 10 }, (peers) => {
      const net = network(4, { min: 3, max: 5 });
      const [ada, grace] = peers as [Peer, Peer];
      ada.app.enqueue(Drop, { by: "ada", value: 5 });
      settle(peers, net, 5);
      const coin = coinsOf(grace)[0]!;
      // The first of them: the bot has dropped others since.
      expect(coinsOf(ada)).toEqual(coinsOf(grace));
      expect(ada.app.world.get(coin, Coin)?.value).toBe(5);
      // Both go for it on the same tick. Each sees itself take it.
      ada.app.enqueue(Take, { by: "ada", coin });
      grace.app.enqueue(Take, { by: "grace", coin });
      round(peers, net);
      expect(ada.app.world.singleton(Purse).ada).toBe(5);
      expect(grace.app.world.singleton(Purse).grace).toBe(5);
      settle(peers, net, 5);
      // Ada's name comes first: hers stands on both, and grace's is taken back.
      for (const peer of peers) {
        const purse = peer.app.world.singleton(Purse);
        expect({
          ada: purse.ada,
          grace: purse.grace,
          taken: purse.taken,
        }).toEqual({ ada: 5, grace: 0, taken: 1 });
        const takes = moves(peer.app.actionLog).filter(
          (entry) => entry.name === "ls/Take"
        );
        expect(takes.map((entry) => entry.refused !== undefined)).toEqual([
          false,
          true,
        ]);
      }
      expect(ada.app.actionLog).toEqual(grace.app.actionLog);
    });
  });

  it("catches peers that have come apart, within checkpointEvery - 1 + delay + twice how far it runs ahead", () => {
    const at = 23;
    for (const [every, delay, ahead, lag] of [
      [1, 0, 6, { min: 0, max: 4 }],
      [4, 1, 3, { min: 1, max: 6 }],
      [10, 0, 8, { min: 0, max: 0 }],
      [1, 2, 2, { min: 3, max: 9 }],
    ] as const) {
      const where = `checkpointEvery ${every}, delay ${delay}, ahead ${ahead}`;
      withPeers(
        ["ada", "grace"],
        { ahead, delay, checkpointEvery: { ada: every, grace: every } },
        (peers) => {
          setGlitch({ tick: at, worlds: "all" });
          const net = network(every + delay + ahead, lag);
          peers[0]!.app.enqueue(Drop, { by: "ada", value: 3 });
          const stopped = untilStopped(peers, net, 800);
          const checkpoint = Math.ceil(at / every) * every;
          for (const peer of peers) {
            const drifted = stopped.get(peer.name) as Lockstep.Drifted;
            expect(drifted, where).toBeInstanceOf(Lockstep.Drifted);
            expect(drifted.tick, where).toBe(checkpoint);
            expect(drifted.agreedAt, where).toBe(checkpoint - every);
            expect(drifted.hashes.ada, where).not.toBe(drifted.hashes.grace);
            expect(peer.app.time.tick, where).toBeLessThanOrEqual(
              at + every - 1 + delay + 2 * ahead
            );
          }
        }
      );
    }
  });

  it("fails a tick it cannot be sure of when the game cannot be captured", () => {
    const Holder = Component.define("rb/Holder", {
      thing: Field.json<unknown>(),
    });
    const Spoil = System.make("rb/Spoil", function* () {
      if ((yield* Time).tick === 2) {
        (yield* Query.all(Holder).pipe(Query.writes(Holder))).each((holder) => {
          // Not plain data: no snapshot can hold it.
          holder.thing = () => 1;
        });
      }
    });
    withApp(App.make(App.define({ systems: [Spoil] })), (app) => {
      app.world.spawn(Holder.of({ thing: "fine" }));
      const session = Rollback.make(app, {
        peer: "ada",
        peers: ["ada", "grace"],
        delta: DELTA,
      });
      expect(session.tickExit()).toEqual(Exit.succeed(true));
      expect(session.tickExit()).toEqual(Exit.succeed(true));
      const exit = session.tickExit();
      expect(Exit.isFailure(exit)).toBe(true);
      const refused = Exit.isFailure(exit) ? exit.cause : undefined;
      expect(String(refused)).toMatch(/rb\/Holder/u);
      expect(() => session.tick()).toThrow(Save.SaveRefused);
      // The tick did not run.
      expect(app.time.tick).toBe(2);
    });
  });
});
