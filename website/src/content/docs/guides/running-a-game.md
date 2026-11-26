---
title: "Running a game"
description: "Start a game with Driver.run and your platform's runMain. Learn how to run in a page and under Node, tick only when needed, and step an app by hand."
---

**`Driver.run`** runs a game until it is interrupted. Your platform's `runMain` starts it: `Browser.runMain` in a page, and `NodeRuntime.runMain` under Node.

## Run a game in a page

```ts
import { Action, App, Driver, Plugin } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect, Schema } from "effect";

const NewGame = Action.define("game/NewGame", Schema.Struct({}));
const newGame = Action.handler(NewGame, function* () {});
const Game = Plugin.make("game/Game", { handlers: [newGame] });

const canvas = document.querySelector("canvas")!;
const button = document.querySelector("button")!;

Browser.runMain(
  Driver.run(App.define({ plugins: [Game] }), {
    seed: Date.now(),
    hz: 60,
    ready: (app) =>
      Effect.gen(function* () {
        // A click comes from outside any Effect: it runs what it asks for.
        const runFork = Effect.runForkWith(yield* Effect.context());
        button.onclick = () => runFork(app.enqueue(NewGame, {}));
      }),
  }),
  { target: canvas, preventDefault: ["Space", "ArrowUp", "ArrowDown"] }
);
```

`Driver.run` makes the app from two things:

- The game, which `App.define` makes from its plugins, systems, and handlers. It is the same every time it is played.
- How this run of it starts: a `seed` for a new game, or a `save` to continue one, among its options as `App.make` takes them.

On each repaint, it runs the ticks that are due at `hz`, then the frame stage. It never completes on its own. When it is interrupted, or a tick or a frame fails, it closes the app. Its options:

| Option | Default | Description |
| --- | --- | --- |
| `seed` | `0` | Where the game's random sequence starts, for a new game |
| `save` | None | A save to continue from, in place of a `seed` |
| `hz` | Required | The ticks per second, whatever the frame rate |
| `ticks` | `"always"` | `"whenNeeded"` ticks only while the game changes. See [tick only when needed](#tick-only-when-needed) |
| `maxStepsPerCall` | `5` | The most ticks that one frame runs after a freeze. The loop drops the ticks still owed |
| `ready` | None | A step that has the app once it is made, before its first frame |

`Browser.runMain` is the page's `runMain`. It reports failures, and it provides the page's display and devices to the whole program. The loop follows `requestAnimationFrame`, and the input stage reads the keyboard, the pointer, and the gamepads. Its options:

| Option | Default | Description |
| --- | --- | --- |
| `target` | The window | The element the pointer is pressed on and measured from |
| `preventDefault` | None | The codes of the keys whose default action is prevented, such as the arrows and the space bar, which scroll the page |
| `deadzone` | `0.1` | How far a stick must move to register |
| `sounds` | None | The page's sounds by name, for the page's lifetime. `false` opens no sound at all. See [playing sound in a page](sound-in-a-page.md) |
| `volume` | `1` | The master volume |

When the page closes, `Browser.runMain` interrupts the game. The loop stops requesting frames, `Driver.run` closes the app, and the plugins release their resources.

The loop keeps to these rules:

- The first frame draws the game as it is and runs no tick. The loop counts time from it.
- While the tab is hidden, the loop requests no frames, and the hidden time doesn't count. When the tab returns, the game resumes where it was.
- After a freeze while the tab stays visible, the loop runs at most `maxStepsPerCall` ticks and drops the rest.
- If a tick or a frame fails, the loop stops and the program fails with what it failed with: what the game's systems fail with, which a program catches by its tag. A defect, such as a call made where it may not be, kills it.

To connect something outside the game to the app before its first frame, give it as `ready`, as above. What `ready` acquires is released when the run ends. When `ready` fails, `Driver.run` closes the app and fails with what `ready` failed with. A UI doesn't need the app, because the app hands it [the view bridge](ui.md).

Given a `save`, the app resumes from it instead of starting fresh. Making it can fail with `Save.LoadRefused`, and `Driver.run` fails with whatever making the app fails with. See [saving and loading](saving-and-loading.md).

Provide the services your game needs to `Driver.run`, as in `Driver.run(...).pipe(Effect.provide(Screen.layer))`. A missing service is a compile error. Provide them to `Driver.run` as a whole, not to a part of it. A layer releases what it acquires when the effect it was provided to ends, so a layer provided to the whole program lasts as long as the game. `Browser.layer` acquires nothing itself. The app opens the page's devices in a scope of its own, and `Sound.plugin` opens the page's sound there too. The app lets go of both when it is closed.

Inside a program, and in a test, yield an Effect instead of running it. Each method of an app returns an Effect. Only a callback that runs outside any Effect, such as a button's, runs one, with what `Effect.runForkWith` makes of where it was wired, as `ready` does above.

## Run a game under a Content Security Policy

arcadekit generates no code from strings. It uses no `eval` and no `new Function`, so a page whose policy omits `'unsafe-eval'` runs a game unchanged.

## Run a game under Node

The same game runs under Node without `arcadekit/browser`. There, the display is a timer:

```ts
import { NodeRuntime } from "@effect/platform-node";
import { App, Driver, Plugin } from "arcadekit";

const Game = Plugin.make("game/Game", {});

NodeRuntime.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }));
```

`NodeRuntime.runMain` interrupts the game when the process is told to stop, and `Driver.run` closes the app as it does in a page. A server, a replay, or a test never imports `arcadekit/browser`, so it needs no `@effect/platform-browser`.

## Tick only when needed

A turn-based game, a puzzle, or a menu has nothing to do between moves. Ticking 60 times a second anyway runs its systems, advances its time, and fills its log with hash checks for nothing. With `ticks: "whenNeeded"`, the loop draws every frame but ticks only while the game changes:

```ts
import { App, Driver, Field, Plugin, Singleton, System, Time } from "arcadekit";
import { Browser } from "arcadekit/browser";

const Clock = Singleton.define("chess/Clock", { left: Field.f32 }, { left: 0 });

// The game ticks while the clock runs, since each tick changes it.
const Countdown = System.tick("chess/Countdown", function* () {
  const clock = yield* Clock.writes;
  if (clock.left > 0) {
    clock.left = Math.max(0, clock.left - (yield* Time).delta);
  }
});

const Chess = Plugin.make("chess/Chess", {
  systems: [Countdown],
});

const board = document.querySelector("canvas")!;

Browser.runMain(
  Driver.run(App.define({ plugins: [Chess] }), { hz: 60, ticks: "whenNeeded" }),
  { target: board }
);
```

- The input stage runs every frame. A key press, a UI button, or a network message is received in the frame it arrives, and the tick it requests runs in that frame.
- The app ticks at `hz` while `app.settled` is false. Then it rests. No tick runs, and game time doesn't advance.
- `app.settled` is false while the last tick changed more than the game's time. It is also false while work is pending: an action to apply, an action dispatched since the last tick, a state to enter, a fiber that is due, or an event that some system hasn't read.
- A running countdown or a body in flight keeps the game ticking for as long as it moves, and the game declares nothing for it. The game rests after the first tick that changes nothing.
- From the first time `app.settled` is read, the app hashes its world after each tick to tell whether the tick changed it. The hash costs about 10 µs for a thousand entities and 0.9 ms for a hundred thousand. A game that ticks in real time never reads `app.settled`, and pays nothing.
- A newly created or loaded app isn't settled. It runs one tick, and rests after it if that tick changed nothing.
- The frame stage runs every frame, at rest too, with a `Frame.alpha` of 1, so interpolated drawing draws the game where it is.
- Resting isn't part of the game. A recording holds the actions, their ticks, and the tick the game had reached. A replay runs them back to back and ends on the same hash.
- A frame of a game at rest, with device input, a state, and a view, costs about 5 µs. It reads the devices, checks the app, and runs the frame stage.
- A system that draws from `Random` every tick changes the world every tick, so the game never rests. Draw only when something happens.
- Game time doesn't advance at rest. A system that waits for a moment of game time by comparing it with `Time`, and writes nothing while it waits, never reaches that moment. Count down in the world instead, as `Countdown` does.

## Step an app by hand

A test, a tool, or a turn-based game can step its app itself:

```ts
import { App, Driver, Plugin } from "arcadekit";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});

const program = Effect.gen(function* () {
  const app = yield* Effect.acquireRelease(
    App.make(App.define({ plugins: [Game] })),
    (made) => made.close
  );
  yield* app.input(); // the input stage: reads the devices and the UI
  yield* app.tick(1 / 60); // one tick
  yield* app.frame(1, 1 / 60); // the frame stage: alpha, then real seconds

  const advance = Driver.fixedStep(app, { hz: 60 });
  yield* advance(0.5); // thirty ticks, then the frame stage
}).pipe(Effect.scoped);
```

An app has a scope of its own. It opens the devices, the sound, and what its plugins' layers acquire there, and `app.close` lets go of them. Close an app you step when you are done with it. Held with `Effect.acquireRelease`, as above, it is closed with the program's scope. An app that is never closed holds what it opened until the program ends.

- A tick reads no device. Run `app.input()` before each tick that should receive the devices and the UI, as a driver does. A tool that re-runs a game from its log skips that step, because the log already holds what the devices reported. See [replays](replays.md).
- No driver ticks an app that you step. When its UI sends something, run a tick.

A program that makes its app itself can run `Driver.frames(app, { hz })`, the loop that `Driver.run` uses. `Driver.interval(app, { hz })` steps the same way on a timer. Neither closes the app, which belongs to the program. Each stops when the fiber that runs it is interrupted. One started with `Effect.forkScoped` stops when its scope closes, and leaves no frame requested.

`Driver.frames` reaches the screen through the `Driver.Display` service. In a page it is `Browser.display`. Elsewhere, such as under Node, the default is a timer at 60 frames a second that is never hidden. A test provides a display it advances by hand, `Driver.layer(Driver.makeManualDisplay())`. See [testing](testing.md).

## Read more

- [`Browser`](/reference/arcadekit/browser/Browser) and [`Driver`](/reference/arcadekit/Driver) in the API reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page), started with `Browser.runMain` and served by `pnpm --filter arcadekit page`, and [`examples/demo`](../../../../../packages/arcadekit/examples/demo), started under Node.
