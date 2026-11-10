# arcadekit/game

A game's building blocks. Each part of a game is one named declaration: `Game.Event` for what a run reports, `Game.Command` for what a player decides, `Game.Rejection` for why the rules may refuse it, `Game.Simulation` for the rules, and, in `arcadekit/game/browser`, `Game.Engine` for the browser half that draws a run and reads its input. A declaration runs nothing by itself: `Game.Loop` steps a simulation anywhere, an engine's `layer` provides it to an app, and a scenario (`arcadekit/game/scenario`) checks the rules in a test.

An entry of the [`arcadekit`](../../README.md) package. The root entry and `./scenario` are DOM-free. Import each as a namespace: `import * as Game from "arcadekit/game"`.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## The rules

A simulation says what a run's state is made from, how one step advances it, which events it reports and which commands it takes. The events and commands are classes that are also their own Schemas. `create`, `step` and each `apply` handler are plain functions: a step runs no Effect and reads no clock or random source of its own, so the same seed, input and commands always give the same run ([ADR-0017](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0017-effect-at-the-edges-plain-code-inside.md)).

```ts
import * as Game from "arcadekit/game";
import { Schema } from "effect";

// What a run reports: a fact, and the HUD's sample.
export class Finished extends Game.Event("Finished", { steps: Schema.Int }) {}
export class Hud extends Game.Event("Hud", { x: Schema.Number }) {}

// What a player decides, outside what their device holds.
export class Boost extends Game.Command("Boost", { by: Schema.Number }) {}

interface Runner {
  x: number;
  speed: number;
  readonly goal: number;
  finished: boolean;
}

export class Race extends Game.Simulation("Race", {
  input: Schema.Struct({ moveX: Schema.Number }),
  events: [Finished],
  commands: [Boost],
  create: (config: { readonly goal: number }): Runner => ({
    x: 0,
    speed: 4,
    goal: config.goal,
    finished: false,
  }),
  step: (runner, input, { dt, step, report }) => {
    runner.x += input.moveX * runner.speed * dt;
    if (!runner.finished && runner.x >= runner.goal) {
      runner.finished = true;
      report(new Finished({ steps: step + 1 }));
    }
  },
  apply: {
    Boost: (runner, boost) => {
      runner.speed += boost.by;
    },
  },
  sample: {
    event: Hud,
    every: "100 millis",
    read: (runner) => ({ x: runner.x }),
  },
}) {}

// Step it without a browser, as a replay or a server does.
const loop = new Game.Loop(Race);
loop.subscribe((event) => console.log(event._tag));
loop.start({ goal: 2 }, 1234, 0);
loop.send(new Boost({ by: 4 }));
// 60 steps with the stick held right. The boost is applied at the start of the first.
loop.frame({ read: () => ({ moveX: 1 }) }, { steps: 60 }, 1000);
console.log(loop.state?.x); // about 8: one second at speed 8
```

- **`create`**, **`step`** and each `apply` handler are plain functions. `step` and `apply` change the state in place and return nothing. One that returns anything else is a type error, and the loop refuses it too: a step can't be `async` or return an Effect, so when a frame returns, its steps are over. A step may allocate what it reports, and keeps what it holds per entity in typed arrays ([`arcadekit/core`](../core/README.md)'s pools).
- **`input`** is one step's input as a Schema: what a device holds for the step, what a replay records and what crosses the network in lockstep.
- **`events`** lists what a step may report with `report`. Keep them rare: they cross into the UI.
- **`commands`** lists what a player may send, and **`apply`** handles each by its tag. A command is applied at the start of the next step, before `step`, in the order sent. A run changes in no other way, so a simulation that declares a command without its handler is refused when its module loads. A handler may refuse its command: see [Refusing a command](#refusing-a-command).
- **`sample`** is a read of the state for the UI, such as a HUD, delivered as an event: when a run starts and then every `every`, and/or right after any frame in which `version` (a cheap number, such as a turn counter) changed.

`Game.StateOf<typeof Race>`, `ConfigOf`, `InputOf`, `EventOf` and `CommandOf` name a simulation's types. `Race.match({ Finished: ..., Hud: ... })` makes a function that handles each event by its tag, checked to cover them all.

## Refusing a command

A command the rules may turn down says how. Each way is a `Game.Rejection`, listed in the command's `rejects`. Its `apply` handler returns one in place of changing the state, and whoever sent the command gets it back as a typed failure. A refusal is not a bug and not an event: nothing happened in the run, and only the sender hears of it.

```ts
import * as Game from "arcadekit/game";
import * as Scenario from "arcadekit/game/scenario";
import { Schema } from "effect";

// Why the rules refuse it, and the command that says it may be refused that way.
class OfferClosed extends Game.Rejection("OfferClosed", {
  offer: Schema.Int,
}) {}
class ChooseUpgrade extends Game.Command(
  "ChooseUpgrade",
  { offer: Schema.Int, index: Schema.Int },
  { rejects: [OfferClosed] }
) {}
class Upgraded extends Game.Event("Upgraded", { level: Schema.Int }) {}

class Run extends Game.Simulation("Run", {
  input: Schema.Null,
  events: [Upgraded],
  commands: [ChooseUpgrade],
  create: () => ({ offer: 1, level: 0 }),
  step: () => {},
  apply: {
    ChooseUpgrade: (run, command, { report }) => {
      // Decide first, then change: a refused command leaves the state as it was.
      if (command.offer !== run.offer) {
        return new OfferClosed({ offer: command.offer });
      }
      run.level += 1;
      run.offer += 1;
      report(new Upgraded({ level: run.level }));
    },
  },
}) {}

const scenario = Scenario.make(Run);

// The same offer picked twice: the first pick is taken, the second refused.
scenario(
  Scenario.given(null),
  Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
  Scenario.send(new ChooseUpgrade({ offer: 1, index: 2 })),
  Scenario.step(null),
  Scenario.reported(new Upgraded({ level: 1 })),
  Scenario.refused(new OfferClosed({ offer: 1 }))
);
```

- **A handler returns nothing, or one of its command's rejections**: a value of the rejection's class, `new OfferClosed(...)`. Anything else is a type error, and the loop refuses at run time what a cast gets past the types. Under `noImplicitReturns`, a handler that refuses on one path ends its other path with `return undefined;`.
- **A handler decides before it changes anything.** A refused command changed nothing in the run. The loop holds a handler to the part it can see: one that reports an event and then refuses is thrown out. It can't see a quiet change to the state, so a scenario checks that.
- **The app gets it from `engine.send`**, which waits for the rules' answer: `yield* engine.send(new ChooseUpgrade({ offer, index }))` succeeds if the handler took the command and fails with `OfferClosed`, the class's own value, if it refused. An app handles it by its tag, `Effect.catchTag("OfferClosed", ...)`. The handler runs at the start of the run's next step, and the send completes after that step's frame has drawn: the line after it never runs inside a step, so it may start or stop a run. A send's answer and the events of its step reach an app in no fixed order.
- **`Game.CommandDropped`** is the other way a send fails: the rules gave no answer, because there is no run (`reason: "noRun"`) or the run ended first (`"runEnded"`: a stop, a new run or a crash). Every send can fail with it. An app that only cares what the rules said writes `Effect.catchTag("CommandDropped", () => Effect.void)`, and one that doesn't care how a command ends writes `Effect.ignore`, which hides a refusal too. A command sent again after `runEnded` goes to whichever run is current.
- **A step needs a frame**, so a send waits while the engine is paused or not attached, and ends when its run next steps or ends: bound it with `Effect.timeout` if a screen can't wait. A screen that sends a command leaves the run stepping, and freezes the game in its rules if it must. Interrupting a send takes the command back, if it hasn't been applied yet.
- **With `Game.Loop`**, `loop.send(command, player, settled)` calls `settled` with `undefined`, the rejection or a `CommandDropped`, once the loop is out of the frame, the `start` or the `stop` that ended the command, so `settled` may send, start or stop. It returns a function that takes the command back: `settled` is not called after it. A frame that throws tells nobody: the `stop` that follows does.
- **To name the types**: `Game.RejectionOf<typeof Survivors>` is every rejection of a simulation, and `Game.EngineOf<typeof Survivors>` the running engine, for a function that takes one.

## A scenario

A scenario is a specification you can run: given a run, after these steps and commands, it reported these events. It steps the real simulation through `Game.Loop`, so what it describes is what the game does. Each step is checked against the simulation's types where it is written.

```ts
import * as Game from "arcadekit/game";
import * as Scenario from "arcadekit/game/scenario";
import { Schema } from "effect";

class DoorOpened extends Game.Event("DoorOpened", { atStep: Schema.Int }) {}
class Lock extends Game.Command("Lock") {}

class Door extends Game.Simulation("Door", {
  input: Schema.Struct({ lever: Schema.Boolean }),
  events: [DoorOpened],
  commands: [Lock],
  create: (config: { readonly needed: number }) => ({
    needed: config.needed,
    held: 0,
    open: false,
    locked: false,
  }),
  step: (door, input, { report, step }) => {
    door.held = input.lever && !door.locked ? door.held + 1 : 0;
    if (!door.open && door.held === door.needed) {
      door.open = true;
      report(new DoorOpened({ atStep: step }));
    }
  },
  apply: {
    Lock: (door) => {
      door.locked = true;
    },
  },
}) {}

const scenario = Scenario.make(Door);

// In a test: it("opens once the lever has been held long enough", () => scenario(...)).
scenario(
  Scenario.given({ needed: 3 }),
  Scenario.step({ lever: true }, 2),
  Scenario.reported(),
  Scenario.step({ lever: true }),
  Scenario.reported(new DoorOpened({ atStep: 2 }))
);

scenario(
  Scenario.given({ needed: 3 }),
  Scenario.send(new Lock()),
  Scenario.step({ lever: true }, 5),
  Scenario.state((door) => {
    if (door.open) {
      throw new Error("A locked door stays shut");
    }
  })
);
```

| Step | What it does |
| --- | --- |
| `Scenario.given(config, { seed })` | Starts the run the scenario is about. The seed is 0 unless given. |
| `Scenario.step(input, count)` | Runs `count` steps (1 unless given) with `input` held for each. |
| `Scenario.send(command, player)` | Sends a command; the next step applies it. |
| `Scenario.reported(...events)` | Checks what the run reported since the last check: exactly these events, in order. With none, that nothing was reported. |
| `Scenario.refused(...rejections)` | Checks what the rules refused since the last check: exactly these rejections, in order. |
| `Scenario.sampled(sample)` | Checks the run's latest sample. |
| `Scenario.state(check)` | Reads the state, for the test's own assertions. |

A list of steps is a step, so a game names its own (`const tap = (direction) => [Scenario.step(...), Scenario.step(...)]`). A passing scenario accounts for everything: it fails with a `ScenarioError` if the run reported an event no `Scenario.reported` checked, if the rules refused a command no `Scenario.refused` checked, or if a command was sent and no step applied it. A refusal's message names the command and the player who sent it. Samples are the exception, since a real-time game reports one every few steps. If your linter asks every test for an `expect`, tell it a scenario asserts (`assertFunctionNames: ["expect", "scenario"]`).

## In the browser

`Game.Engine`, in `arcadekit/game/browser`, adds the browser half: the view that draws a run into the viewport element and the input source that reads each step's input from it. The class is the key of the engine service an app drives, and its `layer` provides it.

```ts
import * as Game from "arcadekit/game/browser";
import { Effect, Schema } from "effect";

export class Hud extends Game.Event("Hud", { x: Schema.Number }) {}

export class Race extends Game.Simulation("Race", {
  input: Schema.Struct({ moveX: Schema.Number }),
  create: () => ({ x: 0 }),
  step: (runner, input, { dt }) => {
    runner.x += input.moveX * 4 * dt;
  },
  sample: {
    event: Hud,
    every: "100 millis",
    read: (runner) => ({ x: runner.x }),
  },
}) {}

export class RaceEngine extends Game.Engine("RaceEngine", {
  simulation: Race,
  // What the view and the input source are made from: Effects run on each attach. A service
  // key is one, and so is an asset's load.
  uses: { color: Effect.succeed("#e0b040") },
  view: (container, { color }) => {
    const dot = document.createElement("div");
    dot.style.cssText = `position:absolute;width:16px;height:16px;background:${color}`;
    container.append(dot);
    return {
      // Reads the state on every frame; never changes it. No state between runs.
      render: (runner) => {
        dot.style.left = `${(runner?.x ?? 0) * 32}px`;
      },
      dispose: () => dot.remove(),
    };
  },
  input: () => {
    let moveX = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "ArrowRight") {
        moveX = event.type === "keydown" ? 1 : 0;
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return {
      read: () => ({ moveX }),
      dispose: () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
      },
    };
  },
}) {}

// An app: start a run, hear its events, and draw it into an element until interrupted.
export const play = Effect.gen(function* () {
  const engine = yield* RaceEngine;
  yield* engine.listen(Race.match({ Hud: ({ x }) => console.log(x) }));
  yield* engine.start(null, { seed: 7 });
  return yield* engine.attach(document.body);
}).pipe(Effect.scoped, Effect.provide(RaceEngine.layer));
```

- **`uses`** names what the view and the input source are made from. Each Effect runs once per attach, in the attach's scope, before anything is made: the app's audio, a sprite sheet's load ([`arcadekit/content`](../content/README.md)'s `Asset`), or something the view and the input share for that attach. The engine's `layer` needs their services, and a failure of one is `attach`'s.
- **`view`** and **`input`** are called once per attach, the view first, and disposed when the engine detaches. Several views are one with `Game.combineViews`, such as a drawing view and a sound view.
- **`engine.attach(element)`** steps the run by the time since the last frame, then draws it, on every animation frame. It never succeeds: it fails with what a `uses` Effect fails with, with `AttachError` if the view or the input source can't be made (no WebGL), and with `GameCrashed` if a frame throws. `engine.start`, `setPaused` and `stop` drive the run, `engine.send` sends it a command and waits for the rules' answer ([Refusing a command](#refusing-a-command)), and `engine.listen` hears its events.
- **`Game.Frames`** is where an attached engine gets its frames: `requestAnimationFrame`, unless a test provides `manualFrames()` from `arcadekit/runtime/testing` (`Layer.succeed(Game.Frames, frames)`).
- **`Game.frameLoop(frames, frame)`** is the loop an engine draws on, for anything else an app draws on animation frames.

In a Foldkit app, [`arcadekit/foldkit`](../foldkit/README.md)'s `engineEntry` attaches the engine to the viewport and turns its events into Messages: `engineEntry({ engine: RaceEngine, toMessage: Race.match({ ... }), ... })`.

## What is still on the older contract

Co-op is. The Co-op client in [`arcadekit/net`](../net/README.md) steps a `GameSimulation` ([`arcadekit/runtime`](../runtime/README.md)) in lockstep, and survivors' Co-op rules give it one, built from the rules its `Survivors` declares; a player's decision rides the step input there. `GameSimulation` stays until co-op has moved. Both games' single-player paths are declared, so no game uses `makeGameEngine` or `makeEngineLoader` any more. `Game.Loop` steps a declared simulation on the same `GameLoop`, so the step order is one.
