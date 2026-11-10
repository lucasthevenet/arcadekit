---
"arcadekit": minor
---

A lockstep run hosts a declared simulation: `hostLockstep`, `joinLockstep`, their scoped forms and the Co-op client step a `Game.Simulation` class through `Game.Loop`, as `Game.Engine` does ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0020-a-game-is-declared.md)). A simulation several players can play declares its step input with `Game.PlayerInputs`, and the session takes from it what a game used to pass as `codec` and `combine`.

The messages, their bounds, the hashes and the referee are the same. What one player's payload is changed with commands, in the same release: see the changeset on a command riding a lockstep step.

**New in `arcadekit/game`** (and `arcadekit/game/browser`)

- `Game.PlayerInputs(OnePlayersInput)`: the step input of a simulation several players can play, as a Schema made from the Schema of one player's input. `players[slot]` is one player's input or null, and `leaving` the slots removed at this step. It is a marked Schema: `.annotate()` and `.check()` keep the mark, and a struct with the same two fields written by hand doesn't have it.
- `Game.PlayerInputs<PlayerInput>`, the type, and `Game.soloInput`, which fills it for one player, move here from `arcadekit/runtime`. A value needs no mark: `{ players: [input], leaving: [] }` is one.
- `Game.PlayersSimulation` is what a host that seats several players asks for: a simulation whose step input was declared with `Game.PlayerInputs`. Any other is a type error that names `Game.PlayerInputs` where the host infers the step input from the simulation it is handed (`hostLockstep`, `Game.playerInputSchema`). Where the step input's type is named, as in `CoopRules`, the types can't tell a struct written by hand from the declared input. `Game.playerInputSchema(simulation)` gives such a host the one-player Schema, and throws for whatever got past the types. `Game.PlayerInputOf<Input>` is one player's input of a step input, and `Game.PlayerInputsSchema<P>` the type `Game.PlayerInputs` returns.
- `Game.Loop`: an input source's `read(step)` may call `loop.send`. A command sent there is applied in that same step, before `step`.

**Breaking**

- `hostLockstep`, `joinLockstep`, `hostLockstepScoped` and `joinLockstepScoped` take `simulation: MySimulation`, a `Game.Simulation` class whose `input` is a `Game.PlayerInputs`, where they took a `GameSimulation` object. The `codec` and `combine` options are gone: each player's input crosses the network as the one-player Schema encodes it, and the session puts each at its slot. `local` reads one player's input, as before. A simulation with any other step input is refused: a throw with nothing left listening, and before it a type error on `simulation` when the call infers its types from the simulation. `LockstepOptions`, `HostOptions` and `JoinOptions` are now `<Config, State, Input, Event, Command, Refusals>`, with `Input` the simulation's step input; a call that names no type arguments is unaffected.

  ```ts
  // Before
  const simulation: GameSimulation<
    Config,
    World,
    PlayerInputs<HeroInput>,
    Event
  > = {
    create: (config, seed) => createWorld(config, seed),
    step,
    drainEvents: (world) => world.events.drain(),
  };
  hostLockstep(
    {
      simulation,
      codec: schemaCodec(HeroInput),
      combine: combinePlayerInputs(players),
      // config, contentHash, transport, local, hash, inputDelay, hashEvery, peers, seed
    },
    nowMs
  );

  // After
  class MyGame extends Game.Simulation("MyGame", {
    input: Game.PlayerInputs(HeroInput),
    events: [RunEnded],
    create: createWorld,
    step,
  }) {}
  hostLockstep(
    {
      simulation: MyGame,
      // config, contentHash, transport, local, hash, inputDelay, hashEvery, peers, seed
    },
    nowMs
  );
  ```

- `joinLockstep` and `joinLockstepScoped` take `players`: the run's player order as the lobby agreed it, the host first, then the `peers` the host passes. It is the list a guest passed to `combinePlayerInputs`. A guest must be told it: the host's start message lists who is still in the run when it is sent, so a guest that first hears it after a player was removed would otherwise seat the players that are left at other slots than the host does. The Co-op client passes its lobby's order.

  ```ts
  joinLockstep(
    {
      simulation: MyGame,
      host: "host",
      players: ["host", "guest-1", "guest-2"],
      // config, contentHash, transport, local, hash, inputDelay, hashEvery
    },
    nowMs
  );
  ```

- `CoopRules.simulation` is that declared class, and `CoopRules.codec` is gone. `choosing`, `localEvent`, `runEnded`, `CoopGame` and the client's events are unchanged; `settled`, `localInput` and the client's `answer` and `setPaused` go with commands, in the same release. `makeCoopClient` now throws where it is called for a game whose simulation's step input is not a `Game.PlayerInputs`. That throw is the only refusal there: `CoopRules` names the step input's type, so a struct written by hand with `players` and `leaving` compiles.
- `arcadekit/net` no longer exports `InputCodec`, `jsonCodec`, `schemaCodec`, `combinePlayerInputs`, `ConfirmedStep` or `PlayerStepInput`: no option takes them any more.
- `arcadekit/runtime` no longer exports `PlayerInputs` or `soloInput`: import `arcadekit/game`, as `Game.PlayerInputs` and `Game.soloInput`.
- A host's own input that doesn't survive the wire still stops it with `badInput`, and a local input source that returns a value the one-player Schema refuses to encode still makes the tick throw, as it did with `schemaCodec`. A game that passed `jsonCodec` got neither check.
- `arcadekit/net/testing`: the test game is declared. `testSimulation` is replaced by the class `TestGame`, its events are the classes `Score`, `OfferOpened` and `RunEnded` (they were `{ type: "score" | "offer" | "ended" }` objects), `TestEvent` is their union, and `TestState` has no `events`. `testCoopRules` has no `codec`. What the Co-op client reports of a run (`TestLocalEvent`) is unchanged. Its answer and its pause are commands: see the changeset on a command riding a lockstep step.
