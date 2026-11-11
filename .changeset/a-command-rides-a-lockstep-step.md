---
"arcadekit": minor
---

A co-op player's decision is a command: a `Game.Command` of the game's simulation rides its sender's next step to every peer of a lockstep run, each peer's rules take or refuse it alike at that step, and only the sender hears which ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0020-a-game-is-declared.md)). It replaces the Co-op client's `answer` and `setPaused`, and the answer and the pause a game wrote into each step's input.

**The wire changed.** What a player sends for one step was its encoded input, and is now a list: the input, or null while nothing is attached, then the commands sent for that step, four at most. `[{"moveX":0,"moveZ":1}]` is a step with no command. The messages, the acknowledgements and resends, the bounds, the hashes and the referee are as they were. A peer on this release can't play with a peer on the one before: each removes the other, or stops, on the first payload, with `badInput`.

**New**

- `LockstepSession.send(command, settled?)` (`arcadekit/net`) is `Game.Loop`'s `send` without the slot. The command rides the local player's payload for the next step the session schedules, so the host confirms it once, with that step, and every peer hands it to its loop with the sender's slot, before the step and before the step's leavers. `settled` is called on the sender's peer, once the session is out of the tick that ran the step, with `undefined`, the rejection or a `CommandDropped`. It returns a function that takes the command back while it has no step yet.
- `ScopedLockstepSession.send(command)` and `CoopClient.send(command)` (`arcadekit/net/browser`) are that as an Effect, in the shape of `Game.Engine`'s `send`: it succeeds when this peer's rules took the command, fails with the rejection they refused it with, and fails with `CommandDropped` when they gave no answer. For the client that is `noRun` with no seat or in the lobby, and `runEnded` when the run stopped or the player left first.
- Every send ends. A session that stops, is disposed or throws out of a tick tells the senders still waiting `CommandDropped` (`runEnded`), a send after that is answered at once, and a step the host confirms without what this peer sent for it answers those senders the same way, with no throw. A command sent while a guest's session is still `joining` waits, and rides the run's first steps.
- At most four commands ride one player's step, checked where a payload is decoded: a fifth rides the sender's next step, in the order sent, and a peer that sends five in one step is removed as for any payload that doesn't decode.
- `send` throws for a command that can't cross the network: a value JSON doesn't carry, such as a NaN in a `Schema.Number` field, which no peer could decode. Before a step it would have shown as its sender's bad input.
- A session's `local` source may return null for a step, and the Co-op client's does while nothing is attached. The rules see null at that player's slot, as `Game.PlayerInputs` allows.
- A player the host removes after it confirmed the step of that player's command is told `CommandDropped` (`runEnded`) though the peers still in the run applied the command: a send speaks for its own peer's rules.

**Breaking**

- `CoopClient.answer` and `CoopClient.setPaused` are gone: send a command of the game's simulation with `CoopClient.send`. The kit knows nothing of pausing any more: a game with a co-op pause declares a command for it.

  ```ts
  // Before
  const before = Effect.gen(function* () {
    yield* coop.answer({ offer, index });
    yield* coop.setPaused(true);
  });

  // After: the game declares both, and its `apply` handlers take or refuse them
  class ChooseUpgrade extends Game.Command(
    "ChooseUpgrade",
    { offer: Schema.Int, index: Schema.Int },
    { rejects: [OfferClosed] }
  ) {}
  class HoldPause extends Game.Command(
    "HoldPause",
    { held: Schema.Boolean },
    { rejects: [NotPlaying] }
  ) {}

  const after = Effect.gen(function* () {
    yield* coop
      .send(new ChooseUpgrade({ offer, index }))
      .pipe(
        Effect.catchTag(["OfferClosed", "CommandDropped"], () => Effect.void)
      );
    yield* coop.send(new HoldPause({ held: true })).pipe(
      // The rules hold no pause for this player: stop showing the run as paused. Keep the way
      // to leave the run on screen, if the pause screen is where it is.
      Effect.catchTag(["NotPlaying", "CommandDropped"], () => showRunPlaysOn)
    );
  });
  ```

- `CoopRules.localInput` and `CoopRules.settled` are gone, and `CoopTypes` has no `Answer`. The bag names the simulation's commands and their rejections in its place, which type the client's `send`:

  ```ts
  interface MyCoop extends CoopTypes {
    // Config, State, Event, PlayerInput, LocalEvent, Content: as before
    readonly Command: Game.CommandOf<typeof MyGame>;
    readonly Refusals: Game.RefusalsOf<
      readonly [typeof ChooseUpgrade, typeof HoldPause]
    >;
  }
  ```

  The one-player input Schema holds what a device holds and nothing else: take the answer and the pause out of it, and out of `step`. A pause becomes state a command sets once, where a step read it from every step's input: decide in the rules what lets go of it (a player leaving, a hero going down) and what refuses it (a hero that is not playing, a run that is over).

- A step's commands are applied before the step, so before the players in its `leaving`. Rules that handled leaving first and then the answers in a step's input see the other order when a command and a removal share a step. Check that both orders give the same state, or decide which is right, with a scenario.
- A step's input is null for a player whose peer has nothing attached, where the game's `localInput` made an input for it: `players[slot]` was already `PlayerInput | null`.
- `LockstepSession` and `ScopedLockstepSession` are `<State, Event, Command, Refusals>`, and `CoopRules.simulation` is typed with the bag's `Command` and `Refusals`.
- `arcadekit/net/testing`: the test game's input is `{ add }`. Its answer is the command `AnswerOffer`, refused with `NothingOwed`, and its pause the command `HoldPause`; `TestCommand` is their union. `TestAnswer` is gone, `TestState` has `held`, and `testCoopRules` has no `localInput` and no `settled`.
