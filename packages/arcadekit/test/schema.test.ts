import { Data, Effect, Exit, Option, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Component,
  EntityId,
  Field,
  System,
  World,
} from "../src/index";
import type { Entity } from "../src/index";

const Health = Component.define("sc/Health", { hp: Field.i32 });

class NoSuchTarget extends Data.TaggedError("NoSuchTarget")<{
  readonly target: Entity;
}> {}

const Damage = Action.define(
  "Damage",
  Schema.Struct({
    target: EntityId,
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    // Not representable in JSON as it is: the log has to convert it.
    seed: Schema.BigInt,
    note: Schema.optional(Schema.String),
  })
);

/** Type-only: checked by the compiler and nothing else. */
const Rename = Action.define<{ readonly name: string }>()("Rename");

const received: unknown[] = [];
const damage = Action.handler(Damage, function* (payload) {
  received.push(payload);
  const world = yield* World;
  const health = world.get(payload.target, Health);
  if (health === undefined) {
    return yield* new NoSuchTarget({ target: payload.target });
  }
  world.set(payload.target, Health, { hp: health.hp - payload.amount });
  return health.hp - payload.amount;
});
const rename = Action.handler(Rename, function* ({ name }) {
  return name.toUpperCase();
});

const game = Effect.map(App.make({ handlers: [damage, rename] }), (app) => {
  const target = app.world.spawn(Health.of({ hp: 50 }));
  return { app, target };
});

const withApp = <A, T>(
  make: Effect.Effect<A, never, Scope.Scope>,
  use: (made: A) => T
): T => Effect.runSync(Effect.scoped(Effect.map(make, use)));

/** The applied actions of a log, without the checkpoints recorded among them. */
const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

const failure = (exit: Exit.Exit<unknown, unknown>): any => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failure");
  }
  return (exit.cause.reasons[0] as any).error;
};

describe("actions with a schema", () => {
  it("infer the payload type and log the payload in its JSON form", () => {
    withApp(game, ({ app, target }) => {
      received.length = 0;
      const exit = app.dispatch(Damage, {
        target,
        amount: 4,
        seed: 12_345_678_901_234_567_890n,
      });
      expect(exit).toEqual(Exit.succeed(46));
      // The handler gets the value as given...
      expect(received).toEqual([
        { target, amount: 4, seed: 12_345_678_901_234_567_890n },
      ]);
      // ...and the log gets something JSON can hold.
      expect(moves(app.actionLog)).toEqual([
        {
          tick: 0,
          name: "Damage",
          payload: { target, amount: 4, seed: "12345678901234567890" },
        },
      ]);
      expect(() => JSON.stringify(app.actionLog)).not.toThrow();

      // The failure type says a schema-defined action can be rejected as invalid.
      const typed: Exit.Exit<number, NoSuchTarget | Action.InvalidPayload> =
        exit;
      void typed;
    });
  });

  it("reject a payload the compiler accepts but the schema does not", () => {
    withApp(game, ({ app, target }) => {
      received.length = 0;
      const exit = app.dispatch(Damage, { target, amount: 999, seed: 1n });
      const error = failure(exit);
      expect(error).toBeInstanceOf(Action.InvalidPayload);
      expect(error.action).toBe("Damage");
      expect(error.message).toMatch(/amount/);
      // The handler never ran, nothing changed, nothing was logged.
      expect(received).toEqual([]);
      expect(app.world.get(target, Health)).toEqual({ hp: 50 });
      expect(moves(app.actionLog)).toEqual([]);
    });
  });

  it("validate and convert payloads that arrive as data", () => {
    withApp(game, ({ app, target }) => {
      received.length = 0;
      const exit = app.dispatchByName("Damage", {
        target,
        amount: 3,
        seed: "77",
        note: "from the network",
      });
      expect(exit).toEqual(Exit.succeed(47));
      // Decoded for the handler: the seed is a bigint again.
      expect(received).toEqual([
        { target, amount: 3, seed: 77n, note: "from the network" },
      ]);
      expect(moves(app.actionLog)[0]!.payload).toEqual({
        target,
        amount: 3,
        seed: "77",
        note: "from the network",
      });
    });
  });

  it("turn every kind of bad input into a failure, never a crash", () => {
    withApp(game, ({ app, target }) => {
      received.length = 0;
      const bad: [label: string, payload: unknown][] = [
        ["missing field", { target, amount: 3 }],
        ["wrong type", { target, amount: "3", seed: "1" }],
        ["out of range", { target, amount: 0, seed: "1" }],
        ["not an integer", { target, amount: 2.5, seed: "1" }],
        ["bad entity id", { target: -1, amount: 3, seed: "1" }],
        ["fractional entity id", { target: 1.5, amount: 3, seed: "1" }],
        ["unconvertible", { target, amount: 3, seed: "not a number" }],
        ["null", null],
        ["a string", "Damage"],
        ["an array", [1, 2, 3]],
        ["undefined", undefined],
      ];
      for (const [label, payload] of bad) {
        const error = failure(app.dispatchByName("Damage", payload));
        expect(error, label).toBeInstanceOf(Action.InvalidPayload);
        expect(error.message.length, label).toBeGreaterThan(0);
      }
      expect(failure(app.dispatchByName("Nope", {}))).toEqual(
        new Action.UnknownAction({ action: "Nope" })
      );
      expect(failure(app.dispatchByName("constructor", {}))).toBeInstanceOf(
        Action.UnknownAction
      );

      // A well-formed payload can still be refused by the rules.
      const dead = 4000 as Entity;
      expect(
        failure(
          app.dispatchByName("Damage", { target: dead, amount: 3, seed: "1" })
        )
      ).toEqual(new NoSuchTarget({ target: dead }));

      expect(received).toHaveLength(1); // only the last one reached the handler
      expect(app.world.get(target, Health)).toEqual({ hp: 50 });
      expect(moves(app.actionLog)).toEqual([]);
    });
  });

  it("report bad queued input as events", () => {
    const rejected: string[] = [];
    const Watch = System.make("Watch", function* () {
      for (const event of (yield* Action.Rejected).read()) {
        rejected.push(
          `${event.action}: ${(event.error as { _tag: string })._tag}`
        );
      }
    });
    const make = Effect.map(
      App.make({ systems: [Watch], handlers: [damage] }),
      (app) => {
        const target = app.world.spawn(Health.of({ hp: 50 }));
        return { app, target };
      }
    );
    withApp(make, ({ app, target }) => {
      app.enqueueByName("Damage", { target, amount: 5, seed: "9" });
      app.enqueueByName("Damage", { target, amount: 500, seed: "9" });
      app.enqueueByName("Teleport", { x: 1 });
      app.enqueue(Damage, { target, amount: 2, seed: 9n });
      app.enqueue(Damage, { target, amount: -2, seed: 9n });
      app.tick(1);
      expect(app.world.get(target, Health)).toEqual({ hp: 43 });
      expect(rejected).toEqual([
        "Damage: InvalidPayload",
        "Teleport: UnknownAction",
        "Damage: InvalidPayload",
      ]);
      // What was enqueued is in the log as it arrived, with what became of
      // it. The last one is not: its payload has no JSON form to log.
      expect(
        moves(app.actionLog).map((entry) => [
          entry.name,
          (entry.payload as { amount?: number }).amount,
          entry.queued,
          entry.refused === undefined ? "applied" : "refused",
        ])
      ).toEqual([
        ["Damage", 5, true, "applied"],
        ["Damage", 500, true, "refused"],
        ["Teleport", undefined, true, "refused"],
        ["Damage", 2, true, "applied"],
      ]);
      // The mark is the error's own message where it has one, and its name
      // where it has none.
      const invalid = Exit.findErrorOption(
        app.dispatchByName("Damage", { target, amount: 500, seed: "9" })
      );
      expect(moves(app.actionLog)[1]!.refused).toBe(
        Option.getOrThrow(invalid as Option.Option<Error>).message
      );
      expect(moves(app.actionLog)[1]!.refused).toMatch(/amount/);
      expect(moves(app.actionLog)[2]!.refused).toBe("UnknownAction");
      expect(moves(app.actionLog)[3]!.payload).toEqual({
        target,
        amount: 2,
        seed: "9",
      });
    });
  });

  it("leave type-only actions unchecked", () => {
    withApp(game, ({ app }) => {
      // No InvalidPayload in the failure type: there is no schema to fail.
      const exit: Exit.Exit<string, never> = app.dispatch(Rename, {
        name: "bob",
      });
      expect(exit).toEqual(Exit.succeed("BOB"));
      // By name, the payload is passed through as it is. A wrong shape reaches
      // the handler, which here crashes on it: a defect, contained in the Exit.
      const crashed = app.dispatchByName("Rename", { name: 42 });
      expect(Exit.isFailure(crashed)).toBe(true);
    });
  });

  it("check entity ids for shape", () => {
    const ok = Schema.decodeUnknownExit(EntityId);
    expect(Exit.isSuccess(ok(0))).toBe(true);
    expect(Exit.isSuccess(ok(4_294_967_295))).toBe(true);
    for (const bad of [-1, 4_294_967_296, 1.5, Number.NaN, "7", null]) {
      expect(Exit.isFailure(ok(bad))).toBe(true);
    }
  });
});

describe("saving and replaying", () => {
  const record = () =>
    withApp(game, ({ app, target }) => {
      app.dispatch(Damage, { target, amount: 4, seed: 1n });
      app.tick(1);
      app.enqueue(Damage, { target, amount: 10, seed: 2n, note: "big hit" });
      app.tick(1);
      app.tick(1);
      app.dispatchByName("Damage", { target, amount: 1, seed: "3" });
      app.dispatch(Rename, { name: "x" });
      app.tick(1);
      return {
        text: Action.encodeLog(app.actionLog),
        hp: app.world.get(target, Health)!.hp,
        ticks: app.time.tick,
      };
    });

  const replayInto = (log: readonly Action.LogEntry[], ticks: number) =>
    withApp(game, ({ app, target }) => {
      App.replay(app, log, { delta: 1, ticks });
      return app.world.get(target, Health)!.hp;
    });

  it("round-trips the log through text and reproduces the game", () => {
    const saved = record();
    expect(saved.hp).toBe(35);
    expect(saved.text).toBeTypeOf("string");

    const loaded = Action.decodeLog(saved.text);
    expect(Exit.isSuccess(loaded)).toBe(true);
    if (!Exit.isSuccess(loaded)) {
      return;
    }
    expect(
      moves(loaded.value).map((entry) => `${entry.tick}:${entry.name}`)
    ).toEqual(["0:Damage", "1:Damage", "3:Damage", "3:Rename"]);
    expect(replayInto(loaded.value, saved.ticks)).toBe(saved.hp);
  });

  it("refuses text that is not a log", () => {
    for (const text of [
      "not json",
      "{}",
      "[1, 2]",
      JSON.stringify([{ tick: -1, name: "Damage", payload: {} }]),
      JSON.stringify([{ tick: 0.5, name: "Damage", payload: {} }]),
      JSON.stringify([{ tick: 0, payload: {} }]),
      JSON.stringify([{ tick: 0, name: 7, payload: {} }]),
    ]) {
      expect(Exit.isFailure(Action.decodeLog(text)), text).toBe(true);
    }
    expect(Exit.isSuccess(Action.decodeLog("[]"))).toBe(true);
  });

  it("stops a replay at the first entry that no longer applies", () => {
    const saved = record();
    // Entry 0 is the checkpoint of the state the game started from; the four
    // actions follow it.
    const log = JSON.parse(saved.text) as any[];
    expect(log.map((entry) => entry.name)).toEqual([
      undefined,
      "Damage",
      "Damage",
      "Damage",
      "Rename",
    ]);

    // An edited save file: a hit far above what the schema allows.
    const edited = structuredClone(log);
    edited[2].payload.amount = 9999;
    let caught: unknown;
    try {
      replayInto(edited, saved.ticks);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(App.ReplayDiverged);
    expect((caught as App.ReplayDiverged).index).toBe(2);
    expect((caught as App.ReplayDiverged).tick).toBe(1);
    // It was enqueued, so the replay enqueues it too, and stops after the
    // tick in which its own rules refused what the game had accepted.
    expect((caught as App.ReplayDiverged).reason).toMatch(/amount/);
    expect((caught as Error).message).toMatch(
      /Log entry 2 \("Damage" at tick 1\) was refused on replay/
    );

    // An action this build of the game does not have.
    const renamed = structuredClone(log);
    renamed[1].name = "Smite";
    expect(() => replayInto(renamed, saved.ticks)).toThrow(
      /Log entry 1 \("Smite" at tick 0\)/
    );

    // Valid entries the rules refuse: the target is not in this game.
    const retargeted = structuredClone(log);
    retargeted[3].payload.target = 4000;
    expect(() => replayInto(retargeted, saved.ticks)).toThrow(/Log entry 3/);

    // Entries that could never be reached.
    const late = structuredClone(log);
    late[4].tick = 99;
    expect(() => replayInto(late, saved.ticks)).toThrow(
      /its tick \(99\) was never reached/
    );
  });
});
