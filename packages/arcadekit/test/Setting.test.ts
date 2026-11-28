import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, pipe } from "effect";

import {
  Action,
  App,
  Field,
  Plugin,
  Setting,
  Singleton,
  System,
  World,
} from "../src/index.ts";

const Volume = Setting.define(
  "st/Volume",
  Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  1
);
const Keys = Setting.define("st/Keys", Schema.Struct({ jump: Schema.String }), {
  jump: "Space",
});

describe("a setting", () => {
  it.effect(
    "is its initial value until it is set, and keeps what it is set to through a reload",
    () =>
      Effect.gen(function* () {
        const kept = Setting.makeMemory();
        const visit = <A, E>(
          effect: Effect.Effect<A, E, Setting.Store>
        ): Effect.Effect<A, E> => Effect.provide(effect, Setting.layer(kept));
        expect(yield* visit(Setting.get(Volume))).toBe(1);
        expect(yield* visit(Setting.get(Keys))).toEqual({ jump: "Space" });
        yield* visit(Setting.set(Volume, 0.25));
        yield* visit(pipe(Keys, Setting.set({ jump: "KeyW" })));
        expect(yield* visit(Setting.get(Volume))).toBe(0.25);
        // Another visit, which reads what the first one kept.
        expect(yield* visit(Setting.get(Volume))).toBe(0.25);
        expect(yield* visit(Setting.get(Keys))).toEqual({ jump: "KeyW" });
        expect(kept.get("st/Keys")).toBe('{"jump":"KeyW"}');
        // Another program's settings are its own.
        expect(
          yield* Effect.provide(
            Setting.get(Volume),
            Setting.layer(Setting.makeMemory())
          )
        ).toBe(1);
      })
  );

  it.effect(
    "refuses a value its schema doesn't take, and keeps the one it had",
    () =>
      Effect.gen(function* () {
        const set = yield* Effect.exit(Setting.set(Volume, 3));
        expect(set).toEqual(
          Exit.fail(
            new Setting.Invalid({
              key: "st/Volume",
              message:
                'The setting "st/Volume" doesn\'t take this value: Expected a value between 0 and 1',
            })
          )
        );
        expect(yield* Setting.get(Volume)).toBe(1);
      }).pipe(Effect.provide(Setting.layer(Setting.makeMemory())))
  );

  it.effect(
    "fails with the store that can't keep it, and keeps the value it had",
    () =>
      Effect.gen(function* () {
        const full: Setting.StoreShape = {
          get: () => undefined,
          set: (key) =>
            Effect.fail(
              new Setting.StoreFailed({ key, message: "It is full." })
            ),
        };
        const set = yield* Effect.exit(
          Setting.set(Volume, 0.5).pipe(Effect.provide(Setting.layer(full)))
        );
        expect(set).toEqual(
          Exit.fail(
            new Setting.StoreFailed({
              key: "st/Volume",
              message: "It is full.",
            })
          )
        );
        expect(
          yield* Effect.provide(Setting.get(Volume), Setting.layer(full))
        ).toBe(1);
      })
  );

  it.effect(
    "fails to read what its schema no longer takes, or text that isn't JSON, until it is set again",
    () =>
      Effect.gen(function* () {
        expect(yield* Effect.exit(Setting.get(Volume))).toEqual(
          Exit.fail(
            new Setting.Invalid({
              key: "st/Volume",
              message:
                'The setting "st/Volume" keeps a value its schema doesn\'t take: Expected a value between 0 and 1. Set it again, or read its initial value in its place with Effect.orElseSucceed.',
            })
          )
        );
        expect(yield* Effect.exit(Setting.get(Keys))).toEqual(
          Exit.fail(
            new Setting.Invalid({
              key: "st/Keys",
              message:
                'The setting "st/Keys" keeps a value its schema doesn\'t take: Expected a valid JSON string. Set it again, or read its initial value in its place with Effect.orElseSucceed.',
            })
          )
        );
        expect(
          yield* Effect.orElseSucceed(Setting.get(Volume), () => Volume.initial)
        ).toBe(1);
        yield* Setting.set(Volume, 0.5);
        expect(yield* Setting.get(Volume)).toBe(0.5);
      }).pipe(
        Effect.provide(
          Setting.layer(
            Setting.makeMemory({ "st/Volume": "3", "st/Keys": "{ not json" })
          )
        )
      )
  );

  it.effect(
    "is read in the frame and input stages, and the game hashes the same whatever it is",
    () =>
      Effect.gen(function* () {
        const Score = Singleton.define(
          "st/Score",
          { points: Field.i32 },
          { points: 0 }
        );
        const Add = Action.define("st/Add", Schema.Struct({}));
        const heard: number[] = [];
        const Game = App.define({
          systems: [
            System.frame("st/Hear", function* () {
              heard.push(yield* Setting.get(Volume));
            }),
            System.input("st/Bound", function* () {
              const { jump } = yield* Setting.get(Keys);
              if (jump === "KeyW") {
                (yield* Action.Actions).enqueue(Add, {});
              }
            }),
          ],
          handlers: [
            Action.handler(Add, function* () {
              (yield* Singleton.Write(Score)).points++;
            }),
          ],
        });
        const play = Effect.fnUntraced(function* (kept: Setting.StoreShape) {
          const app = yield* App.make(Game).pipe(
            Effect.provide(Setting.layer(kept))
          );
          for (let i = 0; i < 3; i++) {
            yield* app.input();
            yield* app.tick(1 / 60);
            yield* app.frame();
          }
          return {
            hash: (yield* app.read(World)).hash(),
            points: (yield* app.read(Singleton.Read(Score))).points,
          };
        });
        const quiet = yield* play(Setting.makeMemory({ "st/Volume": "0.5" }));
        expect(heard).toEqual([0.5, 0.5, 0.5]);
        const loud = yield* play(Setting.makeMemory());
        expect(heard.slice(3)).toEqual([1, 1, 1]);
        expect(loud).toEqual(quiet);
        // What changes the game goes in as an action, which the log holds.
        const bound = yield* play(
          Setting.makeMemory({ "st/Keys": '{"jump":"KeyW"}' })
        );
        expect(bound.points).toBe(3);
        expect(bound.hash).not.toBe(quiet.hash);
      })
  );

  it("is not for the code of the tick to read", () => {
    const Reads = System.tick(
      "st/Reads",
      // @ts-expect-error a setting is outside the world, which a tick reads
      function* () {
        yield* Setting.get(Volume);
      }
    );
    const Add = Action.define("st/Pick", Schema.Struct({}));
    const picked = Action.handler(
      Add,
      // @ts-expect-error nor in a handler, which runs in the tick
      function* () {
        yield* Setting.get(Keys);
      }
    );
    Plugin.make("st/Setup", {
      // @ts-expect-error nor in a plugin's setup, which runs as a tick does
      setup: Effect.asVoid(Setting.get(Volume)),
    });
    expect([Reads, picked]).toHaveLength(2);
  });
});
