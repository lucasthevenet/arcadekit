import { Effect, Layer, Logger } from "effect";
import { KeyValueStore } from "effect/persistence";
import { describe, expect, it } from "vitest";

import {
  applyAudioSettings,
  defaultAudioSettings,
  makeAudioSettingsStore,
  silentAudio,
} from "./index";
import type { AudioSettings, AudioSettingsStore, AudioSystem } from "./index";

// The settings run against an in-memory KeyValueStore, never real localStorage.

const KEY = "arcadekit/test-game/settings";

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

const run = async <A>(
  program: (
    settings: AudioSettingsStore
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
    return yield* program(yield* makeAudioSettingsStore(KEY));
  }).pipe(
    Effect.provide(options.storage ?? KeyValueStore.layerMemory),
    Effect.provide(Logger.layer([logger])),
    Effect.runPromise
  );
  return { result, warnings };
};

const quiet: AudioSettings = { master: 0.5, sfx: 0.25, music: 0, muted: true };

describe("audio settings", () => {
  it("read as the defaults when missing", async () => {
    const { result, warnings } = await run((settings) => settings.load);
    expect(result).toStrictEqual(defaultAudioSettings);
    expect(warnings).toStrictEqual([]);
  });

  it("read back what was saved, last write winning", async () => {
    const { result } = await run((settings) =>
      Effect.andThen(
        Effect.all([settings.save(defaultAudioSettings), settings.save(quiet)]),
        settings.load
      )
    );
    expect(result).toStrictEqual(quiet);
  });

  it.each([
    ["not JSON", "{not json"],
    ["a volume out of range", JSON.stringify({ ...quiet, master: 2 })],
    ["a missing field", JSON.stringify({ master: 1 })],
  ])("read %s as the defaults and log it", async (_, stored) => {
    const { result, warnings } = await run((settings) => settings.load, {
      stored,
    });
    expect(result).toStrictEqual(defaultAudioSettings);
    expect(warnings).toHaveLength(1);
  });

  it("read a store that can't be read as the defaults", async () => {
    const { result, warnings } = await run((settings) => settings.load, {
      storage: failing("get"),
    });
    expect(result).toStrictEqual(defaultAudioSettings);
    expect(warnings).toHaveLength(1);
  });

  it("log and drop a failed write", async () => {
    const { warnings } = await run((settings) => settings.save(quiet), {
      storage: failing("set"),
    });
    expect(warnings).toHaveLength(1);
  });
});

describe(applyAudioSettings, () => {
  it("sets each bus volume and mute", () => {
    const calls: unknown[] = [];
    const audio: AudioSystem = {
      ...silentAudio,
      setVolume: (bus, volume) => calls.push([bus, volume]),
      setMuted: (muted) => calls.push(muted),
    };
    applyAudioSettings(audio, quiet);
    expect(calls).toStrictEqual([
      ["master", 0.5],
      ["sfx", 0.25],
      ["music", 0],
      true,
    ]);
  });
});
