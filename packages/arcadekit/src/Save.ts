/**
 * Saved games: the world as a snapshot, plus everything else that determines
 * what the next tick does.
 *
 *   const saved = app.save()                       // Exit<Save, SaveRefused>
 *   const bytes = Save.encode(save)                // for a file or the network
 *
 *   const loaded = Save.decode(bytes)              // Exit<Save, LoadRefused>
 *   const app = yield* App.load(save, { plugins }) // the game, where it was
 *
 * A save is taken between two ticks. It holds the world, which holds the game
 * time, the actions queued for the next tick and the events waiting to be read,
 * and beside it where each system had read to, in the events and in what
 * change queries haven't visited yet. Everything a game is in the middle of is
 * in the world, so the save holds all of it.
 *
 * Everything logged after a save is the game's tail. A game that keeps its last
 * save and the log since can return to the present by loading the save and
 * replaying only that tail, however long it has been running:
 *
 *   const tail = app.record(save)
 *   App.replay(loaded, tail)
 */
import { Cause, Data, Exit, Schema } from "effect";

import type { SavedChanges } from "./ecs/changes";
import { SnapshotError, readSnapshot, writeSnapshot } from "./ecs/snapshot";
import type { SnapshotContents, SnapshotProblem } from "./ecs/snapshot";

/**
 * A game captured between two ticks, made by `app.save()`: its world as a
 * snapshot, with its time, what was queued for the next tick and the events
 * waiting to be read, each reader's place, and the length of its log. `Save.encode` turns it into bytes, and `App.load` continues from it.
 *
 * @category Models
 */
export interface Save {
  /**
   * The version of the game that wrote the save: the `version` its app was
   * created with, defaulting to 0. Increment it when you change the game's
   * components, and give `App.load` a migration from each older version.
   */
  readonly version: number;
  /**
   * `world.snapshot()`, which holds the game's time, the actions queued for
   * the next tick and the events waiting to be read with the rest of it.
   */
  readonly world: Uint8Array;
  /**
   * What change queries haven't visited yet, with each system's and handler's
   * position: `world.saveChanges()`.
   */
  readonly changes: readonly SavedChanges[];
  /**
   * The number of entries in the app's action log. Everything logged after that
   * is the tail to replay after loading this save.
   */
  readonly logLength: number;
}

/**
 * The game can't be saved in its current state. The message names what is in
 * the way: a queued action or a waiting event whose payload its schema doesn't
 * take, a field holding a value that can't be saved, or a command still queued.
 *
 * @category Errors
 */
export class SaveRefused extends Data.TaggedError("SaveRefused")<{
  readonly message: string;
}> {}

/**
 * A save couldn't be loaded. `problem` identifies the kind of failure:
 *
 * - one of a snapshot's problems;
 * - `"not a save"`: the bytes aren't a saved game at all;
 * - `"newer version"`: a later version of the game wrote the save;
 * - `"no migration"`: an earlier version wrote it, and the game has no
 *   migration from that version;
 * - `"migration failed"`: a migration threw.
 *
 * An event waiting to be read that this program doesn't define is the
 * snapshot's `"unknown list"`, and one in a form its schema no longer takes is
 * its `"list changed"`.
 *
 * @category Errors
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
 * A save in a plain, self-describing form, for a migration to edit. The world
 * is listed as the snapshot describes it, components by name with their fields,
 * so it can be read whatever the game's current components are. `Migrate`
 * provides the common changes.
 *
 * @category Models
 */
export interface Contents {
  /**
   * The world, whose `lists` hold the actions that were queued, under
   * `"arcadekit/queued"`, each `{ name, payload, from? }` with its payload in
   * JSON form, and the events that were waiting, under each event's name, in
   * JSON form.
   */
  world: SnapshotContents;
  /**
   * What change queries haven't visited yet, by component name. A component a
   * migration renames or removes keeps its old name here, and entries under a
   * name the game no longer has are dropped when the save is loaded: the
   * queries watching the component then start over, with every entity counting
   * as changed.
   */
  changes: {
    component: string;
    kind: "changed" | "added" | "removed";
    entries: number[];
    readers: Record<string, number>;
  }[];
}

/**
 * Turns a save written by version `from` of a game into one of version `from +
 * 1`, by editing the contents it receives in place.
 *
 * **Gotchas**
 *
 * - A migration turns an old save into a new game: the log recorded before it
 *   no longer replays against it.
 * - A migration that accompanies a schema change updates the payloads in
 *   `world.lists` too. A waiting event that its schema no longer takes refuses
 *   the save as it is loaded; a queued action is refused when it is applied,
 *   as an `Action.Rejected` event.
 *
 * @category Models
 */
export interface Migration {
  readonly from: number;
  readonly migrate: (contents: Contents) => void;
}

/**
 * Migrates a save to a version of the game, one migration at a time. A save
 * already at that version is returned unchanged.
 *
 * Fails with `LoadRefused`: `"newer version"` for a save from a later version,
 * `"no migration"` when a step is missing, `"migration failed"` when a
 * migration throws, and a snapshot's own problems when the save's world can't
 * be read or written back.
 *
 * @category Migrations
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
      world: readSnapshot(save.world),
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
      world: writeSnapshot(contents.world),
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
// 2: the game's time, its queued actions and its waiting events are in the
// world, not beside it. 3: so is where each system had read the events to.
const FORMAT = 3;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Header = Schema.fromJsonString(
  Schema.Struct({
    version: Count,
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
 * Encodes a save as bytes: a short header, everything but the world as JSON
 * text, then the world's snapshot unchanged.
 *
 * @category Codecs
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
 * Decodes a save from bytes. It checks the save's own structure; the world
 * inside is checked when the save is loaded.
 *
 * Fails with `LoadRefused`: `"not a save"`, `"newer format"` for a save written
 * by a later version of arcadekit, `"truncated"` or `"corrupt"`.
 *
 * @category Codecs
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
  const header = Schema.decodeExit(Header)(text);
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
