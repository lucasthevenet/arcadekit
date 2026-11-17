/**
 * A saved game: the world as a snapshot, and with it everything else that
 * decides what the next tick does.
 *
 *   const saved = app.save()                       // Exit<Save, SaveRefused>
 *   const bytes = Save.encode(save)                // for a file or the network
 *
 *   const loaded = Save.decode(bytes)              // Exit<Save, LoadRefused>
 *   const app = yield* App.load(save, { plugins }) // the game, where it was
 *
 * A save is taken between two ticks. It holds the world, the game's time,
 * the actions waiting for the next tick and the events waiting to be read.
 * It does not hold scripts: a plugin lists its scripts, and they start
 * again when the app is loaded.
 *
 * What was logged after a save is the tail of the game. A game that keeps
 * its last save and the log since can come back to where it is by loading
 * the save and replaying only that tail, however long it has been running:
 *
 *   const tail = app.actionLog.slice(save.logLength)
 *   App.replay(loaded, tail, { delta, ticks: app.time.tick - save.tick })
 */
import { Cause, Data, Exit, Schema } from "effect";

import { readSnapshot, SnapshotError, writeSnapshot } from "./ecs/snapshot";
import type { SnapshotContents, SnapshotProblem } from "./ecs/snapshot";
import type { SavedChanges } from "./ecs/world";

/** The events of one kind that were waiting to be read when a game was saved. */
export interface SavedEvents {
  readonly name: string;
  /** Each event's payload in its JSON form, oldest first. */
  readonly payloads: readonly unknown[];
  /** Per system or handler that had read some: how many of them it had read. */
  readonly read: Readonly<Record<string, number>>;
}

/**
 * A game held between two ticks, made by `app.save()`: its world as a
 * snapshot, its time, what was waiting for the next tick, and how long its
 * log was. `Save.encode` turns it into bytes, and `App.load` goes on from it.
 */
export interface Save {
  /**
   * The version of the game that wrote the save: the `version` its app was
   * made with, 0 when it was given none. A game raises it when it changes
   * its components, and gives `App.load` a migration from each older one.
   */
  readonly version: number;
  /** How many ticks had run. */
  readonly tick: number;
  /** Game time, in seconds. */
  readonly elapsed: number;
  /** The seconds the last tick simulated. */
  readonly delta: number;
  /** `world.snapshot()`. */
  readonly world: Uint8Array;
  /**
   * The actions waiting for the next tick, in order, payloads in JSON form,
   * each with who issued it if it came with a name.
   */
  readonly queued: readonly {
    readonly name: string;
    readonly payload: unknown;
    readonly from?: string;
  }[];
  readonly events: readonly SavedEvents[];
  /**
   * What change queries had yet to visit, with how far each system and
   * handler had got: `world.saveChanges()`.
   */
  readonly changes: readonly SavedChanges[];
  /**
   * How many entries the app's action log held. Everything logged from
   * there on is the tail to replay after loading this save.
   */
  readonly logLength: number;
}

/**
 * A game could not be saved as it stands. The message says what is in the
 * way and names it: a queued action or a waiting event with no schema, a
 * field that holds what it cannot save, a command that is still queued.
 */
export class SaveRefused extends Data.TaggedError("SaveRefused")<{
  readonly message: string;
}> {}

/**
 * A save could not be loaded. `problem` says which kind of trouble it is:
 *
 * - one of a snapshot's problems;
 * - `"not a save"`: the bytes are not a saved game at all;
 * - `"newer version"`: a later version of the game wrote the save;
 * - `"no migration"`: an earlier one did, and the game has no migration
 *   from that version;
 * - `"migration failed"`: it has one, and the migration threw.
 */
export class LoadRefused extends Data.TaggedError("LoadRefused")<{
  readonly problem:
    | SnapshotProblem
    | "not a save"
    | "newer version"
    | "no migration"
    | "migration failed";
  readonly message: string;
}> {}

/**
 * A save in a plain form that describes itself, for a migration to change.
 * The world is its contents as the snapshot lists them, components by name
 * with their fields, so it can be read whatever the game's components are
 * now. `Migrate` has the usual changes to it.
 */
export interface Contents {
  tick: number;
  elapsed: number;
  delta: number;
  world: SnapshotContents;
  /** The actions that were waiting, payloads in JSON form. */
  queued: { name: string; payload: unknown; from?: string }[];
  /** The events that were waiting, payloads in JSON form. */
  events: {
    name: string;
    payloads: unknown[];
    read: Record<string, number>;
  }[];
  /**
   * What change queries had yet to visit, by component name. A component
   * that a migration renames or removes keeps its old name here, and what
   * is under a name the game no longer has is left out when the save is
   * loaded: the queries that watch the component then start over, with
   * every entity counting as changed.
   */
  changes: {
    component: string;
    kind: "changed" | "added" | "removed";
    entries: number[];
    readers: Record<string, number>;
  }[];
}

/**
 * How a save written by version `from` of a game becomes one of version
 * `from + 1`. It changes the contents it is given in place.
 */
export interface Migration {
  readonly from: number;
  readonly migrate: (contents: Contents) => void;
}

/**
 * Brings a save up to a version of the game, one migration at a time. A
 * save of that version already is returned as it is.
 *
 * Fails with `LoadRefused`: `"newer version"` for a save from a later
 * version, `"no migration"` when a step is missing, `"migration failed"`
 * when a migration throws, and a snapshot's own problems when the save's
 * world cannot be read or written back.
 */
export const migrate = (
  save: Save,
  version: number,
  migrations: readonly Migration[]
): Exit.Exit<Save, LoadRefused> => {
  if (save.version === version) {
    return Exit.succeed(save);
  }
  if (save.version > version) {
    return refuse(
      "newer version",
      `The save was written by version ${save.version} of the game, and this is version ${version}. A game cannot read what a later version of itself wrote.`
    );
  }
  try {
    const contents: Contents = {
      tick: save.tick,
      elapsed: save.elapsed,
      delta: save.delta,
      world: readSnapshot(save.world),
      queued: save.queued.map((action) => ({ ...action })),
      events: save.events.map((events) => ({
        name: events.name,
        payloads: [...events.payloads],
        read: { ...events.read },
      })),
      changes: save.changes.map((changes) => ({
        component: changes.component,
        kind: changes.kind,
        entries: [...changes.entries],
        readers: { ...changes.readers },
      })),
    };
    for (let from = save.version; from < version; from++) {
      const step = migrations.find((migration) => migration.from === from);
      if (step === undefined) {
        return refuse(
          "no migration",
          `The save was written by version ${save.version} of the game, and this is version ${version}. There is no migration from version ${from} to version ${from + 1}.`
        );
      }
      try {
        step.migrate(contents);
      } catch (error) {
        return refuse(
          "migration failed",
          `The migration from version ${from} to version ${from + 1} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return Exit.succeed({
      version,
      tick: contents.tick,
      elapsed: contents.elapsed,
      delta: contents.delta,
      world: writeSnapshot(contents.world),
      queued: contents.queued,
      events: contents.events,
      changes: contents.changes,
      logLength: save.logLength,
    });
  } catch (error) {
    if (error instanceof SnapshotError) {
      return refuse(error.problem, error.message);
    }
    throw error;
  }
};

/** "AKSV": arcadekit save. */
const MAGIC = 0x56534b41;
const FORMAT = 1;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Header = Schema.fromJsonString(
  Schema.Struct({
    version: Count,
    tick: Count,
    elapsed: Schema.Finite,
    delta: Schema.Finite,
    queued: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        payload: Schema.Unknown,
        from: Schema.optionalKey(Schema.String),
      })
    ),
    events: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        payloads: Schema.Array(Schema.Unknown),
        read: Schema.Record(Schema.String, Count),
      })
    ),
    changes: Schema.Array(
      Schema.Struct({
        component: Schema.String,
        kind: Schema.Literals(["changed", "added", "removed"]),
        entries: Schema.Array(Count),
        readers: Schema.Record(Schema.String, Count),
      })
    ),
    logLength: Count,
  })
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A save as bytes: a short header, everything but the world as JSON text,
 * then the world's snapshot as it is.
 */
export const encode = (save: Save): Uint8Array => {
  const { world, ...rest } = save;
  const json = textEncoder.encode(JSON.stringify(rest));
  const bytes = new Uint8Array(12 + json.length + world.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, json.length, true);
  bytes.set(json, 12);
  bytes.set(world, 12 + json.length);
  return bytes;
};

const refuse = (
  problem: LoadRefused["problem"],
  message: string
): Exit.Exit<never, LoadRefused> =>
  Exit.fail(new LoadRefused({ problem, message }));

/**
 * Reads a save back from bytes. This checks the save's own shape; the
 * world inside it is checked when the save is loaded.
 */
export const decode = (bytes: Uint8Array): Exit.Exit<Save, LoadRefused> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint32(0, true) !== MAGIC) {
    return refuse("not a save", "These bytes are not a saved game.");
  }
  const format = view.getUint32(4, true);
  if (format !== FORMAT) {
    return refuse(
      "newer format",
      `The save is in format ${format}, and this version reads format ${FORMAT}.`
    );
  }
  const length = view.getUint32(8, true);
  if (length > bytes.length - 12) {
    return refuse("truncated", "The save ends short of what it says it holds.");
  }
  let text: string;
  try {
    text = textDecoder.decode(bytes.subarray(12, 12 + length));
  } catch {
    return refuse("corrupt", "The save is damaged: its text is not text.");
  }
  const header = Schema.decodeUnknownExit(Header)(text);
  if (Exit.isFailure(header)) {
    const error = Cause.squash(header.cause);
    return refuse(
      "corrupt",
      `The save is damaged: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return Exit.succeed({
    ...header.value,
    world: bytes.slice(12 + length),
  });
};
