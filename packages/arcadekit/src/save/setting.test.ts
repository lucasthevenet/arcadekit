import { Effect, Layer, Logger, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Setting } from "./index";
import type { Stored } from "./index";

// Settings run against an in-memory KeyValueStore, never real localStorage.

const Controls = Schema.Struct({
  sensitivity: Schema.Finite.check(
    Schema.isBetween({ minimum: 1, maximum: 6 })
  ),
  invertY: Schema.Boolean,
});
type Controls = typeof Controls.Type;

const defaultControls: Controls = { sensitivity: 3, invertY: false };

class GameControls extends Setting("GameControls", {
  storageKey: "arcadekit/test-game/controls",
  schema: Controls,
  default: defaultControls,
}) {}

const Progress = Schema.Struct({
  offered: Schema.Boolean,
  completed: Schema.Boolean,
});

class GameTutorial extends Setting("GameTutorial", {
  storageKey: "arcadekit/test-game/tutorial",
  schema: Progress,
  default: { offered: false, completed: false },
  merge: (stored, written) => ({
    offered: stored.offered || written.offered,
    completed: stored.completed || written.completed,
  }),
}) {}

/** A value that only grows, with a default that is not its smallest. */
class GameBest extends Setting("GameBest", {
  storageKey: "arcadekit/test-game/best",
  schema: Schema.Struct({ best: Schema.Int }),
  default: { best: 10 },
  merge: (stored, written) => ({ best: Math.max(stored.best, written.best) }),
}) {}

/** A setting whose merge builds a member of a tagged union. */
class GameScreen extends Setting("GameScreen", {
  storageKey: "arcadekit/test-game/screen",
  schema: Schema.Union([
    Schema.TaggedStruct("Windowed", { width: Schema.Int }),
    Schema.TaggedStruct("Fullscreen", {}),
  ]),
  default: { _tag: "Windowed", width: 800 },
  merge: (stored, written) =>
    stored._tag === "Fullscreen" ? { _tag: "Fullscreen" } : written,
}) {}

class ControlsClass extends Schema.Class<ControlsClass>("ControlsClass")({
  invertY: Schema.Boolean,
}) {}

/** Declares a setting over a Schema class with an instance as its default, or a plain object. */
const declareOverClass = (instance: boolean) =>
  // oxlint-disable-next-line declaration/class -- A test declares what a builder must refuse.
  Setting("ClassControls", {
    storageKey: "arcadekit/test-game/class-controls",
    schema: ControlsClass,
    default: instance
      ? new ControlsClass({ invertY: false })
      : { invertY: false },
  });

const KEY = GameControls.definition.storageKey;

const failing = (method: "get" | "set") =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      return {
        ...store,
        [method]: (key: string) =>
          Effect.fail(
            new KeyValueStore.KeyValueStoreError({
              message: "Storage is broken",
              method,
              key,
            })
          ),
      };
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory));

/** A store that counts its reads, as they run. */
const counting = () => {
  const reads: string[] = [];
  const layer = Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      return {
        ...store,
        get: (key: string) =>
          Effect.suspend(() => {
            reads.push(key);
            return store.get(key);
          }),
      };
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory));
  return { layer, reads };
};

const run = async <A>(
  program: (
    controls: Stored<Controls>
  ) => Effect.Effect<A, never, KeyValueStore.KeyValueStore>,
  options: {
    readonly stored?: string;
    readonly storage?: Layer.Layer<KeyValueStore.KeyValueStore>;
  } = {}
) => {
  const warnings: unknown[] = [];
  const logger = Logger.make((log) => {
    warnings.push(log.message);
  });
  const result = await Effect.gen(function* () {
    if (options.stored !== undefined) {
      yield* (yield* KeyValueStore.KeyValueStore)
        .set(KEY, options.stored)
        .pipe(Effect.orDie);
    }
    return yield* program(yield* GameControls);
  }).pipe(
    Effect.provide(
      GameControls.layer.pipe(
        Layer.provideMerge(options.storage ?? KeyValueStore.layerMemory)
      )
    ),
    Effect.provide(Logger.layer([logger])),
    Effect.runPromise
  );
  return { result, warnings };
};

const readRaw = (key: string) =>
  Effect.gen(function* () {
    return yield* (yield* KeyValueStore.KeyValueStore).get(key);
  }).pipe(Effect.orDie);

const fast: Controls = { sensitivity: 6, invertY: true };

/** Declares a setting whose default the types can't judge, to reach the builder's throw. */
const declareWithSensitivity = (sensitivity: number) =>
  // oxlint-disable-next-line declaration/class -- A test declares what a builder must refuse.
  Setting("LooseControls", {
    storageKey: "arcadekit/test-game/loose-controls",
    schema: Controls,
    default: { sensitivity, invertY: false },
  });

/** Settings whose definitions show a mistake: each is a type error. */
const declareMistyped = () => [
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Setting("WrongDefault", {
    storageKey: "arcadekit/test-game/wrong-default",
    schema: Controls,
    // @ts-expect-error -- the Schema decides the value, and it has no `invert`.
    default: { sensitivity: 3, invert: false },
  }),
  // @ts-expect-error -- a setting has a value before the player changes it.
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Setting("NoDefault", {
    storageKey: "arcadekit/test-game/no-default",
    schema: Controls,
  }),
  // @ts-expect-error -- a setting that replaces leaves `merge` out.
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Setting("UndefinedMerge", {
    storageKey: "arcadekit/test-game/undefined-merge",
    schema: Controls,
    default: defaultControls,
    merge: undefined,
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Setting("PromiseMerge", {
    storageKey: "arcadekit/test-game/promise-merge",
    schema: Controls,
    default: defaultControls,
    // @ts-expect-error -- a merge gives a value, now.
    merge: (stored) => Promise.resolve(stored),
  }),
];

describe(Setting, () => {
  it("reads as its default when missing", async () => {
    const { result, warnings } = await run((controls) => controls.read);
    expect(result).toStrictEqual(defaultControls);
    expect(warnings).toStrictEqual([]);
  });

  it("reads back what was written, last write winning, stored as its Schema encodes it", async () => {
    const { result } = await run((controls) =>
      Effect.andThen(
        Effect.all([controls.write(defaultControls), controls.write(fast)]),
        Effect.all([controls.read, readRaw(KEY)])
      )
    );
    expect(result).toStrictEqual([fast, JSON.stringify(fast)]);
  });

  it("gives what it stored, and reads nothing to replace a value", async () => {
    const { layer, reads } = counting();
    const written = await Effect.gen(function* () {
      return yield* (yield* GameControls).write(fast);
    }).pipe(
      Effect.provide(GameControls.layer.pipe(Layer.provide(layer))),
      Effect.runPromise
    );
    expect([written, reads]).toStrictEqual([fast, []]);
  });

  it.each([
    ["not JSON", "{not json"],
    ["a value out of range", JSON.stringify({ ...fast, sensitivity: 9 })],
    ["a missing field", JSON.stringify({ sensitivity: 2 })],
  ])(
    "reads %s as its default, logs it by name and leaves it where it is",
    async (_, stored) => {
      const { result, warnings } = await run(
        (controls) =>
          Effect.all([controls.read, readRaw(KEY), readRaw(`${KEY}/corrupt`)]),
        { stored }
      );
      expect(result).toStrictEqual([defaultControls, stored, undefined]);
      expect(warnings).toStrictEqual([
        [
          `Setting "GameControls" can't be read. Play goes on without it.`,
          expect.any(String),
        ],
      ]);
    }
  );

  it("reads a store that can't be read as its default", async () => {
    const { result, warnings } = await run((controls) => controls.read, {
      storage: failing("get"),
    });
    expect(result).toStrictEqual(defaultControls);
    expect(warnings).toHaveLength(1);
  });

  it("logs and drops a failed write", async () => {
    const { result, warnings } = await run((controls) => controls.write(fast), {
      storage: failing("set"),
    });
    expect(result).toStrictEqual(fast);
    expect(warnings).toStrictEqual([
      [`Setting "GameControls" can't be written.`, expect.any(String)],
    ]);
  });

  it("with a merge, writes what is stored and what is written as one", async () => {
    const result = await Effect.gen(function* () {
      const tutorial = yield* GameTutorial;
      const store = yield* KeyValueStore.KeyValueStore;
      // Another tab answered the offer after this one read its progress.
      yield* store.set(
        GameTutorial.definition.storageKey,
        JSON.stringify({ offered: true, completed: false })
      );
      const written = yield* tutorial.write({
        offered: false,
        completed: true,
      });
      return [written, yield* tutorial.read];
    }).pipe(
      Effect.provide(
        GameTutorial.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
      ),
      Effect.orDie,
      Effect.runPromise
    );
    expect(result).toStrictEqual([
      { offered: true, completed: true },
      { offered: true, completed: true },
    ]);
  });

  it("with a merge and nothing stored, merges what is written with its default", async () => {
    const result = await Effect.gen(function* () {
      const best = yield* GameBest;
      return [
        yield* best.read,
        yield* best.write({ best: 3 }),
        yield* best.read,
      ];
    }).pipe(
      Effect.provide(
        GameBest.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
      ),
      Effect.runPromise
    );
    expect(result).toStrictEqual([{ best: 10 }, { best: 10 }, { best: 10 }]);
  });

  it("keeps a literal in a value its merge builds", () => {
    expectTypeOf(GameScreen.definition.default).toEqualTypeOf<
      | { readonly _tag: "Windowed"; readonly width: number }
      | { readonly _tag: "Fullscreen" }
    >();
    expect(GameScreen.settingName).toBe("GameScreen");
  });

  it("is its service's key, named for the class, and two settings are two services", () => {
    expect([
      GameControls.kind,
      GameControls.settingName,
      GameControls.key,
      GameTutorial.key,
    ]).toStrictEqual([
      "Setting",
      "GameControls",
      "arcadekit/save/Setting/GameControls",
      "arcadekit/save/Setting/GameTutorial",
    ]);
  });

  it("types its service, its layer and its merge from its Schema", () => {
    expectTypeOf(GameControls.layer).toEqualTypeOf<
      Layer.Layer<GameControls, never, KeyValueStore.KeyValueStore>
    >();
    expectTypeOf<Effect.Success<typeof GameControls>>().toEqualTypeOf<
      Stored<Controls>
    >();
    expectTypeOf(GameTutorial.definition.merge).parameter(0).toEqualTypeOf<{
      readonly offered: boolean;
      readonly completed: boolean;
    }>();
  });

  it("refuses a default that its Schema refuses", () => {
    expect(() => declareWithSensitivity(9)).toThrow(
      new Error(
        `Setting "LooseControls" has a \`default\` that its \`schema\` refuses: Expected a value between 1 and 6 at ["sensitivity"]. A missing setting reads as its \`default\` and no write could store it, so give one the schema takes: a value within its checks, and an instance if the schema is a class.`
      )
    );
    expect(declareWithSensitivity(2).settingName).toBe("LooseControls");
  });

  it("refuses a plain object as the default of a Schema class, which the types take", () => {
    expect(() => declareOverClass(false)).toThrow(
      new Error(
        `Setting "ClassControls" has a \`default\` that its \`schema\` refuses: Expected ControlsClass. A missing setting reads as its \`default\` and no write could store it, so give one the schema takes: a value within its checks, and an instance if the schema is a class.`
      )
    );
    expect(declareOverClass(true).settingName).toBe("ClassControls");
  });

  it("refuses in the types what a definition shows", () => {
    expect(declareMistyped).toThrow(
      /has a `default` that its `schema` refuses/u
    );
  });
});
