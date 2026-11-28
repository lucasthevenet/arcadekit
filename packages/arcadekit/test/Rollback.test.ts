import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  Event,
  Field,
  Plugin,
  Query,
  Replay,
  Save,
  Singleton,
  System,
  Time,
  World,
} from "../src/index.ts";
import type { Entity, JsonValue } from "../src/index.ts";
import { Drift, Session } from "../src/net/index.ts";
import { thrown, unwrap } from "./checks.ts";
import {
  Coin,
  CoinGame,
  Drop,
  HZ,
  Purse,
  Take,
  Whisper,
  catchUp,
  coinsOf,
  moves,
  network,
  players,
  round,
  setGlitch,
  untilStopped,
  withApp,
  withPeers,
} from "./peers.ts";
import type { Network, Peer } from "./peers.ts";

/** Runs `use` with what `make` makes: a session. */
const withMade = <T, A, E2 = never>(
  make: Effect.Effect<T, never>,
  use: (made: T) => Effect.Effect<A, E2>
) => Effect.flatMap(make, use);

/**
 * Lets a game come to rest: rounds in which nobody issues anything, long
 * enough for every message that had something to say to arrive, and then
 * every peer brought to the same tick. Returns that tick.
 */
const settle = Effect.fnUntraced(function* (
  peers: readonly Peer[],
  net: Network,
  lag: number
) {
  for (let i = 0; i < 3 * lag + 12; i++) {
    yield* round(peers, net);
  }
  return yield* catchUp(peers, net);
});

describe("a rollback session", () => {
  afterEach(() => {
    setGlitch(undefined);
  });

  it.effect(
    "has a player's own move in the very next tick, whatever the network takes",
    () =>
      withPeers(["ada", "grace"], { ahead: 10 }, (peers) =>
        Effect.gen(function* () {
          const net = network(3, { min: 4, max: 6 });
          const [ada, grace] = peers as [Peer, Peer];
          for (let i = 0; i < 5; i++) {
            yield* round(peers, net);
          }
          // Nobody waited: a tick a round, with messages four rounds away.
          expect(ada.app.time.tick).toBe(5);
          expect(grace.app.time.tick).toBe(5);
          yield* ada.app.enqueue(Drop, { by: "ada", value: 9 });
          yield* round(peers, net);
          // It is in ada's world, applied on the tick it was issued for.
          const move = {
            tick: 5,
            name: "ls/Drop",
            payload: { by: "ada", value: 9 },
            from: "ada",
            queued: true,
          };
          expect(moves(ada.app.actionLog).at(-1)).toEqual(move);
          const coin = (yield* coinsOf(ada)).at(-1)!;
          expect(ada.world.get(coin, Coin)?.value).toBe(9);
          // Grace has run that tick too, and has not heard of it.
          expect(grace.app.time.tick).toBe(6);
          expect(moves(grace.app.actionLog)).not.toContainEqual(move);
          const before = grace.session.stats.rewinds;
          yield* settle(peers, net, 6);
          // When she hears, it is put where it belongs: on tick 5, not on the
          // tick the message arrived in.
          expect(moves(grace.app.actionLog)).toContainEqual(move);
          expect(grace.session.stats.rewinds).toBeGreaterThan(before);
          expect(grace.world.hash()).toBe(ada.world.hash());
        })
      )
  );

  // Four games of a fixed number of rounds, which wait on nothing the test
  // does not hand over itself. The limit is there to end a hang, not to time
  // the games, which take over a minute on a busy machine.
  it.effect(
    "ends hash-equal with the other peers, and with a game of one that was given the same actions",
    () =>
      Effect.gen(function* () {
        for (const [seed, lag, ahead, delay] of [
          [1, { min: 0, max: 3 }, 8, 0],
          [2, { min: 2, max: 7 }, 12, 0],
          [3, { min: 1, max: 5 }, 8, 1],
          [4, { min: 0, max: 0 }, 4, 0],
        ] as const) {
          const where = `seed ${seed}`;
          yield* withPeers(["ada", "grace"], { ahead, delay }, (peers) =>
            Effect.gen(function* () {
              const net = network(seed, lag);
              const act = players(seed + 200);
              for (let i = 0; i < 300; i++) {
                for (const peer of peers) {
                  yield* act(peer);
                }
                yield* round(peers, net);
              }
              const [ada, grace] = peers as [Peer, Peer];
              const ticks = yield* settle(peers, net, lag.max);
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
              const purse = ada.world.singleton(Purse);
              expect(purse.taken, where).toBeGreaterThan(0);
              expect(purse.tallied, where).toBeGreaterThan(0);
              expect(purse.born, where).toBeGreaterThan(40);
              // Over a network that takes no time, the peer that runs first in a
              // round hears of the other's moves late, and the other on time.
              expect(
                [
                  ada.session.stats.rewinds > 5,
                  grace.session.stats.rewinds > 5,
                ],
                where
              ).toEqual(lag.max > 0 ? [true, true] : [true, false]);
              expect(
                ada.session.stats.resimulated,
                where
              ).toBeGreaterThanOrEqual(ada.session.stats.rewinds);
              // What it keeps to go back to is what it is not sure of, however
              // long the game has gone on; at rest, with everything said, that
              // is next to nothing.
              expect(ada.session.stats.kept, where).toBeLessThanOrEqual(ahead);
              expect(ada.session.stats.kept, where).toBeLessThanOrEqual(
                lag.max + 1
              );
              // The same game on both.
              expect(ada.world.hash(), where).toBe(grace.world.hash());
              expect(ada.app.actionLog, where).toEqual(grace.app.actionLog);
              expect(ada.session.drifted, where).toBeUndefined();
              expect(grace.session.drifted, where).toBeUndefined();
              // And the game a single app plays when it is given those actions
              // on those ticks and never goes back: the replay holds every
              // tick's hash against the log's, and ends on the same one.
              const played = yield* Replay.record(ada.app);
              yield* withApp(
                Replay.verify(played, CoinGame, { hashEvery: 1 }),
                (_, alone) =>
                  Effect.gen(function* () {
                    expect(alone.hash(), where).toBe(ada.world.hash());
                    expect({ ...alone.singleton(Purse) }, where).toEqual({
                      ...purse,
                    });
                  })
              );
            })
          );
        }
      }),
    { timeout: 600_000 }
  );

  it.effect(
    "records since a save of a final tick after it went back, and not since a save a rollback went back past",
    () =>
      withPeers(["ada", "grace"], { ahead: 8 }, ([ada, grace]) =>
        Effect.gen(function* () {
          const net = network(3, { min: 3, max: 3 });
          const act = players(4);
          const play = Effect.fnUntraced(function* (rounds: number) {
            for (let i = 0; i < rounds; i++) {
              yield* act(grace!);
              yield* round([ada!, grace!], net);
            }
          });
          // A whisper changes nothing in the game. It comes to ada after a
          // save of a tick past it: ada goes back, runs the ticks again to
          // the same game, and the save dies all the same.
          for (let i = 0; i < 16; i++) {
            if (i === 14) {
              yield* grace!.app.enqueue(Whisper, { to: "ada" });
            }
            yield* round([ada!, grace!], net);
          }
          expect(ada!.session.confirmed).toBeLessThan(ada!.app.time.tick);
          const guessed = unwrap(yield* Effect.exit(Save.make(ada!.app)));
          const rewinds = ada!.session.stats.rewinds;
          yield* settle([ada!, grace!], net, 3);
          expect(ada!.session.stats.rewinds).toBe(rewinds + 1);
          expect(yield* thrown(Replay.record(ada!.app, guessed))).toThrow(
            /its log no longer reaches/
          );

          // Grace runs ahead while ada waits, and ada then hears all she
          // said up to its own next tick: every tick ada has run is final.
          for (let i = 0; i < 6; i++) {
            yield* round([ada!, grace!], net, [grace!]);
          }
          yield* round([ada!, grace!], net, [ada!]);
          expect(ada!.session.confirmed).toBe(ada!.app.time.tick);
          const final = unwrap(yield* Effect.exit(Save.make(ada!.app)));
          // Ada runs ahead in turn, and grace's moves come to it late.
          for (let i = 0; i < 12; i++) {
            yield* round([ada!, grace!], net, [ada!]);
          }
          const after = ada!.session.stats.rewinds;
          yield* play(20);
          yield* settle([ada!, grace!], net, 3);
          expect(ada!.session.stats.rewinds).toBeGreaterThan(after);
          yield* withApp(
            Replay.verify(yield* Replay.record(ada!.app, final), CoinGame, {
              hashEvery: 1,
            }),
            (_, alone) =>
              Effect.sync(() => {
                expect(alone.hash()).toBe(ada!.world.hash());
              })
          );
        })
      )
  );

  it.effect("keeps three peers the same game", () =>
    withPeers(["ada", "grace", "edsger"], { ahead: 10 }, (peers) =>
      Effect.gen(function* () {
        const net = network(9, { min: 0, max: 6 });
        const act = players(10);
        for (let i = 0; i < 200; i++) {
          yield* act(peers[0]!);
          yield* act(peers[1]!);
          yield* round(peers, net);
        }
        const ticks = yield* settle(peers, net, 6);
        const [first, ...others] = peers as [Peer, Peer, Peer];
        for (const other of others) {
          expect(other.world.hash()).toBe(first.world.hash());
          expect(other.app.actionLog).toEqual(first.app.actionLog);
          expect(other.session.drifted).toBeUndefined();
        }
        expect(first.session.stats.rewinds).toBeGreaterThan(5);
        const recording = yield* Replay.record(first.app);
        expect(recording.end).toBe(ticks);
        yield* withApp(
          Replay.verify(recording, CoinGame, { hashEvery: 1 }),
          (_, alone) =>
            Effect.gen(function* () {
              expect(alone.hash()).toBe(first.world.hash());
            })
        );
      })
    )
  );

  it.effect(
    "runs a tick every round where a lockstep session under the same network waits",
    () =>
      Effect.gen(function* () {
        const ticksAfter = Effect.fnUntraced(function* (
          ahead: number | undefined
        ) {
          return yield* withPeers(
            ["ada", "grace"],
            ahead === undefined ? {} : { ahead },
            (peers) =>
              Effect.gen(function* () {
                const net = network(5, { min: 3, max: 6 });
                const act = players(6);
                for (let i = 0; i < 120; i++) {
                  yield* act(peers[0]!);
                  yield* round(peers, net);
                }
                return peers[0]!.app.time.tick;
              })
          );
        });
        expect(yield* ticksAfter(10)).toBe(120);
        expect(yield* ticksAfter(undefined)).toBeLessThan(80);
      })
  );

  it.effect("goes back only for a message that had something to say", () =>
    withPeers(["ada", "grace"], { ahead: 10 }, (peers) =>
      Effect.gen(function* () {
        const net = network(7, { min: 2, max: 5 });
        const [ada, grace] = peers as [Peer, Peer];
        for (let i = 0; i < 60; i++) {
          yield* round(peers, net);
        }
        // Sixty ticks ahead of the network, every one predicted right.
        expect(ada.app.time.tick).toBe(60);
        expect(ada.session.stats.rewinds).toBe(0);
        expect(grace.session.stats.resimulated).toBe(0);
        yield* ada.app.enqueue(Drop, { by: "ada", value: 1 });
        for (let i = 0; i < 20; i++) {
          yield* round(peers, net);
        }
        // One move: grace went back once, and ada, who made it, never.
        expect(grace.session.stats.rewinds).toBe(1);
        expect(grace.session.stats.resimulated).toBeGreaterThanOrEqual(2);
        expect(grace.session.stats.resimulated).toBeLessThanOrEqual(6);
        expect(ada.session.stats.rewinds).toBe(0);
      })
    )
  );

  it.effect(
    "counts as final only the ticks it has run with everything that was said",
    () =>
      withPeers(["ada", "grace"], { ahead: 10 }, (peers) =>
        Effect.gen(function* () {
          const [ada] = peers as [Peer];
          for (let i = 0; i < 5; i++) {
            yield* ada.session.tick();
          }
          expect(ada.session.confirmed).toBe(0);
          expect(ada.session.stats.kept).toBe(5);
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
          expect(ada.session.stats.rewinds).toBe(0);
          yield* ada.session.tick();
          expect(ada.session.stats.rewinds).toBe(1);
          expect(ada.session.stats.resimulated).toBe(3);
          expect(ada.session.confirmed).toBe(5);
          expect(ada.app.time.tick).toBe(6);
          // Sure of every tick but the one it has just run.
          expect(ada.session.stats.kept).toBe(1);
          expect(moves(ada.app.actionLog)).toEqual([
            {
              tick: 2,
              name: "ls/Drop",
              payload: { by: "grace", value: 2 },
              from: "grace",
              queued: true,
            },
          ]);
        })
      )
  );

  it.effect(
    "has the frame stage hear each event once, though a rewind runs its tick again",
    () =>
      Effect.gen(function* () {
        const Rang = Event.define(
          "rb/Rang",
          Schema.Struct({ by: Schema.String })
        );
        const Ring = Action.define("rb/Ring", { payload: Schema.Struct({}) });
        const ring = Action.handler(Ring, function* (_, { from }) {
          (yield* Event.Emitter(Rang)).emit({ by: from ?? "" });
        });
        const heard: string[] = [];
        const Listen = System.frame("rb/Listen", function* () {
          heard.push(
            ...(yield* Event.Reader(Rang)).read().map((rang) => rang.by)
          );
        });
        const Ringing = App.define({ systems: [Listen], handlers: [ring] });
        yield* withMade(
          Session.make(Ringing, {
            me: "ada",
            others: ["grace"],
            hz: HZ,
            ahead: 8,
          }),
          (ada) =>
            Effect.gen(function* () {
              expect(yield* ada.tick()).toBe(true);
              yield* ada.frame(0);
              yield* ada.app.enqueue(Ring, {});
              expect(yield* ada.tick()).toBe(true);
              yield* ada.frame(0);
              expect(heard).toEqual(["ada"]);
              // Grace rang on the first tick: ada goes back, and runs ada's ring
              // again after grace's.
              ada.receive({
                from: "grace",
                tick: 0,
                actions: [{ name: "rb/Ring", payload: {} }],
              });
              ada.receive({ from: "grace", tick: 1, actions: [] });
              expect(yield* ada.tick()).toBe(true);
              yield* ada.frame(0);
              expect(ada.stats.rewinds).toBe(1);
              expect(heard).toEqual(["ada", "grace"]);
            })
        );
      })
  );

  it.effect("captures the game only before a tick it is not sure of", () =>
    Effect.gen(function* () {
      // A session of its own each time it is asked for, no tick run yet.
      const counted = Effect.map(
        Session.make(CoinGame, {
          seed: 5,
          hashEvery: 1,
          me: "ada",
          others: ["grace"],
          hz: HZ,
        }),
        (session) => session
      );
      // Grace says everything before ada runs: ada is sure of every tick.
      const sure = yield* counted;
      const start = sure.peers.length;
      expect(start).toBe(2);
      for (let tick = 0; tick < 20; tick++) {
        sure.receive({ from: "grace", tick, actions: [] });
        expect(yield* sure.tick()).toBe(true);
        expect(sure.stats.kept).toBe(0);
      }
      expect(sure.confirmed).toBe(20);
      // Grace says nothing: every tick is a guess, and is captured.
      const unsure = yield* counted;
      for (let tick = 0; tick < 5; tick++) {
        expect(yield* unsure.tick()).toBe(true);
        expect(unsure.stats.kept).toBe(tick + 1);
      }
      expect(unsure.confirmed).toBe(0);
    })
  );

  it.effect("waits once it is as far ahead of the peers as it may be", () =>
    withPeers(["ada", "grace"], { ahead: 3 }, (peers) =>
      Effect.gen(function* () {
        const [ada, grace] = peers as [Peer, Peer];
        expect(ada.session.ahead).toBe(3);
        expect(ada.session.delay).toBe(0);
        for (let i = 0; i < 3; i++) {
          expect(ada.session.waitingFor).toEqual([]);
          expect(yield* ada.session.tick()).toBe(true);
        }
        // Three ticks past what grace has said, which is nothing.
        expect(ada.session.waitingFor).toEqual(["grace"]);
        expect(yield* ada.session.tick()).toBe(false);
        expect(ada.app.time.tick).toBe(3);
        expect(ada.session.confirmed).toBe(0);
        yield* grace.session.tick();
        for (const message of grace.session.outgoing()) {
          ada.session.receive(message);
        }
        // Grace has said tick 0: one more may run.
        expect(ada.session.confirmed).toBe(1);
        expect(yield* ada.session.tick()).toBe(true);
        expect(yield* ada.session.tick()).toBe(false);
        expect(ada.app.time.tick).toBe(4);
      })
    )
  );

  it.effect(
    "runs eight ticks ahead unless told, and none with a delay of its own",
    () =>
      Effect.gen(function* () {
        yield* withMade(
          Session.make(CoinGame, {
            seed: 5,
            hashEvery: 1,
            me: "ada",
            others: ["grace"],
            hz: HZ,
          }),
          (session) =>
            Effect.gen(function* () {
              expect(session.ahead).toBe(8);
              expect(session.delay).toBe(0);
              let ran = 0;
              while (yield* session.tick()) {
                ran++;
              }
              expect(ran).toBe(8);
            })
        );
        for (const ahead of [-1, 1.5, Number.NaN]) {
          expect(
            yield* thrown(
              withMade(
                Session.make(CoinGame, {
                  seed: 5,
                  hashEvery: 1,
                  me: "ada",
                  others: [],
                  hz: HZ,
                  ahead,
                }),
                (session) => Effect.sync(() => session)
              )
            )
          ).toThrow(/runs ahead is a whole number of ticks, 0 or more/u);
        }
      })
  );

  it.effect("is a lockstep session when it runs no tick ahead", () =>
    withPeers(["ada", "grace"], { ahead: 0, delay: 1 }, (peers) =>
      Effect.gen(function* () {
        const net = network(2, { min: 1, max: 4 });
        const act = players(3);
        for (let i = 0; i < 150; i++) {
          yield* act(peers[0]!);
          yield* act(peers[1]!);
          yield* round(peers, net);
        }
        yield* catchUp(peers, net);
        const [ada, grace] = peers as [Peer, Peer];
        expect(ada.session.stats.rewinds).toBe(0);
        expect(ada.session.confirmed).toBe(ada.app.time.tick);
        expect(ada.app.time.tick).toBeGreaterThan(20);
        expect(ada.app.time.tick).toBeLessThan(140);
        expect(ada.hashes).toEqual(grace.hashes);
      })
    )
  );

  it.effect(
    "puts a peer's two moves for one tick, and two peers' for one tick, in the order every peer has them",
    () =>
      withPeers(["ada", "grace"], { ahead: 10 }, (peers) =>
        Effect.gen(function* () {
          const net = network(4, { min: 3, max: 5 });
          const [ada, grace] = peers as [Peer, Peer];
          yield* round(peers, net);
          // All for the tick that runs next, on each peer before it hears the other.
          yield* grace.app.enqueue(Drop, { by: "grace", value: 1 });
          yield* grace.app.enqueue(Drop, { by: "grace", value: 2 });
          yield* ada.app.enqueue(Drop, { by: "ada", value: 3 });
          yield* settle(peers, net, 5);
          const order = (peer: Peer) =>
            moves(peer.app.actionLog).map(
              (entry) => (entry.payload as { value: number }).value
            );
          expect(order(ada)).toEqual([3, 1, 2]);
          expect(order(grace)).toEqual([3, 1, 2]);
          expect(ada.world.hash()).toBe(grace.world.hash());
        })
      )
  );

  it.effect(
    "refuses the same move on every peer, though one of them had first seen it accepted",
    () =>
      withPeers(["ada", "grace"], { ahead: 10 }, (peers) =>
        Effect.gen(function* () {
          const net = network(4, { min: 3, max: 5 });
          const [ada, grace] = peers as [Peer, Peer];
          yield* ada.app.enqueue(Drop, { by: "ada", value: 5 });
          yield* settle(peers, net, 5);
          const coin = (yield* coinsOf(grace))[0]!;
          // The first of them: the bot has dropped others since.
          expect(yield* coinsOf(ada)).toEqual(yield* coinsOf(grace));
          expect(ada.world.get(coin, Coin)?.value).toBe(5);
          // Both go for it on the same tick. Each sees itself take it.
          yield* ada.app.enqueue(Take, { by: "ada", coin });
          yield* grace.app.enqueue(Take, { by: "grace", coin });
          yield* round(peers, net);
          expect(ada.world.singleton(Purse).ada).toBe(5);
          expect(grace.world.singleton(Purse).grace).toBe(5);
          yield* settle(peers, net, 5);
          // Ada's name comes first: hers stands on both, and grace's is taken back.
          for (const peer of peers) {
            const purse = peer.world.singleton(Purse);
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
        })
      )
  );

  it.effect(
    "catches peers that have come apart, within hashEvery - 1 + delay + twice how far it runs ahead",
    () =>
      Effect.gen(function* () {
        const at = 23;
        for (const [every, delay, ahead, lag] of [
          [1, 0, 6, { min: 0, max: 4 }],
          [4, 1, 3, { min: 1, max: 6 }],
          [10, 0, 8, { min: 0, max: 0 }],
          [1, 2, 2, { min: 3, max: 9 }],
        ] as const) {
          const where = `hashEvery ${every}, delay ${delay}, ahead ${ahead}`;
          yield* withPeers(
            ["ada", "grace"],
            { ahead, delay, hashEvery: { ada: every, grace: every } },
            (peers) =>
              Effect.gen(function* () {
                setGlitch({ tick: at, apps: "all" });
                const net = network(every + delay + ahead, lag);
                yield* peers[0]!.app.enqueue(Drop, { by: "ada", value: 3 });
                const stopped = yield* untilStopped(peers, net, 800);
                const hashCheck = Math.ceil(at / every) * every;
                for (const peer of peers) {
                  const drifted = stopped.get(peer.name) as Drift.Drifted;
                  expect(drifted, where).toBeInstanceOf(Drift.Drifted);
                  expect(drifted.tick, where).toBe(hashCheck);
                  expect(drifted.agreedAt, where).toBe(hashCheck - every);
                  expect(drifted.hashes.ada, where).not.toBe(
                    drifted.hashes.grace
                  );
                  expect(peer.app.time.tick, where).toBeLessThanOrEqual(
                    at + every - 1 + delay + 2 * ahead
                  );
                }
              })
          );
        }
      })
  );

  it.effect(
    "fails a tick it cannot be sure of when the game cannot be captured",
    () =>
      Effect.gen(function* () {
        const Holder = Component.define("rb/Holder", {
          thing: Field.json<JsonValue>(null),
        });
        const Spoil = System.tick("rb/Spoil", function* () {
          if ((yield* Time).tick === 2) {
            (yield* Query.View(
              Query.all(Holder).pipe(Query.writes(Holder))
            )).each((holder) => {
              // Not plain data: no snapshot can hold it.
              // @ts-expect-error A function is not JSON.
              holder.thing = () => 1;
            });
          }
        });
        const Hold = Plugin.make("rb/Hold", {
          setup: Effect.map(Commands.spawns(Holder), (commands) => {
            commands.spawn(Holder.of({ thing: "fine" }));
          }),
        });
        yield* withMade(
          Session.make(App.define({ plugins: [Hold], systems: [Spoil] }), {
            me: "ada",
            others: ["grace"],
            hz: HZ,
          }),
          (session) =>
            Effect.gen(function* () {
              const { app } = session;
              expect(yield* Effect.exit(session.tick())).toEqual(
                Exit.succeed(true)
              );
              expect(yield* Effect.exit(session.tick())).toEqual(
                Exit.succeed(true)
              );
              const exit = yield* Effect.exit(session.tick());
              expect(Exit.isFailure(exit)).toBe(true);
              const refused = Exit.isFailure(exit) ? exit.cause : undefined;
              expect(String(refused)).toMatch(/rb\/Holder/u);
              expect(yield* thrown(session.tick())).toThrow(Save.Refused);
              // The tick did not run.
              expect(app.time.tick).toBe(2);
            })
        );
      })
  );

  it.effect(
    "has what draws visit only what the ticks given up and the ticks run again changed",
    () =>
      Effect.gen(function* () {
        const Dot = Component.define("rb/Dot", { x: Field.f32 });
        const Dots = Query.all(Dot);
        const Halted = Singleton.define(
          "rb/Halted",
          { on: Field.i32 },
          { on: 0 }
        );
        const Halt = Action.define("rb/Halt", { payload: Schema.Struct({}) });
        const halt = Action.handler(Halt, function* () {
          (yield* Singleton.Write(Halted)).on = 1;
        });
        const Lay = Plugin.make("rb/Lay", {
          setup: Effect.map(Commands.spawns(Dot), (commands) => {
            for (let x = 0; x < 10; x++) {
              commands.spawn(Dot.of({ x }));
            }
          }),
        });
        // On tick 3, a game that was not halted spawns a dot, despawns one and
        // moves another; one that was halted moves a third.
        const Play = System.tick("rb/Play", function* () {
          if ((yield* Time).tick !== 3) {
            return;
          }
          const dots = (yield* Query.View(Dots)).entities();
          const world = yield* World.writes(Dot);
          if ((yield* Singleton.Read(Halted)).on === 1) {
            world.set(dots[5]!, Dot, { x: 50 });
            return;
          }
          (yield* Commands.spawns(Dot)).spawn(Dot.of({ x: 10 }));
          (yield* Commands).despawn(dots[1]!);
          world.set(dots[2]!, Dot, { x: 20 });
        });
        const Changed = Query.all(Dot).pipe(Query.changed(Dot));
        const Added = Query.all(Dot).pipe(Query.added(Dot));
        const drawn: { changed: Entity[]; added: Entity[] }[] = [];
        const Draw = System.frame("rb/Draw", function* () {
          drawn.push({
            changed: (yield* Query.View(Changed)).entities(),
            added: (yield* Query.View(Added)).entities(),
          });
        });
        yield* withMade(
          Session.make(
            App.define({
              plugins: [Lay],
              systems: [Play, Draw],
              handlers: [halt],
            }),
            { me: "ada", others: ["grace"], hz: HZ, ahead: 10 }
          ),
          (session) =>
            Effect.gen(function* () {
              const { app } = session;
              const dots = (yield* app.read(Query.View(Dots))).entities();
              // Ahead of grace, who has said nothing: every tick is a guess.
              for (let tick = 0; tick < 5; tick++) {
                yield* session.tick();
                yield* app.frame(0);
              }
              expect(drawn.map(({ changed }) => changed.length)).toEqual([
                10, 0, 2, 0, 0,
              ]);
              // Grace halted the game on tick 2: ada goes back there, and runs
              // ticks 2 to 4 again, and then tick 5.
              for (let tick = 0; tick < 5; tick++) {
                session.receive({
                  from: "grace",
                  tick,
                  actions: tick === 2 ? [{ name: "rb/Halt", payload: {} }] : [],
                });
              }
              drawn.length = 0;
              yield* session.tick();
              yield* app.frame(0);
              expect(session.stats.rewinds).toBe(1);
              // The dot moved in the future given up and the one moved in the ticks
              // run again changed, and the despawned one is back: the dot spawned
              // in the future given up is no more.
              expect(drawn).toEqual([
                { changed: [dots[1], dots[2], dots[5]], added: [dots[1]] },
              ]);
            })
        );
      })
  );
});
