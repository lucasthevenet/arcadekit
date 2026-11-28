---
title: "Saving and loading"
description: "A save captures a game between two ticks, and a game loaded from it continues exactly as the saved one would have. Learn how to save, load in place, keep saves in slots, save when the rules ask, and read why a load was refused."
---

A **save** captures a game between two ticks. A game loaded from a save continues exactly as the saved game would have. [Migrating old saves](migrating-saves.md) covers saves that an older version of the game wrote, and [settings](settings.md) what a game keeps that isn't the game.

## Save a game and load it again

```ts
import {
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Save,
  World,
} from "arcadekit";
import { Effect } from "effect";

const Position = Component.define("game/Position", { x: Field.f32 });
const Rules = Plugin.make("game/Rules", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Position)).spawn(Position.of({ x: 3 }));
  }),
});
const Game = App.define({ plugins: [Rules] });

const program = Effect.gen(function* () {
  const app = yield* Effect.acquireRelease(
    App.make(Game),
    (made) => made.close
  );
  const world = yield* app.read(World);
  yield* app.tick(1 / 60);
  const save = yield* Save.make(app); // fails with Save.Refused
  const saved = world.hash();

  yield* app.tick(1 / 60);
  yield* Save.load(app, save); // fails with Save.LoadRefused
  world.hash() === saved; // true
}).pipe(Effect.scoped);
```

`Save.make(app)` works between two ticks. The save holds the world as a [snapshot](snapshots.md), which holds the game's time, the actions queued for the next tick, the simulation's own among them, the events waiting to be read with each system's place in them, and what change queries haven't visited.

`Save.load(app, save)` puts the game the save holds into the app that runs, between two ticks. The app, its plugins' layers, its frame and input stages, its views and its sound stay as they are, and so does the driver that runs it: a page keeps drawing and playing as it was. The app is then the one `App.make(game, { save })` would make, and plays on to the same hashes.

- Its action log starts over, as that app's starts empty, and `Replay.record(app)` records from the save.
- The frame and input stages hear the loaded game from then on, and nothing of the game it replaced. Their change queries visit every entity again, so what draws draws all of it.
- A moment captured with `Timeline.capture` before the load is of the game the load replaced, and `Timeline.rewind` refuses it.
- A save it refuses, with the reasons [below](#read-why-a-load-was-refused), leaves the app as it was.
- It dies on an app that a [session](sessions.md) has taken over, where it would move this machine's game alone.

## Keep saves in slots

```ts
import { App, Driver, Plugin, Save } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect, Option } from "effect";

const Game = App.define({ plugins: [Plugin.make("game/Game", {})] });
const button = (id: string) => document.querySelector<HTMLElement>(id)!;

Browser.runMain(
  Driver.run(Game, {
    hz: 60,
    ready: (app) =>
      Effect.gen(function* () {
        // A button runs an Effect of its own, with what the game was given.
        const run = Effect.runForkWith(yield* Effect.context<Save.Store>());
        button("#save").onclick = () =>
          run(
            Effect.flatMap(Save.make(app), (save) => Save.write("slot2", save))
          );
        button("#load").onclick = () =>
          run(
            Effect.flatMap(Save.read("slot2"), (saved) =>
              Option.isSome(saved) ? Save.load(app, saved.value) : Effect.void
            )
          );
      }),
  }).pipe(Effect.provide(Save.layer(Browser.saves("mygame")))),
  { target: document.querySelector("canvas")! }
);
```

A **slot** is a name a save is kept under in `Save.Store`. `Save.write(slot, save)` keeps it, in place of what the slot held, and `Save.read(slot)` reads it back, or none for an empty slot. A click runs between two frames, so between two ticks, where `Save.make(app)` and `Save.load` work. The game goes on drawing and playing through a load.

| Store | Keeps the saves |
| --- | --- |
| `Browser.saves(name)` | In the page's local storage, under the game's name, through a reload |
| `Save.makeMemory()` | In memory, for a test |
| One of your own | Wherever it keeps them: a `Save.StoreShape`, given to `Save.layer` |

- `(yield* Save.Store).slots` lists the slots that hold a save, for a menu of saved games, and `remove(slot)` empties one.
- `Save.write` and `Save.read` fail with `Save.StoreFailed` when the store can't keep or read a slot, and `Save.read` with `Save.LoadRefused` when the slot holds what isn't a save.
- A page's local storage holds about 5 MB for its whole site, and keeps a save as base64 text, a third larger than its bytes.

## Save when the rules ask

```ts
import {
  App,
  Driver,
  Event,
  Field,
  Save,
  Singleton,
  System,
  Timer,
} from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect } from "effect";

const Level = Singleton.define(
  "game/Level",
  { won: Field.bool },
  { won: false }
);

// The rules say when: once the level is won, and every minute of play.
const LevelEnd = System.tick("game/LevelEnd", function* () {
  if ((yield* Singleton.Read(Level)).won) {
    (yield* Event.Emitter(Save.Asked)).emit({ slot: "level" });
  }
});
const Autosave = System.tick("game/Autosave", function* () {
  (yield* Event.Emitter(Save.Asked)).emit({ slot: "auto" });
}).pipe(Timer.every(60));
const Game = App.define({ systems: [LevelEnd, Autosave] });

Browser.runMain(
  Driver.run(Game, { hz: 60, ready: (app) => Save.autosave(app) }).pipe(
    Effect.provide(Save.layer(Browser.saves("mygame")))
  ),
  { target: document.querySelector("canvas")! }
);
```

The rules ask for a save with the event `Save.Asked`, which names a slot. `Save.autosave(app)` keeps what they ask for: once the tick that asked has run, between two ticks, it takes the game's save and writes it to each slot asked for. Nothing outside the game watches its world for the moment.

- The save is of the game as the tick that asked left it, and is written before the next tick runs. A handler that `app.dispatch` runs can ask too, and its save is taken once the dispatch has run.
- `Timer.every` keeps the interval in the world, so a replay asks at the same ticks, and a game loaded from the save goes on counting from where it was.
- A save that can't be taken, or a slot the store can't keep, is logged as an error, and the game goes on. The next ask tries again, and [the slot's status](#tell-the-player-whether-the-game-is-saved) says so meanwhile.
- A game that nothing autosaves, as a replay or a server, asks and nothing happens.
- It keeps saves for as long as the scope it runs in lasts: with `ready`, for as long as the game runs.

## Tell the player whether the game is saved

```ts
import { Save, View } from "arcadekit";

// The rules ask with `{ slot: Auto.name }`.
export const Auto = Save.slot("auto");

const Saved = View.define("game/Saved", { label: "" });

export const ShowSaved = View.publish(Saved, function* () {
  return {
    label: Save.match(yield* Save.Status(Auto), {
      Off: () => "",
      Unasked: () => "",
      Saved: () => "Saved",
      Failed: ({ error }) => `Not saved: ${error.message}`,
    }),
  };
});
```

`Save.slot(name)` names a slot. In a frame or input system, `yield*` of it returns what `Save.autosave` last did with the slot, and `Save.match` gives a case for each status, so a [view](ui.md) of it tells the player whether the game is saved:

| Status | The slot |
| --- | --- |
| `Off` | Nothing autosaves the app, so an ask keeps nothing. |
| `Unasked` | The rules haven't asked for it since `Save.autosave` began. |
| `Saved` | It holds the save the rules last asked for. |
| `Failed` | It doesn't hold the save the rules last asked for. `error` is `Save.Refused` when the save couldn't be taken, and `Save.StoreFailed` when the store couldn't keep it. |

A slot that `Save.write` keeps has no status. Like a [setting](settings.md), the status is outside the world: the hash, the log and a save don't hold it, and the tick can't read it.

## Start a game from a save

```ts sketch
const bytes = Save.encode(save); // a Uint8Array, for a file
const read = yield * Save.decode(bytes); // fails with Save.LoadRefused
const again = yield * App.make(Game, { save: read });
```

`Save.encode` writes a short header and a little JSON text, then the snapshot unchanged. For 100,000 entities with four float fields, a save is 2.8 MB and takes about 0.7 ms.

`App.make(game, { save })` makes a new app that continues the game from a save. Pass the game the save was made with. No plugin's `setup` runs, since the save already holds what each setup spawned. To start a page from a save, give it to `Driver.run`, as in `Driver.run(game, { hz: 60, save })`. A save holds where the game's random sequence had got to, so `App.make` takes `save` or `seed`, not both.

To return the same app to an earlier moment in the same run, use `Timeline.capture(app)` and `Timeline.rewind(app, moment)`, which work in memory. See [capturing and rewinding](capturing-and-rewinding.md).

## Keep a game savable

- **Keep the names of what a save holds.** A save names every component, singleton, state and event it holds. A load finds each by the definition your program has under that name, with no list to register them in. A save that holds a name your program no longer defines fails to load with `"unknown component"`, or `"store changed"` for an event, and the message names it. Rename or remove the name in a [migration](migrating-saves.md).
- **Keep what the game is in the middle of in the world.** Work that takes [many ticks](systems.md#spread-work-over-many-ticks), such as a countdown or a wave of enemies, keeps its place in a component, a singleton or a state, so a save holds it.
- **Save after a tick.** A game can't be saved while commands are queued but not applied. A tick applies them at its end.

`Save.make(app)` fails with `Save.Refused`, whose message names the problem, when commands are queued, when a field holds a value that can't be saved, or when a queued action or a waiting event has a payload its schema doesn't take.

These aren't saved: `Field.transient` fields, which are `undefined` after a load, and anything kept outside the world, such as a variable of a module.

## Return to the present from a save

```ts sketch
const tail = yield * Replay.record(app, save); // from the save's tick to now
const present = yield * Replay.verify(tail, Game);
```

The app knows where in its action log each save it made was taken. Record what the game played since its last save, and replay only that tail to return to the present. The tail holds the save, so replaying it costs the same however long the game has run.

`Replay.record(app, save)` knows a save by what it holds: the one `Save.make` gave, or a copy read back from its bytes, as `Save.read` gives one from a slot. It dies for a save the app didn't make, and for one its log no longer reaches: the app loaded a save since, or the game went back to before the save and came to it again past a move, as a rollback of a session does. A game that undoes a turn back to its save still records since it. An app made from a save starts its own log empty, and a recording of it begins at that save.

The [replay](replays.md) checks itself against the tail's hash checks, so a save that didn't restore the game exactly is caught at the next hash check.

## Read why a load was refused

`Save.decode`, and `App.make` with a `save`, fail with `Save.LoadRefused`. Its `problem` identifies the kind of failure, and its message names the component, field or version involved:

| `problem` | The save |
| --- | --- |
| `"not a save"`, `"not a snapshot"` | Isn't a saved game at all |
| `"truncated"`, `"corrupt"` | Is incomplete or damaged |
| `"older format"` | Was written by an earlier version of arcadekit, in a format this one doesn't read |
| `"newer format"` | Was written by a later version of arcadekit |
| `"newer version"` | Was written by a later version of the game |
| `"no migration"` | Is older, and there is no migration from its version, or from a version on the way |
| `"migration failed"` | Is older, and a migration threw. The message says which migration, and what it threw |
| `"unknown component"` | Holds a component this program doesn't define, or no longer by that name |
| `"store changed"` | Holds an event waiting to be read that this program doesn't define, or one in a form its schema no longer takes |
| `"unknown store"` | Holds what the world it was loaded into has no store for, such as queued actions in a world with no app |
| `"component changed"` | Holds a component whose fields differ from the game's after any migrations ran. The message lists both |

## Read more

- [Settings](settings.md), for what a game keeps that isn't the game.
- [`Save`](/reference/arcadekit/Save) and [`Migrate`](/reference/arcadekit/Migrate) in the API reference.
