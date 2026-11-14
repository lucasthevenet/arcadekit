import { Effect, Schema } from "effect";
import type { Layer } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { AudioSystem, CueTable } from "./index";
import type { CueSoundsOf } from "./index";

// A cue table as a genre declares it, and the sounds an app gives it: what the service gives
// back, and every refusal of `layer`, each message word for word.

class GameCueTable extends CueTable("GameCueTable", {
  cues: {
    /** The ball hit a bumper. */
    bump: AudioSystem.SoundId,
    /** The ball was lost. */
    drain: AudioSystem.SoundId,
  },
}) {}

/** A table with every shape a cue's Schema can give it: silent, left out, and a group. */
class ShapesCueTable extends CueTable("ShapesCueTable", {
  cues: {
    hit: AudioSystem.SoundId,
    /** `null` fires silently. */
    miss: Schema.NullOr(AudioSystem.SoundId),
    /** Without it, the hit sound plays. */
    crit: Schema.optionalKey(AudioSystem.SoundId),
    weapons: Schema.Struct({
      swing: AudioSystem.SoundId,
      bolt: Schema.NullOr(AudioSystem.SoundId),
    }),
  },
}) {}

/** A cue whose Schema transforms: the app gives the side a view reads, the decoded one. */
class GainCueTable extends CueTable("GainCueTable", {
  cues: {
    hit: AudioSystem.SoundId,
    /** How loud the hit plays, which a file would hold as text. */
    hitGain: Schema.FiniteFromString,
  },
}) {}

const sounds: CueSoundsOf<typeof GameCueTable> = {
  bump: "ping",
  drain: "lost",
};

/** Gives `layer` what the types refuse, as a cast, parsed JSON or a wider variable would. */
const layerOf = (given: unknown) =>
  GameCueTable.layer(given as CueSoundsOf<typeof GameCueTable>);

const fits =
  "Give its layer a sound id for each of its cues and for nothing else: bump, drain.";

/** Reads a cue the table does not declare: a type error. */
const readUndeclared = (given: CueSoundsOf<typeof GameCueTable>) =>
  // @ts-expect-error -- a cue the table does not declare.
  given.jackpot;

/** Names the sounds of what only looks like a cue table: a type error. */
const cuesOfLookAlike = (
  // @ts-expect-error -- `CueSoundsOf` takes a class made by `CueTable`, not a look-alike.
  given: CueSoundsOf<{ readonly cues: typeof GameCueTable.cues }>
) => Object.keys(given);

/** Declares a cue with the app's sound, where its Schema goes: a type error. */
const declareWithSound = () =>
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  CueTable("SoundCueTable", {
    cues: {
      // @ts-expect-error -- a cue is declared with a Schema: the sound is the app's to give.
      bump: "ping",
    },
  });

describe(CueTable, () => {
  it("gives the app's sounds to whatever reads the table", async () => {
    const given = await Effect.gen(function* () {
      return yield* GameCueTable;
    }).pipe(Effect.provide(GameCueTable.layer(sounds)), Effect.runPromise);
    expect(given).toBe(sounds);
  });

  it("is its service's key, named for the class, and has its cues", () => {
    expect([
      GameCueTable.kind,
      GameCueTable.cueTableName,
      GameCueTable.key,
      Object.keys(GameCueTable.cues),
    ]).toStrictEqual([
      "CueTable",
      "GameCueTable",
      "arcadekit/audio/CueTable/GameCueTable",
      ["bump", "drain"],
    ]);
  });

  it("types the sounds, the layer and the service from the cues", () => {
    expectTypeOf<CueSoundsOf<typeof GameCueTable>>().toEqualTypeOf<{
      readonly bump: string;
      readonly drain: string;
    }>();
    expectTypeOf(GameCueTable.layer).toEqualTypeOf<
      (sounds: {
        readonly bump: string;
        readonly drain: string;
      }) => Layer.Layer<GameCueTable>
    >();
    expectTypeOf<Effect.Success<typeof GameCueTable>>().toEqualTypeOf<
      CueSoundsOf<typeof GameCueTable>
    >();
    expectTypeOf<CueSoundsOf<typeof ShapesCueTable>>().toEqualTypeOf<{
      readonly hit: string;
      readonly miss: string | null;
      readonly crit?: string;
      readonly weapons: {
        readonly swing: string;
        readonly bolt: string | null;
      };
    }>();
  });

  it("takes a cue its Schema lets an app leave silent, leave out or group", () => {
    expect(() =>
      ShapesCueTable.layer({
        hit: "hit",
        miss: null,
        weapons: { swing: "swing", bolt: null },
      })
    ).not.toThrow();
  });

  it("checks the sounds as the app has them, with no decoding", () => {
    expect(() =>
      GainCueTable.layer({ hit: "hit", hitGain: 0.5 })
    ).not.toThrow();
  });

  it("refuses sounds with a cue left out", () => {
    expect(() => layerOf({ bump: "ping" })).toThrow(
      new Error(
        `CueTable "GameCueTable" is given sounds that don't fit its cues (drain: no sound). ${fits}`
      )
    );
  });

  it("refuses a sound for a name that is no cue", () => {
    expect(() => layerOf({ ...sounds, jackpot: "win" })).toThrow(
      new Error(
        `CueTable "GameCueTable" is given sounds that don't fit its cues (jackpot: not one of its cues). ${fits}`
      )
    );
  });

  it("names every cue that is wrong at once, a group's by its path", () => {
    expect(() => layerOf({ bmup: "ping" })).toThrow(
      new Error(
        `CueTable "GameCueTable" is given sounds that don't fit its cues (bmup: not one of its cues; bump: no sound; drain: no sound). ${fits}`
      )
    );
    expect(() =>
      ShapesCueTable.layer({ hit: "hit", miss: null, weapons: {} } as never)
    ).toThrow(/\(weapons\.swing: no sound; weapons\.bolt: no sound\)/u);
  });

  it("refuses a sound that is no sound id, in the Schema's words", () => {
    expect(() => layerOf({ bump: "", drain: 7 })).toThrow(
      new Error(
        `CueTable "GameCueTable" is given sounds that don't fit its cues (bump: Expected a value with a length of at least 1; drain: Expected string). ${fits}`
      )
    );
  });

  it("refuses what is no table with an Error, not a TypeError", () => {
    expect(() => layerOf(null)).toThrow(
      new Error(
        `CueTable "GameCueTable" is given sounds that don't fit its cues (Expected object). ${fits}`
      )
    );
  });

  it("refuses in the types what a table or a declaration shows", () => {
    expect(() => [
      // @ts-expect-error -- a cue left out.
      GameCueTable.layer({ bump: "ping" }),
      GameCueTable.layer({
        ...sounds,
        // @ts-expect-error -- a sound for no cue.
        jackpot: "win",
      }),
      // @ts-expect-error -- a sound that is no sound id.
      GameCueTable.layer({ ...sounds, drain: null }),
    ]).toThrow(/don't fit its cues/u);
    expect(readUndeclared(sounds)).toBeUndefined();
    expect(cuesOfLookAlike(sounds)).toStrictEqual(["bump", "drain"]);
    expect(declareWithSound).toBeTypeOf("function");
  });
});
