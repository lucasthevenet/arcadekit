import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Random, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Driver, Input, World } from "../src/index.ts";
import type { Action } from "../src/index.ts";
import { Drift, Lobby, Session, Transport } from "../src/net/index.ts";
import { thrown } from "./checks.ts";
import { CoinGame, DELTA, HZ, moves, players } from "./peers.ts";

const Settings = Schema.Struct({ map: Schema.String });

/** A peer of the room, in the lobby of the hub's network. */
const joined = (hub: Transport.Hub, me: string, count: number) =>
  Lobby.join({ me, players: count, settings: Settings }).pipe(
    Effect.provide(Transport.layer(hub.port(me)))
  );

/** Lets the lobbies read what arrived, a step of the network at a time. */
const wait = Effect.fnUntraced(function* (hub: Transport.Hub, steps = 10) {
  for (let i = 0; i < steps; i++) {
    hub.step();
    yield* TestClock.adjust("20 millis");
  }
});

/** Plays the started peers to rest, and returns each world's hash. */
const play = Effect.fnUntraced(function* (
  hub: Transport.Hub,
  lobbies: readonly Lobby.Lobby<typeof Settings.Type>[],
  starts: readonly Lobby.Start<typeof Settings.Type>[]
) {
  const seats = [];
  for (const [at, lobby] of lobbies.entries()) {
    const session = yield* Session.make(CoinGame, {
      ...starts[at]!,
      hashEvery: 1,
      hz: HZ,
    }).pipe(Effect.provide(Input.layer(Input.makeManualSource())));
    const connected = yield* Effect.acquireRelease(
      lobby.connect(session),
      (made) => made.close
    );
    seats.push({
      name: lobby.me,
      app: session.app,
      session,
      connected,
      world: yield* session.app.read(World),
      hashes: [],
      source: Input.makeManualSource(),
    });
  }
  const act = players(29);
  const steps = seats.map((seat) => Driver.fixedStep(seat.connected));
  for (let i = 0; i < 120; i++) {
    hub.step();
    for (const [at, seat] of seats.entries()) {
      if (i < 80) {
        yield* act(seat);
      }
      yield* steps[at]!(DELTA);
    }
  }
  for (
    let i = 0;
    i < 100 && new Set(seats.map((seat) => seat.app.time.tick)).size > 1;
    i++
  ) {
    hub.step();
    const furthest = Math.max(...seats.map((seat) => seat.app.time.tick));
    for (const seat of seats) {
      if (seat.app.time.tick < furthest) {
        yield* seat.connected.tick();
      }
    }
  }
  return seats.map((seat) => ({
    tick: seat.app.time.tick,
    hash: seat.world.hash(),
    log: seat.app.actionLog,
    drifted: seat.session.drifted,
  }));
});

/** Checks that peers played to the same game, with moves in it. */
const expectOneGame = (
  ended: readonly {
    readonly tick: number;
    readonly hash: number;
    readonly log: readonly Action.LogEntry[];
    readonly drifted: unknown;
  }[]
): void => {
  const [first] = ended;
  expect(first!.tick).toBeGreaterThan(60);
  expect(moves(first!.log).length).toBeGreaterThan(10);
  for (const peer of ended) {
    expect(peer).toEqual({ ...first, drifted: undefined });
  }
};

describe("a lobby", () => {
  it.effect(
    "has two peers agree on settings, seats and a seed none of them chose, and play the same game",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = Transport.makeHub({ delay: { min: 0, max: 2 }, seed: 4 });
          const ada = yield* joined(hub, "ada", 2);
          const grace = yield* joined(hub, "grace", 2);
          const starting = [
            yield* Effect.forkChild(ada.start),
            yield* Effect.forkChild(grace.start),
          ];
          yield* wait(hub);
          expect(grace.members).toEqual(["ada", "grace"]);
          // Nobody has set the settings: nobody can begin.
          yield* ada.ready();
          yield* grace.ready();
          yield* wait(hub);
          expect(grace.settings).toBeUndefined();
          yield* ada.set({ map: "dunes" });
          yield* wait(hub);
          // A change of the settings takes back every peer's word.
          expect(grace.settings).toEqual({ map: "dunes" });
          expect(grace.waitingFor).toEqual(["ada", "grace"]);
          yield* grace.ready();
          yield* wait(hub);
          expect(ada.waitingFor).toEqual(["ada"]);
          yield* ada.ready();
          yield* wait(hub);
          const starts = [];
          for (const fiber of starting) {
            starts.push(yield* Fiber.join(fiber));
          }
          const [one, two] = starts as [
            Lobby.Start<typeof Settings.Type>,
            Lobby.Start<typeof Settings.Type>,
          ];
          expect(one).toEqual({
            me: "ada",
            others: ["grace"],
            seed: two.seed,
            settings: { map: "dunes" },
          });
          expect(two).toEqual({ ...one, me: "grace", others: ["ada"] });
          // Run again, it is the same start.
          expect(yield* ada.start).toEqual(one);
          // The lobby is done once it has begun.
          expect(yield* thrown(ada.set({ map: "lakes" }))).toThrow(
            /lobby\.set was called after the game began/u
          );
          expectOneGame(yield* play(hub, [ada, grace], starts));
        })
      )
  );

  it.effect(
    "holds a lobby of three, one of whom leaves before the start, and begins with the one who takes the seat",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = Transport.makeHub({ delay: { min: 0, max: 3 }, seed: 8 });
          const ada = yield* joined(hub, "ada", 3);
          const grace = yield* joined(hub, "grace", 3);
          const linus = yield* joined(hub, "linus", 3);
          const starting = [
            yield* Effect.forkChild(ada.start),
            yield* Effect.forkChild(grace.start),
            yield* Effect.forkChild(linus.start),
          ];
          yield* grace.set({ map: "caves" });
          yield* wait(hub);
          expect(ada.members).toEqual(["ada", "grace", "linus"]);
          yield* ada.ready();
          yield* grace.ready();
          yield* wait(hub);
          expect(ada.waitingFor).toEqual(["linus"]);
          // Linus's socket drops before the start, and he is gone.
          hub.disconnect("linus");
          yield* wait(hub);
          expect(ada.members).toEqual(["ada", "grace"]);
          expect(grace.waitingFor).toEqual([]);
          // Two are ready, and the lobby takes three: nobody begins.
          const edsger = yield* joined(hub, "edsger", 3);
          starting[2] = yield* Effect.forkChild(edsger.start);
          yield* wait(hub);
          expect(edsger.members).toEqual(["ada", "edsger", "grace"]);
          expect(edsger.settings).toEqual({ map: "caves" });
          expect(ada.waitingFor).toEqual(["edsger"]);
          yield* edsger.ready();
          yield* wait(hub);
          const starts = [];
          for (const fiber of starting) {
            starts.push(yield* Fiber.join(fiber));
          }
          for (const [at, start] of starts.entries()) {
            expect(start.me).toBe(["ada", "grace", "edsger"][at]);
            expect([start.me, ...start.others].toSorted()).toEqual([
              "ada",
              "edsger",
              "grace",
            ]);
            expect(start.seed).toBe(starts[0]!.seed);
            expect(start.settings).toEqual({ map: "caves" });
          }
          expectOneGame(yield* play(hub, [ada, grace, edsger], starts));
        })
      )
  );

  it.effect(
    "tells a peer that joins a room whose game has begun that it is full",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = Transport.makeHub();
          const ada = yield* joined(hub, "ada", 2);
          const grace = yield* joined(hub, "grace", 2);
          const starting = [
            yield* Effect.forkChild(ada.start),
            yield* Effect.forkChild(grace.start),
          ];
          yield* ada.set({ map: "dunes" });
          yield* wait(hub, 3);
          yield* ada.ready();
          yield* grace.ready();
          yield* wait(hub, 3);
          const starts = [];
          for (const fiber of starting) {
            starts.push(yield* Fiber.join(fiber));
          }
          const late = yield* joined(hub, "linus", 2);
          const refused = yield* Effect.forkChild(Effect.flip(late.start));
          const sessions = [];
          for (const [at, lobby] of [ada, grace].entries()) {
            const session = yield* Session.make(CoinGame, {
              ...starts[at]!,
              hz: HZ,
            });
            sessions.push(yield* lobby.connect(session));
          }
          for (let i = 0; i < 5; i++) {
            hub.step();
            for (const connected of sessions) {
              yield* connected.tick();
            }
            yield* TestClock.adjust("20 millis");
          }
          expect(yield* Fiber.join(refused)).toEqual(
            new Lobby.Full({ players: ["ada", "grace"] })
          );
        })
      )
  );

  it.effect(
    "connects only a session made from its start, once it has begun",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = Transport.makeHub();
          const ada = yield* Lobby.join({ me: "ada", players: 1 }).pipe(
            Effect.provide(Transport.layer(hub.port("ada")))
          );
          const alone = yield* Session.make(CoinGame, {
            me: "ada",
            others: [],
            seed: 1,
            hz: HZ,
          });
          expect(yield* thrown(ada.connect(alone))).toThrow(
            /lobby\.connect was called before the game began/u
          );
          yield* ada.ready();
          const start = yield* ada.start;
          expect(start).toMatchObject({ me: "ada", others: [] });
          expect(start.settings).toBeUndefined();
          const other = yield* Session.make(CoinGame, {
            me: "ada",
            others: ["grace"],
            seed: start.seed,
            hz: HZ,
          });
          expect(yield* thrown(ada.connect(other))).toThrow(
            /was given a session of ada, grace as "ada", and the lobby began with ada as "ada"/u
          );
          expect(
            yield* thrown(
              Lobby.join({ me: "ada", players: 0 }).pipe(
                Effect.provide(Transport.layer(hub.port("ada")))
              )
            )
          ).toThrow(/A lobby's players are a whole number from 1/u);
          const connected = yield* ada.connect(
            yield* Session.make(CoinGame, { ...start, hz: HZ })
          );
          expect(yield* connected.tick()).toBe(true);
        })
      )
  );

  it.effect(
    "makes the seed of the settings too, so peers that began with other settings stop as drifted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Two rooms of the same two peers, with the same parts of the seed,
          // that agree on two maps.
          const startIn = (map: string) =>
            Effect.gen(function* () {
              const hub = Transport.makeHub();
              const lobbies = yield* Effect.forEach(["ada", "grace"], (name) =>
                joined(hub, name, 2).pipe(Random.withSeed(name))
              );
              const starting = yield* Effect.forEach(lobbies, (lobby) =>
                Effect.forkChild(lobby.start)
              );
              yield* lobbies[0]!.set({ map });
              yield* wait(hub, 3);
              yield* Effect.forEach(lobbies, (lobby) => lobby.ready());
              yield* wait(hub, 3);
              return yield* Effect.forEach(starting, (fiber) =>
                Fiber.join(fiber)
              );
            });
          const dunes = yield* startIn("dunes");
          const again = yield* startIn("dunes");
          const lakes = yield* startIn("lakes");
          expect(again[0]!.seed).toBe(dunes[0]!.seed);
          expect(lakes[0]!.seed).not.toBe(dunes[0]!.seed);
          // Ada plays on the dunes, and grace by the lakes.
          const hub = Transport.makeHub();
          const sessions = [];
          for (const start of [dunes[0]!, lakes[1]!]) {
            const session = yield* Session.make(CoinGame, {
              ...start,
              hashEvery: 1,
              hz: HZ,
            });
            sessions.push(
              yield* Transport.connect(session).pipe(
                Effect.provide(Transport.layer(hub.port(start.me)))
              )
            );
          }
          const stopped: unknown[] = [];
          for (let i = 0; i < 20 && stopped.length === 0; i++) {
            hub.step();
            for (const connected of sessions) {
              const ticked = yield* Effect.result(connected.tick());
              if (Result.isFailure(ticked)) {
                stopped.push(ticked.failure);
              }
            }
          }
          expect(stopped[0]).toBeInstanceOf(Drift.Drifted);
          // On the state they began from, before any tick.
          expect((stopped[0] as Drift.Drifted).tick).toBe(0);
        })
      )
  );

  it.effect(
    "begins a peer that lost what a player began with, on the player's next word, and never leaves it waiting",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = Transport.makeHub({ delay: 1 });
          const ada = yield* joined(hub, "ada", 2);
          const grace = yield* joined(hub, "grace", 2);
          const graceStarts = yield* Effect.forkChild(grace.start);
          yield* ada.set({ map: "dunes" });
          yield* wait(hub, 3);
          yield* grace.ready();
          yield* wait(hub, 3);
          // Ada is the last to say she is ready, and begins at once.
          yield* ada.ready();
          const begun = yield* ada.start;
          // Her word that she is ready, what she began with and her
          // session's first messages are lost on their way to grace.
          hub.disconnect("ada");
          const connected = yield* Effect.acquireRelease(
            ada.connect(
              yield* Session.make(CoinGame, {
                ...begun,
                hashEvery: 1,
                hz: HZ,
              })
            ),
            (made) => made.close
          );
          for (let i = 0; i < 5; i++) {
            yield* connected.tick();
            yield* wait(hub, 1);
          }
          expect(grace.members).toEqual(["grace"]);
          expect(grace.waitingFor).toEqual([]);
          // Ada comes back: as soon as her connection hears the room, she
          // says what she began with, and grace begins with it.
          hub.reconnect("ada");
          yield* connected.tick();
          yield* wait(hub, 1);
          yield* connected.tick();
          yield* wait(hub, 1);
          const started = yield* Fiber.join(graceStarts);
          expect(started).toEqual({
            ...begun,
            me: "grace",
            others: ["ada"],
          });
          // And she plays the game ada plays, from what ada sent meanwhile.
          const theirs = yield* grace.connect(
            yield* Session.make(CoinGame, {
              ...started,
              hashEvery: 1,
              hz: HZ,
            })
          );
          for (let i = 0; i < 30; i++) {
            hub.step();
            yield* connected.tick();
            yield* theirs.tick();
          }
          for (
            let i = 0;
            i < 20 && theirs.app.time.tick !== connected.app.time.tick;
            i++
          ) {
            hub.step();
            yield* (
              theirs.app.time.tick < connected.app.time.tick
                ? theirs
                : connected
            ).tick();
          }
          expect(theirs.app.time.tick).toBe(connected.app.time.tick);
          expect(theirs.app.time.tick).toBeGreaterThan(20);
          expect((yield* theirs.app.read(World)).hash()).toBe(
            (yield* connected.app.read(World)).hash()
          );
          expect(theirs.drifted).toBeUndefined();
        })
      )
  );
});
