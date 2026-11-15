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

import type { SnapshotProblem } from "./ecs/snapshot";

/** The events of one kind that were waiting to be read when a game was saved. */
export interface SavedEvents {
  readonly name: string;
  /** Each event's payload in its JSON form, oldest first. */
  readonly payloads: readonly unknown[];
  /** Per system or handler that had read some: how many of them it had read. */
  readonly read: Readonly<Record<string, number>>;
}

export interface Save {
  /** How many ticks had run. */
  readonly tick: number;
  /** Game time, in seconds. */
  readonly elapsed: number;
  /** The seconds the last tick simulated. */
  readonly delta: number;
  /** `world.snapshot()`. */
  readonly world: Uint8Array;
  /** The actions waiting for the next tick, in order, payloads in JSON form. */
  readonly queued: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
  readonly events: readonly SavedEvents[];
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
 * one of a snapshot's problems, or `"not a save"` when the bytes are not a
 * saved game at all.
 */
export class LoadRefused extends Data.TaggedError("LoadRefused")<{
  readonly problem: SnapshotProblem | "not a save";
  readonly message: string;
}> {}

/** "AKSV": arcadekit save. */
const MAGIC = 0x56534b41;
const FORMAT = 1;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Header = Schema.fromJsonString(
  Schema.Struct({
    tick: Count,
    elapsed: Schema.Finite,
    delta: Schema.Finite,
    queued: Schema.Array(
      Schema.Struct({ name: Schema.String, payload: Schema.Unknown })
    ),
    events: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        payloads: Schema.Array(Schema.Unknown),
        read: Schema.Record(Schema.String, Count),
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
