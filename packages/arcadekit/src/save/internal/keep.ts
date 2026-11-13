import { Effect, Option, Semaphore } from "effect";
import type { Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

import * as Stored from "../stored";

/** What `keep` is told by the declaration it keeps a value for. */
export interface Keeping<A> {
  /** The declaration's kind, as its class's `kind` is: a log names it `Save "RaceSave"`. */
  readonly kind: "Save" | "Setting";
  /** The declared name, which a log and each span name. */
  readonly name: string;
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

/**
 * The service a `Save`'s or a `Setting`'s `layer` provides: one value under `storageKey` in the
 * `KeyValueStore` in context, which it takes once, here, so the service's Effects require none of
 * it. Making it reads nothing.
 *
 * Neither Effect fails. A read that storage refuses, or whose value fails its Schema, is logged and
 * gives `missing`; a value that fails its Schema is first copied to `<storageKey>/corrupt` and
 * removed, where the declaration backs up. A write that storage refuses is logged and dropped, and
 * gives the value as it would have been stored. A write with a `merge` reads what is stored first,
 * so one runs at a time: a semaphore of one permit, which every write of this service takes, keeps
 * two from reading the same value and the second from storing over the first. A trace shows each
 * read as `<name>.read` and each write as `<name>.write`, with the read a merge makes inside it.
 */
export const keep: <A>(
  keeping: Keeping<A>
) => Effect.Effect<Stored.Stored<A>, never, KeyValueStore.KeyValueStore> =
  Effect.fnUntraced(function* <A>(keeping: Keeping<A>) {
    const { kind, name, storageKey, missing, merge } = keeping;
    const label = `${kind} "${name}"`;
    const backupKey = `${storageKey}/corrupt`;
    const store = yield* KeyValueStore.KeyValueStore;
    const values = KeyValueStore.toSchemaStore(store, keeping.schema);
    const writing = yield* Semaphore.make(1);

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
      ),
      Effect.withSpan(`${name}.read`)
    );

    const write = Effect.fn(`${name}.write`)(
      function* (value: A) {
        const next = merge === undefined ? value : merge(yield* read, value);
        yield* values
          .set(storageKey, next)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(`${label} can't be written.`, error.message)
            )
          );
        return next;
      },
      (effect) => writing.withPermit(effect)
    );

    return Stored.make({ read, write });
  });
