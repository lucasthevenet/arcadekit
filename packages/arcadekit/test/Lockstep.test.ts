import { Cause, Data, Effect, Exit } from "effect";
import type { Scope } from "effect";
import { afterEach, assert, describe, expect, it } from "vitest";

import {
  Action,
  App,
  Build,
  Driver,
  Input,
  Journal,
  Save,
  System,
  Time,
} from "../src/index";
import { Drift, Message, Session } from "../src/net/index";
import {
  Bot,
  Coin,
  CoinGame,
  Controls,
  DELTA,
  Drop,
  Fault,
  Hear,
  Mint,
  Purse,
  Tally,
  Drift as Wander,
  catchUp,
  coinsOf,
  drop,
  fire,
  game,
  mint,
  moves,
  network,
  players,
  refusals,
  round,
  setGlitch,
  take,
  tip,
  untilStopped,
  whisper,
  withApp,
  withPeers,
} from "./peers";
import type { Peer } from "./peers";

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
      const recording = ada.app.record();
      expect(recording.end).toBe(ticks);
      withApp(
        Journal.replay(recording, (start) =>
          App.make(CoinGame, { ...start, checkpointEvery: 1 })
        ),
        (alone) => {
          expect(alone.world.hash()).toBe(ada.app.world.hash());
        }
      );
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
          from: "ada",
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
        {
          from: "ada",
          tick: 0,
          actions: [],
          // The state it starts from, for the others to compare.
          checkpoints: [{ tick: 0, hash: ada.app.world.hash() }],
          // And what it was made with, first of all.
          made: {
            game: expect.any(Number),
            delta: DELTA,
            peers: ["ada", "grace"],
            start: 0,
          },
        },
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
        { tick: 4, name: "ls/Fire", payload: {}, from: "ada", queued: true },
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
        { tick: 2, name: "ls/Fire", payload: {}, from: "ada", queued: true },
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
          checkpoints: [{ tick: 0, hash: ada.app.world.hash() }],
          made: expect.objectContaining({ start: 0 }),
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

  it("refuses a payload its schema refuses where it is issued, so no peer hears of it", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      refusals.length = 0;
      // The compiler takes 1.5 for a number; the schema wants a whole one.
      // It has no JSON form to send, so it is refused here and now, and not
      // when its turn comes on this machine alone.
      expect(ada.app.enqueue(Drop, { by: "ada", value: 1.5 })).toEqual(
        Exit.fail(
          new Action.InvalidPayload({
            action: "ls/Drop",
            message: 'Expected an integer\n  at ["value"]',
          })
        )
      );
      for (let i = 0; i < 5; i++) {
        round(peers, net);
      }
      catchUp(peers, net);
      // Neither app heard of it, and it is in nobody's log.
      expect(refusals).toEqual([]);
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
        return yield* new Blown({ at: tick });
      }
    });
    const Fused = App.define({ systems: [Fuse] });
    const alone = {
      peer: "ada",
      peers: ["ada"],
      delta: DELTA,
      delay: 0,
      ahead: 0,
    };
    withApp(Session.make(Fused, alone), (session) => {
      expect(session.tickExit()).toEqual(Exit.succeed(true));
      expect(session.tickExit()).toEqual(Exit.fail(new Blown({ at: 2 })));
      expect(session.tick()).toBe(true);
      expect(session.app.time.tick).toBe(3);
    });
    withApp(Session.make(Fused, alone), (session) => {
      session.tick();
      expect(() => session.tick()).toThrow(Blown);
    });
  });

  it("does not run a tick whose input stage failed", () => {
    class Jammed extends Data.TaggedError("Jammed")<{}> {}
    let jam = true;
    const Keys = System.make("ls/Keys", function* () {
      if (jam) {
        return yield* new Jammed();
      }
    }).pipe(System.inStage("input"));
    withApp(
      Session.make(App.define({ systems: [Keys] }), {
        peer: "ada",
        peers: ["ada"],
        delta: DELTA,
        delay: 0,
        ahead: 0,
      }),
      (session) => {
        expect(session.tickExit()).toEqual(Exit.fail(new Jammed()));
        expect(session.app.time.tick).toBe(0);
        // It said nothing for a tick it did not get to.
        expect(session.outgoing()).toEqual([]);
        jam = false;
        expect(session.tickExit()).toEqual(Exit.succeed(true));
        expect(session.app.time.tick).toBe(1);
      }
    );
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
          from: "ada",
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
      // A session's app has none of the four in its type, and the app it
      // is refuses each of them when it is reached all the same.
      expect(() =>
        // @ts-expect-error a session's app has no dispatch: it would apply the action on this machine alone
        ada.app.dispatch(Drop, { by: "ada", value: 1 })
      ).toThrow(/on this machine alone.*Use enqueue/u);
      expect(() =>
        // @ts-expect-error a session's app has no dispatchByName: it would apply the action on this machine alone
        ada.app.dispatchByName("ls/Drop", { by: "ada", value: 1 })
      ).toThrow(/on this machine alone/u);
      // Nor is it stepped by anything but its session.
      expect(() =>
        // @ts-expect-error a session's app has no tick: the session steps it
        ada.app.tick(DELTA)
      ).toThrow(/a tick ahead of the other peers.*call the session's tick/u);
      expect(() =>
        // @ts-expect-error a session's app has no tickExit: the session steps it
        ada.app.tickExit(DELTA)
      ).toThrow(/taken over/u);
      expect(ada.app.time.tick).toBe(0);
      expect(ada.app.actionLog).toEqual([]);
    });
    // Nor is an app taken over twice.
    withApp(
      Build.build(CoinGame, { seed: 5, checkpointEvery: 1 }),
      ({ take }) => {
        take(() => {});
        expect(() => take(() => {})).toThrow(/taken over already/u);
      }
    );
  });

  it("is handed the reins of its app: a tick that reads no device", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const source = Input.makeManualSource();
          const { app, take } = yield* Build.build(CoinGame, {
            seed: 5,
            checkpointEvery: 1,
          }).pipe(Effect.provideService(Input.Source, source));
          const taken: string[] = [];
          const reins = take((name) => {
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

  it("tells whoever stepped a tick of its systems, and nobody of the next", () => {
    withApp(
      Build.build(CoinGame, { seed: 5, checkpointEvery: 1 }),
      ({ app, take }) => {
        const reins = take(() => {});
        const told: (string | undefined)[] = [];
        expect(
          reins.tickExit(DELTA, (system) => {
            told.push(system);
          })
        ).toEqual(Exit.void);
        // Before the first system, then after each.
        expect(told).toEqual([undefined, ...app.systemOrder]);
        expect(reins.tickExit(DELTA)).toEqual(Exit.void);
        expect(told).toHaveLength(1 + app.systemOrder.length);
      }
    );
  });

  it("refuses options that could not be a game", () => {
    const attempt = (options: Partial<Session.Options>) =>
      withApp(
        Session.make(CoinGame, {
          seed: 5,
          checkpointEvery: 1,
          peer: "ada",
          peers: ["ada", "grace"],
          delta: DELTA,
          ...options,
          ahead: 0,
        }),
        (session) => session
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

  it("starts from wherever its game is: at the save every peer loads", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          // A game that has been going for a while, saved for every peer.
          const going = yield* game();
          going.dispatch(Drop, { by: "ada", value: 2 });
          for (let i = 0; i < 9; i++) {
            going.tick(DELTA);
          }
          const saved = going.save();
          assert(Exit.isSuccess(saved));
          const peerOf = (peer: string) =>
            Session.make(CoinGame, {
              save: saved.value,
              checkpointEvery: 1,
              peer,
              peers: ["ada", "grace"],
              delta: DELTA,
              delay: 1,
              ahead: 0,
            });
          const ada = yield* peerOf("ada");
          const grace = yield* peerOf("grace");
          expect(ada.app.time.tick).toBe(9);
          expect(ada.app.world.hash()).toBe(going.world.hash());
          // A loaded game's log starts empty.
          expect(ada.app.actionLog).toEqual([]);
          expect(ada.tick()).toBe(false);
          const said = ada.outgoing();
          expect(said.map((message) => message.tick)).toEqual([9, 10]);
          // Where it starts is the first thing it says: the session takes
          // the checkpoint, once.
          const start = { tick: 9, hash: going.world.hash() };
          expect(said[0]!.checkpoints).toEqual([start]);
          expect(ada.app.actionLog).toEqual([start]);
          grace.tick();
          for (const message of grace.outgoing()) {
            ada.receive(message);
          }
          expect(ada.tick()).toBe(true);
          expect(ada.app.time.tick).toBe(10);
          // The tick took none for where it started: the log has the one.
          expect(
            ada.app.actionLog.filter(
              (entry) => Action.isCheckpoint(entry) && entry.tick === 9
            )
          ).toEqual([start]);

          // A checkpoint the game took itself where it starts is the one
          // sent, and the session takes no second.
          const edsger = yield* peerOf("ada");
          const own = edsger.app.checkpoint();
          expect(edsger.tick()).toBe(false);
          expect(edsger.outgoing()[0]!.checkpoints).toEqual([
            { tick: 9, hash: own },
          ]);
          expect(edsger.app.actionLog).toEqual([{ tick: 9, hash: own }]);
        })
      )
    );
  });
});

describe("peers that have come apart", () => {
  afterEach(() => {
    setGlitch(undefined);
  });

  it("are caught within checkpointEvery - 1 + delay ticks of a system that is not deterministic", () => {
    const at = 23;
    for (const every of [1, 4, 10]) {
      for (const delay of [0, 1, 3]) {
        for (const lag of [
          { min: 0, max: 0 },
          { min: 0, max: 4 },
        ]) {
          withPeers(
            ["ada", "grace"],
            { delay, checkpointEvery: { ada: every, grace: every } },
            (peers) => {
              setGlitch({ tick: at, worlds: "all" });
              const net = network(every * 10 + delay, lag);
              peers[0]!.app.enqueue(Drop, { by: "ada", value: 3 });
              const stopped = untilStopped(peers, net, 600);
              const where = `checkpointEvery ${every}, delay ${delay}, lag ${lag.max}`;
              // The first checkpoint at or after the tick that differed.
              const checkpoint = Math.ceil(at / every) * every;
              for (const peer of peers) {
                const reason = stopped.get(peer.name);
                expect(reason, where).toBeInstanceOf(Drift.Drifted);
                const drifted = reason as Drift.Drifted;
                expect(drifted.tick, where).toBe(checkpoint);
                expect(drifted.peer, where).toBe(peer.name);
                expect(drifted.agreedAt, where).toBe(checkpoint - every);
                expect(Object.keys(drifted.hashes), where).toEqual([
                  "ada",
                  "grace",
                ]);
                expect(drifted.hashes.ada, where).not.toBe(
                  drifted.hashes.grace
                );
                // No further than this, however slow the network.
                expect(peer.app.time.tick, where).toBeGreaterThanOrEqual(
                  checkpoint
                );
                expect(peer.app.time.tick, where).toBeLessThanOrEqual(
                  checkpoint + delay
                );
                expect(peer.app.time.tick, where).toBeLessThanOrEqual(
                  at + every - 1 + delay
                );
              }
              // Both say the same of who had what.
              expect(
                (stopped.get("ada") as Drift.Drifted).hashes,
                where
              ).toEqual((stopped.get("grace") as Drift.Drifted).hashes);
            }
          );
        }
      }
    }
  });

  it("stop for good, and say so in words", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      setGlitch({ tick: 9, worlds: "all" });
      const net = network(1, { min: 0, max: 0 });
      const [ada] = peers as [Peer];
      ada.app.enqueue(Drop, { by: "ada", value: 3 });
      expect(ada.session.drifted).toBeUndefined();
      const stopped = untilStopped(peers, net, 100);
      const drifted = stopped.get("ada") as Drift.Drifted;
      expect(ada.session.drifted).toBe(drifted);
      const { tick } = ada.app.time;
      // Every tick fails with it from then on, and runs nothing.
      expect(ada.session.tickExit()).toEqual(Exit.fail(drifted));
      expect(() => ada.session.tick()).toThrow(Drift.Drifted);
      expect(ada.app.time.tick).toBe(tick);
      expect(drifted.message).toBe(
        `The peers are no longer playing the same game. At tick 9 the hashes of their worlds are: ada ${drifted.hashes.ada}, grace ${drifted.hashes.grace} (found by "ada"). They last agreed at tick 8, so they came apart in one of the 1 ticks after it: look for a system or a handler that reads what is not in the world (Math.random, a clock, a service that keeps state of its own, the order of a Map or a Set), or for peers whose systems of the same name do different things.`
      );
    });
  });

  it("stop a peer in the very call that ran the tick, when the others' word for it was in already", () => {
    withPeers(["ada", "grace"], { delay: 2 }, (peers) => {
      const [ada] = peers as [Peer];
      const start = ada.app.world.hash();
      // Grace, by hand: every message up to tick 5, and a hash for tick 2
      // that is not ada's.
      for (let tick = 0; tick <= 5; tick++) {
        ada.session.receive({
          from: "grace",
          tick,
          actions: [],
          ...(tick === 0 ? { checkpoints: [{ tick: 0, hash: start }] } : {}),
          ...(tick === 4 ? { checkpoints: [{ tick: 2, hash: 12_345 }] } : {}),
        });
      }
      expect(ada.session.tickExit()).toEqual(Exit.succeed(true));
      expect(ada.session.drifted).toBeUndefined();
      const exit = ada.session.tickExit();
      expect(ada.app.time.tick).toBe(2);
      expect(exit).toEqual(
        Exit.fail(
          new Drift.Drifted({
            tick: 2,
            peer: "ada",
            hashes: { ada: ada.app.world.hash(), grace: 12_345 },
            agreedAt: 0,
          })
        )
      );
    });
  });

  it("let go of the checkpoints that were answered, and in time of the ones that never are", () => {
    withPeers(["ada", "grace"], {}, (peers) => {
      const net = network(2, { min: 0, max: 4 });
      for (let i = 0; i < 200; i++) {
        round(peers, net);
      }
      // What is left is what the other has not had the time to answer.
      expect(peers[0]!.session.unanswered).toBeLessThanOrEqual(2 * 2 + 2);
      expect(peers[0]!.app.time.tick).toBeGreaterThan(30);
    });
    // Nobody answers a peer that plays alone.
    withApp(
      Session.make(CoinGame, {
        seed: 5,
        checkpointEvery: 1,
        peer: "ada",
        peers: ["ada"],
        delta: DELTA,
        ahead: 0,
      }),
      (session) => {
        for (let i = 0; i < 700; i++) {
          session.tick();
        }
        expect(session.app.time.tick).toBe(700);
        expect(session.unanswered).toBe(601);
      }
    );
  });

  it("are caught before their first tick when they do not start from the same state", () => {
    withPeers(
      ["ada", "grace"],
      { seeds: { ada: 1, grace: 2 }, checkpointEvery: { ada: 60, grace: 60 } },
      (peers) => {
        const net = network(1, { min: 0, max: 3 });
        const stopped = untilStopped(peers, net, 100);
        for (const peer of peers) {
          const drifted = stopped.get(peer.name) as Drift.Drifted;
          expect(drifted).toBeInstanceOf(Drift.Drifted);
          expect(drifted.tick).toBe(0);
          expect(drifted.agreedAt).toBeUndefined();
          expect(drifted.message).toMatch(
            /did not start from the same state: check that every peer was made with the same seed/u
          );
          expect(peer.app.time.tick).toBe(0);
        }
      }
    );
  });

  it("compare the state they start from even when their logs record no checkpoint", () => {
    withPeers(
      ["ada", "grace"],
      { seeds: { ada: 1, grace: 2 }, checkpointEvery: { ada: 0, grace: 0 } },
      (peers) => {
        const stopped = untilStopped(peers, network(1, { min: 0, max: 0 }), 50);
        expect(stopped.get("ada")).toBeInstanceOf(Drift.Drifted);
        expect(stopped.get("grace")).toBeInstanceOf(Drift.Drifted);
        expect(peers[0]!.app.time.tick).toBe(0);
      }
    );
    // And nothing after it: with no checkpoints there is nothing to compare.
    withPeers(
      ["ada", "grace"],
      { checkpointEvery: { ada: 0, grace: 0 } },
      (peers) => {
        setGlitch({ tick: 9, worlds: "all" });
        peers[0]!.app.enqueue(Drop, { by: "ada", value: 3 });
        const stopped = untilStopped(peers, network(1, { min: 0, max: 0 }), 50);
        expect(stopped.size).toBe(0);
        expect(peers[0]!.app.world.hash()).not.toBe(peers[1]!.app.world.hash());
      }
    );
  });

  it("are all stopped when one of three has gone its own way, and the report says which", () => {
    withPeers(["ada", "grace", "edsger"], { delay: 2 }, (peers) => {
      const [ada, grace, edsger] = peers as [Peer, Peer, Peer];
      setGlitch({ tick: 12, worlds: new Set([grace.app.world]) });
      const net = network(6, { min: 0, max: 3 });
      ada.app.enqueue(Drop, { by: "ada", value: 3 });
      const stopped = untilStopped(peers, net, 300);
      expect(stopped.size).toBe(3);
      const reports = [ada, grace, edsger].map(
        (peer) => stopped.get(peer.name) as Drift.Drifted
      );
      for (const report of reports) {
        expect(report).toBeInstanceOf(Drift.Drifted);
        expect(report.tick).toBe(12);
        expect(report.agreedAt).toBe(11);
      }
      // Every report has every peer's hash: two agree and one does not.
      for (const report of reports) {
        expect(Object.keys(report.hashes)).toEqual(["ada", "edsger", "grace"]);
        expect(report.hashes.ada).toBe(report.hashes.edsger);
        expect(report.hashes.grace).not.toBe(report.hashes.ada);
        expect(report.hashes).toEqual(reports[0]!.hashes);
      }
    });
  });

  it("compare the checkpoints they both have, when one records more than the other", () => {
    withPeers(
      ["ada", "grace"],
      { delay: 1, checkpointEvery: { ada: 2, grace: 6 } },
      (peers) => {
        const net = network(3, { min: 0, max: 2 });
        const act = players(4);
        const [ada, grace] = peers as [Peer, Peer];
        for (let i = 0; i < 100; i++) {
          act(ada);
          act(grace);
          round(peers, net);
          if (i === 40) {
            // One taken by hand, at a tick of nobody's schedule.
            ada.app.checkpoint();
          }
        }
        // A healthy game is not stopped by what one peer alone recorded.
        expect(ada.session.drifted).toBeUndefined();
        expect(grace.session.drifted).toBeUndefined();
        expect(ada.app.time.tick).toBeGreaterThan(40);
        const at = ada.app.time.tick + 3;
        setGlitch({ tick: at, worlds: "all" });
        const stopped = untilStopped(peers, net, 100);
        // Caught at the first tick both record: a multiple of 6.
        const drifted = stopped.get("grace") as Drift.Drifted;
        expect(drifted).toBeInstanceOf(Drift.Drifted);
        expect(drifted.tick).toBe(Math.ceil(at / 6) * 6);
        expect(drifted.agreedAt).toBe(drifted.tick - 6);
      }
    );
  });
});

/** What a test of peers made apart reads of each. */
interface Seat {
  readonly receive: (message: Message.Message) => void;
  readonly outgoing: () => readonly Message.Message[];
  readonly tickExit: () => Exit.Exit<boolean, unknown>;
  readonly confirmed: number;
  readonly app: { readonly time: { readonly tick: number } };
}

/** Peers each made as it says, over a network that delays and reorders. */
const madeApart = (
  makers: readonly (readonly [
    name: string,
    make: Effect.Effect<Seat, Save.LoadRefused, Scope.Scope>,
  ])[],
  rounds = 60
) =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const seats = new Map<string, Seat>();
        for (const [name, make] of makers) {
          seats.set(name, yield* make);
        }
        const net = network(2, { min: 0, max: 3 });
        const stopped = new Map<string, unknown>();
        for (let i = 0; i < rounds && stopped.size < seats.size; i++) {
          net.round();
          for (const [name, seat] of seats) {
            for (const message of net.arrivals(name)) {
              seat.receive(message);
            }
            const exit = seat.tickExit();
            if (Exit.isFailure(exit)) {
              stopped.set(name, Cause.squash(exit.cause));
            }
            net.send(
              [...seats.keys()].filter((other) => other !== name),
              seat.outgoing()
            );
          }
        }
        return {
          stopped,
          ticks: Array.from(seats.values(), (seat) => seat.app.time.tick),
          confirmed: Array.from(seats.values(), (seat) => seat.confirmed),
        };
      })
    )
  );

/** How each peer of these tests is made, unless it is told otherwise. */
const alike = {
  seed: 5,
  peers: ["ada", "grace"],
  delta: DELTA,
  ahead: 0,
} as const;

const unlike = (failure: unknown): Drift.Unlike => {
  assert(failure instanceof Drift.Unlike, `${String(failure)} is not Unlike`);
  return failure;
};

describe("peers that were not made alike", () => {
  it("stop before either runs a tick when one ticks another delta, and say which", () => {
    const { stopped, ticks } = madeApart([
      ["ada", Session.make(CoinGame, { ...alike, peer: "ada" })],
      [
        "grace",
        Session.make(CoinGame, { ...alike, peer: "grace", delta: 1 / 60 }),
      ],
    ]);
    const found = unlike(stopped.get("ada"));
    expect(found).toEqual(
      new Drift.Unlike({
        peer: "ada",
        other: "grace",
        mine: {
          game: found.mine.game,
          delta: DELTA,
          peers: ["ada", "grace"],
          start: 0,
        },
        theirs: {
          game: found.mine.game,
          delta: 1 / 60,
          peers: ["ada", "grace"],
          start: 0,
        },
        differ: ["delta"],
      })
    );
    expect(found.message).toBe(
      `The peers "ada" and "grace" were not made alike: "ada" ticks ${DELTA} seconds at a time and "grace" ${1 / 60}. Give every peer the same delta.`
    );
    expect(unlike(stopped.get("grace")).other).toBe("ada");
    expect(ticks).toEqual([0, 0]);
  });

  it("stop, every one of them, when one was given names that leave a peer out", () => {
    const three = ["ada", "edsger", "grace"];
    const { stopped, ticks } = madeApart([
      ["ada", Session.make(CoinGame, { ...alike, peer: "ada", peers: three })],
      [
        "edsger",
        Session.make(CoinGame, { ...alike, peer: "edsger", peers: three }),
      ],
      // Grace never hears edsger, and would wait for nobody.
      ["grace", Session.make(CoinGame, { ...alike, peer: "grace" })],
    ]);
    expect(stopped.size).toBe(3);
    for (const failure of stopped.values()) {
      expect(unlike(failure).differ).toEqual(["peers"]);
    }
    expect(unlike(stopped.get("grace")).message).toMatch(
      /"grace" plays with ada and grace, and "(ada|edsger)" with ada, edsger and grace\. Give every peer the same names\./u
    );
    expect(ticks).toEqual([0, 0, 0]);
  });

  it("stop, when a stranger that counts this peer among its own speaks to it", () => {
    const { stopped } = madeApart(
      [
        ["ada", Session.make(CoinGame, { ...alike, peer: "ada" })],
        [
          "mallory",
          Session.make(CoinGame, {
            ...alike,
            peer: "mallory",
            peers: ["ada", "mallory"],
          }),
        ],
      ],
      20
    );
    const found = unlike(stopped.get("ada"));
    expect([found.other, found.differ]).toEqual(["mallory", ["peers"]]);
  });

  it("stop, where they would have waited for each other for ever, when they begin at other ticks", () => {
    const saved = withApp(game(), (going) => {
      for (let i = 0; i < 9; i++) {
        going.tick(DELTA);
      }
      const save = going.save();
      assert(Exit.isSuccess(save));
      return save.value;
    });
    for (const ahead of [0, 8]) {
      const { stopped, ticks, confirmed } = madeApart([
        ["ada", Session.make(CoinGame, { ...alike, peer: "ada", ahead })],
        [
          "grace",
          Session.make(CoinGame, {
            save: saved,
            peer: "grace",
            peers: alike.peers,
            delta: DELTA,
            ahead,
          }),
        ],
      ]);
      for (const failure of stopped.values()) {
        expect(unlike(failure).differ).toEqual(["start"]);
      }
      expect(stopped.size).toBe(2);
      expect(unlike(stopped.get("ada")).message).toMatch(
        /"ada" begins at tick 0 and "grace" at tick 9\. Give every peer the same seed or save\./u
      );
      // No tick either is sure of has run.
      expect(confirmed).toEqual([0, 9]);
      expect(ticks[1]! - 9).toBeLessThanOrEqual(ahead);
    }
  });

  it("stop when they play another game, and not when one only draws it", () => {
    const handlers = [drop, take, tip, fire, mint, whisper] as const;
    const grace = { ...alike, peer: "grace" };
    const others = [
      Session.make(
        App.define({
          systems: [Tally, Wander, Fault, Controls, Hear] as const,
          handlers,
        }),
        grace
      ),
      Session.make(
        App.define({
          systems: [Fault, Bot, Wander, Tally, Controls, Hear] as const,
          handlers,
        }),
        grace
      ),
      Session.make(
        App.define({
          systems: CoinGame.systems,
          handlers: [take, tip, fire, mint, whisper] as const,
        }),
        grace
      ),
      Session.make(
        App.define({ systems: CoinGame.systems, handlers, version: 1 }),
        grace
      ),
    ];
    for (const other of others) {
      const { stopped } = madeApart([
        ["ada", Session.make(CoinGame, { ...alike, peer: "ada" })],
        ["grace", other],
      ]);
      expect(stopped.size).toBe(2);
      expect(unlike(stopped.get("ada")).differ).toEqual(["game"]);
      expect(unlike(stopped.get("grace")).message).toMatch(
        /they play another game: a system of the tick, a hook of a state or a handler that one has and the other hasn't/u
      );
    }
    // What a peer draws, plays or reads from its devices is its own.
    const Paint = System.make("ls/Paint", function* () {}).pipe(
      System.inStage("frame")
    );
    const Listen = System.make("ls/Listen", function* () {}).pipe(
      System.inStage("input")
    );
    const drawn = App.define({
      systems: [...CoinGame.systems, Paint, Listen] as const,
      handlers,
    });
    const { stopped, ticks } = madeApart([
      ["ada", Session.make(CoinGame, { ...alike, peer: "ada" })],
      ["grace", Session.make(drawn, { ...alike, peer: "grace" })],
    ]);
    expect(stopped.size).toBe(0);
    expect(ticks[0]).toBeGreaterThan(20);
  });
});

describe("a message between peers", () => {
  it("goes to text and comes back", () => {
    const message: Message.Message = {
      from: "ada",
      tick: 12,
      actions: [{ name: "ls/Drop", payload: { by: "ada", value: 1 } }],
    };
    expect(Message.decode(Message.encode(message))).toEqual(
      Exit.succeed(message)
    );
    const checked: Message.Message = {
      ...message,
      checkpoints: [
        { tick: 10, hash: 0 },
        { tick: 12, hash: 4_294_967_295 },
      ],
    };
    expect(Message.decode(Message.encode(checked))).toEqual(
      Exit.succeed(checked)
    );
    const first: Message.Message = {
      ...message,
      made: { game: 4_294_967_295, delta: 1 / 60, peers: ["ada"], start: 3 },
    };
    expect(Message.decode(Message.encode(first))).toEqual(Exit.succeed(first));
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
      JSON.stringify({ from: "ada", tick: 1, actions: [], checkpoints: 3 }),
      ...[-1, 4_294_967_296, 0.5].map((hash) =>
        JSON.stringify({
          from: "ada",
          tick: 1,
          actions: [],
          checkpoints: [{ tick: 0, hash }],
        })
      ),
      JSON.stringify({
        from: "ada",
        tick: 1,
        actions: [],
        checkpoints: [{ tick: -1, hash: 1 }],
      }),
      JSON.stringify({ from: "ada", tick: 0, actions: [], made: 1 }),
      JSON.stringify({
        from: "ada",
        tick: 0,
        actions: [],
        made: { game: 1, delta: "1/60", peers: ["ada"], start: 0 },
      }),
    ]) {
      expect(Exit.isFailure(Message.decode(text)), text).toBe(true);
    }
  });
});
