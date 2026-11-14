import { Effect } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Stored } from "../../src/save/index";

// A stored value as data: made from its read and its write, recognised by its guard, piped and
// printed. What a declaration's service does with storage is tested beside Save and Setting.

describe(Stored.make, () => {
  it("runs nothing when made, and each read and write when they run", () => {
    const ran: string[] = [];
    const volume = Stored.make({
      read: Effect.sync(() => {
        ran.push("read");
        return 0.5;
      }),
      write: (value: number) =>
        Effect.sync(() => {
          ran.push(`write ${value}`);
          return value;
        }),
    });
    const made = [...ran];
    const result = Effect.runSync(
      volume.read.pipe(Effect.andThen((value) => volume.write(value / 2)))
    );
    expect([made, result, ran]).toStrictEqual([
      [],
      0.25,
      ["read", "write 0.25"],
    ]);
  });

  it("types its read and its write from what it is given", () => {
    const volume = Stored.make({
      read: Effect.succeed(0.5),
      write: (value: number) => Effect.succeed(value),
    });
    expectTypeOf(volume).toEqualTypeOf<Stored.Stored<number>>();
    expectTypeOf(volume.read).toEqualTypeOf<Effect.Effect<number>>();
  });
});

describe(Stored.isStored, () => {
  it("tells a stored value from a look-alike with the same fields", () => {
    const fields = { read: Effect.succeed(1), write: Effect.succeed };
    expect([
      Stored.isStored(Stored.make(fields)),
      Stored.isStored(fields),
      Stored.isStored(null),
    ]).toStrictEqual([true, false, false]);
  });
});

describe("a stored value", () => {
  it("pipes, and prints as what it is", () => {
    const volume = Stored.make({
      read: Effect.succeed(1),
      write: Effect.succeed,
    });
    expect([
      volume.pipe(Stored.isStored),
      volume.toJSON(),
      JSON.parse(String(volume)),
    ]).toStrictEqual([true, { _id: "Stored" }, { _id: "Stored" }]);
  });
});
