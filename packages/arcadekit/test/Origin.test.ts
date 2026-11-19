import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { Action, App, Save, System, Time } from "../src/index";
import {
  catchUp,
  DELTA,
  game,
  gameOptions,
  moves,
  network,
  Purse,
  purseOf,
  round,
  Stranger,
  Tip,
  withApp,
  withPeers,
} from "./peers";
import type { Peer } from "./peers";

describe("who issued an action", () => {
  it("is told to its handler when the action came with a name", () => {
    withApp(game(), (app) => {
      // Brought in on someone's behalf, as a server does for its clients.
      expect(app.dispatchByName("ls/Tip", { amount: 3 }, "ada")).toStrictEqual(
        Exit.succeed("ada")
      );
      app.enqueueByName("ls/Tip", { amount: 4 }, "grace");
      app.tick(DELTA);
      expect(purseOf(app)).toStrictEqual({ ada: 3, grace: 4 });
    });
  });

  it("is nobody for an action this program issued itself", () => {
    withApp(game(), (app) => {
      // Typed, through the app: a game of one has no one to name.
      expect(app.dispatch(Tip, { amount: 1 })).toStrictEqual(
        Exit.fail(new Stranger({ from: undefined }))
      );
      expect(app.dispatchByName("ls/Tip", { amount: 1 })).toStrictEqual(
        Exit.fail(new Stranger({ from: undefined }))
      );
      app.enqueue(Tip, { amount: 1 });
      app.tick(DELTA);
      expect(moves(app.actionLog).at(-1)?.refused).toBeDefined();
      expect(purseOf(app)).toStrictEqual({ ada: 0, grace: 0 });
    });
    // And for one the simulation issues, a bot's: no peer stands behind it.
    const told: (string | undefined)[] = [];
    const Poke = Action.define<{ readonly n: number }>()("or/Poke");

    const poke = Action.handler(Poke, function* (_, origin) {
      yield* Effect.sync(() => told.push(origin.from));
    });

    const Bot = System.make("or/Bot", function* () {
      if ((yield* Time).tick === 1) {
        (yield* Action.Actions).enqueue(Poke, { n: 1 });
      }
    });

    withApp(App.make({ systems: [Bot], handlers: [poke] }), (app) => {
      app.tick(DELTA);
      app.tick(DELTA);
      expect(told).toStrictEqual([undefined]);
    });
  });

  it("is in the log, and a replay hands it back", () => {
    const recorded = withApp(game(), (app) => {
      app.dispatchByName("ls/Tip", { amount: 2 }, "ada");
      app.enqueueByName("ls/Tip", { amount: 5 }, "grace");
      app.enqueueByName("ls/Tip", { amount: 9 }, "mallory");
      app.tick(DELTA);

      return { log: [...app.actionLog], hash: app.world.hash() };
    });

    expect(moves(recorded.log)).toStrictEqual([
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
    // As text and back, as a log that is kept would be.
    const text = Action.encodeLog(recorded.log);
    const read = Action.decodeLog(text);
    expect(read).toStrictEqual(Exit.succeed(recorded.log));
    withApp(game(), (app) => {
      App.replay(app, Exit.isSuccess(read) ? read.value : [], {
        delta: DELTA,
        ticks: 1,
      });
      expect(app.world.hash()).toBe(recorded.hash);
      expect(purseOf(app)).toStrictEqual({ ada: 2, grace: 5 });
    });

    // A log that had lost who issued each is another game, and says so.
    const anonymous = recorded.log.map((entry) => {
      if (Action.isCheckpoint(entry)) {
        return entry;
      }

      const { from: _, ...rest } = entry;

      return rest;
    });

    withApp(game(), (app) => {
      expect(() =>
        App.replay(app, anonymous, { delta: DELTA, ticks: 1 })
      ).toThrow(App.ReplayDiverged);
    });
    // A name is text.
    expect(
      Exit.isFailure(
        Action.decodeLog(
          JSON.stringify([{ tick: 0, name: "ls/Tip", payload: {}, from: 7 }])
        )
      )
    ).toBe(true);
  });

  it("is kept with an action that waits, in a save and in a moment", () => {
    const saved = withApp(game(), (app) => {
      app.tick(DELTA);
      app.enqueueByName("ls/Tip", { amount: 6 }, "grace");
      const save = app.save();

      if (Exit.isFailure(save)) {
        throw new Error("the game could not be saved");
      }

      expect(save.value.queued).toStrictEqual([
        { name: "ls/Tip", payload: { amount: 6 }, from: "grace" },
      ]);
      // And where a game goes back to: the tip is waiting again, hers still.
      const moment = app.capture();
      app.tick(DELTA);
      expect(purseOf(app)).toStrictEqual({ ada: 0, grace: 6 });
      app.rewind(Exit.isSuccess(moment) ? moment.value : { tick: -1 });
      expect(purseOf(app)).toStrictEqual({ ada: 0, grace: 0 });
      app.tick(DELTA);
      expect(purseOf(app)).toStrictEqual({ ada: 0, grace: 6 });

      return Save.encode(save.value);
    });

    const read = Save.decode(saved);

    if (Exit.isFailure(read)) {
      throw new Error("the save could not be read");
    }

    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.load(read.value, gameOptions());
          app.tick(DELTA);
          const { ada, grace } = app.world.singleton(Purse);
          expect({ ada, grace }).toStrictEqual({ ada: 0, grace: 6 });
        })
      )
    );
  });

  it("is told with a refusal", () => {
    const heard: (string | undefined)[] = [];

    const Hear = System.make("or/Hear", function* () {
      for (const refusal of (yield* Action.Rejected).read()) {
        heard.push(refusal.from);
      }
    });

    const Never = Action.define<{ readonly n: number }>()("or/Never");

    const never = Action.handler(Never, function* () {
      return yield* Effect.fail(new Stranger({ from: undefined }));
    });

    withApp(App.make({ systems: [Hear], handlers: [never] }), (app) => {
      app.enqueueByName("or/Never", { n: 1 }, "ada");
      app.enqueue(Never, { n: 2 });
      app.enqueueByName("or/Nobody", {}, "grace");
      app.tick(DELTA);
      // Whose each was, so that a UI can show a player their own.
      expect(heard).toStrictEqual(["ada", undefined, "grace"]);
    });
  });
});

describe("who issued an action, in a session", () => {
  it("is the peer that issued it, on every peer, whoever's payload it was", () => {
    for (const ahead of [undefined, 8]) {
      withPeers(
        ["ada", "grace"],
        ahead === undefined ? {} : { ahead },
        (peers) => {
          const net = network(6, { min: 0, max: 4 });
          const [ada, grace] = peers as [Peer, Peer];
          ada.app.enqueue(Tip, { amount: 2 });
          grace.app.enqueue(Tip, { amount: 5 });
          grace.app.enqueue(Tip, { amount: 1 });

          for (let i = 0; i < 30; i += 1) {
            round(peers, net);
          }

          catchUp(peers, net);

          for (const peer of peers) {
            expect(purseOf(peer.app)).toStrictEqual({ ada: 2, grace: 6 });
            expect(
              moves(peer.app.actionLog).map((entry) => [
                entry.from,
                (entry.payload as { amount: number }).amount,
              ])
            ).toStrictEqual([
              ["ada", 2],
              ["grace", 5],
              ["grace", 1],
            ]);
          }

          expect(ada.app.world.hash()).toBe(grace.app.world.hash());
        }
      );
    }
  });

  it("is the peer whose key it was", () => {
    withPeers(["ada", "grace"], { delay: 1 }, (peers) => {
      const net = network(1, { min: 0, max: 0 });
      const [ada, grace] = peers as [Peer, Peer];
      grace.source.tap("Space");

      for (let i = 0; i < 6; i += 1) {
        round(peers, net);
      }

      catchUp(peers, net);
      expect(moves(ada.app.actionLog)).toStrictEqual([
        {
          tick: expect.any(Number),
          name: "ls/Fire",
          payload: {},
          from: "grace",
          queued: true,
        },
      ]);
      expect(ada.app.actionLog).toStrictEqual(grace.app.actionLog);
    });
  });

  it("is not for a peer to say of what it issues itself", () => {
    withPeers(["ada", "grace"], {}, (peers) => {
      const [ada] = peers as [Peer];
      expect(() =>
        ada.app.enqueueByName("ls/Tip", { amount: 1 }, "grace")
      ).toThrow(
        /was given who issued it, "grace", on an app that a session has taken over.*nobody speaks for another/u
      );
      // With no name it is this peer's, as any action it enqueues is.
      ada.app.enqueueByName("ls/Tip", { amount: 1 });
      ada.session.tick();
      expect(
        ada.session.outgoing().flatMap((message) => message.actions)
      ).toStrictEqual([{ name: "ls/Tip", payload: { amount: 1 } }]);
    });
  });

  it("goes by the name a message says it is from", () => {
    withPeers(["ada", "grace"], { delay: 0 }, (peers) => {
      const [ada] = peers as [Peer];
      // Who a message is from is the transport's to vouch for: the session
      // takes its word.
      ada.session.receive({
        from: "grace",
        tick: 0,
        actions: [{ name: "ls/Tip", payload: { amount: 7 } }],
      });
      expect(ada.session.tickExit()).toStrictEqual(Exit.succeed(true));
      expect(purseOf(ada.app)).toStrictEqual({ ada: 0, grace: 7 });
    });
  });
});
