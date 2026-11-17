---
title: "Running a game"
description: "A game is started with App.run, given to the platform's runMain. This guide covers running in a page and under Node, games that tick only when needed, and stepping an app by hand."
---

A game is started with `App.run`, given to the platform's `runMain`. This guide covers running in a page and under Node, games that tick only when needed, and stepping an app by hand.

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

`App.run` makes the app and runs it until it is interrupted: each repaint, the ticks that are due at a fixed `hz`, then the frame stage.

`Browser.runMain` starts it in the page, with the page's display and devices provided to the whole of it: the loop follows `requestAnimationFrame`, and the input stage hears the keyboard, the pointer and the gamepads. Its options:

| Option | What it is |
| --- | --- |
| `target` | The element the pointer is pressed on and measured from |
| `preventDefault` | Keys that must not scroll the page |
| `deadzone` | How far a stick has to move to count, a tenth unless told |
| `sounds` | The page's sounds by name, for as long as it lasts. See [sound](sound.md) |
| `volume` | How loud everything plays |

When the page goes away, the game is interrupted: the loop stops asking for frames, the app's scope closes, scripts are interrupted, and what the plugins acquired is let go.

- While the tab is hidden the loop asks for no frame, and that time doesn't count. A game that comes back is where it was left.
- A page that froze without being hidden runs at most `maxStepsPerCall` ticks, 5 unless told, and drops the rest.
- `ready` runs once, with the app, before the first frame: to wire up what is outside the game. A UI needs no hold of the app: it is given [the view bridge](ui.md).
- Given a `save`, `App.run` goes on from it instead of starting fresh.

A game that needs services of its own is given them first, `App.run(...).pipe(Effect.provide(Screen.layer))`. One that still needs something doesn't compile.

## Under Node

The same game runs under Node, with no import but `arcadekit`. There the display is a timer:

```ts
import { NodeRuntime } from "@effect/platform-node";
import { App, Plugin } from "arcadekit";

const Game = Plugin.make("game/Game", {});

NodeRuntime.runMain(App.run({ plugins: [Game] }, { hz: 60 }));
```

A server, a replay or a test never imports `arcadekit/Browser`, so it installs no browser package.

## Ticking only when needed

A game of turns, a puzzle or a menu has nothing to do between moves. With `ticks: "whenNeeded"`, the loop draws every frame and ticks only while something is waiting:

```ts sketch
Browser.runMain(
  App.run({ plugins: [Chess] }, { hz: 60, ticks: "whenNeeded" }),
  {
    target: board,
  }
);
```

- The input stage runs every frame, so a key or a button is heard in the frame it comes in, and the tick it asks for runs then.
- The app ticks while it isn't settled, and once more after, then rests. `app.settled` says whether anything waits: an action, a state to enter, a script that sleeps, an unread event.
- A system that has work every tick for a while, a clock that runs down or a body in flight, says so: `(yield* Ticks).more()`, each tick it has more to do. One that doesn't stops with the game.
- Resting is no part of the game. The log holds the actions and their ticks, and a replay ends on the same hash.

## Stepping by hand

A test, a tool or a turn-based game steps its app itself:

```ts
import { App, Driver, Plugin } from "arcadekit";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game] });
  app.tick(1 / 60); // one tick, its input stage first
  app.frame(1, 1 / 60); // the frame stage: alpha, then real seconds

  const advance = Driver.fixedStep(app, { hz: 60 });
  advance(0.5); // thirty ticks, then the frame stage
}).pipe(Effect.scoped);
```

`Driver.frames(app, { hz })` is the loop `App.run` uses, for a program that makes its app itself. It reaches the screen through `Driver.Display`: `Browser.display` in a page, a timer by default. A test turns one by hand, `Driver.makeManualDisplay()`. See [testing](testing.md).

## Read more

- [In a page](/reference/arcadekit#in-a-page) and [a game that moves when its player does](/reference/arcadekit#a-game-that-moves-when-its-player-does) in the reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page), started with `Browser.runMain`, and [`examples/demo`](../../../../../packages/arcadekit/examples/demo), started under Node.
