import { Cause, Data, Effect, Exit, Option, Schema } from "effect";
import type { Scope } from "effect";
import { assert, describe, expect, it } from "vitest";

import {
  Action,
  App,
  Component,
  EntityId,
  Event,
  Field,
  Journal,
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

const Rename = Action.define("Rename", Schema.Struct({ name: Schema.String }));
/** No payload: only a name. */
const Reset = Action.define("Reset");

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
const resets: unknown[] = [];
const reset = Action.handler(Reset, function* (payload) {
  resets.push(payload);
});

const game = Effect.map(
  App.make(App.define({ handlers: [damage, rename, reset] })),
  (app) => {
    const target = app.world.spawn(Health.of({ hp: 50 }));
    return { app, target };
  }
);

const withApp = <A, T>(
  make: Effect.Effect<A, never, Scope.Scope>,
  use: (made: A) => T
): T => Effect.runSync(Effect.scoped(Effect.map(make, use)));

/** The applied actions of a log, without the checkpoints recorded among them. */
const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failure");
  }
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
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
      assert(error instanceof Action.InvalidPayload);
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
        assert(error instanceof Action.InvalidPayload, label);
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

  it("report bad queued input as events, and refuse a payload with no JSON form where it is enqueued", () => {
    const rejected: string[] = [];
    const events: (typeof Action.Rejected.codec)["Type"][] = [];
    const Watch = System.make("Watch", function* () {
      for (const event of (yield* Action.Rejected).read()) {
        rejected.push(`${event.action}: ${event.error._tag}`);
        events.push(event);
      }
    });
    const make = Effect.map(
      App.make(App.define({ systems: [Watch], handlers: [damage] })),
      (app) => {
        const target = app.world.spawn(Health.of({ hp: 50 }));
        return { app, target };
      }
    );
    withApp(make, ({ app, target }) => {
      app.enqueueByName("Damage", { target, amount: 5, seed: "9" });
      app.enqueueByName("Damage", { target, amount: 500, seed: "9" });
      app.enqueueByName("Teleport", { x: 1 });
      expect(app.enqueue(Damage, { target, amount: 2, seed: 9n })).toEqual(
        Exit.void
      );
      // Refused by its handler: no such target.
      app.enqueue(Damage, { target: 999 as Entity, amount: 3, seed: 7n });
      // A payload its schema refuses has no JSON form to log or send: it is
      // refused where it is enqueued, and nothing is queued.
      expect(app.enqueue(Damage, { target, amount: -2, seed: 9n })).toEqual(
        Exit.fail(
          new Action.InvalidPayload({
            action: "Damage",
            message: 'Expected a value between 1 and 10\n  at ["amount"]',
          })
        )
      );
      app.tick(1);
      expect(app.world.get(target, Health)).toEqual({ hp: 43 });
      expect(rejected).toEqual([
        "Damage: InvalidPayload",
        "Teleport: UnknownAction",
        "Damage: NoSuchTarget",
      ]);
      // A refusal is data: the payload in its JSON form, the error as its tag
      // and message. It is written down and read back as it was.
      expect(events[2]).toEqual({
        action: "Damage",
        payload: { target: 999, amount: 3, seed: "7" },
        error: { _tag: "NoSuchTarget", message: "" },
        from: undefined,
      });
      for (const event of events) {
        const encoded = Event.encode(Action.Rejected, event);
        assert(Exit.isSuccess(encoded));
        const json: unknown = JSON.parse(JSON.stringify(encoded.value));
        expect(Event.decode(Action.Rejected, json)).toEqual(
          Exit.succeed(event)
        );
      }
      // What was enqueued is in the log as it arrived, with what became of
      // it.
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
        ["Damage", 3, true, "refused"],
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

  it("are all defined with one: a payload's schema, or only a name", () => {
    // @ts-expect-error an action's payload is given by a schema, not a type
    void (() => Action.define<{ readonly name: string }>()("Typed"));
    withApp(game, ({ app }) => {
      const exit: Exit.Exit<string, Action.InvalidPayload> = app.dispatch(
        Rename,
        { name: "bob" }
      );
      expect(exit).toEqual(Exit.succeed("BOB"));
      // By name, a wrong shape is refused before the handler sees it.
      const wrong = failure(app.dispatchByName("Rename", { name: 42 }));
      expect(wrong).toBeInstanceOf(Action.InvalidPayload);

      // An action with no payload is issued with nothing, logged as null, and
      // taken by name as null.
      resets.length = 0;
      expect(Exit.isSuccess(app.dispatch(Reset, undefined))).toBe(true);
      expect(Exit.isSuccess(app.dispatchByName("Reset", null))).toBe(true);
      expect(failure(app.dispatchByName("Reset", { x: 1 }))).toBeInstanceOf(
        Action.InvalidPayload
      );
      expect(resets).toEqual([undefined, undefined]);
      expect(
        moves(app.actionLog)
          .filter((entry) => entry.name === "Reset")
          .map((entry) => entry.payload)
      ).toEqual([null, null]);
    });
  });

  it("check entity ids for shape", () => {
    const ok = Schema.decodeUnknownExit(EntityId);
    expect(Exit.isSuccess(ok(0))).toBe(true);
    expect(Exit.isSuccess(ok(4_294_967_295))).toBe(true);
    // The id of an entity whose slot was given out 1,024 times, and the
    // largest there is: an id is a whole number below 2^53.
    expect(Exit.isSuccess(ok(4_294_967_296))).toBe(true);
    expect(Exit.isSuccess(ok(2 ** 53 - 1))).toBe(true);
    for (const bad of [-1, 2 ** 53, 1.5, Number.NaN, "7", null]) {
      expect(Exit.isFailure(ok(bad))).toBe(true);
    }
  });
});

describe("events with a schema", () => {
  const Hit = Event.define(
    "sc/Hit",
    Schema.Struct({
      target: EntityId,
      amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
      at: Schema.Date,
      seed: Schema.BigInt,
      note: Schema.optional(Schema.String),
    })
  );
  /** No payload: only a name. */
  const Started = Event.define("sc/Started");

  it("infer the payload type, and are emitted and read as ever, with no check", () => {
    const seen: unknown[] = [];
    const Emit = System.make("Emit", function* () {
      const hit = yield* Hit;
      // The payload is typed by the schema: a string here would not compile.
      hit.emit({ target: 1 as Entity, amount: 3, at: new Date(5), seed: 9n });
      hit.emit({
        target: 1 as Entity,
        // @ts-expect-error the schema says a whole number
        amount: "three",
        at: new Date(5),
        seed: 9n,
      });
      // Out of the schema's range, which only the schema knows: emitting
      // checks nothing, so that it stays a plain call inside a loop.
      hit.emit({ target: 1 as Entity, amount: 500, at: new Date(5), seed: 9n });
    });
    const Read = System.make("Read", function* () {
      for (const hit of (yield* Hit).read()) {
        seen.push(hit.amount);
      }
    });
    withApp(App.make(App.define({ systems: [Emit, Read] })), (app) => {
      app.tick(1);
      expect(seen).toEqual([3, "three", 500]);
      expect(app.events.pending(Hit)).toBe(3);
    });
    expect(Hit.name).toBe("sc/Hit");
    expect(Hit.codec).toBeDefined();
  });

  it("are written as JSON and read back, checked against the schema", () => {
    const payload = {
      target: 7 as Entity,
      amount: 3,
      at: new Date("2026-11-15T12:00:00.000Z"),
      seed: 12_345_678_901_234_567_890n,
    };
    const encoded = Event.encode(Hit, payload);
    expect(encoded).toEqual(
      Exit.succeed({
        target: 7,
        amount: 3,
        at: "2026-11-15T12:00:00.000Z",
        seed: "12345678901234567890",
      })
    );
    // JSON all the way: text and back.
    const text = JSON.stringify(Exit.isSuccess(encoded) && encoded.value);
    expect(Event.decode(Hit, JSON.parse(text))).toEqual(Exit.succeed(payload));

    for (const bad of [
      { ...payload, amount: 500 },
      { ...payload, at: new Date(Number.NaN) },
    ]) {
      const error = failure(Event.encode(Hit, bad));
      expect(error).toBeInstanceOf(Event.InvalidEvent);
      expect(error.event).toBe("sc/Hit");
    }
    for (const bad of [
      { target: 7, amount: 500, at: "2026-11-15T12:00:00.000Z", seed: "1" },
      { target: 7, amount: 3, at: "yesterday", seed: "1" },
      { target: 7, amount: 3, at: "2026-11-15T12:00:00.000Z" },
      "not an object",
      null,
    ]) {
      const error = failure(Event.decode(Hit, bad));
      expect(error).toBeInstanceOf(Event.InvalidEvent);
      expect(error.event).toBe("sc/Hit");
      expect(error.message.length).toBeGreaterThan(0);
    }
    expect(
      failure(Event.decode(Hit, { ...payload, amount: 500 })).message
    ).toMatch(/amount/);
  });

  it("all have one: a payload's schema, or only a name", () => {
    // @ts-expect-error an event's payload is given by a schema, not a type
    void (() => Event.define<{ readonly n: number }>("sc/Typed"));
    expect(Event.encode(Started, undefined)).toEqual(Exit.succeed(null));
    expect(Event.decode(Started, null)).toEqual(Exit.succeed(undefined));
    expect(failure(Event.decode(Started, { n: 1 })).event).toBe("sc/Started");
  });

  it("are known by name in an app: two different events with one name are refused", () => {
    const Twin = Event.define("sc/Hit", Schema.Number);
    const Both = System.make("Both", function* () {
      (yield* Hit).emit({
        target: 1 as Entity,
        amount: 1,
        at: new Date(1),
        seed: 1n,
      });
      (yield* Twin).emit(1);
    });
    withApp(App.make(App.define({ systems: [Both] })), (app) => {
      expect(() => app.tick(1)).toThrow(
        /Two different events are both named "sc\/Hit"/
      );
    });
    // Each on its own, in an app of its own, is fine.
    const Alone = System.make("Alone", function* () {
      (yield* Twin).emit(2);
    });
    withApp(App.make(App.define({ systems: [Alone] })), (app) => {
      app.tick(1);
      expect(app.events.pending(Twin)).toBe(1);
    });
    withApp(App.make(App.define({})), (app) => {
      expect(app.events.pending(Hit)).toBe(0);
      expect(() => app.events.emit(Twin, 1)).toThrow(/both named/);
      expect(() => app.events.pending(Twin)).toThrow(/both named/);
    });
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
        text: Journal.encode(app.record()),
        hp: app.world.get(target, Health)!.hp,
      };
    });

  /** A log entry as its JSON has it, which a player can edit into anything. */
  interface Written {
    tick: number;
    name?: string;
    payload?: Record<string, unknown>;
    hash?: number;
  }
  /** A recording as its JSON has it, with a log of written entries. */
  type WrittenRecording = Omit<Journal.Recording, "log"> & {
    log: Written[];
  };
  const replayInto = (recording: Journal.Recording | WrittenRecording) =>
    withApp(game, ({ app, target }) => {
      // Whatever the file says: the replay is what checks it.
      Journal.replay(app, recording as Journal.Recording);
      return app.world.get(target, Health)!.hp;
    });

  it("round-trips the recording through text and reproduces the game", () => {
    const saved = record();
    expect(saved.hp).toBe(35);
    expect(saved.text).toBeTypeOf("string");

    const loaded = Journal.decode(saved.text);
    expect(Exit.isSuccess(loaded)).toBe(true);
    if (!Exit.isSuccess(loaded)) {
      return;
    }
    expect(
      moves(loaded.value.log).map((entry) => `${entry.tick}:${entry.name}`)
    ).toEqual(["0:Damage", "1:Damage", "3:Damage", "3:Rename"]);
    expect(loaded.value).toMatchObject({
      start: 0,
      end: 4,
      deltas: [{ tick: 0, delta: 1 }],
    });
    expect(replayInto(loaded.value)).toBe(saved.hp);
  });

  it("refuses text that is not a recording", () => {
    const valid = {
      start: 1,
      end: 3,
      deltas: [{ tick: 1, delta: 1 }],
      log: [] as unknown[],
    };
    for (const text of [
      "not json",
      "{}",
      "[1, 2]",
      JSON.stringify({ ...valid, log: [{ tick: 1.5, hash: 3 }] }),
      JSON.stringify({ ...valid, log: [{ tick: 1, payload: {} }] }),
      JSON.stringify({ ...valid, log: [{ tick: 1, name: 7, payload: {} }] }),
      // A log out of order, or outside the recording.
      JSON.stringify({ ...valid, log: [{ tick: 0, hash: 1 }] }),
      JSON.stringify({ ...valid, log: [{ tick: 4, hash: 1 }] }),
      JSON.stringify({
        ...valid,
        log: [
          { tick: 2, hash: 1 },
          { tick: 1, hash: 1 },
        ],
      }),
      // A recording that ends before it begins, or at a tick that isn't one.
      JSON.stringify({ ...valid, start: -1 }),
      JSON.stringify({ ...valid, end: 0 }),
      // Runs of deltas that don't cover it, in order.
      JSON.stringify({ ...valid, deltas: [] }),
      JSON.stringify({ ...valid, deltas: [{ tick: 2, delta: 1 }] }),
      JSON.stringify({
        ...valid,
        deltas: [
          { tick: 1, delta: 1 },
          { tick: 1, delta: 2 },
        ],
      }),
      JSON.stringify({
        ...valid,
        deltas: [
          { tick: 1, delta: 1 },
          { tick: 3, delta: 2 },
        ],
      }),
      JSON.stringify({ ...valid, deltas: [{ tick: 1, delta: null }] }),
    ]) {
      expect(Exit.isFailure(Journal.decode(text)), text).toBe(true);
    }
    expect(Exit.isSuccess(Journal.decode(JSON.stringify(valid)))).toBe(true);
    expect(
      Exit.isSuccess(
        Journal.decode(
          JSON.stringify({ start: 4, end: 4, deltas: [], log: [] })
        )
      )
    ).toBe(true);
  });

  it("stops a replay at the first entry that no longer applies", () => {
    const saved = record();
    // Entry 0 is the checkpoint of the state the game started from; the four
    // actions follow it.
    const recording = JSON.parse(saved.text) as WrittenRecording;
    const { log } = recording;
    expect(log.map((entry) => entry.name)).toEqual([
      undefined,
      "Damage",
      "Damage",
      "Damage",
      "Rename",
    ]);

    // An edited save file: a hit far above what the schema allows.
    const edited = structuredClone(log);
    edited[2]!.payload!.amount = 9999;
    let caught: unknown;
    try {
      replayInto({ ...recording, log: edited });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Journal.ReplayDiverged);
    expect((caught as Journal.ReplayDiverged).index).toBe(2);
    expect((caught as Journal.ReplayDiverged).tick).toBe(1);
    // It was enqueued, so the replay enqueues it too, and stops after the
    // tick in which its own rules refused what the game had accepted.
    expect((caught as Journal.ReplayDiverged).reason).toMatch(/amount/);
    expect((caught as Error).message).toMatch(
      /Log entry 2 \("Damage" at tick 1\) was refused on replay/
    );

    // An action this build of the game does not have.
    const renamed = structuredClone(log);
    renamed[1]!.name = "Smite";
    expect(() => replayInto({ ...recording, log: renamed })).toThrow(
      /Log entry 1 \("Smite" at tick 0\)/
    );

    // Valid entries the rules refuse: the target is not in this game.
    const retargeted = structuredClone(log);
    retargeted[3]!.payload!.target = 4000;
    expect(() => replayInto({ ...recording, log: retargeted })).toThrow(
      /Log entry 3/
    );

    // Entries that could never be reached.
    const late = structuredClone(log);
    late[4]!.tick = 99;
    expect(() => replayInto({ ...recording, log: late })).toThrow(
      /its tick \(99\) was never reached/
    );
  });
});
