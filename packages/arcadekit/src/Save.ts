/**
 * A save is a game captured between two ticks, to continue later: its world
 * as a snapshot, which holds everything that decides what the next tick does.
 *
 *   const save = yield* Save.make(app)            // fails with Save.Refused
 *   yield* Save.load(app, save)                   // the same app, where it was
 *
 *   yield* Save.write("slot2", save)               // kept in Save.Store
 *   const saved = yield* Save.read("slot2")        // an Option
 *
 *   const bytes = Save.encode(save)                // for a file or the network
 *   const loaded = yield* Save.decode(bytes)       // fails with Save.LoadRefused
 *   const again = yield* App.make(game, { save: loaded }) // a new app, where it was
 *
 * A save is kept in a slot of `Save.Store`, which a page provides with
 * `Save.layer(Browser.saves(name))` and a test with
 * `Save.layer(Save.makeMemory())`.
 *
 * Its world holds the game's time, the actions queued for the next tick, the
 * events waiting to be read with where each system had read to, and what
 * change queries haven't visited yet. Everything a game is in the middle of
 * is in the world, so the save holds all of it.
 *
 * Everything logged after a save is the game's tail, and
 * `Replay.record(app, save)` records it with the save. Replaying that
 * recording brings the game back to the present, however long it has run:
 *
 *   const tail = yield* Replay.record(app, save)
 *   const present = yield* Replay.verify(tail, game)
 */
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";
import type { Scope } from "effect";

import type * as App from "./App.ts";
import type { SnapshotProblem } from "./ecs/snapshot.ts";
import * as Event from "./Event.ts";
import { said } from "./internal/intake.ts";
import { partsOf } from "./internal/parts.ts";

/**
 * A game captured between two ticks, which `Save.make(app)` makes: the game's
 * version and its world as a snapshot. `Save.encode` turns it into bytes,
 * `Save.load` puts it back into an app, and `App.make` makes an app from it.
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
}

/**
 * Saves the game as it is, between ticks, to load later with `Save.load` or
 * `App.make(game, { save })`. The save holds the game's world, which holds
 * its time, the actions queued for the next tick, the events waiting to be
 * read, and what the change queries haven't visited yet. Run it only between
 * ticks, since it dies anywhere else.
 *
 *   const save = yield* Save.make(app)
 *
 * It fails with `Save.Refused`, which names what is in the way: a queued
 * action or a waiting event whose payload its schema doesn't take, a field
 * that holds a value that can't be saved, or commands queued but not applied.
 *
 * **Details**
 *
 * The app knows where in its log each save it made was taken, so that
 * `Replay.record(app, save)` records what it played since.
 *
 * @category Constructors
 */
export const make = (
  app: Pick<App.Any, "phase">
): Effect.Effect<Save, Refused> => Effect.suspend(() => partsOf(app).save());

/**
 * Loads a save into an app, in place of the game it plays: the app, its
 * plugins' layers, its frame and input stages, its views and its sound stay
 * as they are, and its game is the one the save holds. The save is brought up
 * to the game's version with its migrations first, as `App.make` brings one.
 * Run it only between ticks, since it dies anywhere else.
 *
 *   const save = yield* Save.make(app)
 *   yield* app.tick(1 / 60)
 *   yield* Save.load(app, save)                  // the game where it was saved
 *
 * The app is then the one `App.make(game, { save })` would make, ticks and
 * hashes as that one would, and is played by the same driver. Its action log
 * starts over, as that app's starts empty, and `Replay.record(app)` records
 * from the save. A moment captured before the load is refused by
 * `Timeline.rewind`. The frame and input stages, and code outside the game
 * that reads an event, hear the loaded game from then on, and their change
 * queries visit every entity again.
 *
 * It fails with `Save.LoadRefused` for a save the game can't load, as
 * `App.make` does, and the app is then as it was.
 *
 * **Gotchas**
 *
 * - An app a session steps has no `tick`, and doesn't compile here: a load
 *   would move this machine's game alone. One that a session has taken over
 *   dies.
 *
 * @category Running
 */
export const load = (
  app: Pick<App.Any, "phase" | "tick">,
  save: Save
): Effect.Effect<void, LoadRefused> =>
  Effect.suspend(() => partsOf(app).load(save));

/**
 * The game can't be saved as it is. Its message names the cause: a queued
 * action or a waiting event whose payload its schema doesn't take, a field
 * that holds a value that can't be saved, or a command still queued.
 *
 * @category Errors
 */
export class Refused extends Data.TaggedError("SaveRefused")<{
  readonly message: string;
}> {}

/**
 * A save couldn't be loaded. `problem` names the kind of failure:
 *
 * - one of a snapshot's problems that a load meets, such as `"corrupt"` or
 *   `"unknown component"`;
 * - `"not a save"`: the bytes aren't a saved game at all;
 * - `"older format"`: an earlier version of arcadekit wrote the save, in a
 *   format this version doesn't read;
 * - `"newer version"`: a later version of the game wrote the save;
 * - `"no migration"`: an earlier version wrote it, and the game has no
 *   migration from that version;
 * - `"migration failed"`: a migration threw, or left a value that can't be
 *   saved.
 *
 * An event waiting to be read that this program doesn't define, or one in a
 * form its schema no longer takes, is the snapshot's `"store changed"`.
 *
 * @category Errors
 */
export class LoadRefused extends Data.TaggedError("SaveLoadRefused")<{
  readonly problem:
    | Exclude<SnapshotProblem, "world not empty" | "cannot be saved">
    | "not a save"
    | "older format"
    | "newer version"
    | "no migration"
    | "migration failed";
  readonly message: string;
}> {}

/** "AKSV": arcadekit save. */
const MAGIC = 0x56534b41;
// 2: the game's time, its queued actions and its waiting events are in the
// world, not beside it. 3: so is where each system had read the events to,
// and what its change queries had yet to visit. 4: no length of the log that
// made it, which format 3 held and which a save of 3 is read without.
const FORMAT = 4;
/** The oldest format this version reads. */
const OLDEST = 3;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Header = Schema.fromJsonString(Schema.Struct({ version: Count }));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes a save as bytes: a short header, everything but the world as JSON
 * text, then the world's snapshot unchanged.
 *
 * @category Codecs
 */
export const encode = (save: Save): Uint8Array => {
  const { version, world } = save;
  const json = textEncoder.encode(JSON.stringify({ version }));
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
  if (format < OLDEST || format > FORMAT) {
    return refuse(
      format < OLDEST ? "older format" : "newer format",
      `The save is in format ${format}, and this version reads formats ${OLDEST} to ${FORMAT}.`
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
    version: header.value.version,
    world: bytes.slice(12 + length),
  });
};

// --- slots: where a program keeps its saves ----------------------------------------

/**
 * Where a program keeps its saves, each as its bytes under the name of its
 * slot. A page keeps them in its local storage, with `Browser.saves(name)`,
 * and a test in memory, with `Save.makeMemory()`.
 *
 * @category Services
 */
export interface StoreShape {
  /** Returns the bytes a slot holds, or undefined for an empty slot. */
  readonly get: (
    slot: string
  ) => Effect.Effect<Uint8Array | undefined, StoreFailed>;
  /** Keeps bytes in a slot, in place of what it held. */
  readonly set: (
    slot: string,
    bytes: Uint8Array
  ) => Effect.Effect<void, StoreFailed>;
  /** Empties a slot. An empty slot stays empty. */
  readonly remove: (slot: string) => Effect.Effect<void, StoreFailed>;
  /** The slots that hold something, by name. */
  readonly slots: Effect.Effect<readonly string[], StoreFailed>;
}

/**
 * Where a program keeps its saves, which `Save.layer` provides, for
 * `Save.write` and `Save.read`. It is code outside the game that saves to a
 * slot and loads from one, between ticks.
 *
 * @category Services
 */
export class Store extends Context.Service<Store, StoreShape>()(
  "arcadekit/Save.Store"
) {}

/**
 * Returns a layer that provides where saves are kept, such as
 * `Browser.saves(name)` in a page or `Save.makeMemory()` in a test, as
 * `Save.Store`.
 *
 * @category Layers
 */
export const layer = (store: StoreShape): Layer.Layer<Store> =>
  Layer.succeed(Store, store);

/**
 * Makes a store of saves in memory, for a test or a tool. Two layers given
 * one store share its slots, as two visits to a page share its storage.
 *
 * @category Testing
 */
export const makeMemory = (): StoreShape => {
  const slots = new Map<string, Uint8Array>();
  return {
    get: (slot) => Effect.sync(() => slots.get(slot)?.slice()),
    set: (slot, bytes) =>
      Effect.sync(() => {
        slots.set(slot, bytes.slice());
      }),
    remove: (slot) =>
      Effect.sync(() => {
        slots.delete(slot);
      }),
    slots: Effect.sync(() => [...slots.keys()]),
  };
};

/**
 * Where saves are kept couldn't do what it was asked, such as a page whose
 * storage is full or turned off.
 *
 * @category Errors
 */
export class StoreFailed extends Data.TaggedError("SaveStoreFailed")<{
  /** The slot it was asked about, if one. */
  readonly slot: string | undefined;
  readonly message: string;
}> {}

/**
 * Keeps a save in a slot of `Save.Store`, as its bytes, in place of what the
 * slot held.
 *
 *   yield* Save.write("slot2", yield* Save.make(app))
 *
 * It fails with `Save.StoreFailed` when the store can't keep it, as when a
 * page's storage is full.
 *
 * @category Running
 */
export const write = Effect.fn("Save.write")(function* (
  slot: string,
  save: Save
) {
  const store = yield* Store;
  yield* store.set(slot, encode(save));
});

/**
 * Reads the save a slot of `Save.Store` holds, or none for an empty slot.
 *
 *   const saved = yield* Save.read("slot2")
 *   if (Option.isSome(saved)) yield* Save.load(app, saved.value)
 *
 * It fails with `Save.LoadRefused` when what the slot holds isn't a save this
 * version of arcadekit reads, as `Save.decode` does, and with
 * `Save.StoreFailed` when the store can't be read. Whether the game loads the
 * save is checked when it is loaded.
 *
 * @category Running
 */
export const read = Effect.fn("Save.read")(function* (slot: string) {
  const store = yield* Store;
  const bytes = yield* store.get(slot);
  if (bytes === undefined) {
    return Option.none<Save>();
  }
  return Option.some(yield* decode(bytes));
});

// --- a save the game asks for -------------------------------------------------------

/**
 * Asks for a save of the game in a slot, from its rules: the app takes it
 * once the tick that asked for it has run, and keeps it in the slot, when
 * `Save.autosave` keeps the app's saves. It is an event like any other, so a
 * replay asks again, and a game whose saves nothing keeps asks for nothing.
 *
 *   const LevelEnd = State.onEnter(Level, "won", "game/LevelEnd", function* () {
 *     (yield* Save.Asked.emits).emit({ slot: "auto" })
 *   })
 *   const Every = System.tick("game/Autosave", function* () {
 *     (yield* Save.Asked.emits).emit({ slot: "auto" })
 *   }).pipe(Timer.every(60))
 *
 * @category Events
 */
export const Asked = Event.define(
  "arcadekit/Save.Asked",
  Schema.Struct({ slot: Schema.String })
);

/**
 * Keeps the saves a game asks for with `Save.Asked`, for as long as the scope
 * it runs in lasts: after each tick and each dispatched action in which the
 * rules asked, it takes the game's save and writes it to each slot they asked
 * for, in `Save.Store`. Nothing outside the game watches its world for the
 * moment: the rules say when.
 *
 *   Driver.run(Game, { hz: 60, ready: (app) => Save.autosave(app) }).pipe(
 *     Effect.provide(Save.layer(Browser.saves("mygame")))
 *   )
 *
 * **Details**
 *
 * - The save is taken between two ticks, of the game as the tick that asked
 *   left it, and written before the next tick runs.
 * - A save that can't be taken, or a slot the store can't keep, is logged as
 *   an error with what went wrong, and the game goes on. The next ask tries
 *   again.
 *
 * @category Running
 */
export const autosave = (
  app: Pick<App.Any, "phase">
): Effect.Effect<void, never, Store | Scope.Scope> =>
  Effect.gen(function* () {
    if (app.phase !== "idle") {
      throw new Error(
        "Save.autosave() was called while the app was running something. The saves of a game are kept from between two ticks."
      );
    }
    const store = yield* Store;
    const { after, events } = partsOf(app);
    const asked = events.handle(Asked);
    const step = Effect.fnUntraced(function* () {
      const slots = [...new Set(asked.read().map(({ slot }) => slot))];
      if (slots.length === 0) {
        return;
      }
      const taken = yield* Effect.exit(make(app));
      if (Exit.isFailure(taken)) {
        return yield* Effect.logError(
          `Save.autosave could not take the save the game asked for in ${slots.map((slot) => `"${slot}"`).join(", ")}: ${said(Cause.squash(taken.cause))}`
        );
      }
      const bytes = encode(taken.value);
      for (const slot of slots) {
        const kept = yield* Effect.exit(store.set(slot, bytes));
        if (Exit.isFailure(kept)) {
          yield* Effect.logError(
            `Save.autosave could not keep the save the game asked for in "${slot}": ${said(Cause.squash(kept.cause))}`
          );
        }
      }
    });
    after.add(step);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        after.delete(step);
      })
    );
  });
