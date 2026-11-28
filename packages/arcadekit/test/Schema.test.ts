import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { SchemaBinary } from "effect/encoding";

import { entityOf } from "../src/ecs/component.ts";
import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Field,
  Plugin,
  Query,
  Replay,
  Save,
  System,
  World,
} from "../src/index.ts";
import { Layout } from "../src/internal/recording.ts";
import { Message } from "../src/net/index.ts";
import { thrown, unwrap } from "./checks.ts";

const Health = Component.define("sc/Health", { hp: Field.i32 });

class NoSuchTarget extends Schema.TaggedError<NoSuchTarget>()("NoSuchTarget", {
  target: EntityId,
}) {}

const Damage = Action.define("Damage", {
  payload: Schema.Struct({
    target: EntityId,
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    // Not representable in JSON as it is: the log has to convert it.
    seed: Schema.BigInt,
    note: Schema.optional(Schema.String),
  }),
  error: NoSuchTarget,
});

const Rename = Action.define("Rename", {
  payload: Schema.Struct({ name: Schema.String }),
});
/** No payload: only a name. */
const Reset = Action.define("Reset");

const received: unknown[] = [];
const damage = Action.handler(Damage, function* (payload) {
  received.push(payload);
  const world = yield* World.writes(Health);
  const health = world.get(payload.target, Health);
  if (health === undefined) {
    return yield* NoSuchTarget.make({ target: payload.target });
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

/** How the game begins: with one thing to damage. */
const Target = Plugin.make("sc/Target", {
  setup: Effect.map(Commands.spawns(Health), (commands) => {
    commands.spawn(Health.of({ hp: 50 }));
  }),
});
const Game = App.define({
  plugins: [Target],
  handlers: [damage, rename, reset],
});
/** An app, its world, and the thing to damage, which the game begins with. */
const begin = <A extends App.Any, E>(make: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const app = yield* make;
    const [target] = (yield* app.read(
      Query.View(Query.all(Health))
    )).entities();
    assert(target !== undefined, "the game begins with a thing to damage");
    return { app, world: yield* app.read(World), target };
  });

const game = begin(App.make(Game));

const withApp = <A, T, E = never, E2 = never>(
  make: Effect.Effect<A, E>,
  use: (made: A) => Effect.Effect<T, E2>
) => Effect.flatMap(make, use);

/** The applied actions of a log, without the hash checks recorded among them. */
const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isHashCheck(entry));

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failure");
  }
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

describe("actions with a schema", () => {
  it.effect("infer the payload type and log the payload in its JSON form", () =>
    withApp(game, ({ app, target }) =>
      Effect.gen(function* () {
        received.length = 0;
        const exit = yield* Effect.exit(
          app.dispatch(Damage, {
            target,
            amount: 4,
            seed: 12_345_678_901_234_567_890n,
          })
        );
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
      })
    )
  );

  it.effect(
    "reject a payload the compiler accepts but the schema does not",
    () =>
      withApp(game, ({ app, world, target }) =>
        Effect.gen(function* () {
          received.length = 0;
          const exit = yield* Effect.exit(
            app.dispatch(Damage, {
              target,
              amount: 999,
              seed: 1n,
            })
          );
          const error = failure(exit);
          assert(error._tag === "ActionInvalidPayload");
          expect(error.action).toBe("Damage");
          expect(error.message).toMatch(/amount/);
          // The handler never ran, nothing changed, nothing was logged.
          expect(received).toEqual([]);
          expect(world.get(target, Health)).toEqual({ hp: 50 });
          expect(moves(app.actionLog)).toEqual([]);
        })
      )
  );

  it.effect("validate and convert payloads that arrive as data", () =>
    withApp(game, ({ app, target }) =>
      Effect.gen(function* () {
        received.length = 0;
        const exit = yield* Effect.exit(
          app.dispatchByName("Damage", {
            target,
            amount: 3,
            seed: "77",
            note: "from the network",
          })
        );
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
      })
    )
  );

  it.effect("turn every kind of bad input into a failure, never a crash", () =>
    withApp(game, ({ app, world, target }) =>
      Effect.gen(function* () {
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
          const error = failure(
            yield* Effect.exit(app.dispatchByName("Damage", payload))
          );
          assert(Schema.is(Action.InvalidPayload)(error), label);
          expect(error.message.length, label).toBeGreaterThan(0);
        }
        expect(
          failure(yield* Effect.exit(app.dispatchByName("Nope", {})))
        ).toEqual(Action.Unknown.make({ action: "Nope" }));
        expect(
          failure(yield* Effect.exit(app.dispatchByName("constructor", {})))
        ).toBeInstanceOf(Action.Unknown);

        // A well-formed payload can still be refused by the rules.
        const dead = entityOf(4000);
        expect(
          failure(
            yield* Effect.exit(
              app.dispatchByName("Damage", {
                target: dead,
                amount: 3,
                seed: "1",
              })
            )
          )
        ).toEqual(NoSuchTarget.make({ target: dead }));

        expect(received).toHaveLength(1); // only the last one reached the handler
        expect(world.get(target, Health)).toEqual({ hp: 50 });
        expect(moves(app.actionLog)).toEqual([]);
      })
    )
  );

  it.effect(
    "report bad queued input as events, and refuse a payload with no JSON form where it is enqueued",
    () =>
      Effect.gen(function* () {
        const rejected: string[] = [];
        const events: (typeof Action.Rejected.codec)["Type"][] = [];
        const Watch = System.tick("Watch", function* () {
          for (const event of (yield* Event.Reader(Action.Rejected)).read()) {
            rejected.push(`${event.action}: ${event.error._tag}`);
            events.push(event);
          }
        });
        const make = begin(
          App.make(
            App.define({
              plugins: [Target],
              systems: [Watch],
              handlers: [damage],
            })
          )
        );
        yield* withApp(make, ({ app, world, target }) =>
          Effect.gen(function* () {
            yield* app.enqueueByName("Damage", {
              target,
              amount: 5,
              seed: "9",
            });
            yield* app.enqueueByName("Damage", {
              target,
              amount: 500,
              seed: "9",
            });
            yield* app.enqueueByName("Teleport", { x: 1 });
            expect(
              yield* Effect.exit(
                app.enqueue(Damage, { target, amount: 2, seed: 9n })
              )
            ).toEqual(Exit.void);
            // Refused by its handler: no such target.
            yield* app.enqueue(Damage, {
              target: entityOf(999),
              amount: 3,
              seed: 7n,
            });
            // A payload its schema refuses has no JSON form to log or send: it is
            // refused where it is enqueued, and nothing is queued.
            expect(
              yield* Effect.exit(
                app.enqueue(Damage, { target, amount: -2, seed: 9n })
              )
            ).toEqual(
              Exit.fail(
                Action.InvalidPayload.make({
                  action: "Damage",
                  message: 'Expected a value between 1 and 10\n  at ["amount"]',
                })
              )
            );
            yield* app.tick(1);
            expect(world.get(target, Health)).toEqual({ hp: 43 });
            expect(rejected).toEqual([
              "Damage: ActionInvalidPayload",
              "Teleport: ActionUnknown",
              "Damage: NoSuchTarget",
            ]);
            // A refusal is data: the payload and the error in their JSON form. It
            // is written down and read back as it was.
            expect(events[2]).toEqual({
              action: "Damage",
              payload: { target: 999, amount: 3, seed: "7" },
              error: { _tag: "NoSuchTarget", target: 999 },
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
              yield* Effect.exit(
                app.dispatchByName("Damage", { target, amount: 500, seed: "9" })
              )
            );
            expect(moves(app.actionLog)[1]!.refused).toBe(
              Option.getOrThrow(invalid as Option.Option<Error>).message
            );
            expect(moves(app.actionLog)[1]!.refused).toMatch(/amount/);
            expect(moves(app.actionLog)[2]!.refused).toBe("ActionUnknown");
            expect(moves(app.actionLog)[3]!.payload).toEqual({
              target,
              amount: 2,
              seed: "9",
            });
          })
        );
      })
  );

  it.effect(
    "are all defined with one: a payload's schema, or only a name",
    () =>
      Effect.gen(function* () {
        // @ts-expect-error an action's payload is given by a schema, not a type
        void (() => Action.define<{ readonly name: string }>()("Typed"));
        yield* withApp(game, ({ app }) =>
          Effect.gen(function* () {
            const exit: Exit.Exit<string, Action.InvalidPayload> =
              yield* Effect.exit(app.dispatch(Rename, { name: "bob" }));
            expect(exit).toEqual(Exit.succeed("BOB"));
            // By name, a wrong shape is refused before the handler sees it.
            const wrong = failure(
              yield* Effect.exit(app.dispatchByName("Rename", { name: 42 }))
            );
            expect(wrong).toBeInstanceOf(Action.InvalidPayload);

            // An action with no payload is issued with nothing, logged as null, and
            // taken by name as null.
            resets.length = 0;
            expect(
              Exit.isSuccess(yield* Effect.exit(app.dispatch(Reset)))
            ).toBe(true);
            void (() =>
              // @ts-expect-error an action with a payload is issued with it
              app.dispatch(Rename));
            expect(
              Exit.isSuccess(
                yield* Effect.exit(app.dispatchByName("Reset", null))
              )
            ).toBe(true);
            expect(
              failure(yield* Effect.exit(app.dispatchByName("Reset", { x: 1 })))
            ).toBeInstanceOf(Action.InvalidPayload);
            expect(resets).toEqual([undefined, undefined]);
            expect(
              moves(app.actionLog)
                .filter((entry) => entry.name === "Reset")
                .map((entry) => entry.payload)
            ).toEqual([null, null]);
          })
        );
      })
  );

  it.effect(
    "enqueued by name with no payload, are refused at once, since the JSON form of none is null",
    () =>
      withApp(game, ({ app }) =>
        Effect.gen(function* () {
          resets.length = 0;
          // As typed in the browser's console: no payload at all.
          const none = yield* Effect.exit(
            app.enqueueByName("Reset", undefined)
          );
          yield* app.enqueueByName("Reset", null);
          yield* app.tick(1);
          // Neither queued nor logged: only the one with a JSON form.
          expect(
            moves(app.actionLog).map((entry) => [
              entry.name,
              entry.payload,
              entry.refused,
            ])
          ).toEqual([["Reset", null, undefined]]);
          expect(resets).toEqual([undefined]);
          expect(none).toEqual(
            Exit.fail(
              Action.InvalidPayload.make({
                action: "Reset",
                message: "Expected JSON value",
              })
            )
          );
          // So the game can still be written down.
          expect(
            Exit.isSuccess(
              yield* Effect.exit(Replay.encode(yield* Replay.record(app)))
            )
          ).toBe(true);
        })
      )
  );

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

  it.effect(
    "infer the payload type, and are emitted and read as ever, with no check",
    () =>
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const Emit = System.tick("Emit", function* () {
          // An event with no payload is emitted with none.
          (yield* Event.Emitter(Started)).emit();
          const hit = yield* Event.Emitter(Hit);
          // The payload is typed by the schema: a string here would not compile.
          hit.emit({
            target: entityOf(1),
            amount: 3,
            at: new Date(5),
            seed: 9n,
          });
          hit.emit({
            target: entityOf(1),
            // @ts-expect-error the schema says a whole number
            amount: "three",
            at: new Date(5),
            seed: 9n,
          });
          // Out of the schema's range, which only the schema knows: emitting
          // checks nothing, so that it stays a plain call inside a loop.
          hit.emit({
            target: entityOf(1),
            amount: 500,
            at: new Date(5),
            seed: 9n,
          });
        });
        const Read = System.tick("Read", function* () {
          for (const hit of (yield* Event.Reader(Hit)).read()) {
            seen.push(hit.amount);
          }
        });
        yield* withApp(App.make(App.define({ systems: [Emit, Read] })), (app) =>
          Effect.gen(function* () {
            yield* app.tick(1);
            expect(seen).toEqual([3, "three", 500]);
            expect((yield* app.inspect()).events["sc/Hit"]).toHaveLength(3);
          })
        );
        expect(Hit.name).toBe("sc/Hit");
        expect(Hit.codec).toBeDefined();
      })
  );

  it("are written as JSON and read back, checked against the schema", () => {
    const payload = {
      target: entityOf(7),
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
      expect(error).toBeInstanceOf(Event.Invalid);
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
      expect(error).toBeInstanceOf(Event.Invalid);
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

  it.effect(
    "are known by name in an app: two different events with one name are refused",
    () =>
      Effect.gen(function* () {
        const Twin = Event.define("sc/Hit", Schema.Number);
        const Both = System.tick("Both", function* () {
          (yield* Event.Emitter(Hit)).emit({
            target: entityOf(1),
            amount: 1,
            at: new Date(1),
            seed: 1n,
          });
          (yield* Event.Emitter(Twin)).emit(1);
        });
        yield* withApp(App.make(App.define({ systems: [Both] })), (app) =>
          Effect.gen(function* () {
            expect(yield* thrown(app.tick(1))).toThrow(
              /Two different events are both named "sc\/Hit"/
            );
          })
        );
        // Each on its own, in an app of its own, is fine.
        const Alone = System.tick("Alone", function* () {
          (yield* Event.Emitter(Twin)).emit(2);
        });
        const heard: number[] = [];
        const Hear = System.tick("Hear", function* () {
          heard.push(...(yield* Event.Reader(Twin)).read());
        });
        yield* withApp(
          App.make(App.define({ systems: [Alone, Hear] })),
          (app) =>
            Effect.gen(function* () {
              yield* app.tick(1);
              expect(heard).toEqual([2]);
            })
        );
        // An event that is only read is known by its name as well.
        const Shout = System.tick("Shout", function* () {
          (yield* Event.Emitter(Hit)).emit({
            target: entityOf(1),
            amount: 1,
            at: new Date(1),
            seed: 1n,
          });
        });
        yield* withApp(
          App.make(App.define({ systems: [Shout, Hear] })),
          (app) =>
            Effect.gen(function* () {
              expect(yield* thrown(app.tick(1))).toThrow(/both named/);
            })
        );
      })
  );
});

describe("saving and replaying", () => {
  const record = Effect.fnUntraced(function* () {
    return yield* withApp(game, ({ app, world, target }) =>
      Effect.gen(function* () {
        yield* app.dispatch(Damage, { target, amount: 4, seed: 1n });
        yield* app.tick(1);
        yield* app.enqueue(Damage, {
          target,
          amount: 10,
          seed: 2n,
          note: "big hit",
        });
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.dispatchByName("Damage", { target, amount: 1, seed: "3" });
        yield* app.dispatch(Rename, { name: "x" });
        yield* app.tick(1);
        return {
          bytes: yield* Replay.encode(yield* Replay.record(app)),
          hp: world.get(target, Health)!.hp,
        };
      })
    );
  });

  /** A recording's fields as its bytes hold them, each checked on its own. */
  const Written = SchemaBinary.toCodec(Layout);
  const fieldsIn = (bytes: Uint8Array<ArrayBuffer>) =>
    unwrap(Schema.decodeExit(Written)(bytes));
  /** Fields written as a recording's bytes, as a player edits a file. */
  const written = (fields: typeof Layout.Type) =>
    unwrap(Schema.encodeExit(Written)(fields));
  const replayInto = Effect.fnUntraced(function* (recording: Replay.Recording) {
    return yield* withApp(
      begin(Replay.verify(recording, Game)),
      ({ world, target }) => Effect.sync(() => world.get(target, Health)!.hp)
    );
  });
  /**
   * The recording in `bytes` with its log replaced by `log`, read back as a
   * player's edited file is: whatever the log says, the replay checks it.
   */
  const withLog = (
    bytes: Uint8Array<ArrayBuffer>,
    log: readonly Action.LogEntry[]
  ): Replay.Recording => {
    const read = Replay.decode(written({ ...fieldsIn(bytes), log }));
    assert(Exit.isSuccess(read));
    return read.value;
  };
  /** The action at `index` of `log`, with its payload, to edit. */
  const actionAt = (log: readonly Action.LogEntry[], index: number) => {
    const entry = log[index];
    assert(
      entry !== undefined &&
        !Action.isHashCheck(entry) &&
        Predicate.isObject(entry.payload)
    );
    return { ...entry, payload: entry.payload };
  };

  it.effect(
    "round-trips the recording through bytes and reproduces the game",
    () =>
      Effect.gen(function* () {
        const saved = yield* record();
        expect(saved.hp).toBe(35);
        expect(saved.bytes).toBeInstanceOf(Uint8Array);

        const loaded = Replay.decode(saved.bytes);
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
        expect(yield* replayInto(loaded.value)).toBe(saved.hp);
      })
  );

  it.effect("refuses bytes that are not a recording", () =>
    Effect.gen(function* () {
      /**
       * A recording of nothing that begins after `ticks` ticks: it holds the
       * save its game was at then.
       */
      const since = Effect.fnUntraced(function* (ticks: number) {
        return yield* withApp(game, ({ app }) =>
          Effect.gen(function* () {
            for (let tick = 0; tick < ticks; tick++) {
              yield* app.tick(1);
            }
            const save = yield* Effect.exit(Save.make(app));
            assert(Exit.isSuccess(save));
            return yield* Replay.encode(yield* Replay.record(app, save.value));
          })
        );
      });
      const valid = {
        ...fieldsIn(yield* since(1)),
        start: 1,
        end: 3,
        deltas: [{ tick: 1, delta: 1 }],
        log: [],
      };
      const AnyStart = SchemaBinary.toCodec(
        Schema.Struct({ ...Layout.fields, start: Schema.Int })
      );
      const anyStart = (fields: typeof AnyStart.Type) =>
        unwrap(Schema.encodeExit(AnyStart)(fields));
      for (const [what, bytes] of [
        ["text", new TextEncoder().encode("not a recording")],
        ["nothing", new Uint8Array()],
        ["noise", new Uint8Array([1, 2])],
        // A log out of order, or outside the recording.
        ["a log before it", written({ ...valid, log: [{ tick: 0, hash: 1 }] })],
        ["a log after it", written({ ...valid, log: [{ tick: 4, hash: 1 }] })],
        [
          "a log out of order",
          written({
            ...valid,
            log: [
              { tick: 2, hash: 1 },
              { tick: 1, hash: 1 },
            ],
          }),
        ],
        // A recording that ends before it begins, or at a tick that isn't one.
        ["a start that is no tick", anyStart({ ...valid, start: -1 })],
        ["an end before its start", written({ ...valid, end: 0 })],
        // Runs of deltas that don't cover it, in order.
        ["no deltas", written({ ...valid, deltas: [] })],
        [
          "deltas that begin late",
          written({ ...valid, deltas: [{ tick: 2, delta: 1 }] }),
        ],
        [
          "deltas of one tick twice",
          written({
            ...valid,
            deltas: [
              { tick: 1, delta: 1 },
              { tick: 1, delta: 2 },
            ],
          }),
        ],
        [
          "deltas past its end",
          written({
            ...valid,
            deltas: [
              { tick: 1, delta: 1 },
              { tick: 3, delta: 2 },
            ],
          }),
        ],
      ] as const) {
        expect(Exit.isFailure(Replay.decode(bytes)), what).toBe(true);
      }
      expect(Exit.isSuccess(Replay.decode(anyStart(valid)))).toBe(true);
      expect(Exit.isSuccess(Replay.decode(written(valid)))).toBe(true);
      expect(fieldsIn(yield* since(4))).toMatchObject({
        start: 4,
        end: 4,
        deltas: [],
        log: [],
      });
      expect(Exit.isSuccess(Replay.decode(yield* since(4)))).toBe(true);
    })
  );

  it.effect(
    "writes a message and a recording in the same bytes as before",
    () =>
      Effect.gen(function* () {
        // Bytes written once, so a change to how either is laid out, an upgrade
        // of Effect's SchemaBinary included, fails here and not on a peer.
        const hex = (bytes: Uint8Array): string =>
          Buffer.from(bytes).toString("hex");
        const bytesOf = (text: string): Uint8Array =>
          Uint8Array.from(Buffer.from(text, "hex"));
        const message = {
          from: "ada",
          tick: 12,
          actions: [{ name: "g/Move", payload: { dx: 1 } }],
          checkpoints: [{ tick: 11, hash: 4_294_967_295 }],
          made: { game: 99, hz: 60, peers: ["ada", "bob"], start: 0 },
          heard: 10,
          at: 12,
          lead: -3,
        };
        const messageBytes =
          "4421f218d829e05c42a21f070c010a000302160afeffffff1f1818036164611401120003107b226478223a317d0c672f4d6f76650f09020361646103626f62c60101780014";
        expect(hex(yield* Message.encode(message))).toBe(messageBytes);
        expect(Message.decode(bytesOf(messageBytes))).toEqual(
          Exit.succeed(message)
        );

        const recordingBytes =
          "73208895aad41f34022a09a8faeec319087b226478223a317da18ac6d52d00b0deb7ce4606672f4d6f7665a887b0f34a03616461070b02feffffff1fe1cab791280ef9cde0ca3200d1dacea33504b0d1d6d56218011600a4e1d8da050200a1f885d80610111111111111913ff1c7a6a76a80890f";
        const recording = Replay.decode(bytesOf(recordingBytes));
        assert(Exit.isSuccess(recording));
        expect(recording.value).toEqual({
          seed: 7,
          start: 0,
          end: 2,
          endHash: 123_456,
          deltas: [{ tick: 0, delta: 1 / 60 }],
          log: [
            { tick: 0, name: "g/Move", payload: { dx: 1 }, from: "ada" },
            { tick: 1, hash: 4_294_967_295 },
          ],
        });
        expect(hex(yield* Replay.encode(recording.value))).toBe(recordingBytes);
      })
  );

  it.effect("stops a replay at the first entry that no longer applies", () =>
    Effect.gen(function* () {
      const saved = yield* record();
      // Entry 0 is the hash check of the state the game started from; the four
      // actions follow it.
      const { log } = fieldsIn(saved.bytes);
      expect(
        log.map((entry) =>
          Action.isHashCheck(entry) ? "hash check" : entry.name
        )
      ).toEqual(["hash check", "Damage", "Damage", "Damage", "Rename"]);

      // An edited save file: a hit far above what the schema allows.
      const hit = actionAt(log, 2);
      const edited = log.with(2, {
        ...hit,
        payload: { ...hit.payload, amount: 9999 },
      });
      const caught = yield* Effect.flip(
        replayInto(withLog(saved.bytes, edited))
      );
      assert(caught instanceof Replay.Diverged, "the replay diverged");
      expect(caught.index).toBe(2);
      expect(caught.tick).toBe(1);
      // It was enqueued, so the replay enqueues it too, and stops after the
      // tick in which its own rules refused what the game had accepted.
      expect(caught.reason).toMatch(/amount/);
      expect(caught.message).toMatch(
        /Log entry 2 \("Damage" at tick 1\) was refused on replay/
      );

      // An action this build of the game does not have.
      const renamed = log.with(1, { ...actionAt(log, 1), name: "Smite" });
      expect(yield* thrown(replayInto(withLog(saved.bytes, renamed)))).toThrow(
        /Log entry 1 \("Smite" at tick 0\)/
      );

      // Valid entries the rules refuse: the target is not in this game.
      const struck = actionAt(log, 3);
      const retargeted = log.with(3, {
        ...struck,
        payload: { ...struck.payload, target: 4000 },
      });
      expect(
        yield* thrown(replayInto(withLog(saved.bytes, retargeted)))
      ).toThrow(/Log entry 3/);

      // An entry past the recording's end is refused before any replay.
      const late = log.with(4, { ...actionAt(log, 4), tick: 99 });
      expect(
        Exit.isFailure(
          Replay.decode(written({ ...fieldsIn(saved.bytes), log: late }))
        )
      ).toBe(true);
    })
  );
});
