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
- **`sample`** is a read of the state for the UI, such as a HUD, delivered as an event. Its `read` and `version` are given the state read-only, a `Game.ReadonlyState`, so the compiler refuses a write there. It is delivered when a run starts and then every `every`, and/or right after any frame in which `version` (a cheap number, such as a turn counter) changed.
- **`invariants`** says what must hold of every run's state, by name: below.

## Invariants

A run's state is open: the step writes its fields and typed arrays directly, and nothing guards a field. What must stay true of it, an **invariant**, is declared instead: a named function that reads the state, given read-only, and returns whether it holds. A scenario checks every one as its run starts and after every step, and fails at the first that doesn't hold, naming it, the step and the run's seed. So a change that breaks a rule fails at the step that broke it, under the rule's name, in any scenario of the game, not only the one written about that rule.

```ts
import * as Game from "arcadekit/game";
import * as Scenario from "arcadekit/game/scenario";
import { Schema } from "effect";

class Tank extends Game.Simulation("Tank", {
  input: Schema.Number,
  create: (config: { readonly litres: number }) => ({ litres: config.litres }),
  step: (tank, burn) => {
    tank.litres -= burn;
  },
  invariants: {
    neverBelowEmpty: (tank) => tank.litres >= 0,
  },
}) {}

const scenario = Scenario.make(Tank);

// Throws a ScenarioError: 'Simulation "Tank" breaks its invariant "neverBelowEmpty" at step 2
// of the run with seed 0: the step, or a command it applied, left the state where it doesn't hold.'
const overdraw = () =>
  scenario(Scenario.given({ litres: 5 }), Scenario.step(2, 4));
```

A loop checks them only when asked, as a replay or a long run in a test asks: `Game.makeLoop(Tank, { checkInvariants: true })` throws an `Error` with the same message. An engine, a lockstep session and a Co-op client never run them, so play pays nothing for them. Keep each one a cheap read of the state: a scenario runs every one after every step.

`Game.StateOf<typeof Race>`, `ConfigOf`, `InputOf`, `EventOf` and `CommandOf` name a simulation's types. `Race.match({ Finished: ..., Hud: ... })` makes a function that handles each event by its tag, checked to cover them all. A case for an event the simulation doesn't report compiles (one left behind by a renamed event), so `match` refuses it when it is called, as the app's module loads.
