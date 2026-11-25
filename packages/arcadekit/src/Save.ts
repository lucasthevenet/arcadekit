/**
 * A save is a game captured between two ticks, to continue later: its world
 * as a snapshot, which holds everything that decides what the next tick does.
 *
 *   const save = yield* app.save()                 // fails with Save.SaveRefused
 *   const bytes = Save.encode(save)                // for a file or the network
 *
 *   const loaded = yield* Save.decode(bytes)       // fails with Save.LoadRefused
 *   const again = yield* App.make(game, { save: loaded }) // the game, where it was
 *
 * Its world holds the game's time, the actions queued for the next tick, the
 * events waiting to be read with where each system had read to, and what
 * change queries haven't visited yet. Everything a game is in the middle of
 * is in the world, so the save holds all of it.
 *
 * Everything logged after a save is the game's tail, and `app.record(save)`
 * records it with the save. Replaying that recording brings the game back to
 * the present, however long it has run:
 *
 *   const tail = app.record(save)
 *   const present = yield* Journal.replay(tail, game)
 */
import { Cause, Data, Exit, Schema } from "effect";

import type { CommandBuffer } from "./ecs/commands.ts";
import type { Entity } from "./ecs/component.ts";
import { readSingleton, readSnapshot, writeSnapshot } from "./ecs/contents.ts";
import type { SnapshotContents } from "./ecs/contents.ts";
import { SnapshotError } from "./ecs/snapshot.ts";
import type { SnapshotProblem } from "./ecs/snapshot.ts";
import type { Spawned } from "./ecs/spawned.ts";
import type { Store } from "./ecs/store.ts";
import type { World } from "./ecs/world.ts";

/**
 * A game captured between two ticks, which `app.save()` makes: the game's
 * version, its world as a snapshot, and the length of its log. `Save.encode`
 * turns it into bytes, and `App.make` continues the game from it.
 *
 * @category Models
 */
export interface Save {
  /**
   * The `version` of the game that wrote the save, as `App.define` was given
   * it, 0 by default. When you change the game's components, increment it and
   * give the game a migration from the version before. A changed field kind,
   * name or order is refused at load whatever the version; a field whose
   * values mean something else is caught only by incrementing the version.
   */
  readonly version: number;
  /**
   * The world, as `world.snapshot()` writes it. Beside the entities, it holds
   * the game's time, the actions queued for the next tick, the events waiting
   * to be read, and what change queries haven't visited yet.
   */
  readonly world: Uint8Array;
  /**
   * The number of entries the app's action log held when the save was taken.
   * Everything logged after them is the tail that `app.record(save)` records.
   */
  readonly logLength: number;
}

/**
 * The game can't be saved as it is. Its message names the cause: a queued
 * action or a waiting event whose payload its schema doesn't take, a field
 * that holds a value that can't be saved, or a command still queued.
 *
 * @category Errors
 */
export class SaveRefused extends Data.TaggedError("SaveRefused")<{
  readonly message: string;
}> {}

/**
 * A save couldn't be loaded. `problem` names the kind of failure:
 *
 * - one of a snapshot's problems, such as `"corrupt"` or `"unknown component"`;
 * - `"not a save"`: the bytes aren't a saved game at all;
 * - `"older format"`: an earlier version of arcadekit wrote the save, in a
 *   format this version doesn't read;
 * - `"newer version"`: a later version of the game wrote the save;
 * - `"no migration"`: an earlier version wrote it, and the game has no
 *   migration from that version;
 * - `"migration failed"`: a migration threw.
 *
 * An event waiting to be read that this program doesn't define, or one in a
 * form its schema no longer takes, is the snapshot's `"store changed"`.
 *
 * @category Errors
 */
export class LoadRefused extends Data.TaggedError("LoadRefused")<{
  readonly problem:
    | SnapshotProblem
    | "not a save"
    | "older format"
    | "newer version"
    | "no migration"
    | "migration failed";
  readonly message: string;
}> {}

/**
 * A save in a plain form that describes itself, for a migration to edit. Its
 * world lists components by name with their fields, as the snapshot describes
 * them, so a migration can read it whatever the game's components are now.
 * `Migrate` makes the common changes.
 *
 * @category Models
 */
export interface Contents {
  /**
   * The world. Its `stores` hold, each under its name, what an app keeps of a
   * game beside its entities:
   *
   * - `Action.INTAKE`: `{ queued }`, the actions that were queued, each
   *   `{ name, payload, from? }` with its payload in JSON form;
   * - `Event.STORE`: for each event that was waiting, `{ name, waiting,
   *   read }`, its events in JSON form and how many each system had read;
   * - `Save.VISITS`: what change queries hadn't visited yet, by component
   *   name. Entries under a name the game no longer has are dropped when the
   *   save is loaded: the queries watching the component then start over,
   *   with every entity counting as changed.
   */
  world: SnapshotContents;
}

/**
 * Turns a save written by version `from` of a game into one of version
 * `from + 1`, by editing in place the contents it receives.
 *
 * **Gotchas**
 *
 * - A migration turns an old save into a new game, and the log recorded
 *   before it no longer replays against it.
 * - A migration that comes with a schema change updates the payloads in
 *   `world.stores` too. A waiting event that its schema no longer takes makes
 *   the load fail with `"store changed"`. A queued action that its schema no
 *   longer takes is refused when it is applied, as an `Action.Rejected` event.
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
// world, not beside it. 3: so is where each system had read the events to,
// and what its change queries had yet to visit.
const FORMAT = 3;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Header = Schema.fromJsonString(
  Schema.Struct({
    version: Count,
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
 * Decodes a save from bytes. It checks the save's own structure. The world
 * inside is checked when the save is loaded.
 *
 * Fails with `LoadRefused`: `"not a save"`, `"older format"` or
 * `"newer format"` for a save written by an earlier or a later version of
 * arcadekit, `"truncated"` or `"corrupt"`.
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
      format < FORMAT ? "older format" : "newer format",
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

/** Says what a failed decoding found wrong. */
const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Takes a world as it is, with `take`, to `save` or to `capture`: refused
 * while commands are queued and not applied, and when the world holds what
 * has no saved form.
 *
 * @internal
 */
export const taking = <A>(
  commands: CommandBuffer<Entity | Spawned>,
  to: "save" | "capture",
  take: () => A
): Exit.Exit<A, SaveRefused> => {
  if (commands.size > 0) {
    return Exit.fail(
      new SaveRefused({
        message: `${commands.size} commands are queued and not applied. They are applied at the end of a tick: ${to} after one.`,
      })
    );
  }
  try {
    return Exit.succeed(take());
  } catch (error) {
    if (error instanceof SnapshotError) {
      return Exit.fail(new SaveRefused({ message: error.message }));
    }
    throw error;
  }
};

/**
 * `app.save()`: a save of a world, for a game of a version whose log has a
 * length.
 *
 * @internal
 */
export const take = (
  world: World,
  commands: CommandBuffer<Entity | Spawned>,
  version: number,
  logLength: number
): Exit.Exit<Save, SaveRefused> =>
  Exit.map(
    taking(commands, "save", () => world.snapshot()),
    (bytes) => ({ version, world: bytes, logLength })
  );

/**
 * The version a game is made with: a whole number from 0 up, and 0 when it
 * gives none.
 *
 * @internal
 */
export const versionOf = (given: number | undefined): number => {
  const version = given ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(
      `A game's version must be a whole number from 0 up, and this one is ${version}.`
    );
  }
  return version;
};

/**
 * Fills an empty world from a save, brought up to a version of the game
 * first, and returns the save as it was loaded.
 *
 * @internal
 */
export const into = (
  world: World,
  save: Save,
  version: number,
  migrations: readonly Migration[]
): Exit.Exit<Save, LoadRefused> => {
  const current = migrate(save, version, migrations);
  if (Exit.isFailure(current)) {
    return current;
  }
  try {
    world.load(current.value.world);
  } catch (error) {
    if (!(error instanceof SnapshotError)) {
      throw error;
    }
    return Exit.fail(
      new LoadRefused({
        problem: error.problem,
        message:
          error.problem === "unknown component"
            ? `${error.message} A migration renames or removes a component in a save.`
            : error.problem === "unknown store" ||
                error.problem === "store changed"
              ? `${error.message} A migration changes the events and the queued actions of a save in \`world.stores\`.`
              : error.message,
      })
    );
  }
  return current;
};

/**
 * The first value a save's world holds of a singleton's field, or undefined
 * when it holds none. It reads none of the save's entities.
 *
 * @internal
 */
export const singleton = (
  save: Save,
  component: string,
  field: string
): unknown => readSingleton(save.world, component)?.columns[field]?.[0];

/**
 * The name of the store that holds what an app's change queries have yet to
 * visit, as a snapshot has it: `readSnapshot(save.world).stores`. It holds
 * what `world.saveChanges()` returns for the systems of the tick and the
 * handlers: one entry per component and kind of change,
 * `{ component, kind, entries, readers }`.
 *
 * @category Constants
 */
export const VISITS = "arcadekit/changes";

/**
 * What a snapshot holds of the visits: `world.saveChanges()`.
 * @internal
 */
export const VisitsData = Schema.Array(
  Schema.Struct({
    component: Schema.String,
    kind: Schema.Literals(["changed", "added", "removed"]),
    entries: Schema.Array(Schema.Number),
    readers: Schema.Record(Schema.String, Schema.Number),
  })
);

/**
 * Where each system of the tick and each handler has got to in what changed:
 * what its change queries have yet to visit. The world keeps the logs; this
 * puts them in its snapshot, so that a loaded game goes on as the saved one
 * did. The frame and input stages' own places are not the game's: a loaded
 * game has everything still to draw.
 *
 * @internal
 */
export class Visits implements Store<undefined> {
  readonly name = VISITS;
  // Not hashed, and the world's own logs refuse what a frozen world refuses.
  readonly betweenTicks = true;
  private readonly world: World;
  private readonly saved: (reader: string) => boolean;

  /** `saved` says whose place a snapshot holds, by reader. */
  constructor(world: World, saved: (reader: string) => boolean) {
    this.world = world;
    this.saved = saved;
  }

  save(): unknown {
    const saved = this.world.saveChanges(this.saved);
    return saved.length === 0 ? undefined : saved;
  }

  load(data: unknown): void {
    const saved = Schema.decodeUnknownExit(VisitsData)(data);
    if (Exit.isFailure(saved)) {
      throw new SnapshotError(
        "corrupt",
        `The snapshot is damaged: what its change queries had yet to visit is not as a world saves it: ${describeCause(saved.cause)}`
      );
    }
    this.world.restoreChanges(saved.value);
  }

  hashed(): unknown {
    return undefined;
  }

  // A moment's are kept by whoever captures it, who says whose it holds.
  capture(): undefined {
    return undefined;
  }

  rewind(): void {}

  // The world empties its own logs.
  clear(): void {}

  begin(): void {}

  rollback(): void {}

  commit(): void {}

  contents(): unknown {
    return undefined;
  }
}
