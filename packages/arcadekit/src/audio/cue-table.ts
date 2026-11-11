import { Context, Layer, Result, Schema, SchemaIssue } from "effect";

// A cue table: which of the app's sounds each of a genre's cues plays (ADR-0014). The genre
// declares its cues and ships no sound; the app, which owns the sound files, gives the table;
// and the genre's sound view plays from it.

/**
 * A sound id, as a Schema: the name of one sound in the app's sound list, as `audio.play` takes
 * it, and never empty. It is what an app gives for a cue, so a cue table declares each cue with
 * it.
 */
export const SoundId: Schema.NonEmptyString = Schema.NonEmptyString;

/**
 * A cue table's sounds: what the app gives for each cue, by the cue's name. It is what the
 * table's service gives, so a sound view plays `sounds.push`, and what the table's `layer`
 * takes.
 */
export type CueSounds<F extends Schema.Struct.Fields> =
  Schema.Struct<F>["Type"];

/** Any class made by `CueTable`. */
export interface AnyCueTable {
  readonly kind: "CueTable";
  readonly cues: Schema.Struct.Fields;
}

/** The sounds of a cue table, for a sound view that takes them: `CueSoundsOf<typeof PushPuzzleCueTable>`. */
export type CueSoundsOf<Table extends AnyCueTable> = CueSounds<Table["cues"]>;

/** The key string of the cue table named `Name`. */
export type CueTableId<Name extends string> =
  `arcadekit/audio/CueTable/${Name}`;

/**
 * The type-level identity of a cue table's service: what `yield* MyCueTable` requires. It is the
 * type of the class's own values, so the class names it: `Layer.Layer<MyCueTable>`.
 */
export type CueTableService<
  Name extends string,
  F extends Schema.Struct.Fields,
> = Context.ServiceClass.Shape<CueTableId<Name>, CueSounds<F>>;

/** The class `CueTable` returns: the key of the table's service, its cues and the Layer that provides it. */
export interface CueTableClass<
  Name extends string,
  F extends Schema.Struct.Fields,
> extends Context.ServiceClass<
  CueTableService<Name, F>,
  CueTableId<Name>,
  CueSounds<F>
> {
  readonly kind: "CueTable";
  readonly cueTableName: Name;
  /** The cues, as declared. */
  readonly cues: F;
  /**
   * Provides the table from the app's `sounds`: a sound id for each cue. It throws, as the app's
   * module loads, for sounds that got past the types (a cast, parsed JSON, a variable with a key
   * too many) with a cue left out, a sound for a name that is no cue, or a sound that is no
   * sound id: the audio system drops an id it doesn't know, so each would be a cue nobody hears.
   * A table with no cue has nothing to check, in the types or here: it takes anything but
   * `null` and `undefined`. `Layer.succeed(MyCueTable, sounds)` provides the same service and
   * checks nothing.
   */
  readonly layer: (
    sounds: CueSounds<F>
  ) => Layer.Layer<CueTableService<Name, F>>;
}

/** What `CueTable` takes: the genre's cues. */
export interface CueTableDefinition<F extends Schema.Struct.Fields> {
  /**
   * The genre's cues by name: each moment of a run that makes a sound, and each state that holds
   * one, such as a loop. A cue is declared with the Schema of what the app gives for it:
   * `SoundId`, or `Schema.NullOr(SoundId)` for a cue an app may leave silent. Its doc comment
   * says when it plays.
   */
  readonly cues: F;
}

/** What a Schema refuses, one entry for each problem: a cue left out and a sound for no cue in the kit's words. */
const problems = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    if (issue._tag === "MissingKey") {
      return "no sound";
    }
    if (issue._tag === "UnexpectedKey") {
      return "not one of its cues";
    }
    return SchemaIssue.defaultLeafHook(issue);
  },
});

/** The same as one line each, led by the cue it is about: `drain: no sound`. */
const refusals = (issue: SchemaIssue.Issue): readonly string[] =>
  problems(issue).issues.map(({ message, path = [] }) =>
    path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`
  );

/**
 * A genre's table of cue to sound: which of the app's sounds each of its cues plays. The genre
 * declares the cues and ships no sound; the app, which owns the sound files, gives a sound id
 * of its sound list for each; and the genre's sound view reads the sounds beside the app's
 * `Audio`. The class is the key of the table's service.
 *
 * ```ts
 * // The genre declares its cues:
 * export class PushPuzzleCueTable extends CueTable("PushPuzzleCueTable", {
 *   cues: {
 *     // A turn that moved without pushing.
 *     move: SoundId,
 *     push: SoundId,
 *     solved: SoundId,
 *   },
 * }) {}
 *
 * // The app says which of its sounds each one plays:
 * PushPuzzleCueTable.layer({ move: "step", push: "shove", solved: "fanfare" });
 *
 * // And whatever plays them takes the sounds with the audio system:
 * const audio = yield* Audio;
 * const sounds = yield* PushPuzzleCueTable;
 * audio.play(sounds.solved);
 * ```
 *
 * A `Game.Engine` names both in `uses` (`uses: { audio: Audio, sounds: PushPuzzleCueTable }`),
 * so its `view` is handed them on each attach, and a sound view names the sounds' type with
 * `CueSoundsOf<typeof PushPuzzleCueTable>`. A table is how a genre package, which ships no
 * sound, is handed the app's: a game that keeps its sounds beside its rules declares none, and
 * its view takes a plain object.
 */
export const CueTable = <
  const Name extends string,
  const F extends Schema.Struct.Fields,
>(
  name: Name,
  definition: CueTableDefinition<F>
): CueTableClass<Name, F> => {
  const { cues } = definition;
  // The sounds are what the app has, not what it stores: they are checked as they are, with no
  // decoding, every cue at once, and a sound for no cue is refused, not dropped.
  const check = Schema.decodeUnknownResult(Schema.toType(Schema.Struct(cues)), {
    errors: "all",
    onExcessProperty: "error",
  });
  const Key = Context.Service<CueTableService<Name, F>, CueSounds<F>>()(
    `arcadekit/audio/CueTable/${name}` as CueTableId<Name>
  );
  return class extends Key {
    static readonly kind = "CueTable" as const;
    static readonly cueTableName: Name = name;
    static readonly cues = cues;
    static readonly layer = (sounds: CueSounds<F>) => {
      const checked = check(sounds);
      if (Result.isFailure(checked)) {
        throw new Error(
          `CueTable "${name}" is given sounds that don't fit its cues (${refusals(checked.failure.issue).join("; ")}). Give its layer a sound id for each of its cues and for nothing else: ${Object.keys(cues).join(", ")}.`
        );
      }
      return Layer.succeed(Key, sounds);
    };
  } as unknown as CueTableClass<Name, F>;
};
