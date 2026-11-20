---
title: "Running a game"
description: "Start a game with App.run and your platform's runMain. Learn how to run in a page and under Node, tick only when needed, and step an app by hand."
---

You start a game with `App.run`, passed to your platform's `runMain`. This guide covers running in a page and under Node, games that tick only when needed, and stepping an app by hand.

## In a page

```ts
import { Action, App, Plugin } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect, Schema } from "effect";

const NewGame = Action.define("game/NewGame", Schema.Struct({}));
const newGame = Action.handler(NewGame, function* () {});
const Game = Plugin.make("game/Game", { handlers: [newGame] });

const canvas = document.querySelector("canvas")!;
const button = document.querySelector("button")!;

Browser.runMain(
  App.run(
    { plugins: [Game], seed: Date.now() },
    {
      hz: 60,
      ready: (app) =>
        Effect.sync(() => {
          button.onclick = () => app.enqueue(NewGame, {});
        }),
    }
  ),
  { target: canvas, preventDefault: ["Space", "ArrowUp", "ArrowDown"] }
);
```

`App.run` creates the app and runs it until interrupted: on each repaint, the ticks that are due at a fixed `hz`, then the frame stage. It never completes on its own.

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
- `ready` runs once with the app, before the first frame, to connect anything outside the game. Its resources are released with the app. A UI doesn't need the app: it receives [the view bridge](ui.md).
- Given a `save`, `App.run` resumes from it instead of starting fresh, and can fail with `Save.LoadRefused`. See [saving and loading](saving-and-loading.md).
- `App.run` fails with whatever creating the app and `ready` can fail with. If a tick or frame throws, the loop stops and the program dies with the thrown error.

Provide any services your game needs to `App.run`, as in `App.run(...).pipe(Effect.provide(Screen.layer))`; a missing one is a compile error. Provide them to `App.run` as a whole, not to a part of it, so they last as long as the game: a layer that listens, as `Browser.layer` does, is released with whatever it was provided to.

`Effect.runSync` and `Effect.runPromise` are for tests. Inside a program, yield an Effect rather than running it.

## Under a Content Security Policy

arcadekit never generates code from strings: it uses no `eval` and no `new Function`. A page whose policy omits `'unsafe-eval'` runs a game unchanged.

## Under Node

The same game runs under Node, importing nothing but `arcadekit`. There, the display is a timer:

```ts
import { NodeRuntime } from "@effect/platform-node";
import { App, Plugin } from "arcadekit";

const Game = Plugin.make("game/Game", {});

NodeRuntime.runMain(App.run({ plugins: [Game] }, { hz: 60 }));
```

`NodeRuntime.runMain` interrupts the game when the process is asked to stop, and the app's scope closes as it does in a page. A server, a replay or a test never imports `arcadekit/Browser`, so it installs no browser packages.

## Ticking only when needed

A turn-based game, a puzzle or a menu has nothing to do between moves. Ticking sixty times a second regardless runs its systems, advances its time and fills its log with checkpoints for nothing. With `ticks: "whenNeeded"`, the loop draws every frame but only ticks while something is pending:

```ts
import { App, Field, Plugin, Singleton, System, Ticks, Time } from "arcadekit";
import * as Browser from "arcadekit/Browser";

const Clock = Singleton.define("chess/Clock", { left: Field.f32 }, { left: 0 });

// It requests the next tick while the clock runs.
const Countdown = System.make("chess/Countdown", function* () {
  const clock = yield* Clock;
  if (clock.left > 0) {
    clock.left -= (yield* Time).delta;
    (yield* Ticks).more();
  }
});

const Chess = Plugin.make("chess/Chess", {
  systems: [Countdown],
});

const board = document.querySelector("canvas")!;

Browser.runMain(
  App.run({ plugins: [Chess] }, { hz: 60, ticks: "whenNeeded" }),
  { target: board }
);
```

- The input stage runs every frame, so a key press, a UI button or a network message is received in the frame it arrives, and the tick it requests runs then.
- The app ticks at `hz` while it isn't settled, plus one more tick for systems that react a tick late to a system listed after them. Then it rests: no tick runs and game time stands still.
- `app.settled` reports whether anything is pending: an action to apply, a state to enter, a tick some system asked for, a fiber that is due, or an event some system hasn't read.
- A newly created or loaded app isn't settled. It runs one tick, in which every system can request more, plus the following one, before it rests.
- The frame stage runs every frame, including at rest, with a `Frame.alpha` of 1, so interpolated rendering draws the game where it is.
- Resting isn't part of the game. A recording holds the actions, their ticks and the tick the game had reached, and a replay runs them back to back and ends on the same hash.
- A frame of a game at rest costs about 5 µs with device input, a state and a view: reading the devices, checking the app, and the frame stage.

Some pending work is invisible to the app, so you declare it:

- A system with work to do every tick while a condition of its own holds, such as a countdown or a body in flight, requests the next tick itself with `(yield* Ticks).more()` on every tick it has more to do, as `Countdown` does. The game rests after the first tick in which nobody requests one. A system that never requests stops with the game, and nothing distinguishes it from one with nothing to do.
- Handlers can request ticks too. Between ticks, `more` throws, since rendering doesn't decide when the game ticks. Under a driver that ticks in real time it does nothing, so call it in any system that might run in a game that rests. Requests aren't saved.
- A system that reacts through a change query to a system listed after it reacts a tick late, and gets only the one extra tick after the last: two such systems in a row fall a tick short. Order them with `System.after`, or have the system that made the change request a tick.

## Stepping by hand

A test, a tool or a turn-based game can step its app itself:

```ts
import { App, Driver, Plugin } from "arcadekit";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game] });
  app.tick(1 / 60); // one tick, after its input stage
  app.frame(1, 1 / 60); // the frame stage: alpha, then real seconds

  const advance = Driver.fixedStep(app, { hz: 60 });
  advance(0.5); // thirty ticks, then the frame stage
}).pipe(Effect.scoped);
```

A program that steps its app runs it in a scope, with `Effect.scoped`, and closing the scope releases everything the app holds.

- A tick reads the devices first. A tool that re-runs a game from its log by hand passes `app.tick(delta, { input: false })`, as `App.replay` does, or the keys of the machine it runs on leak into the game. See [replays](replays.md).
- Nothing ticks a game that steps itself: when its UI sends something, the game runs a tick.

`Driver.frames(app, { hz })` is the loop `App.run` uses, for a program that creates its app itself, and `Driver.interval(app, { hz })` steps the same way on a timer. Each is interrupted with the fiber that runs it, so one started with `Effect.forkScoped` stops when its scope closes, leaving no frame requested.

`Driver.frames` reaches the screen through `Driver.Display`: `Browser.display` in a page, and by default a 60 fps timer that is never hidden, which is what Node uses. A test drives one by hand with `Driver.makeManualDisplay()`. See [testing](testing.md).

## Read more

- [`Browser`](/reference/arcadekit/Browser) and [`Driver`](/reference/arcadekit/Driver) in the API reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page), started with `Browser.runMain` and served by `pnpm --filter arcadekit page`, and [`examples/demo`](../../../../../packages/arcadekit/examples/demo), started under Node.
