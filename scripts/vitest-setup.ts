import { expect } from "vitest";

// `pnpm test` runs this before every test file.
//
// To `toEqual`, two errors made with `Data.TaggedError` that differ only in
// their `message` are equal: it is the one field of an error that is not an
// enumerable property. A test that compared a failure that way checked
// everything but the reason. Here the message is compared first, and the
// rest is left to what `toEqual` does anyway.
expect.addEqualityTesters([
  (a: unknown, b: unknown): boolean | undefined =>
    a instanceof Error && b instanceof Error && a.message !== b.message
      ? false
      : undefined,
]);
