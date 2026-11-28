---
title: "Settings"
description: "A setting is a choice that outlives a game, such as a volume or the keys a player bound. It is kept outside the world, read between ticks, and brought into the game by an action."
---

A **setting** is a choice that outlives a game: a volume, the keys a player bound, the levels unlocked, the last slot played. It is kept outside the world, so no [save](saving-and-loading.md) holds it, the world's hash leaves it out, and a rewind or a load leaves it as it is.

## Define a setting and read it between ticks

```ts
import { App, Driver, Plugin, Setting, System } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect, Schema } from "effect";

const Volume = Setting.define(
  "game/Volume",
  Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  1
);

const Mixer = System.frame("game/Mixer", function* () {
  const volume = yield* Setting.get(Volume); // 1 until it is set
  /* … */
});
const Game = App.define({
  plugins: [Plugin.make("game/Game", { systems: [Mixer] })],
});
const slider = document.querySelector<HTMLInputElement>("#volume")!;

Browser.runMain(
  Driver.run(Game, {
    hz: 60,
    ready: () =>
      Effect.gen(function* () {
        const run = Effect.runForkWith(yield* Effect.context<Setting.Store>());
        slider.oninput = () => run(Setting.set(Volume, Number(slider.value)));
      }),
  }).pipe(Effect.provide(Setting.layer(Browser.settings("mygame")))),
  { target: document.querySelector("canvas")! }
);
```

`Setting.define(key, schema, initial)` defines a setting. `yield* Setting.get(Volume)` reads its value: the one last set, or `initial` until it is set. `Setting.set(Volume, value)` sets it, and keeps it in `Setting.Store` at once, so the next visit to the page reads it.

- A system of the frame or input stage reads a setting, and so does a plugin's layer and code outside the game. A system of the tick, an action's handler and a plugin's setup that read one don't compile: a replay, a save and the other peers of a session have none of it.
- The key is what identifies the setting where it is kept. Prefix it with its feature, as a component's name is.
- `Setting.set` fails with `Setting.Invalid` for a value the schema doesn't take, and with `Setting.StoreFailed` when the store can't keep it. Either way, the setting keeps the value it had.
- A kept value the schema no longer takes, after the schema changed, or text that isn't JSON, fails the read with `Setting.Invalid`, which names the key, until it is set again. A frame that fails ends `Driver.run` with the failure, so a game that would rather start from `initial` reads it with `yield* Effect.orElseSucceed(Volume, () => Volume.initial)`.

| Store | Keeps the settings |
| --- | --- |
| `Browser.settings(name)` | In the page's local storage, under the game's name, through a reload |
| `Setting.makeMemory(kept)` | In memory, for a test, holding `kept` by key to begin with |
| One of your own | Wherever it keeps them: a `Setting.StoreShape`, given to `Setting.layer` |

A store answers a read at once, since the frame stage reads a setting every frame. `Browser.settings` reads each setting from the page's storage once, and from memory after.

## Bring a setting into the game with an action

```ts
import { Action, Field, Setting, Singleton, System } from "arcadekit";
import { Schema } from "effect";

const Hard = Setting.define("game/Hard", Schema.Boolean, false);
const Mode = Singleton.define("game/Mode", { hard: Field.u8 }, { hard: 0 });
const SetHard = Action.define("game/SetHard", {
  payload: Schema.Struct({ hard: Schema.Boolean }),
});

const setHard = Action.handler(SetHard, function* ({ hard }) {
  (yield* Singleton.Write(Mode)).hard = hard ? 1 : 0;
});
// Before each tick: when the setting and the game differ, the game is told.
const FollowHard = System.input("game/FollowHard", function* () {
  const hard = yield* Setting.get(Hard);
  if (((yield* Singleton.Read(Mode)).hard === 1) !== hard) {
    (yield* Action.Actions).enqueue(SetHard, { hard });
  }
});
```

What of a setting changes the game, such as its difficulty, goes in as an action. An input system reads the setting and issues the action, which the log holds, so a replay and the other peers of a session play the game with it, and a save holds what it did.

## Read more

- [Saving and loading](saving-and-loading.md), for the game itself.
- [`Setting`](/reference/arcadekit/Setting) in the API reference.
