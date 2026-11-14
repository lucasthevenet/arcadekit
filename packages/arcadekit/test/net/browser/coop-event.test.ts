import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  LobbyChanged,
  RunStarted,
  SeatFailed,
  WaitingChanged,
} from "../../../src/net/browser/coop-event";
import { seatEvent } from "../../../src/net/browser/internal/seat-event";
import type { SeatEvent } from "../../../src/net/browser/internal/seat-event";

// The Co-op client's own events: each is a Schema class whose written type is checked against
// its Schema where it is declared, since the kit's type files are made from the written one.

/** `data` as `schema` decodes it: an event, from what an app would store or send of one. */
const decode = <S extends Schema.Top>(schema: S, data: unknown) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Codec<S["Type"]>)(data);

describe("a seat event", () => {
  it("is declared with a written type its Schema is checked against", () => {
    const Named: SeatEvent<
      "Named",
      { readonly names: Schema.$Array<Schema.String> }
    > = seatEvent("Named", { names: Schema.Array(Schema.String) });
    // @ts-expect-error -- the Schema takes numbers where the written type says strings
    const Numbered: SeatEvent<
      "Numbered",
      { readonly names: Schema.$Array<Schema.String> }
    > = seatEvent("Numbered", { names: Schema.Array(Schema.Number) });
    // @ts-expect-error -- the Schema has no `reason`, which the written type has
    const Unreasoned: SeatEvent<
      "Unreasoned",
      { readonly reason: Schema.String; readonly message: Schema.String }
    > = seatEvent("Unreasoned", { message: Schema.String });
    // @ts-expect-error -- the Schema's tag is not the written type's
    const Renamed: SeatEvent<"Renamed", { readonly slot: Schema.Int }> =
      seatEvent("Moved", { slot: Schema.Int });
    expectTypeOf(new Named({ names: ["Host"] }).names).toEqualTypeOf<
      readonly string[]
    >();
    // What the types refuse is still made: each line above is a type error and nothing more.
    expect([
      { ...new Named({ names: ["Host"] }) },
      [Numbered, Unreasoned, Renamed].map((made) => Object.keys(made.fields)),
    ]).toStrictEqual([
      { _tag: "Named", names: ["Host"] },
      [
        ["_tag", "names"],
        ["_tag", "message"],
        ["_tag", "slot"],
      ],
    ]);
  });

  it("takes what its written type says, as a value and as data, and refuses anything else", () => {
    const lobby = {
      role: "guest",
      code: "K7MQ2X",
      self: "guest-1",
      players: [{ id: "host", name: "Host", pick: "red" }],
      maxPlayers: 4,
      canStart: false,
    } as const;
    expect([
      decode(LobbyChanged, { _tag: "LobbyChanged", ...lobby }),
      decode(RunStarted, { _tag: "RunStarted", slot: 1, names: ["Host"] }),
      decode(WaitingChanged, { _tag: "WaitingChanged", waitingFor: ["Host"] }),
      decode(SeatFailed, {
        _tag: "SeatFailed",
        reason: "hostLost",
        message: "Lost the host.",
      }),
    ]).toStrictEqual([
      new LobbyChanged(lobby),
      new RunStarted({ slot: 1, names: ["Host"] }),
      new WaitingChanged({ waitingFor: ["Host"] }),
      new SeatFailed({ reason: "hostLost", message: "Lost the host." }),
    ]);
    for (const refused of [
      () => decode(LobbyChanged, { _tag: "LobbyChanged", ...lobby, role: "" }),
      () => decode(RunStarted, { _tag: "RunStarted", slot: 0.5, names: [] }),
      () => decode(WaitingChanged, { _tag: "WaitingChanged", waitingFor: [1] }),
      () =>
        decode(SeatFailed, { _tag: "SeatFailed", reason: "nope", message: "" }),
      // A tag is its own event's alone.
      () => decode(RunStarted, { _tag: "WaitingChanged", waitingFor: [] }),
    ]) {
      expect(refused).toThrow(Schema.SchemaError);
    }
  });
});
