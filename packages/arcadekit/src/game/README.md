# arcadekit/game

A game's building blocks. Each part of a game is one named declaration: `Game.Event` for what a run reports, `Game.Command` for what a player decides, `Game.Rejection` for why the rules may refuse it, `Game.Simulation` for the rules, and, in `arcadekit/game/browser`, `Game.Engine` for the browser half that draws a run and reads its input. A declaration runs nothing by itself: a loop (`Game.makeLoop`) steps a simulation anywhere, an engine's `layer` provides it to an app, and a scenario (`arcadekit/game/scenario`) checks the rules in a test. `Game.PlayerInputs` is the step input of a simulation several players can play, and `Game.soloInput` fills it for one.

An entry of the [`arcadekit`](../../README.md) package. The root entry and `./scenario` are DOM-free. Import each as a namespace: `import * as Game from "arcadekit/game"`. `arcadekit/game/testing` has the frames a test drives an engine on, and only tests import it.

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
const loop = Game.makeLoop(Race);
loop.subscribe((event) => console.log(event._tag));
loop.start({ goal: 2 }, 1234, 0);
loop.send(new Boost({ by: 4 }));
// 60 steps with the stick held right. The boost is applied at the start of the first.
loop.frame({ read: () => ({ moveX: 1 }) }, { steps: 60 }, 1000);
console.log(loop.state?.x); // about 8: one second at speed 8
```

- **`create`**, **`step`** and each `apply` handler are plain functions. A `create` written in place comes before `step`, `apply` and `sample`: TypeScript types the state from what it returns, and a handler written above it can leave the state `unknown`. `step` and `apply` change the state in place and return nothing. One that returns anything else is a type error, and the loop refuses it too: a step can't be `async` or return an Effect, so when a frame returns, its steps are over. A step may allocate what it reports, and keeps what it holds per entity in typed arrays ([`arcadekit/core`](../core/README.md)'s pools).
- **`input`** is one step's input as a Schema: what a device holds for the step and what a replay records. A simulation several players can play declares it with `Game.PlayerInputs`: see [Several players](#several-players).
- **`events`** lists what a step may report with `report`. Keep them rare: they cross into the UI.
- **`commands`** lists what a player may send, and **`apply`** handles each by its tag. A command is applied at the start of the next step, before `step`, in the order sent. A run changes in no other way, so a simulation that declares a command without its handler is refused when its module loads, and so is a handler without its command. A handler may refuse its command: see [Refusing a command](#refusing-a-command).
- **`sample`** is a read of the state for the UI, such as a HUD, delivered as an event: when a run starts and then every `every`, and/or right after any frame in which `version` (a cheap number, such as a turn counter) changed.

`Game.StateOf<typeof Race>`, `ConfigOf`, `InputOf`, `EventOf` and `CommandOf` name a simulation's types. `Race.match({ Finished: ..., Hud: ... })` makes a function that handles each event by its tag, checked to cover them all. A case for an event the simulation doesn't report compiles (one left behind by a renamed event), so `match` refuses it when it is called, as the app's module loads.

## How a frame becomes steps

A loop steps a run in frames: `Game.makeLoop(simulation)` makes one, a `Game.Loop`. A frame is one `loop.frame(input, budget, nowMs)` call: its caller says where each step's input comes from, how much the frame steps and what time it is, so the loop needs no DOM and reads no clock. A test, a replay, the browser engine and a lockstep session all step a game through it, in one order.

- **The budget** is a `Game.FrameBudget`: `{ seconds }` of time passed, or exactly `{ steps }`. An attached engine passes the seconds since its last animation frame. The loop turns them into whole steps on the simulation's fixed clock (`stepSeconds`, 1/60 s unless the simulation declares another) and carries the rest to the next frame. It counts at most 0.25 s of one frame, so a hidden tab or a debugger pause doesn't fast-forward the game, and it runs at most five steps a frame: a frame further behind than that drops its backlog. Tests, replays and lockstep pass `{ steps }`, which runs exactly that many, with no clamp and nothing carried.
- **Each step** is the input source's `read(step)`, then the commands sent since the last step, then `step`, then the source's `endStep`. Steps are numbered from 0 in each run. After the frame's last step comes the source's `endFrame`, once, if any step ran; then the events those steps reported; then a sample, if one is due.
- **The input source** is a `Game.StepInput`: `read(step)`, with `endStep` and `endFrame` if it needs them. A script reads by the step's number and a device ignores it. `read` runs inside the step loop, so it returns the same object each time, refilled. A source that reads presses forgets them in `endStep` ([`arcadekit/input`](../input/README.md)'s `InputController.consumePresses`), so one press reaches one step even on a slow frame that runs several; what it does once a frame, such as polling gamepads, goes in `endFrame`.
- **`frame` returns the steps it ran**: none with no run, while paused (`loop.setPaused(true)`: the frame's time is discarded, and commands wait), or while a `{ seconds }` frame is still short of a step.

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
- **The app gets it from `engine.send`**, which waits for the rules' answer: `yield* engine.send(new ChooseUpgrade({ offer, index }))` succeeds if the handler took the command and fails with `OfferClosed`, the class's own value, if it refused. An app handles it by its tag, `Effect.catchTag("OfferClosed", ...)`. The handler runs at the start of the run's next step, and the send completes after that step's frame has drawn: the line after it never runs inside a step, so it may start or stop a run.
- **A listener hears a step before its sender does.** When a send completes, the callback given to `engine.listen` has been called with everything the frame of the command's step reported: the events of each of its steps, then its sample if one was due. So a Command that listens and then sends knows, on the line after the send, what its command's step did, such as whether a pick opened another offer. It holds whenever the rules answered, whether they took the command or refused it, with one exception: a frame that throws before its listeners have heard it all, as `attach` fails with `GameCrashed`. A command it had applied still gets the rules' answer. But if a step threw, what that frame reported is discarded with its run and reaches no listener; and if a listener threw, the telling ended there: the listeners called before it heard that event, and none heard what came after. A render that throws comes after both, so the listeners heard its whole frame. A send that fails with `CommandDropped` had no step to hear of; one a new `start` dropped completes after the listener heard that run's start. The order is that of the two calls, not of Messages: an app's Subscription makes a Message of each event and its Command another of the send's result, and the kit fixes no order between those in `update`.
- **`Game.CommandDropped`** is the other way a send fails: the rules gave no answer, because there is no run (`reason: "noRun"`) or the run ended first (`"runEnded"`: a stop, a new run or a crash). Every send can fail with it. An app that only cares what the rules said writes `Effect.catchTag("CommandDropped", () => Effect.void)`, and one that doesn't care how a command ends writes `Effect.ignore`, which hides a refusal too. A command sent again after `runEnded` goes to whichever run is current.
- **A step needs a frame**, so a send waits while the engine is paused or not attached, and ends when its run next steps or ends: bound it with `Effect.timeout` if a screen can't wait. A screen that sends a command leaves the run stepping, and freezes the game in its rules if it must. Interrupting a send takes the command back, if it hasn't been applied yet.
- **In a lockstep run**, the same command and the same rejections travel: `session.send` and the Co-op client's `send` ([`arcadekit/net`](../net/README.md#commands)) carry a command to every peer's rules at one step, each peer's `apply` handler takes or refuses it alike, and only the sender hears. `CommandDropped` then speaks for the sender's own peer: its run stopped before its rules answered.
- **With `Game.Loop`**, `loop.send(command, player, settled)` calls `settled` with `undefined`, the rejection or a `CommandDropped`, once the loop is out of the frame, the `start` or the `stop` that ended the command, so `settled` may send, start or stop. By then the loop's listeners (`loop.subscribe`) have heard what that frame or that start reported: a frame's events, then its sample. It returns a function that takes the command back: `settled` is not called after it. A frame that throws tells no sender: the `stop` that follows tells them. If a step or a handler threw, that `stop` also discards what the frame had reported, which no listener hears; a listener that throws ends the telling where it threw. An input source's `read(step)` may send: a command sent there is applied in that same step, before `step`, which is how a host that knows a command's step (a replay, a lockstep session) gives it to the rules at exactly that step.
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

## Several players

A simulation that several players can play takes every player's input in one step. `Game.PlayerInputs(OnePlayersInput)` is that step input as a Schema, made from the Schema of one player's input: `players[slot]` is one player's input, or null when that player has none this step, and `leaving` lists the slots that leave the run at this step, in ascending order. A slot is a player's place in the run's player order, fixed for the whole run.

```ts
import * as Game from "arcadekit/game";
import { Schema } from "effect";

// One player's input for one step: what their devices hold, and what crosses the network.
const Move = Schema.Struct({ moveX: Schema.Number });

// Every player's, by slot, and the slots leaving at this step.
const RaceInput = Game.PlayerInputs(Move);
type RaceInput = typeof RaceInput.Type;

class Race extends Game.Simulation("Race", {
  input: RaceInput,
  create: (config: { readonly players: number }) =>
    Array.from({ length: config.players }, () => 0),
  step: (xs, input, { dt }) => {
    for (let slot = 0; slot < xs.length; slot++) {
      xs[slot]! += (input.players[slot]?.moveX ?? 0) * dt;
    }
    // A player who leaves the run goes back to the start line.
    for (const slot of input.leaving) {
      xs[slot] = 0;
    }
  },
}) {}

// One player: their source fills slot 0, and nobody leaves.
const solo = Game.makeLoop(Race);
solo.start({ players: 1 }, 1234, 0);
solo.frame(Game.soloInput({ read: () => ({ moveX: 1 }) }), { steps: 60 }, 1000);
console.log(solo.state?.[0]); // about 1: one second at speed 1

// A test or a replay may fill it by hand: a value needs nothing but the two fields.
const both: RaceInput = { players: [{ moveX: 1 }, null], leaving: [] };
console.log(both.players.length); // 2

// A host that seats several players reads one player's Schema from the declaration.
const player = Game.playerInputSchema(Race);
console.log(Schema.decodeUnknownSync(player)({ moveX: 1 })); // { moveX: 1 }
```

- **`Game.soloInput(source)`** makes the step input from one player's source, at slot 0: what an engine's `input` returns for such a simulation, and what a replay steps it with. It refills one object, so a step allocates nothing.
- **A host that seats several players** asks for a `Game.PlayersSimulation` and reads the one-player Schema with `Game.playerInputSchema`. A lockstep session ([`arcadekit/net`](../net/README.md)) is one: it sends each player's own input, decodes it with that Schema on every peer, and puts each at its slot, with the players its host removed in `leaving`. A player whose peer has nothing attached has null at its slot.
- **A command's `player`** is its sender's slot: `context.player` in an `apply` handler. A lockstep session sends each command with its sender's slot, at the step every peer agreed on, so a handler finds the sender's part of the state the same way on every peer and in a single-player run, where it is 0.
- **It is a Schema, and a marked one.** `.annotate()` and `.check()` give a players' input too. A struct with `players` and `leaving` written by hand is not one, since no host could read one player's Schema from it, and a host refuses a simulation declared with such a struct. `playerInputSchema` throws for it. Before that it is a type error that names `Game.PlayerInputs`, where the host infers the step input from the simulation it is handed: `hostLockstep`, `Game.playerInputSchema`, and a `Coop`, which infers it from its engine. Where the step input's type is named, the types can't tell the struct from the declared input, and the throw is the only refusal.
- **To name the types**: `Game.PlayerInputs<Move>` is the step input's type, and `Game.PlayerInputOf<Game.InputOf<typeof Race>>` one player's.

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
- **`view`** and **`input`** are called once per attach, the view first, and disposed when the engine detaches, the input source first. Several views are one with `Game.combineViews`, such as a drawing view and a sound view: it renders each in order and disposes them in reverse. The view's third argument is `{ local }`, the local player's seat, which a view of a run several players share reads when it draws (`local.slot`): the engine seats its one player at slot 0, and a [`Coop`](../net/README.md#co-op), which plays the same engine for several players, at the slot its lobby gave.
- **A view** is a `Game.View`: `render(state, timeSeconds)` and `dispose`. `render` reads the state and never changes it, and gets no state (null) when no run is active. Each run has its own state object, made by `create`, and `render` gets that same object on every frame until the run ends, so a view tells runs apart by identity: push-puzzle's view resets when the object changes.
- **An input source** is a `Game.InputSource`: a `Game.StepInput` ([How a frame becomes steps](#how-a-frame-becomes-steps)) that owns what it listens with, and gives it back in `dispose`.
- **`engine.attach(element)`** steps the run by the time since the last frame, then draws it, on every animation frame. A first frame timed before the attach counts as no time. It never succeeds, so run it last: it fails with what a `uses` Effect fails with, with `AttachError` if the view or the input source can't be made (no WebGL), and with `GameCrashed` if a step, a render or a listener of the run's events throws. That frame is the last: the run ends, and the view and the input source are disposed, so the app can say why instead of showing a frozen viewport. Those failures reach only what waits on `attach`: a forked `attach` that nothing joins loses them, so join its fiber or race the rest of the program against it. Attaching an engine that is already attached dies: an engine draws into one element at a time.
- **`engine.start`**, `setPaused` and `stop` drive the run: while paused a frame draws but doesn't step, and paused time doesn't count. `engine.send` sends the run a command and waits for the rules' answer ([Refusing a command](#refusing-a-command)), and `engine.listen` hears its events and samples, in the order the run reports them: its callback is called inside the `start` or the frame that reports, before the frame draws and before a send that frame answered completes.
- **`Game.Frames`** is where an attached engine gets its frames: `requestAnimationFrame` (`Game.animationFrames`), unless the app or a test provides another `Game.FrameSource` ([Testing an engine](#testing-an-engine)).
- **`Game.frameLoop(frames, frame)`** is the loop an engine draws on, for anything else an app draws on animation frames. It fails with `GameCrashed` when a frame throws.

In a Foldkit app, [`arcadekit/foldkit`](../foldkit/README.md)'s engine entry attaches the engine to the viewport and turns its events into Messages: `EngineEntry.make({ engine: RaceEngine, toMessage: Race.match({ ... }), ... })`.

## Testing an engine

`arcadekit/game/testing` has `ManualFrames`, a frame source a test drives: `ManualFrames.make()` makes one, and no frame runs until the test runs it with `ManualFrames.runFrameAt(frames, ms)`, at a time it chooses, so an engine steps and draws in Node with no `requestAnimationFrame`. Provide it as `Game.Frames`. Only tests import this entry.

```ts
import * as Game from "arcadekit/game/browser";
import { ManualFrames } from "arcadekit/game/testing";
import { Effect, Layer, Schema } from "effect";

class Count extends Game.Simulation("Count", {
  // 1/64 s steps, so the frame times below are exact in floating point.
  stepSeconds: 1 / 64,
  input: Schema.Null,
  create: () => ({ steps: 0 }),
  step: (count) => {
    count.steps += 1;
  },
}) {}

// What the view drew, frame by frame.
const drawn: (number | null)[] = [];

class CountEngine extends Game.Engine("CountEngine", {
  simulation: Count,
  view: () => ({
    render: (count) => {
      drawn.push(count?.steps ?? null);
    },
    dispose: () => {},
  }),
  input: () => ({ read: () => null, dispose: () => {} }),
}) {}

const frames = ManualFrames.make();
// Node has no DOM, and this view touches nothing of its element.
const element = {} as HTMLElement;

// In a test: `await Effect.runPromise(play)`, then `expect(drawn).toStrictEqual([1, 2])`.
export const play = Effect.gen(function* () {
  const engine = yield* CountEngine;
  yield* engine.start(null, { seed: 1 });
  // Attached on a fiber of this scope. It has asked for its first frame when this returns.
  yield* Effect.forkScoped(engine.attach(element), { startImmediately: true });
  // 1/64 s after the attach: one step, then a draw. Then another.
  ManualFrames.runFrameAt(frames, 15.625);
  ManualFrames.runFrameAt(frames, 31.25);
}).pipe(
  Effect.scoped,
  Effect.provide(CountEngine.layer),
  Effect.provide(Layer.succeed(Game.Frames, frames))
);
```

`ManualFrames.waiting(frames)` says whether the engine has asked for a frame that hasn't run: it has while attached, and not after a detach or a crash. A Co-op client draws on the same frames ([`arcadekit/net`](../net/README.md#testing-a-co-op-game)). To check the rules themselves, use [a scenario](#a-scenario): it needs no engine and no frames.
