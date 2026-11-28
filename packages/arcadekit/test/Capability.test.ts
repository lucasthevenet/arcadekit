import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";

import {
  App,
  Component,
  Event,
  Field,
  Query,
  Singleton,
  State,
  System,
  World,
} from "../src/index.ts";

const Position = Component.define("cp/Position", { x: Field.f32 });
const Moving = Query.all(Position).pipe(Query.writes(Position));
const Hit = Event.define("cp/Hit", Schema.Struct({ n: Schema.Number }));
const Score = Singleton.define(
  "cp/Score",
  { points: Field.u32 },
  { points: 0 }
);
const Mode = State.define("cp/Mode", ["menu", "play"]);
const Orbit = System.local(() => ({ angle: 0 }));

describe("a capability", () => {
  it.effect("finds the same thing yielded and run as an Effect", () =>
    Effect.gen(function* () {
      const same: boolean[] = [];
      const Tick = System.tick("cp/Tick", function* () {
        same.push(
          (yield* Query.View(Moving)) ===
            (yield* Effect.map(Query.View(Moving), (view) => view)),
          (yield* Singleton.Write(Score)) ===
            (yield* Effect.map(Singleton.Read(Score), (score) => score)),
          (yield* State.Reader(Mode)).value ===
            (yield* Effect.map(State.Setter(Mode), (mode) => mode.value))
        );
      });
      const Draw = System.frame("cp/Draw", function* () {
        same.push(
          (yield* System.Kept(Orbit)) ===
            (yield* Effect.map(System.Kept(Orbit), (orbit) => orbit))
        );
      });
      const app = yield* App.make(App.define({ systems: [Tick, Draw] }));
      yield* app.tick(1 / 60);
      yield* app.frame(0);
      expect(same).toEqual([true, true, true, true]);
    })
  );

  it.effect("is asked again by each system that yields it", () =>
    Effect.gen(function* () {
      const heard: number[] = [];
      const reader = Event.Reader(Hit);
      const Emit = System.tick("cp/Emit", function* () {
        (yield* Event.Emitter(Hit)).emit({ n: 1 });
      });
      const One = System.tick("cp/One", function* () {
        heard.push((yield* reader).read().length);
      });
      const Two = System.tick("cp/Two", function* () {
        heard.push((yield* reader).read().length);
      });
      const app = yield* App.make(App.define({ systems: [Emit, One, Two] }));
      yield* app.tick(1 / 60);
      // One capability kept in a constant, and each system reads from a place of its own.
      expect(heard).toEqual([1, 1]);
    })
  );

  it.effect(
    "throws at the line that asked, when what it looks up refuses",
    () =>
      Effect.gen(function* () {
        const Draw = System.frame("cp/Emits", function* () {
          // A frame system that emits doesn't compile. The cast is how one gets here.
          yield* Event.Emitter(Hit) as unknown as Effect.Effect<void>;
        });
        const app = yield* App.make(App.define({ systems: [Draw] }));
        const exit = yield* Effect.exit(app.frame(0));
        const error = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;
        assert(error instanceof Error);
        expect(error.message).toContain(
          "Event.Emitter(cp/Hit) was asked for outside the tick"
        );
        expect(error.stack).toContain("Capability.test.ts");
      })
  );
});

describe("a definition", () => {
  it("is plain data, and no Effect", () => {
    for (const definition of [Moving, Hit, Score, Mode, Orbit]) {
      expect(Effect.isEffect(definition)).toBe(false);
    }
    expect(JSON.parse(JSON.stringify(Hit))).toMatchObject({ name: "cp/Hit" });
    expect(Object.keys(Moving)).not.toContain("effect");
  });

  it("is not what a system yields", () => {
    expectTypeOf(Moving).not.toExtend<
      Effect.Effect<unknown, unknown, unknown>
    >();
    expectTypeOf(Hit).not.toExtend<Effect.Effect<unknown, unknown, unknown>>();
    expectTypeOf(Score).not.toExtend<
      Effect.Effect<unknown, unknown, unknown>
    >();
    const view = Query.View(Moving);
    expectTypeOf<Effect.Services<typeof view>>().toEqualTypeOf<
      World | Query.Writes<"cp/Position">
    >();
  });
});
