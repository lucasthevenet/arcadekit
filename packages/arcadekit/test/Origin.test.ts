import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { SchemaBinary } from "effect/encoding";

import { readSnapshot } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Event,
  Replay,
  Save,
  Singleton,
  System,
  Time,
  Timeline,
} from "../src/index.ts";
import { Layout } from "../src/internal/recording.ts";
import { thrown, unwrap } from "./checks.ts";
import {
  CoinGame,
  DELTA,
  Purse,
  Stranger,
  Tip,
  catchUp,
  game,
  moves,
  network,
  purseOf,
  round,
  withApp,
  withPeers,
} from "./peers.ts";
import type { Peer } from "./peers.ts";

describe("who issued an action", () => {
  it.effect("is told to its handler when the action came with a name", () =>
    withApp(game(), (app, world) =>
      Effect.gen(function* () {
        // Brought in on someone's behalf, as a server does for its clients.
        expect(
          yield* Effect.exit(app.dispatchByName("ls/Tip", { amount: 3 }, "ada"))
        ).toEqual(Exit.succeed("ada"));
        yield* app.enqueueByName("ls/Tip", { amount: 4 }, "grace");
        yield* app.tick(DELTA);
        expect(purseOf(world)).toEqual({ ada: 3, grace: 4 });
      })
    )
  );

  it.effect("is nobody for an action this program issued itself", () =>
    Effect.gen(function* () {
      yield* withApp(game(), (app, world) =>
        Effect.gen(function* () {
          // Typed, through the app: a game of one has no one to name.
          expect(yield* Effect.exit(app.dispatch(Tip, { amount: 1 }))).toEqual(
            Exit.fail(Stranger.make({ from: undefined }))
          );
          expect(
            yield* Effect.exit(app.dispatchByName("ls/Tip", { amount: 1 }))
          ).toEqual(Exit.fail(Stranger.make({ from: undefined })));
          yield* app.enqueue(Tip, { amount: 1 });
          yield* app.tick(DELTA);
          expect(moves(app.actionLog).at(-1)?.refused).toBeDefined();
          expect(purseOf(world)).toEqual({ ada: 0, grace: 0 });
        })
      );
      // And for one the simulation issues, a bot's: no peer stands behind it.
      const told: (string | undefined)[] = [];
      const Poke = Action.define("or/Poke", {
        payload: Schema.Struct({ n: Schema.Number }),
      });
      const poke = Action.handler(Poke, function* (_, origin) {
        yield* Effect.sync(() => told.push(origin.from));
      });
      const Bot = System.tick("or/Bot", function* () {
        if ((yield* Time).tick === 1) {
          (yield* Action.Actions).enqueue(Poke, { n: 1 });
        }
      });
      yield* withApp(
        App.make(App.define({ systems: [Bot], handlers: [poke] })),
        (app) =>
          Effect.gen(function* () {
            yield* app.tick(DELTA);
            yield* app.tick(DELTA);
            expect(told).toEqual([undefined]);
          })
      );
    })
  );

  it.effect("is in the log, and a replay hands it back", () =>
    Effect.gen(function* () {
      const recorded = yield* withApp(game(), (app, world) =>
        Effect.gen(function* () {
          yield* app.dispatchByName("ls/Tip", { amount: 2 }, "ada");
          yield* app.enqueueByName("ls/Tip", { amount: 5 }, "grace");
          yield* app.enqueueByName("ls/Tip", { amount: 9 }, "mallory");
          yield* app.tick(DELTA);
          return { recording: yield* Replay.record(app), hash: world.hash() };
        })
      );
      const { log } = recorded.recording;
      expect(moves(log)).toEqual([
        { tick: 0, name: "ls/Tip", payload: { amount: 2 }, from: "ada" },
        {
          tick: 0,
          name: "ls/Tip",
          payload: { amount: 5 },
          from: "grace",
          queued: true,
        },
        {
          tick: 0,
          name: "ls/Tip",
          payload: { amount: 9 },
          from: "mallory",
          queued: true,
          refused: expect.any(String),
        },
      ]);
      // As bytes and back, as a log that is kept would be.
      const bytes = yield* Replay.encode(recorded.recording);
      const read = Replay.decode(bytes);
      expect(read).toEqual(Exit.succeed(recorded.recording));
      assert(Exit.isSuccess(read));
      yield* withApp(
        Replay.verify(read.value, CoinGame, { hashEvery: 1 }),
        (_, world) =>
          Effect.gen(function* () {
            expect(world.hash()).toBe(recorded.hash);
            expect(purseOf(world)).toEqual({ ada: 2, grace: 5 });
          })
      );
      // A log that had lost who issued each is another game, and says so.
      const anonymous = log.map((entry) => {
        if (Action.isHashCheck(entry)) {
          return entry;
        }
        const { from: _, ...rest } = entry;
        return rest;
      });
      const Written = SchemaBinary.toCodec(Layout);
      const fields = unwrap(Schema.decodeExit(Written)(bytes));
      const alteredRecording = Replay.decode(
        unwrap(Schema.encodeExit(Written)({ ...fields, log: anonymous }))
      );
      assert(Exit.isSuccess(alteredRecording));
      const diverged = yield* Effect.flip(
        Replay.verify(alteredRecording.value, CoinGame, {
          hashEvery: 1,
        })
      );
      expect(diverged).toBeInstanceOf(Replay.Diverged);
      // A name is text, and one that isn't is bytes of another layout.
      const numbered = SchemaBinary.toCodec(
        Schema.Struct({
          ...Layout.fields,
          log: Schema.Array(
            Schema.Struct({
              tick: Schema.Int,
              name: Schema.String,
              payload: Schema.Unknown,
              from: Schema.Number,
            })
          ),
        })
      );
      expect(
        Exit.isFailure(
          Replay.decode(
            unwrap(
              Schema.encodeExit(numbered)({
                ...fields,
                log: [{ tick: 0, name: "ls/Tip", payload: {}, from: 7 }],
              })
            )
          )
        )
      ).toBe(true);
    })
  );

  it.effect(
    "is kept with an action that waits, in a save and in a moment",
    () =>
      Effect.gen(function* () {
        const saved = yield* withApp(game(), (app, world) =>
          Effect.gen(function* () {
            yield* app.tick(DELTA);
            yield* app.enqueueByName("ls/Tip", { amount: 6 }, "grace");
            const save = yield* Effect.exit(Save.make(app));
            if (Exit.isFailure(save)) {
              throw new Error("the game could not be saved");
            }
            expect(
              readSnapshot(save.value.world).stores.find(
                (store) => store.name === Action.INTAKE
              )?.data
            ).toEqual({
              queued: [
                { name: "ls/Tip", payload: { amount: 6 }, from: "grace" },
              ],
            });
            // And where a game goes back to: the tip is waiting again, hers still.
            const moment = yield* Effect.exit(Timeline.capture(app));
            yield* app.tick(DELTA);
            expect(purseOf(world)).toEqual({ ada: 0, grace: 6 });
            yield* Timeline.rewind(
              app,
              Exit.isSuccess(moment) ? moment.value : { tick: -1 }
            );
            expect(purseOf(world)).toEqual({ ada: 0, grace: 0 });
            yield* app.tick(DELTA);
            expect(purseOf(world)).toEqual({ ada: 0, grace: 6 });
            return Save.encode(save.value);
          })
        );
        const read = Save.decode(saved);
        if (Exit.isFailure(read)) {
          throw new Error("the save could not be read");
        }
        {
          const app = yield* App.make(CoinGame, {
            save: read.value,
            hashEvery: 1,
          });
          yield* app.tick(DELTA);
          const { ada, grace } = yield* app.read(Singleton.Read(Purse));
          expect({ ada, grace }).toEqual({ ada: 0, grace: 6 });
        }
      })
  );

  it.effect("is told with a refusal", () =>
    Effect.gen(function* () {
      const heard: (string | undefined)[] = [];
      const Hear = System.tick("or/Hear", function* () {
        for (const refusal of (yield* Event.Reader(Action.Rejected)).read()) {
          heard.push(refusal.from);
        }
      });
      const Never = Action.define("or/Never", {
        payload: Schema.Struct({ n: Schema.Number }),
        error: Stranger,
      });
      const never = Action.handler(Never, function* () {
        return yield* Stranger.make({ from: undefined });
      });
      yield* withApp(
        App.make(App.define({ systems: [Hear], handlers: [never] })),
        (app) =>
          Effect.gen(function* () {
            yield* app.enqueueByName("or/Never", { n: 1 }, "ada");
            yield* app.enqueue(Never, { n: 2 });
            yield* app.enqueueByName("or/Nobody", {}, "grace");
            yield* app.tick(DELTA);
            // Whose each was, so that a UI can show a player their own.
            expect(heard).toEqual(["ada", undefined, "grace"]);
          })
      );
    })
  );
});

describe("who issued an action, in a session", () => {
  it.effect(
    "is the peer that issued it, on every peer, whoever's payload it was",
    () =>
      Effect.gen(function* () {
        for (const ahead of [undefined, 8]) {
          yield* withPeers(
            ["ada", "grace"],
            ahead === undefined ? {} : { ahead },
            (peers) =>
              Effect.gen(function* () {
                const net = network(6, { min: 0, max: 4 });
                const [ada, grace] = peers as [Peer, Peer];
                yield* ada.app.enqueue(Tip, { amount: 2 });
                yield* grace.app.enqueue(Tip, { amount: 5 });
                yield* grace.app.enqueue(Tip, { amount: 1 });
                for (let i = 0; i < 30; i++) {
                  yield* round(peers, net);
                }
                yield* catchUp(peers, net);
                for (const peer of peers) {
                  expect(purseOf(peer.world)).toEqual({ ada: 2, grace: 6 });
                  expect(
                    moves(peer.app.actionLog).map((entry) => [
                      entry.from,
                      (entry.payload as { amount: number }).amount,
                    ])
                  ).toEqual([
                    ["ada", 2],
                    ["grace", 5],
                    ["grace", 1],
                  ]);
                }
                expect(ada.world.hash()).toBe(grace.world.hash());
              })
          );
        }
      })
  );

  it.effect("is the peer whose key it was", () =>
    withPeers(["ada", "grace"], { delay: 1 }, (peers) =>
      Effect.gen(function* () {
        const net = network(1, { min: 0, max: 0 });
        const [ada, grace] = peers as [Peer, Peer];
        grace.source.tap("Space");
        for (let i = 0; i < 6; i++) {
          yield* round(peers, net);
        }
        yield* catchUp(peers, net);
        expect(moves(ada.app.actionLog)).toEqual([
          {
            tick: expect.any(Number),
            name: "ls/Fire",
            payload: {},
            from: "grace",
            queued: true,
          },
        ]);
        expect(ada.app.actionLog).toEqual(grace.app.actionLog);
      })
    )
  );

  it.effect("is not for a peer to say of what it issues itself", () =>
    withPeers(["ada", "grace"], {}, (peers) =>
      Effect.gen(function* () {
        const [ada] = peers as [Peer];
        expect(
          yield* thrown(
            // @ts-expect-error a session's app takes no issuer
            ada.app.enqueueByName("ls/Tip", { amount: 1 }, "grace")
          )
        ).toThrow(
          /was given who issued it, "grace", on an app that a session has taken over.*nobody speaks for another/u
        );
        // With no name it is this peer's, as any action it enqueues is.
        yield* ada.app.enqueueByName("ls/Tip", { amount: 1 });
        yield* ada.session.tick();
        expect(
          ada.session.outgoing().flatMap((message) => message.actions)
        ).toEqual([{ name: "ls/Tip", payload: { amount: 1 } }]);
      })
    )
  );

  it.effect("goes by the name a message says it is from", () =>
    withPeers(["ada", "grace"], { delay: 0 }, (peers) =>
      Effect.gen(function* () {
        const [ada] = peers as [Peer];
        // Who a message is from is the transport's to vouch for: the session
        // takes its word.
        ada.session.receive({
          from: "grace",
          tick: 0,
          actions: [{ name: "ls/Tip", payload: { amount: 7 } }],
        });
        expect(yield* Effect.exit(ada.session.tick())).toEqual(
          Exit.succeed(true)
        );
        expect(purseOf(ada.world)).toEqual({ ada: 0, grace: 7 });
      })
    )
  );
});
