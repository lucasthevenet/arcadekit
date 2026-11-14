import { Cause, Effect, Layer, Logger } from "effect";
import { KeyValueStore } from "effect/persistence";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserSaveStorage } from "../../../src/save/browser/index";

// The browser's storage, on a stand-in of `localStorage` that each test puts on globalThis and
// takes off again: one that keeps what it is given, and a browser's that refuses to be read.

/** The few `Storage` members the store calls, over a map the test reads. */
const storageOver = (items: Map<string, string>) => ({
  get length() {
    return items.size;
  },
  key: (index: number) => [...items.keys()][index] ?? null,
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => {
    items.set(key, value);
  },
  removeItem: (key: string) => {
    items.delete(key);
  },
  clear: () => {
    items.clear();
  },
});

const setLocalStorage = (get: () => unknown) => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get,
  });
};

/** Sets `key`, reads it back through a store built from the layer, and collects the logs. */
const roundTrip = async (key: string, value: string) => {
  const warnings: unknown[] = [];
  const logger = Logger.make((log) => {
    const thrown = Cause.squash(log.cause);
    warnings.push([
      log.message,
      ...(thrown instanceof Error ? [thrown.message] : []),
    ]);
  });
  const read = await Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    yield* store.set(key, value);
    return yield* store.get(key);
  }).pipe(
    Effect.provide(BrowserSaveStorage.layer),
    Effect.provide(Logger.layer([logger])),
    Effect.orDie,
    Effect.runPromise
  );
  return { read, warnings };
};

describe("BrowserSaveStorage.layer", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("keeps what is stored in localStorage, and logs nothing", async () => {
    const items = new Map<string, string>();
    setLocalStorage(() => storageOver(items));
    const { read, warnings } = await roundTrip("my-studio/race/save", "{}");
    expect([read, Object.fromEntries(items), warnings]).toStrictEqual([
      "{}",
      { "my-studio/race/save": "{}" },
      [],
    ]);
  });

  it("keeps what is stored in memory, with one warning, where the browser refuses localStorage", async () => {
    setLocalStorage(() => {
      throw new Error("The operation is insecure.");
    });
    const { read, warnings } = await roundTrip("my-studio/race/save", "{}");
    expect(read).toBe("{}");
    expect(warnings).toStrictEqual([
      [
        [
          "localStorage isn't available. Saved progress lasts this session only.",
        ],
        "The operation is insecure.",
      ],
    ]);
  });

  it("is a Layer of Effect's KeyValueStore", () => {
    expect(Layer.isLayer(BrowserSaveStorage.layer)).toBe(true);
  });
});
