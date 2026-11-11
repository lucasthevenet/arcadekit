import { Effect, Option } from "effect";
import type { Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

// What a save and a setting share: one value under one storage key, and what to do when storage
// fails, so neither Effect fails. Each declaration says what the value is and how it is stored;
// this module reads it, writes it and logs.

/**
 * What an app keeps between sessions, as its service gives it: a save's records, a setting's
 * value. Neither Effect fails: a storage problem is logged and play goes on.
 */
export interface Stored<A> {
  /**
   * What is stored, read from storage on every run: nothing is kept, so it gives what another
   * tab wrote. A missing value reads as the declaration's own (a save's is empty, a setting's is
   * its `default`), and so does one that can't be read, which is logged.
   */
  readonly read: Effect.Effect<A>;
  /**
   * Stores `value`. A save's write merges into what it could read: it reads what is stored first
   * and stores the two as one, by id, so the other records, and what another tab wrote, aren't
   * lost. Where that read fails, which is logged, it stores `value` alone, over what is there.
   * A setting's replaces what is stored, unless it declares a `merge`. It gives the value after
   * the merge (the value itself, where nothing merges), also when the write fails, which is
   * logged and dropped.
   */
  readonly write: (value: A) => Effect.Effect<A>;
}

/** What `keep` is told by the declaration it keeps a value for. */
interface Keeping<A> {
  /** The declaration as a log names it: `Save "PushPuzzleSave"`. */
  readonly label: string;
  readonly storageKey: string;
  /** The value as it is stored: the JSON of its encoded side. */
  readonly schema: Schema.ConstraintCodec<A, unknown>;
  /** What a missing or unreadable value reads as. */
  readonly missing: A;
  /** What is stored and what is being written, as one. Without it, a write replaces. */
  readonly merge: ((stored: A, written: A) => A) | undefined;
  /** Whether a value that fails its Schema is copied to `<storageKey>/corrupt` before it is dropped. */
  readonly backUp: boolean;
}

/** Keeps one value under `storageKey` in the `KeyValueStore` in context. Reads nothing until asked. */
export const keep = <A>(
  keeping: Keeping<A>
): Effect.Effect<Stored<A>, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const { label, storageKey, missing, merge } = keeping;
    const backupKey = `${storageKey}/corrupt`;
    const store = yield* KeyValueStore.KeyValueStore;
    const values = KeyValueStore.toSchemaStore(store, keeping.schema);

    // Copies the unreadable value to the backup key and removes it, so it is backed up once.
    const backUp = Effect.gen(function* () {
      const raw = yield* store.get(storageKey);
      if (raw !== undefined) {
        yield* store.set(backupKey, raw);
        yield* store.remove(storageKey);
      }
    });

    const read: Effect.Effect<A> = values.get(storageKey).pipe(
      Effect.map(Option.getOrElse(() => missing)),
      Effect.catchTag("SchemaError", (error) =>
        keeping.backUp
          ? Effect.logWarning(
              `${label} can't be read. It is copied to ${backupKey} and play starts without it.`,
              error.message
            ).pipe(Effect.andThen(backUp), Effect.as(missing))
          : Effect.logWarning(
              `${label} can't be read. Play goes on without it.`,
              error.message
            ).pipe(Effect.as(missing))
      ),
      Effect.catchTag("KeyValueStoreError", (error) =>
        Effect.logWarning(
          `${label} can't be read. Play goes on without it.`,
          error.message
        ).pipe(Effect.as(missing))
      )
    );

    return {
      read,
      write: (value) =>
        Effect.gen(function* () {
          const next = merge === undefined ? value : merge(yield* read, value);
          yield* values
            .set(storageKey, next)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(`${label} can't be written.`, error.message)
              )
            );
          return next;
        }),
    };
  });
