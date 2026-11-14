# Several players

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
- **A host that seats several players** asks for a `Game.PlayersSimulation` and reads the one-player Schema with `Game.playerInputSchema`. A [lockstep session](lockstep-sessions.md) is one: it sends each player's own input, decodes it with that Schema on every peer, and puts each at its slot, with the players its host removed in `leaving`. A player whose peer has nothing attached has null at its slot.
- **A command's `player`** is its sender's slot: `context.player` in an `apply` handler. A lockstep session sends each command with its sender's slot, at the step every peer agreed on, so a handler finds the sender's part of the state the same way on every peer and in a single-player run, where it is 0.
- **It is a Schema, and a marked one.** `.annotate()` and `.check()` give a players' input too. A struct with `players` and `leaving` written by hand is not one, since no host could read one player's Schema from it, and a host refuses a simulation declared with such a struct. `playerInputSchema` throws for it. Before that it is a type error that names `Game.PlayerInputs`, where the host infers the step input from the simulation it is handed: `LockstepSession.host`, `Game.playerInputSchema`, and a `Coop`, which infers it from its engine. Where the step input's type is named, the types can't tell the struct from the declared input, and the throw is the only refusal.
- **To name the types**: `Game.PlayerInputs<Move>` is the step input's type, and `Game.PlayerInputOf<Game.InputOf<typeof Race>>` one player's.
