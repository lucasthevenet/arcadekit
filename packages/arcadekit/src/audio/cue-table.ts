/**
 * Cue tables: which of the app's sounds each of a genre's cues plays (ADR-0014).
 *
 * `CueTable` is a declaration with a service: the genre declares its cues and ships no sound; the
 * app, which owns the sound files, gives the table its sounds with the class's `layer`; and the
 * genre's sound view plays from them, handed the table's service beside the app's audio system.
 * Its `layer` refuses, as the app's module loads, sounds that don't fit the cues: a plain throw,
 * since it is a mistake in the app's code.
 *
 * @since 0.7.0
 */
import { Context, Layer, Result, Schema, SchemaIssue } from "effect";

/**
 * A cue table's sounds: what the app gives for each cue, by the cue's name, from the cues'
 * Schemas.
 *
 * **When to use**
 *
 * Rarely: a game names the sounds of its table with `CueSoundsOf<typeof MyCueTable>`. This is the
 * same type, from the cues themselves.
 *
 * **Example** (The sounds of two cues)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import type { CueSounds } from "arcadekit/audio";
 *
 * const cues = { lap: AudioSystem.SoundId, bump: AudioSystem.SoundId };
 * const sounds: CueSounds<typeof cues> = { lap: "bell", bump: "crunch" };
 * sounds.lap; // => "bell"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CueSounds<F extends Schema.Struct.Fields> =
  Schema.Struct<F>["Type"];

/**
 * Any class made by `CueTable`: what `CueSoundsOf` takes, so a look-alike is refused.
 *
 * **When to use**
 *
 * To type a value that is some cue table's class, as a helper over several tables does.
 *
 * **Example** (A helper over any table)
 *
 * ```ts
 * import { AudioSystem, CueTable } from "arcadekit/audio";
 * import type { AnyCueTable } from "arcadekit/audio";
 *
 * class RaceCueTable extends CueTable("RaceCueTable", {
 *   cues: { lap: AudioSystem.SoundId, bump: AudioSystem.SoundId },
 * }) {}
 *
 * const cueNames = (table: AnyCueTable): string[] => Object.keys(table.cues);
 * cueNames(RaceCueTable); // => ["lap", "bump"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AnyCueTable {
  readonly kind: "CueTable";
  readonly cues: Schema.Struct.Fields;
}

/**
 * The sounds of a cue table: what its service gives and what its `layer` takes.
 *
 * **When to use**
 *
 * To type what a sound view plays from, and an app's table written apart from its `layer`:
 * `CueSoundsOf<typeof RaceCueTable>`.
 *
 * **Example** (An app's sounds for a table)
 *
 * ```ts
 * import { AudioSystem, CueTable } from "arcadekit/audio";
 * import type { CueSoundsOf } from "arcadekit/audio";
 *
 * class RaceCueTable extends CueTable("RaceCueTable", {
 *   cues: { lap: AudioSystem.SoundId, bump: AudioSystem.SoundId },
 * }) {}
 *
 * const sounds: CueSoundsOf<typeof RaceCueTable> = { lap: "bell", bump: "crunch" };
 * sounds.bump; // => "crunch"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CueSoundsOf<Table extends AnyCueTable> = CueSounds<Table["cues"]>;

/**
 * The key string of the cue table named `Name`.
 *
 * **When to use**
 *
 * Rarely: it is part of the table's type, which a game names by its class.
 *
 * **Example** (A cue table's key)
 *
 * ```ts
 * import { AudioSystem, CueTable } from "arcadekit/audio";
 * import type { CueTableId } from "arcadekit/audio";
 *
 * class RaceCueTable extends CueTable("RaceCueTable", {
 *   cues: { lap: AudioSystem.SoundId },
 * }) {}
 *
 * const key: CueTableId<"RaceCueTable"> = RaceCueTable.key;
 * key; // => "arcadekit/audio/CueTable/RaceCueTable"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CueTableId<Name extends string> =
  `arcadekit/audio/CueTable/${Name}`;

/**
 * The type-level identity of a cue table's service: what `yield* MyCueTable` requires. It is the
 * type of the class's own values, so the class names it: `Layer.Layer<MyCueTable>`.
 *
 * **When to use**
 *
 * Rarely: name the class instead, as a requirement (`Effect.Effect<A, E, RaceCueTable>`) or a
 * Layer's service (`Layer.Layer<RaceCueTable>`).
 *
 * **Example** (The class names its service)
 *
 * ```ts
 * import { AudioSystem, CueTable } from "arcadekit/audio";
 * import type { CueTableService } from "arcadekit/audio";
 * import { Layer } from "effect";
 *
 * const cues = { lap: AudioSystem.SoundId };
 * class RaceCueTable extends CueTable("RaceCueTable", { cues }) {}
 *
 * const layer: Layer.Layer<CueTableService<"RaceCueTable", typeof cues>> = RaceCueTable.layer({
 *   lap: "bell",
 * });
 * const same: Layer.Layer<RaceCueTable> = layer;
 * Layer.isLayer(same); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CueTableService<
  Name extends string,
  F extends Schema.Struct.Fields,
> = Context.ServiceClass.Shape<CueTableId<Name>, CueSounds<F>>;

/**
 * The class `CueTable` returns: the key of the table's service, its cues and the Layer that
 * provides it.
 *
 * **When to use**
 *
 * To type a value that is some cue table's class, as a host that takes one does. A game names its
 * own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import { AudioSystem, CueTable } from "arcadekit/audio";
 * import type { CueTableClass } from "arcadekit/audio";
 *
 * const cues = { lap: AudioSystem.SoundId };
 * class RaceCueTable extends CueTable("RaceCueTable", { cues }) {}
 *
 * const declared: CueTableClass<"RaceCueTable", typeof cues> = RaceCueTable;
 * declared.kind; // => "CueTable"
 * declared.cueTableName; // => "RaceCueTable"
 * Object.keys(declared.cues); // => ["lap"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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

/**
 * What `CueTable` takes: the genre's cues.
 *
 * **When to use**
 *
 * Read it from a declared table's `cues`, as a tool that lists a genre's cues does.
 *
 * **Example** (A definition with a cue an app may leave silent)
 *
 * ```ts
 * import { AudioSystem } from "arcadekit/audio";
 * import type { CueTableDefinition } from "arcadekit/audio";
 * import { Schema } from "effect";
 *
 * const cues = { lap: AudioSystem.SoundId, horn: Schema.NullOr(AudioSystem.SoundId) };
 * const definition: CueTableDefinition<typeof cues> = { cues };
 * Object.keys(definition.cues); // => ["lap", "horn"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface CueTableDefinition<F extends Schema.Struct.Fields> {
  /**
   * The genre's cues by name: each moment of a run that makes a sound, and each state that holds
   * one, such as a loop. A cue is declared with the Schema of what the app gives for it:
   * `AudioSystem.SoundId`, or `Schema.NullOr(AudioSystem.SoundId)` for a cue an app may leave
   * silent. Its doc comment says when it plays.
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
 * Declares a genre's cue table: which of the app's sounds each of its cues plays. The genre
 * declares the cues and ships no sound; the app, which owns the sound files, gives a sound id of
 * its sound list for each; and the genre's sound view reads the sounds beside the app's audio
 * system. The class is the key of the table's service.
 *
 * **When to use**
 *
 * In a genre package, which ships no sound, to be handed the app's. A game that keeps its sounds
 * beside its rules declares none, and its view takes a plain object.
 *
 * **Details**
 *
 * A `Game.Engine` names the table in `uses` beside the audio system
 * (`uses: { audio: AudioSystem.AudioSystem, sounds: RaceCueTable }`), so its `view` is handed them
 * on each attach, and a sound view names the sounds' type with `CueSoundsOf<typeof RaceCueTable>`.
 * A cue the app leaves out, and a sound for a name that is no cue, are type errors in a table
 * written in place, and the class's `layer` throws for one that got past the types: that is a
 * throw from the host, as the app's module loads, and never a throw when declared.
 *
 * **Example** (Declaring a table, giving it the app's sounds, and reading them)
 *
 * ```ts
 * import { AudioSystem, CueTable } from "arcadekit/audio";
 * import { Effect } from "effect";
 *
 * // The genre declares its cues:
 * class RaceCueTable extends CueTable("RaceCueTable", {
 *   cues: {
 *     // A car crossing the line.
 *     lap: AudioSystem.SoundId,
 *     bump: AudioSystem.SoundId,
 *   },
 * }) {}
 *
 * // The app says which of its sounds each one plays, and whatever plays them reads it:
 * const layer = RaceCueTable.layer({ lap: "bell", bump: "crunch" });
 * const program = Effect.gen(function* () {
 *   return (yield* RaceCueTable).lap;
 * });
 * Effect.runSync(program.pipe(Effect.provide(layer))); // => "bell"
 * ```
 *
 * @category declarations
 * @since 0.7.0
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
