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

`App.run` makes the app and runs it until it is interrupted: each repaint, the ticks that are due at a fixed `hz`, then the frame stage. It never ends by itself.

`Browser.runMain` starts it in the page. It is the platform's `runMain`, which reports a failure and interrupts the program cleanly, with the page's display and devices provided to the whole of it: the loop follows `requestAnimationFrame`, and the input stage hears the keyboard, the pointer and the gamepads. Its options:

| Option | What it is |
| --- | --- |
| `target` | The element the pointer is pressed on and measured from |
| `preventDefault` | Keys that must not scroll the page |
| `deadzone` | How far a stick has to move to count, a tenth unless told |
| `sounds` | The page's sounds by name, for as long as it lasts. See [sound](sound.md) |
| `volume` | How loud everything plays |

When the page goes away for good, the game is interrupted: the loop stops asking for frames, the app's scope closes, scripts are interrupted, and what the plugins acquired is let go.

- The first frame draws the game as it stands and runs no tick. Time is counted from it.
- While the tab is hidden the loop asks for no frame, and that time doesn't count. A game that comes back is where it was left.
- A page that froze without being hidden runs at most `maxStepsPerCall` ticks, 5 unless told, and drops the rest.
- `ready` runs once, with the app, before the first frame: to wire up what is outside the game. What it acquires is let go with the app. A UI needs no hold of the app: it is given [the view bridge](ui.md).
- Given a `save`, `App.run` goes on from it instead of starting fresh, and can fail with `Save.LoadRefused`. See [saving and loading](saving-and-loading.md).
- `App.run` fails with what making the app and `ready` can fail with. If a tick or a frame throws, the loop stops and the program dies with what was thrown.

A game that needs services of its own is given them first, `App.run(...).pipe(Effect.provide(Screen.layer))`. One that still needs something doesn't compile. They are provided to `App.run`, not to a part of it, so they last as long as the game does: a layer that listens, as `Browser.layer` does, is let go with what it was provided to.

`Effect.runSync` and `Effect.runPromise` are for tests. Inside a program an Effect is yielded, never run.

## Under a Content Security Policy

Nothing in the package makes code from text: no `eval` and no `new Function`. A page whose policy has no `'unsafe-eval'` runs a game as it is. That was checked in headless Chromium, with `script-src 'self'`; other browsers were not tried.

## Under Node

The same game runs under Node, with no import but `arcadekit`. There the display is a timer:

```ts
import { NodeRuntime } from "@effect/platform-node";
import { App, Plugin } from "arcadekit";

const Game = Plugin.make("game/Game", {});

NodeRuntime.runMain(App.run({ plugins: [Game] }, { hz: 60 }));
```

`NodeRuntime.runMain` interrupts the game when the process is told to stop, and the app's scope closes as it does in a page. A server, a replay or a test never imports `arcadekit/Browser`, so it installs no browser package.

## Ticking only when needed

A game of turns, a puzzle or a menu has nothing to do between moves. One that ticks sixty times a second regardless runs its systems, passes its time and fills its log with checkpoints for nothing. With `ticks: "whenNeeded"`, the loop draws every frame and ticks only while something is waiting:

```ts
import { App, Field, Plugin, Singleton, System, Ticks, Time } from "arcadekit";
import * as Browser from "arcadekit/Browser";

const Clock = Singleton.define("chess/Clock", { left: Field.f32 }, { left: 0 });

// Work of a system's own: it asks for the next tick while the clock runs.
const Countdown = System.make("chess/Countdown", function* () {
  const clock = yield* Clock;
  if (clock.left > 0) {
    clock.left -= (yield* Time).delta;
    (yield* Ticks).more();
  }
});

const Chess = Plugin.make("chess/Chess", {
  components: [Clock],
  systems: [Countdown],
});

const board = document.querySelector("canvas")!;

Browser.runMain(
  App.run({ plugins: [Chess] }, { hz: 60, ticks: "whenNeeded" }),
  { target: board }
);
```

- The input stage runs every frame, so a key, a button of the UI's or a message is heard in the frame it comes in, and the tick it asks for runs then.
- The app ticks while it isn't settled, at `hz` like any game, and once more after, for the systems that react a tick late to what a system listed after them did. Then it rests: no tick runs and the game's time stands still.
- `app.settled` says whether anything waits: an action to apply, a state to enter, a script that waits for the next tick or sleeps, a fiber that is due, or an event some system has not had its chance at.
- An app that has just been made, or loaded from a save, is not settled. It runs one tick, in which every system can ask, and the one that follows it, before it rests.
- The frame stage runs every frame, at rest too. It is told a `Frame.alpha` of 1: what draws between two ticks draws the game where it is.
- Resting is no part of the game. The log holds the actions and their ticks, and a replay given how many ticks the game ran, `app.time.tick`, runs them one after the other and ends on the same hash.
- A frame of a game at rest costs about 5 µs with the picture of the devices, a state and a view: the devices read, the app asked, and the frame stage.

What the app can't see waiting has to be said:

- A system that has work every tick for as long as a condition of its own holds, a clock that runs down or a body in flight, asks for the next tick itself: `(yield* Ticks).more()`, each tick it has more to do, as `Countdown` does. The tick in which nobody asks is the last. One that doesn't ask stops with the game, and nothing tells it apart from one that had nothing to do.
- A handler and a script may ask too. Between ticks `more` throws, since what draws the game doesn't decide when it ticks. Under a driver that ticks in real time it does nothing, so a system that might ever run in a game that rests says it. What was asked is not in a save.
- A script that sleeps keeps the game ticking for as long as it sleeps, so what takes the game's time, a piece sliding for three tenths of a second, takes it. A script that should let the game rest waits for an event.
- A system that reacts through a change query to a system listed after it reacts a tick late, and the one tick that follows the last is all it is given: two such systems in a row are a tick short. Order them with `System.after`, or have the one that changed something ask for a tick.

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

A program that steps its app itself is run in a scope, `Effect.scoped`, and closing that scope lets go of what the app holds.

- A tick hears the devices first. A tool that runs a game again from its log by hand says `app.tick(delta, { input: false })`, as `App.replay` does, or the keys of the machine it runs on are reported into the game. See [replays](replays.md).
- Nothing ticks for a game that steps itself: when its UI has sent something, it runs a tick.

`Driver.frames(app, { hz })` is the loop `App.run` uses, for a program that makes its app itself, and `Driver.interval(app, { hz })` steps the same way on a timer. Each is interrupted with the fiber that runs it, so one started with `Effect.forkScoped` stops when its scope closes, with no frame left asked for.

`Driver.frames` reaches the screen through `Driver.Display`: `Browser.display` in a page, and by default a timer of 60 frames a second that is never hidden, which is all there is under Node. A test turns one by hand, `Driver.makeManualDisplay()`. See [testing](testing.md).

## Not done yet

The frame loop always pauses while the tab is hidden. A game that has to go on in the background, such as one peer of several, cannot say so.

## Read more

- [`Browser`](/reference/arcadekit/Browser) and [`Driver`](/reference/arcadekit/Driver) in the API reference.
- [`examples/page`](../../../../../packages/arcadekit/examples/page), started with `Browser.runMain` and served by `pnpm --filter arcadekit page`, and [`examples/demo`](../../../../../packages/arcadekit/examples/demo), started under Node.
