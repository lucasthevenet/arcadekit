---
title: "Running a game"
description: "Start a game with Driver.run and your platform's runMain. Learn how to run in a page and under Node, tick only when needed, and step an app by hand."
---

You start a game with `Driver.run`, passed to your platform's `runMain`. This guide covers running in a page and under Node, games that tick only when needed, and stepping an app by hand.

## In a page

```ts
import { Action, App, Driver, Plugin } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect, Schema } from "effect";

const NewGame = Action.define("game/NewGame", Schema.Struct({}));
const newGame = Action.handler(NewGame, function* () {});
const Game = Plugin.make("game/Game", { handlers: [newGame] });

const canvas = document.querySelector("canvas")!;
const button = document.querySelector("button")!;

Browser.runMain(
  Driver.run(
    App.make(App.define({ plugins: [Game] }), { seed: Date.now() }).pipe(
      Effect.tap((app) =>
        Effect.sync(() => {
          button.onclick = () => app.enqueue(NewGame, {});
        })
      )
    ),
    { hz: 60 }
  ),
  { target: canvas, preventDefault: ["Space", "ArrowUp", "ArrowDown"] }
);
```

`Driver.run` runs the app that `App.make` makes, until interrupted: on each repaint, the ticks that are due at a fixed `hz`, then the frame stage. It never completes on its own.

`App.make` takes the game and how this run of it starts:

- the game, from `App.define`: its plugins, systems and handlers, which are the same every time it is played;
- a `seed` for a new game, or a `save` to continue one.

`Driver.run` takes the effect `App.make` returns, without yielding it, and how the app is driven: `hz`, and the options below.

`Browser.runMain` starts it in the page. It is the platform's `runMain`, which reports failures and interrupts the program cleanly, and it provides the page's display and devices to the whole program: the loop follows `requestAnimationFrame`, and the input stage receives the keyboard, pointer and gamepads. Its options:

| Option | Description |
| --- | --- |
| `target` | The element the pointer is pressed on and measured from |
| `preventDefault` | Keys that must not scroll the page |
| `deadzone` | How far a stick must move to register, `0.1` by default |
| `sounds` | The page's sounds by name, available for the page's lifetime. See [sound](sound.md) |
| `volume` | The master volume |

When the page is closed, the game is interrupted: the loop stops requesting frames, the app's scope closes, and the plugins' resources are released.

- The first frame draws the game as it is and runs no tick. Time is counted from it.
- While the tab is hidden, the loop requests no frames, and that time doesn't count. When the tab returns, the game resumes where it was.
- After a freeze without the tab being hidden, the loop runs at most `maxStepsPerCall` ticks, 5 by default, and drops the rest.
- To connect anything outside the game to the app before its first frame, add a step to the effect that makes it, as `Effect.tap` does above. What the step acquires is released with the app. A UI doesn't need the app: it receives [the view bridge](ui.md).
- An app made from a `save` resumes from it instead of starting fresh, and making it can fail with `Save.LoadRefused`. See [saving and loading](saving-and-loading.md).
- `Driver.run` fails with whatever making the app can fail with. If a tick or frame throws, the loop stops and the program dies with the thrown error.

Provide any services your game needs to `Driver.run`, as in `Driver.run(...).pipe(Effect.provide(Screen.layer))`; a missing one is a compile error. Provide them to `Driver.run` as a whole, not to a part of it, so they last as long as the game: what a layer acquires is released with whatever it was provided to. `Browser.layer` acquires nothing itself: the app opens the page's devices, and with `Sound.plugin` its sound, in the scope it is made in.

`Effect.runSync` and `Effect.runPromise` are for tests. Inside a program, yield an Effect rather than running it.

## Under a Content Security Policy

arcadekit never generates code from strings: it uses no `eval` and no `new Function`. A page whose policy omits `'unsafe-eval'` runs a game unchanged.

## Under Node

The same game runs under Node, importing nothing but `arcadekit`. There, the display is a timer:

```ts
import { NodeRuntime } from "@effect/platform-node";
import { App, Driver, Plugin } from "arcadekit";

const Game = Plugin.make("game/Game", {});

NodeRuntime.runMain(
  Driver.run(App.make(App.define({ plugins: [Game] })), { hz: 60 })
);
```

`NodeRuntime.runMain` interrupts the game when the process is asked to stop, and the app's scope closes as it does in a page. A server, a replay or a test never imports `arcadekit/Browser`, so it installs no browser packages.

## Ticking only when needed

A turn-based game, a puzzle or a menu has nothing to do between moves. Ticking sixty times a second regardless runs its systems, advances its time and fills its log with checkpoints for nothing. With `ticks: "whenNeeded"`, the loop draws every frame but only ticks while the game changes:

```ts
import { App, Driver, Field, Plugin, Singleton, System, Time } from "arcadekit";
import * as Browser from "arcadekit/Browser";

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
  Driver.run(App.make(App.define({ plugins: [Chess] })), {
    hz: 60,
    ticks: "whenNeeded",
  }),
  { target: board }
);
```

- The input stage runs every frame, so a key press, a UI button or a network message is received in the frame it arrives, and the tick it requests runs then.
- The app ticks at `hz` while it isn't settled. Then it rests: no tick runs and game time stands still.
- `app.settled` is false while the last tick changed more than the game's time, or while anything is pending: an action to apply or one dispatched since the last tick, a state to enter, a fiber that is due, or an event some system hasn't read. A countdown or a body in flight keeps the game ticking for as long as it moves, with nothing to declare, and the game rests after the first tick that changes nothing.
- To tell, the app hashes its world after each tick, from the first time `app.settled` is read: about 10 µs for a thousand entities and 0.9 ms for a hundred thousand. A game that ticks in real time never reads it, and pays nothing.
- A newly created or loaded app isn't settled. It runs one tick, and rests after it if that tick changed nothing.
- The frame stage runs every frame, including at rest, with a `Frame.alpha` of 1, so interpolated rendering draws the game where it is.
- Resting isn't part of the game. A recording holds the actions, their ticks and the tick the game had reached, and a replay runs them back to back and ends on the same hash.
- A frame of a game at rest costs about 5 µs with device input, a state and a view: reading the devices, checking the app, and the frame stage.
- A system that draws from `Random` every tick changes the world every tick, so the game never rests. Draw only when something happens.
- Game time stands still at rest, so a system that waits for a moment of game time by comparing it with `Time` alone, writing nothing while it waits, is never reached. Count down in the world instead, as `Countdown` does.

## Stepping by hand

A test, a tool or a turn-based game can step its app itself:

```ts
import { App, Driver, Plugin } from "arcadekit";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});

const program = Effect.gen(function* () {
  const app = yield* App.make(App.define({ plugins: [Game] }));
  app.input(); // the input stage: reads the devices and the UI
  app.tick(1 / 60); // one tick
  app.frame(1, 1 / 60); // the frame stage: alpha, then real seconds

  const advance = Driver.fixedStep(app, { hz: 60 });
  advance(0.5); // thirty ticks, then the frame stage
}).pipe(Effect.scoped);
```

A program that steps its app runs it in a scope, with `Effect.scoped`, and closing the scope releases everything the app holds.

- A tick reads no device. Call `app.input()` before each tick that receives the devices and the UI, as a driver does. A tool that re-runs a game from its log by hand doesn't, since the log already holds what they reported. See [replays](replays.md).
- Nothing ticks a game that steps itself: when its UI sends something, the game runs a tick.

`Driver.frames(app, { hz })` is the loop `Driver.run` uses, for a program that creates its app itself, and `Driver.interval(app, { hz })` steps the same way on a timer. Each is interrupted with the fiber that runs it, so one started with `Effect.forkScoped` stops when its scope closes, leaving no frame requested.

`Driver.frames` reaches the screen through `Driver.Display`: `Browser.display` in a page, and by default a 60 fps timer that is never hidden, which is what Node uses. A test drives one by hand with `Driver.makeManualDisplay()`. See [testing](testing.md).

## Read more

- [`Browser`](/reference/arcadekit/Browser) and [`Driver`](/reference/arcadekit/Driver) in the API reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page), started with `Browser.runMain` and served by `pnpm --filter arcadekit page`, and [`examples/demo`](../../../../../packages/arcadekit/examples/demo), started under Node.
