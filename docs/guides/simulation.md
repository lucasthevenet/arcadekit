# The simulation

A simulation says what a run's state is made from, how one step advances it, which events it reports and which commands it takes. The events and commands are classes that are also their own Schemas. `create`, `step` and each `apply` handler are plain functions: a step runs no Effect and reads no clock or random source of its own, so the same seed, input and commands always give the same run.

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

- **`create`**, **`step`** and each `apply` handler are plain functions. A `create` written in place comes before `step`, `apply` and `sample`: TypeScript types the state from what it returns, and a handler written above it can leave the state `unknown`. `step` and `apply` change the state in place and return nothing. One that returns anything else is a type error, and the loop refuses it too: a step can't be `async` or return an Effect, so when a frame returns, its steps are over. A step may allocate what it reports, and keeps what it holds per entity in typed arrays ([entity pools](entity-pools.md)).
- **`input`** is one step's input as a Schema: what a device holds for the step and what a replay records. A simulation several players can play declares it with `Game.PlayerInputs`: see [Several players](several-players.md).
- **`events`** lists what a step may report with `report`. Keep them rare: they cross into the UI.
- **`commands`** lists what a player may send, and **`apply`** handles each by its tag. A command is applied at the start of the next step, before `step`, in the order sent. A run changes in no other way, so a simulation that declares a command without its handler is refused when its module loads, and so is a handler without its command. A handler may refuse its command: see [Refusing a command](commands.md).
- **`sample`** is a read of the state for the UI, such as a HUD, delivered as an event: when a run starts and then every `every`, and/or right after any frame in which `version` (a cheap number, such as a turn counter) changed.

`Game.StateOf<typeof Race>`, `ConfigOf`, `InputOf`, `EventOf` and `CommandOf` name a simulation's types. `Race.match({ Finished: ..., Hud: ... })` makes a function that handles each event by its tag, checked to cover them all. A case for an event the simulation doesn't report compiles (one left behind by a renamed event), so `match` refuses it when it is called, as the app's module loads.
