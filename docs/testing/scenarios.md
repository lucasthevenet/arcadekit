# Scenarios

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
