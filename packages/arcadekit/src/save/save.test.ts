import { Effect, Layer, Logger, Option, Schema } from "effect";
import type { Tracer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Save, Stored } from "./index";
import type { Records } from "./index";

// The save runs against an in-memory KeyValueStore, never real localStorage.
// Each test seeds the store, runs the save, and reads the store and the logs back.

const ScoreRecord = Schema.Struct({
  best: Schema.Int,
  cleared: Schema.Boolean,
});
type ScoreRecord = typeof ScoreRecord.Type;

class GameSave extends Save("GameSave", {
  storageKey: "arcadekit/test-game/save",
  record: ScoreRecord,
  mergeRecord: (a, b) => ({
    best: Math.max(a.best, b.best),
    cleared: a.cleared || b.cleared,
  }),
}) {}

const KEY = GameSave.definition.storageKey;
const BACKUP_KEY = `${KEY}/corrupt`;

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

/** A store whose reads fail while `broken.reads` is set, so a test can read it afterwards. */
const breakable = () => {
  const broken = { reads: false };
  const layer = Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      return {
        ...store,
        get: (key: string) =>
          Effect.suspend(() =>
            broken.reads
              ? Effect.fail(
                  new KeyValueStore.KeyValueStoreError({
                    message: "Storage is broken",
                    method: "get",
                    key,
                  })
                )
              : store.get(key)
          ),
      };
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory));
  return { layer, broken };
};

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

/** A store whose reads let other fibers run before they give what they read, as an async store's do. */
const yielding = Layer.effect(
  KeyValueStore.KeyValueStore,
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    return {
      ...store,
      get: (key: string) =>
        store.get(key).pipe(Effect.tap(() => Effect.yieldNow)),
    };
  })
).pipe(Layer.provide(KeyValueStore.layerMemory));

/** The names of a span and of every span above it, the innermost first. */
const spanNames = (span: Tracer.AnySpan): readonly string[] =>
  span._tag === "Span"
    ? [
        span.name,
        ...Option.match(span.parent, { onNone: () => [], onSome: spanNames }),
      ]
    : [];

/** A store that records the spans each of its reads and writes runs in, as they run. */
const tracing = () => {
  const spans: string[] = [];
  const traced = (method: string) =>
    Effect.currentSpan.pipe(
      Effect.map(spanNames),
      Effect.orElseSucceed(() => []),
      Effect.flatMap((names) =>
        Effect.sync(() => {
          spans.push(`${method}: ${names.join(" < ")}`);
        })
      )
    );
  const layer = Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      return {
        ...store,
        get: (key: string) => Effect.andThen(traced("get"), store.get(key)),
        set: (key: string, value: string | Uint8Array) =>
          Effect.andThen(traced("set"), store.set(key, value)),
      };
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory));
  return { layer, spans };
};

/** Runs `program` with the save over `storage`, after writing `stored` raw under the save key. */
const run = async <A>(
  program: (
    save: Stored.Stored<Records<ScoreRecord>>
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
    return yield* program(yield* GameSave);
  }).pipe(
    Effect.provide(
      GameSave.layer.pipe(
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

const stored = (records: object) => JSON.stringify({ version: 1, records });

const MedalRecord = Schema.Struct({
  medal: Schema.Literals(["gold", "silver"]),
  laps: Schema.Array(Schema.Number),
});

/** A save whose merge builds a record with a literal of a union in it, and an array. */
class MedalSave extends Save("MedalSave", {
  storageKey: "arcadekit/test-game/medal-save",
  record: MedalRecord,
  mergeRecord: (a, b) =>
    a.medal === "gold" || b.medal === "gold"
      ? { medal: "gold", laps: [...a.laps, ...b.laps] }
      : b,
}) {}

/** Saves whose definitions show a mistake: each is a type error. */
const declareMistyped = () => [
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Save("FieldSave", {
    storageKey: "arcadekit/test-game/field-save",
    // @ts-expect-error -- a save keeps its records under `records`, which no definition names.
    field: "levels",
    record: ScoreRecord,
    mergeRecord: (a) => a,
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Save("OtherRecordSave", {
    storageKey: "arcadekit/test-game/other-save",
    record: ScoreRecord,
    // @ts-expect-error -- the record's Schema decides the record, not the handler.
    mergeRecord: (a: { readonly lives: number }) => a,
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Save("PromiseSave", {
    storageKey: "arcadekit/test-game/promise-save",
    record: ScoreRecord,
    // @ts-expect-error -- a merge gives a record, now.
    mergeRecord: (a) => Promise.resolve(a),
  }),
  // @ts-expect-error -- a save says how two records merge.
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Save("NoMergeSave", {
    storageKey: "arcadekit/test-game/no-merge-save",
    record: ScoreRecord,
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Save("KeySave", {
    // @ts-expect-error -- `key` is the class's, its service's key: the storage key is `storageKey`.
    key: "arcadekit/test-game/key-save",
    record: ScoreRecord,
    mergeRecord: (a) => a,
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Save("MutableSave", {
    storageKey: "arcadekit/test-game/mutable-save",
    record: Schema.Struct({ ids: Schema.mutable(Schema.Array(Schema.String)) }),
    // @ts-expect-error -- the price of a kept literal: an array written in a merge is read-only.
    mergeRecord: (a, b) => ({ ids: [...a.ids, ...b.ids] }),
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Save("NamedSave", {
    storageKey: "arcadekit/test-game/named-save",
    record: Schema.Struct({ ids: Schema.mutable(Schema.Array(Schema.String)) }),
    // What such a record writes instead: the array named first.
    mergeRecord: (a, b) => {
      const ids = [...a.ids, ...b.ids];
      return { ids };
    },
  }),
];

describe(Save, () => {
  it("reads a missing save as empty", async () => {
    const { result, warnings } = await run((save) => save.read);
    expect(result).toStrictEqual({});
    expect(warnings).toStrictEqual([]);
  });

  it("reads what is stored", async () => {
    const { result } = await run((save) => save.read, {
      stored: stored({ one: { best: 3, cleared: true } }),
    });
    expect(result).toStrictEqual({ one: { best: 3, cleared: true } });
  });

  it("reads nothing when its layer is built, and storage again on every read", async () => {
    const { layer, reads } = counting();
    const before = await Effect.gen(function* () {
      const save = yield* GameSave;
      const built = reads.length;
      yield* save.read;
      yield* save.read;
      return built;
    }).pipe(
      Effect.provide(GameSave.layer.pipe(Layer.provide(layer))),
      Effect.runPromise
    );
    expect([before, reads]).toStrictEqual([0, [KEY, KEY]]);
  });

  it("backs up a corrupt save once, logs it by name and reads it as empty", async () => {
    const { result, warnings } = await run(
      (save) =>
        Effect.all([save.read, readRaw(BACKUP_KEY), readRaw(KEY), save.read]),
      { stored: "{not json" }
    );
    expect(result).toStrictEqual([{}, "{not json", undefined, {}]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStrictEqual([
      `Save "GameSave" can't be read. It is copied to ${BACKUP_KEY} and play starts without it.`,
      expect.any(String),
    ]);
  });

  it.each([
    ["an unknown version", JSON.stringify({ version: 99, records: {} })],
    [
      "records under a field of their own, as saves were stored before",
      JSON.stringify({
        version: 1,
        stages: { one: { best: 3, cleared: true } },
      }),
    ],
  ])("treats a save of %s like a corrupt one", async (_, raw) => {
    const { result, warnings } = await run(
      (save) => Effect.all([save.read, readRaw(BACKUP_KEY)]),
      { stored: raw }
    );
    expect(result).toStrictEqual([{}, raw]);
    expect(warnings).toHaveLength(1);
  });

  it("logs a store that can't be read and reads it as empty", async () => {
    const { result, warnings } = await run((save) => save.read, {
      storage: failing("get"),
    });
    expect(result).toStrictEqual({});
    expect(warnings).toStrictEqual([
      [
        `Save "GameSave" can't be read. Play goes on without it.`,
        "Storage is broken",
      ],
    ]);
  });

  it("writes the records under the storage key, versioned, in `records`", async () => {
    const { result } = await run((save) =>
      Effect.andThen(
        save.write({ one: { best: 3, cleared: false } }),
        Effect.all([save.read, readRaw(KEY)])
      )
    );
    expect(result).toStrictEqual([
      { one: { best: 3, cleared: false } },
      stored({ one: { best: 3, cleared: false } }),
    ]);
  });

  it("merges each write with the stored records through the game's merge", async () => {
    const { result } = await run((save) =>
      Effect.andThen(
        Effect.all([
          save.write({ one: { best: 3, cleared: true } }),
          save.write({ one: { best: 5, cleared: false } }),
        ]),
        save.read
      )
    );
    expect(result).toStrictEqual({ one: { best: 5, cleared: true } });
  });

  it("merges with what another tab wrote, keeping ids the content no longer has", async () => {
    const { result } = await run(
      (save) => save.write({ one: { best: 4, cleared: false } }),
      {
        stored: stored({
          one: { best: 2, cleared: true },
          two: { best: 7, cleared: false },
          "old-stage": { best: 1, cleared: true },
        }),
      }
    );
    expect(result).toStrictEqual({
      one: { best: 4, cleared: true },
      two: { best: 7, cleared: false },
      "old-stage": { best: 1, cleared: true },
    });
  });

  it("merges writes that run at once, one after the other, over a store that yields", async () => {
    const result = await Effect.gen(function* () {
      const save = yield* GameSave;
      yield* Effect.all(
        [
          save.write({ one: { best: 3, cleared: true } }),
          save.write({ two: { best: 5, cleared: false } }),
        ],
        { concurrency: "unbounded" }
      );
      return yield* save.read;
    }).pipe(
      Effect.provide(GameSave.layer.pipe(Layer.provide(yielding))),
      Effect.runPromise
    );
    expect(result).toStrictEqual({
      one: { best: 3, cleared: true },
      two: { best: 5, cleared: false },
    });
  });

  it("traces each read and write under the declared name, and a write's read inside it", async () => {
    const { layer, spans } = tracing();
    await Effect.gen(function* () {
      const save = yield* GameSave;
      yield* save.write({ one: { best: 3, cleared: true } });
      yield* save.read;
    }).pipe(
      Effect.provide(GameSave.layer.pipe(Layer.provide(layer))),
      Effect.runPromise
    );
    expect(spans).toStrictEqual([
      "get: GameSave.read < GameSave.write",
      "set: GameSave.write",
      "get: GameSave.read",
    ]);
  });

  it("gives the game's merge the stored record first and the written one second", async () => {
    const result = await Effect.gen(function* () {
      const save = yield* MedalSave;
      yield* save.write({ oval: { medal: "gold", laps: [61] } });
      return yield* save.write({ oval: { medal: "silver", laps: [58] } });
    }).pipe(
      Effect.provide(
        MedalSave.layer.pipe(Layer.provide(KeyValueStore.layerMemory))
      ),
      Effect.runPromise
    );
    expect(result).toStrictEqual({ oval: { medal: "gold", laps: [61, 58] } });
  });

  it("stores a write alone, over what is there, when what is stored can't be read", async () => {
    const { layer, broken } = breakable();
    const { result, warnings } = await run(
      (save) =>
        Effect.gen(function* () {
          broken.reads = true;
          const written = yield* save.write({
            one: { best: 1, cleared: false },
          });
          broken.reads = false;
          return [written, yield* readRaw(KEY)];
        }),
      {
        stored: stored({
          one: { best: 5, cleared: true },
          two: { best: 9, cleared: true },
        }),
        storage: layer,
      }
    );
    expect(result).toStrictEqual([
      { one: { best: 1, cleared: false } },
      stored({ one: { best: 1, cleared: false } }),
    ]);
    expect(warnings).toStrictEqual([
      [
        `Save "GameSave" can't be read. Play goes on without it.`,
        "Storage is broken",
      ],
    ]);
  });

  it("logs and drops a failed write, and still gives the records", async () => {
    const { result, warnings } = await run(
      (save) => save.write({ one: { best: 3, cleared: false } }),
      { storage: failing("set") }
    );
    expect(result).toStrictEqual({ one: { best: 3, cleared: false } });
    expect(warnings).toStrictEqual([
      [`Save "GameSave" can't be written.`, expect.any(String)],
    ]);
  });

  it("merges two sets of records as a write does, with no storage", () => {
    const a: Records<ScoreRecord> = {
      one: { best: 2, cleared: true },
      two: { best: 7, cleared: false },
    };
    const b: Records<ScoreRecord> = {
      one: { best: 4, cleared: false },
      three: { best: 1, cleared: false },
    };
    expect(GameSave.merge(a, b)).toStrictEqual({
      two: { best: 7, cleared: false },
      one: { best: 4, cleared: true },
      three: { best: 1, cleared: false },
    });
  });

  it("is its service's key, named for the class, and its service is a stored value", async () => {
    const service = await Effect.gen(function* () {
      return yield* GameSave;
    }).pipe(
      Effect.provide(
        GameSave.layer.pipe(Layer.provide(KeyValueStore.layerMemory))
      ),
      Effect.runPromise
    );
    expect([
      GameSave.kind,
      GameSave.saveName,
      GameSave.key,
      Stored.isStored(service),
    ]).toStrictEqual([
      "Save",
      "GameSave",
      "arcadekit/save/Save/GameSave",
      true,
    ]);
  });

  it("types its service, its layer and its handler from the record's Schema", () => {
    expectTypeOf(GameSave.layer).toEqualTypeOf<
      Layer.Layer<GameSave, never, KeyValueStore.KeyValueStore>
    >();
    expectTypeOf<Effect.Success<typeof GameSave>>().toEqualTypeOf<
      Stored.Stored<Records<ScoreRecord>>
    >();
    expectTypeOf(GameSave.definition.mergeRecord)
      .parameter(0)
      .toEqualTypeOf<ScoreRecord>();
    expectTypeOf(GameSave.merge).returns.toEqualTypeOf<Records<ScoreRecord>>();
  });

  it("keeps a literal in a record its merge builds", () => {
    expectTypeOf(MedalSave.merge).returns.toEqualTypeOf<
      Records<{
        readonly medal: "gold" | "silver";
        readonly laps: readonly number[];
      }>
    >();
    expect(
      MedalSave.merge(
        { oval: { medal: "gold", laps: [61] } },
        { oval: { medal: "silver", laps: [58] } }
      )
    ).toStrictEqual({ oval: { medal: "gold", laps: [61, 58] } });
  });

  it("refuses in the types what a definition shows, and declares each when run", () => {
    expect(declareMistyped().map((save) => save.kind)).toStrictEqual(
      Array.from({ length: 7 }, () => "Save")
    );
  });
});
