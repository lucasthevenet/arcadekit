import { Effect, Exit } from "effect";
import type { Scope } from "effect";
import { assert, describe, expect, it } from "vitest";

import { App, Build, Save, World } from "../src/index";
import { Session } from "../src/net/index";
import { CoinGame, DELTA, Drop, game } from "./peers";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const alone = { me: "ada", others: [], delta: DELTA } as const;

/** What the compiler says of a session's names, or that it says nothing. */
type Said<Me extends string, Others extends readonly string[]> = [
  Session.Repeated<Me, Others>,
] extends [never]
  ? "nothing"
  : Session.Repeated<Me, Others>;

const ME_TOO =
  '"ada" is me, and among the others too. Name only the other peers in others.';
const OTHER_TWICE =
  '"grace" is among the others twice. Every peer has a name of its own: name each other peer once.';

describe("a session", () => {
  it("makes the app it steps, from the game and how it starts", () => {
    run(
      Effect.gen(function* () {
        const session = yield* Session.make(CoinGame, {
          ...alone,
          seed: 5,
          checkpointEvery: 1,
        });
        const { app } = session;
        expect(app.time.tick).toBe(0);
        // The same game, made the same way, is the same world.
        const single = yield* game(5, 1);
        expect((yield* app.read(World)).hash()).toBe(
          (yield* single.read(World)).hash()
        );
        // What is enqueued on its app is the session's to apply.
        app.enqueue(Drop, { by: "ada", value: 3 });
        expect(session.tick()).toBe(true);
        expect(app.time.tick).toBe(1);
        // A recording of it says how it began, as an app's does.
        expect(app.record().seed).toBe(5);
      })
    );
  });

  it("is told this peer apart from the others, and a name given twice does not compile", () => {
    run(
      Effect.gen(function* () {
        const session = yield* Session.make(CoinGame, {
          seed: 5,
          me: "grace",
          others: ["edsger", "ada"],
          delta: DELTA,
        });
        expect(session.me).toBe("grace");
        // Every peer, in the order their actions are applied.
        expect(session.peers).toEqual(["ada", "edsger", "grace"]);
      })
    );

    const mine: Said<"ada", readonly ["grace", "ada"]> = ME_TOO;
    const theirs: Said<"ada", readonly ["grace", "edsger", "grace"]> =
      OTHER_TWICE;
    const fine: Said<"ada", readonly ["grace", "edsger"]> = "nothing";
    // Names the compiler only knows as text are refused when it runs.
    const unknown: Said<string, readonly string[]> = "nothing";
    expect([mine, theirs, fine, unknown]).toEqual([
      ME_TOO,
      OTHER_TWICE,
      "nothing",
      "nothing",
    ]);
    // Refused where they are written: neither effect is run.
    void Session.make(
      CoinGame,
      // @ts-expect-error "ada" is me, and among the others too
      { seed: 5, me: "ada", others: ["grace", "ada"], delta: DELTA }
    );
    void Session.make(
      CoinGame,
      // @ts-expect-error "grace" is among the others twice
      { seed: 5, me: "ada", others: ["grace", "grace"], delta: DELTA }
    );
  });

  it("begins where a save every peer loads was made, and fails as a load does", () => {
    const save = run(
      Effect.gen(function* () {
        const app = yield* game(5, 1);
        app.enqueue(Drop, { by: "ada", value: 2 });
        for (let i = 0; i < 4; i++) {
          app.tick(DELTA);
        }
        const saved = app.save();
        assert(Exit.isSuccess(saved));
        return { save: saved.value, hash: (yield* app.read(World)).hash() };
      })
    );
    run(
      Effect.gen(function* () {
        const session = yield* Session.make(CoinGame, {
          ...alone,
          save: save.save,
        });
        expect(session.app.time.tick).toBe(4);
        expect((yield* session.app.read(World)).hash()).toBe(save.hash);
        expect(session.tick()).toBe(true);
        expect(session.app.time.tick).toBe(5);
      })
    );
    // A save that doesn't load is the session's failure, typed.
    const damaged: Save.Save = {
      ...save.save,
      world: save.save.world.slice(0, 20),
    };
    const refused = Effect.runSync(
      Effect.scoped(
        Effect.exit(Session.make(CoinGame, { ...alone, save: damaged }))
      )
    );
    const typed: Exit.Exit<unknown, Save.LoadRefused> = refused;
    expect(Exit.isFailure(typed)).toBe(true);
    // From a seed there is nothing to refuse.
    const fresh: Effect.Effect<unknown, never, Scope.Scope> = Session.make(
      CoinGame,
      { ...alone, seed: 1 }
    );
    void fresh;
  });

  it("runs 8 ticks ahead with no delay unless told, and with a delay of 2 when it runs none ahead", () => {
    run(
      Effect.gen(function* () {
        const ahead = yield* Session.make(CoinGame, alone);
        expect([ahead.ahead, ahead.delay]).toEqual([8, 0]);
        const lockstep = yield* Session.make(CoinGame, { ...alone, ahead: 0 });
        expect([lockstep.ahead, lockstep.delay]).toEqual([0, 2]);
        const told = yield* Session.make(CoinGame, {
          ...alone,
          ahead: 0,
          delay: 0,
        });
        expect([told.ahead, told.delay]).toEqual([0, 0]);
        const both = yield* Session.make(CoinGame, {
          ...alone,
          ahead: 3,
          delay: 1,
        });
        expect([both.ahead, both.delay]).toEqual([3, 1]);
      })
    );
  });
});

describe("taking an app over", () => {
  it("is no member of an app: only what builds it hands it over, once", () => {
    run(
      Effect.gen(function* () {
        const app = yield* App.make(CoinGame, { seed: 5 });
        // @ts-expect-error an app is taken over by what builds it, not by itself
        void app.divert;
        expect("divert" in app).toBe(false);
        expect("take" in app).toBe(false);

        const built = yield* Build.build(CoinGame, { seed: 5 });
        const reins = built.take(() => {});
        expect(reins.tickExit(DELTA)).toEqual(Exit.void);
        expect(built.app.time.tick).toBe(1);
        expect(() => built.take(() => {})).toThrow(
          /taken over already\. An app is in one session at a time/
        );
      })
    );
  });

  it("is what a sync test does to the app it makes", () => {
    run(
      Effect.gen(function* () {
        const test = yield* Session.syncTest(CoinGame, { seed: 5 });
        test.app.enqueue(Drop, { by: "ada", value: 1 });
        for (let i = 0; i < 5; i++) {
          test.tick(DELTA);
        }
        expect(test.checked).toBe(5);
        expect(test.app.time.tick).toBe(5);
        // Each tick is in the log and the recording once.
        expect(test.app.record()).toMatchObject({ seed: 5, start: 0, end: 5 });
        // The same game stepped once a tick ends in the same world.
        const single = yield* game(5, 60);
        single.enqueue(Drop, { by: "ada", value: 1 });
        for (let i = 0; i < 5; i++) {
          single.tick(DELTA);
        }
        expect((yield* test.app.read(World)).hash()).toBe(
          (yield* single.read(World)).hash()
        );
      })
    );
  });
});
