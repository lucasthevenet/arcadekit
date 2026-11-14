# arcadekit

Versions up to 0.2.3 were published as the nine `@arcadekit/*` packages (core, input, content, save, audio, render-three, runtime, net and foldkit); their entries are merged here.

## 0.6.0

### Minor Changes

- [#76](https://github.com/lucasthevenet/arcadekit/pull/76) [`29de556`](https://github.com/lucasthevenet/arcadekit/commit/29de55669810fee724d1f1fdad092f47dd737e01) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A co-op host hears its run from the start. A host's run has started by the time `hostLockstep` returns, before anything can listen to the session, so what that start reported reached no listener: what the simulation's `create` reports, and the run's first sample. A `Coop`'s host seat heard `RunStarted` and then nothing until its first steps, where a guest's seat heard the start. A game whose `create` reports its first stage showed that stage's banner to the guests alone.

  A session now keeps what a host's start reported and tells it at its first tick, before the tick does anything else.

  - **The Co-op client.** The host's seat hears what `create` reports and then the first sample, after its `RunStarted`, as a guest's seat does: each once, in the same order. A `Coop` and its `match` need no change.
  - **`hostLockstep` and `hostLockstepScoped`.** `session.subscribe(listener)` before the session's first tick, or `yield* session.listen(onEvent)` before `session.run(...)`, hears the run from its start. A listener that comes later hears what comes after it, and nothing is told twice. The entry's README has it under "Listening to a run".
  - **Nothing else of a session changed.** The run still starts in `hostLockstep`: its state is there at once, and what starting throws is thrown there. What peers exchange, the step a command rides and when steps run are as they were.
  - **`arcadekit/net/testing`.** The test game's content takes `offerAtStart: true`: the run then starts on an offer that `create` reports, for a test of what a seat hears first. Left out, the game is as it was.

  **What a game written against 0.5.0 may have to change.** Nothing stops compiling. A host's listener hears more than it did, at its session's first tick: a test that lists everything a host's session or seat reported now has the start's events and its first sample in that list, and a workaround that gave a host the start's news another way now gives it twice.

- [#76](https://github.com/lucasthevenet/arcadekit/pull/76) [`29de556`](https://github.com/lucasthevenet/arcadekit/commit/29de55669810fee724d1f1fdad092f47dd737e01) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/net/testing` has `onFakeTimers(effect)`: what a test of a Co-op client on fake timers runs its Effects on. Nothing breaks: it only adds an export.

  In Node, Effect reads its time from `process.hrtime` and runs its fibers on `setImmediate`, and a test's fake timers reach neither. A run's clock would stand still while its ticker's faked timer ran on. So each such test carried about forty lines: a `Clock` on the page's timers and a scheduler on microtasks, as Foldkit's is in the browser. The kit's own client tests had them, and so had the survivors demo's and grimbonk's ([co-op-findings.md](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/co-op-findings.md), finding 2).

  `onFakeTimers` gives an Effect both, and changes nothing else of it: what it gives, fails with and needs.

  ```ts
  import { onFakeTimers } from "arcadekit/net/testing";
  import { Effect } from "effect";

  // Before: the test's own Clock and scheduler, about forty lines above this.
  const before = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock.Clock, performanceClock),
        Effect.provideService(Scheduler.Scheduler, microtasks)
      )
    );

  // After
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(onFakeTimers(effect));
  ```

  - Wrap every Effect the test runs or forks, the one that builds the client's layer first: a client takes its Clock and its scheduler from the Effect that made it.
  - It fakes nothing itself and imports no test runner. Fake `performance` and `setTimeout`, and `setInterval` with `clearInterval` for a run on the default ticker; leave `queueMicrotask` real. The entry's README has it under "On fake timers".

### Patch Changes

- [#76](https://github.com/lucasthevenet/arcadekit/pull/76) [`29de556`](https://github.com/lucasthevenet/arcadekit/commit/29de55669810fee724d1f1fdad092f47dd737e01) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The docs now say what a listener has heard when a `send` completes. `Game.Engine`'s `send` said that its answer and the events of its step "arrive in no fixed order". That was wrong for a listener: the order is fixed, and a game may rely on it. No code changed, so nothing breaks: tests now hold the order.

  - **`engine.send`.** When it completes, the callback given to `engine.listen` has been called with everything the frame of the command's step reported: the events of each of that frame's steps, then its sample if one was due. So an Effect that listens and then sends knows, on the line after the send, what its command's step did, such as whether a pick opened another offer. It holds whether the rules took the command or refused it, and after a wait behind a pause.
  - **The one exception is a frame that throws before its listeners have heard it all**, as `attach` fails with `GameCrashed`. A command one of its steps had applied still gets the rules' answer. But if a step threw, what the frame had reported is discarded with its run and reaches no listener; and if a listener threw, the telling ended there: the listeners called before it heard that event, and none heard what came after. A render that throws comes after both, so the listeners heard its whole frame.
  - **A send that fails with `CommandDropped`** had no step to hear of. One that a new `start` dropped completes after the listener heard that run's start.
  - **A lockstep session's `send`, the scoped session's and the Co-op client's** have the same order, with no exception: a session's listeners are called inside the tick and its senders after it, and a tick that throws tells its senders `CommandDropped`. So no sender hears the rules' answer to a command whose step its listeners did not hear.
  - **The order is that of the two calls, not of Messages.** An app's Subscription makes a Message of each event and its Command another of the send's result, and the kit fixes no order between those in `update`. A Command that needs what its command's step reported listens itself, around its send.

  `Game.Loop`'s `subscribe` and `frame`, the entries' READMEs (`arcadekit/game`, `arcadekit/net`) and the glossary say the same.

## 0.5.0

### Minor Changes

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`fb8ff12`](https://github.com/lucasthevenet/arcadekit/commit/fb8ff12dc992c647dc803f3f3e37a14c3f344d0d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A co-op player's decision is a command: a `Game.Command` of the game's simulation rides its sender's next step to every peer of a lockstep run, each peer's rules take or refuse it alike at that step, and only the sender hears which ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)). It replaces the Co-op client's `answer` and `setPaused`, and the answer and the pause a game wrote into each step's input.

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

- [#73](https://github.com/lucasthevenet/arcadekit/pull/73) [`3ad14cc`](https://github.com/lucasthevenet/arcadekit/commit/3ad14cc7a6d420012a56e1238c4232661c0ab7e9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game is declared: one named class per part, hosted by a Layer or a loop ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)).

  **New entries**

  - `arcadekit/game`: `Game.Event` and `Game.Command` (Schema classes for what a run reports and what a player decides), `Game.Rejection` (why the rules may refuse a command), `Game.Simulation` (the DOM-free rules: `input`, `events`, `commands`, `create`, `step`, `apply`, `sample`) and `Game.Loop`, which steps one anywhere. A command sent to a run is applied at the start of its next step, so a run changes only at a step. Its `apply` handler takes it or returns one of the rejections the command declares (`rejects`), and the sender is told which. A `step` or an `apply` handler that returns anything else is a type error, and the loop refuses it.
  - `arcadekit/game/browser`: the same, plus `Game.Engine`: a simulation with the `view` and `input` that draw it and read its input, and what they are made from (`uses`, Effects run on each attach). The class is the engine service's key and its `layer` provides it. `engine.send(command)` completes when the rules have answered: it fails with the command's rejection if they refused it, and with `CommandDropped` if it never reached them. `Game.Frames` replaces the frame clock in a test. The sender goes on after the frame of the command's step, so it may start or stop a run. `Game.EngineOf<typeof MySimulation>` names the running engine. `Game.frameLoop(frames, frame)` is the loop an engine and the Co-op client draw on, for anything else an app draws on animation frames.
  - `arcadekit/game/scenario`: scenarios that check a simulation: `Scenario.given`, `step`, `send`, `reported`, `refused`, `sampled`, `state`.

  **New in `arcadekit/content`**

  - `Content(name, { schema, files, validate })` and `Asset<A, E>()(name, { release })`: content and loaded-once assets as classes that key their own service (`.layer`, `.load`; `Content` also has `.read` for tests). `loadOnce` is what both are built on.

  **Breaking**

  - `arcadekit/foldkit`'s `engineEntry` no longer infers the app's Message type from `toMessage` and `onError`: it comes from `Subscription.make`. A call outside one names its type parameters. A `toMessage` that returns something that isn't a Message is now reported on `toMessage`.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`6228fb7`](https://github.com/lucasthevenet/arcadekit/commit/6228fb7c29e803f8de7ea8cc0818ce22cf0ae8b4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A save, a setting and a cue table are declarations. `class MySave extends Save("MySave", { storageKey, field, record, mergeRecord }) {}` and `class MyAudioSettings extends Setting("MyAudioSettings", { storageKey, schema, default }) {}` (`arcadekit/save`): each class is the key of its service, `layer` provides it over a `KeyValueStore`, and the service is a `Stored`, `read` and `write`. `class MyCueTable extends CueTable("MyCueTable", { cues: { hit: SoundId } }) {}` (`arcadekit/audio`): the class is the key of the app's sounds, which `MyCueTable.layer(sounds)` checks and provides. Each builder's types are exported with it: `SaveClass`, `SaveId` and `SaveService`; `SettingClass`, `SettingDefinition`, `SettingId` and `SettingService`; `CueTableClass`, `CueTableDefinition`, `CueTableId`, `CueTableService`, `CueSounds` and `AnyCueTable`. The stored formats and the storage keys are unchanged.

  **Breaking**

  - `arcadekit/save`: `makeSaveStore`, `SaveStore` and `mergeRecords` are gone. Declare a `Save`: its definition's `key` is `storageKey`; `load` is `read` and `merge(records)` is `write(records)`, which still merges into what is stored, both reached with `yield* MySave`; `mergeRecords(mergeRecord)` is the class's `MySave.merge`. `SaveDefinition` is generic over the record's Schema, and a `field` named `version` is refused.
  - `arcadekit/audio`: `makeAudioSettingsStore` and `AudioSettingsStore` are gone, and the entry no longer reads storage. Declare a `Setting` with `schema: AudioSettings` and `default: defaultAudioSettings`; `load` is `read` and `save(settings)` is `write(settings)`, which gives back what it wrote. `AudioSettings`, `defaultAudioSettings` and `applyAudioSettings` stay.
  - The log lines name the declaration, where they said `The save ...` and `The audio settings ...`: `Save "MySave" can't be read. ...`, `Setting "MyAudioSettings" can't be written.`
  - A genre's cue table is a `CueTable`. `@arcadekit/push-puzzle/browser` has `PushPuzzleCueTable` in place of `PushPuzzleCueSounds` and the type `PushPuzzleSounds`, and `@arcadekit/survivors/browser` has `SurvivorsCueTable` in place of `SurvivorsCueSounds` and `SurvivorsSounds`. An app gives its sounds with `PushPuzzleCueTable.layer(sounds)` in place of `Layer.succeed(PushPuzzleCueSounds, sounds)`, and names their type `CueSoundsOf<typeof PushPuzzleCueTable>`. `layer` throws when the sounds don't fit the cues, as the app's module loads, where a cue the app left out was silent.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`a98eb7f`](https://github.com/lucasthevenet/arcadekit/commit/a98eb7fc0fd8ce70c759f98f222dd1673c81a4c7) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Co-op is a declaration: `Coop` (`arcadekit/net/browser`), made from the game's `Game.Engine` ([ADR-0021](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0021-co-op-is-declared-from-the-games-engine.md)). It replaces `CoopRules`, the `CoopTypes` bag, `CoopGame` and `makeCoopClient`. Nothing changed on the wire, in the lockstep session or in how a command travels.

  **What a co-op game writes differently**

  ```ts
  // Before: a bag of types by hand, a rules object, a game value with a second presentation,
  // and a client made by the app.
  interface SurvivorsCoop extends CoopTypes {
    readonly Config: SurvivorsConfig;
    readonly State: World;
    // ...six more
  }
  const survivorsCoopRules: CoopRules<SurvivorsCoop> = {
    simulation: Survivors,
    hash: hashWorld,
    picks: (content) => content.heroes.map((hero) => hero.id),
    config: (content, heroIds) => ({ content, heroIds }),
    choosing: (world, slot) => world.heroes[slot]?.offer != null,
    localEvent: (event, slot) => /* a second event vocabulary */ null,
    runEnded: (event) => event._tag === "RunEnded",
  };
  const coopClient = makeCoopClient(
    { ...survivorsCoopRules, content, presentation },
    { rooms: browserCoopRooms({ url, iceServers }) }
  );

  // After: one declaration, over the engine the game already has. Every type is inferred.
  export class SurvivorsCoop extends Coop("SurvivorsCoop", {
    engine: SurvivorsEngine,
    input: heroDevice,
    content: SurvivorsContent.load,
    picks: (content) => content.heroes.map((hero) => hero.id),
    config: (content, heroIds) => ({ content, heroIds }),
    maxPlayers: MAX_HEROES,
    hash: hashWorld,
    ends: [RunEnded],
  }) {}

  // The client is the service `SurvivorsCoop`, provided by SurvivorsCoop.layer over
  // browserCoopRoomsLayer(() => ({ url, iceServers }))
  const hostRoom = (heroId: string) =>
    Effect.gen(function* () {
      const coop = yield* SurvivorsCoop;
      yield* coop.host(heroId);
    });
  ```

  - **`engine`** gives the simulation, what the view is made from (`uses`) and the view: the browser half is declared once. **`input`** is one player's input source, made as the engine's is, with what the engine uses.
  - **`ends: [RunEnded]`** replaces the `runEnded` predicate.
  - **`localEvent` is gone.** A seat hears the run's events as the rules reported them, each with the local player, and the app says which are its own in the class's `match`.
  - **`choosing` is gone**, and so is the `choosing` list of the waiting event. Who a run waits on to decide is the game's to say, in its sample (a flag for each player in a HUD), and the app reads it there.
  - **The class is the key of the Co-op client** (`yield* SurvivorsCoop`), and `SurvivorsCoop.layer` provides it. What every peer must agree on is on the class as plain functions (`SurvivorsCoop.definition.hash`, `picks`, `config`), for a test in Node.
  - **It is refused when declared**, by type and then by a throw as the module loads: an engine whose simulation's `input` was not declared with `Game.PlayerInputs`, an `ends` entry the simulation doesn't report (its sample included), and a `maxPlayers` no room can have.

  **What an app writes differently**

  ```ts
  // Before
  toMessage: (event) => {
    switch (event.type) {
      case "lobby":
        return Message.GotCoopLobby({
          role: event.role /* ...five more fields */,
        });
      case "run":
        return runMessage(event.event);
      // ...
    }
  };

  // After: one match for everything a seat reports. The run's cases have their own place, and
  // each is given the local player.
  toMessage: SurvivorsCoop.match({
    LobbyChanged: (lobby) => Message.GotCoopLobby({ lobby }),
    RunStarted: ({ slot, names }) => Message.GotCoopStarted({ slot, names }),
    WaitingChanged: ({ waitingFor }) => Message.GotCoopWaiting({ waitingFor }),
    SeatFailed: ({ message }) => Message.GotCoopFailed({ error: message }),
    run: {
      Hud: (hud) => Message.GotHud({ hud }),
      LeveledUp: ({ hero, offer, choices }, { local }) =>
        hero === local.slot
          ? Message.GotCoopLevelUp({ offer, choices })
          : undefined,
      HeroLeft: () => undefined,
      RunEnded: ({ summaries }, { local }) => {
        const summary = summaries[local.slot];
        return summary === undefined
          ? undefined
          : Message.GotCoopRunEnded({ summary });
      },
    },
  });
  ```

  - **The client's own events are Schema classes**, told by `_tag`: `LobbyChanged`, `RunStarted`, `WaitingChanged` and `SeatFailed`, where `CoopEvent` had `type: "lobby" | "started" | "waiting" | "failed"`. An app puts one in a Message or its Model as it is. A run's event comes as `{ _tag: "RunEvent", event, local }`, where it was `{ type: "run", event }` with what the game's `localEvent` made. `local` is the local player of the seat that heard it, one object for that seat's run, so an event an app keeps still says whose it was after the player has left or taken another seat.
  - **`match` covers everything a seat reports, and nothing else.** A missing case is a type error. A case for an event that doesn't exist, such as one left behind by a renamed event or a run's case written beside the client's own, compiles; `match` refuses it when it is called, as the app's module loads, and says where the case goes.
  - **The rooms are a service**, `CoopRooms`, with a Layer for each implementation: `browserCoopRoomsLayer(() => ({ url, iceServers }))`, which replaces `browserCoopRooms(options)` and reads its options when the layer is built, and `fakeCoopRooms().layer`. **The ticker is a reference**, `CoopTicker`, whose default is the worker's timer; a test provides `manualTicker().layer`. The frame clock is the engine's `Game.Frames`. `CoopClientOptions` is gone.

  **`Game.Engine`** (`arcadekit/game/browser`)

  - **`view` is told the local player**: `view(container, uses, { local })`, and it reads `local.slot` when it draws. The engine seats its one player at slot 0 and a `Coop` at the slot the lobby gave, so one view follows the local player in both. A view that takes two arguments compiles as before. `LocalPlayer` moved here from `arcadekit/net/browser`, with `ViewContext`.
  - **`input` is unchanged**: the whole step's input, so an engine can still fill several slots.
  - **`EngineClass` is typed by what the engine uses** (`EngineClass<Name, Config, State, Input, Event, Command, U, Refusals>`, where it had the error and the services of those as two parameters), and has the engine's `definition`, which a `Coop` reads.

  **`Game.Simulation`** (`arcadekit/game`)

  - **`match` refuses a case for an event the simulation doesn't report**, when it is called, as a `Coop`'s does. The types let an extra case through (one left behind by a renamed event), and it would never run. A case a cast left out is refused then too, where it was refused when its event came.

  **The Co-op client**

  - `CoopClient<State, Event, Command, E, Refusals>` has five type parameters, as `Game.Engine`'s service has, where it had the type bag. Its methods are the same.
  - On attach it makes the view first, then the input source, as an engine does. It made the input first.
  - It calls nothing of the game's between steps but the local player's input source.
  - `WaitingChanged` names a player only once the run has stood at one step for 300 ms. A peer whose run began more than the input delay before another's has a step due for the whole run while it steps at full rate, and its client named the other player all that time ("Waiting for Guest 1…" over a run that played).

  **`arcadekit/net/testing`**

  - `fakeCoopRooms()` has a `layer`, and so has `manualTicker()`.
  - The entry makes no Co-op client any more: `testCoopRules`, `testCoopGame`, `testPresentation`, the `TestCoop` bag and `TestLocalEvent` are gone, with nothing in their place. A test makes a client as an app does, from a `Coop`'s `layer`: provide it with `fakeCoopRooms().layer`, `manualTicker().layer` and `manualFrames()` as `Game.Frames`. That is your own game's `Coop`, or one declared over the test game, which stays: `TestGame` with its events and commands, `testContent` and `hashTestState`. Its sample `Score` says who still owes the open offer an answer (`owes`).

  **Removed**

  - `arcadekit/net`: `CoopRules`, `CoopTypes`.
  - `arcadekit/net/browser`: `makeCoopClient`, `CoopGame`, `CoopPresentation`, `CoopClientOptions`, `browserCoopRooms`, the `CoopRooms` interface (now the service; its shape is `Rooms`), `LocalPlayer` (now in `arcadekit/game/browser`).

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`d869690`](https://github.com/lucasthevenet/arcadekit/commit/d86969069eda5d11b8bc08a6e747a228c8627bfa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game's content loads through its `Content` declaration, and in no other way.

  **Breaking**

  `arcadekit/content` no longer exports `loadContent` or `LoadContentOptions`. `loadContent({ ...definition, source })` was the same call as a declared content's `read(source)`, so there were two ways to read and check a game's files once. What to write:

  ```ts
  export class MyContent extends Content("MyContent", {
    schema: MyGameContent,
    files: { levels: "levels.json" },
  }) {}

  // Before: loadContent({ schema: MyGameContent, files: { levels: "levels.json" }, source })
  const checked = MyContent.read(source);
  ```

  `read` keeps nothing, which suits a test of a game's real content files: it runs the checks the game runs. An app loads with `MyContent.load`, over `MyContent.layer(source)`, which keeps the first success.

  **Fixed**

  - A handler in `apply` takes the state `create` returns wherever it is written, with `create` the first of the handlers. Written directly under a `create` with an unannotated parameter (`create: (config: Config, { seed }) => ...`), it had a state of type `unknown`, and only another handler between the two (a `step`, a `sample`) hid that. `Game.CommandHandlers` is keyed by the commands' tags as before, and now reads them from the list without renaming the keys, which is what lets TypeScript type a handler before the state is settled. It also changes a definition that compiled: an `apply` written above a `create` written in place can now leave the whole simulation's state `unknown`, sometimes with no error, as a `step` there always could. Write `create` before `step`, `apply` and `sample`: this repository's lint reports the order (`declaration/create-first`).
  - A handler in `apply` with no command declared for it is refused: it was never called, and nothing said so. In a simulation that declares no command it is now a type error on the handler's line: `apply` is typed there by `Game.NoHandlers`, a new exported type. One the types let through (a cast, handlers held in a variable) makes `Game.Simulation` throw when declared: ``Simulation "Jar" has apply.Empty but declares no command "Empty". List the command's class in `commands`, or remove the handler.``

  **Changed**

  - Attaching an engine or a Co-op client that is already attached still dies, and the defect now names the declaration and says what to do: `Engine "MyEngine" is already attached to an element. An engine draws into one element at a time: interrupt the first attach, which detaches it, before attaching again.` A `Coop`'s says the same of its Co-op client.
  - `Game.Simulation`'s doc comment says what it refuses when declared and shows a loop that steps one, and `Game.Engine`'s example is push-puzzle's engine as it is written, with its cue table in `uses`.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`599e518`](https://github.com/lucasthevenet/arcadekit/commit/599e518b01fc748b79b9e49e31e6d5cf1fdbfe99) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A lockstep run hosts a declared simulation: `hostLockstep`, `joinLockstep`, their scoped forms and the Co-op client step a `Game.Simulation` class through `Game.Loop`, as `Game.Engine` does ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)). A simulation several players can play declares its step input with `Game.PlayerInputs`, and the session takes from it what a game used to pass as `codec` and `combine`.

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

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`281a4cd`](https://github.com/lucasthevenet/arcadekit/commit/281a4cd57dfe24595bb159df83727975ccb42858) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The engine loader and the content loader are gone. A game's engine, its assets and its content are declarations ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)), and no game used the loaders any more.

  **Breaking**

  `arcadekit/runtime/browser` no longer exports `makeEngineLoader`, `EngineLoader`, `LoadedEngine` or `engineOf`, and `arcadekit/content` no longer exports `makeContentLoader` or `ContentLoader`. What to write in place of each, as `@arcadekit/push-puzzle` does in [`src/browser/game.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/browser/game.ts) and [`src/content.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/content.ts):

  - `makeEngineLoader({ assets, game, release })`: declare what it loaded as an `Asset` (`arcadekit/content`), with its `release`, and the engine as a `Game.Engine` (`arcadekit/game/browser`) over the game's `Game.Simulation`, with the asset's load in `uses`. The app gives the asset's layer the load it passed as `assets`. The engine exists before its assets: each attach loads them, or takes what is already loaded.

    ```ts
    export class MySheet extends Asset<SpriteSheet, SpriteSheetError>()(
      "MySheet",
      { release: (sheet) => sheet.dispose() }
    ) {}

    export class MyEngine extends Game.Engine("MyEngine", {
      simulation: MyGame,
      uses: { sheet: MySheet.load },
      view: (container, { sheet }) => new MyView(container, sheet),
      input: myInput,
    }) {}

    // The app provides both. Building the layers loads nothing.
    const resources = Layer.mergeAll(
      MyEngine.layer,
      MySheet.layer(loadSpriteSheet("/sprites/my-game.json"))
    );
    ```

    Its `frames` option is the `Game.Frames` reference: `Layer.succeed(Game.Frames, manualFrames())`.

  - `EngineLoader`: the class `Game.Engine` returns is the engine service's key, and its `layer` provides the service. A genre writes no service and no layer maker for it.
  - `LoadedEngine`: `yield* MyEngine` is the engine, and `yield* MySheet.load` the asset.
  - `engineOf(MyEngine)`: `MyEngine` itself, in `engineEntry({ engine: MyEngine, ... })` and in a Command (`yield* MyEngine`). Reaching the engine loads nothing and can't fail. A sheet that can't be loaded is `attach`'s failure, which `engineEntry`'s `onError` gets, and the app's loading screen runs the same `MySheet.load` to show it and retry.
  - `makeContentLoader({ schema, files, validate, source })`: declare the content with `Content`, and give its layer the source.

    ```ts
    export class MyContent extends Content("MyContent", {
      schema: MyGameContent,
      files: { levels: "levels.json" },
    }) {}

    // The app says where the files are. Building the layer reads nothing.
    MyContent.layer(fetchJsonSource("/content/"));
    ```

    `MyContent.load` is the loader's `load`: it keeps the first success, and a failed load can be run again.

  - `ContentLoader<A>`: the class `Content` returns is the content service's key, so `MyContent` is the requirement and `MyContent.load` the load. The shape of the service is `Loaded<A, ContentError>`.

  `loadContent` is no longer exported either: `MyContent.read(source)` is that call, for a test of a game's real content files.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`219e8be`](https://github.com/lucasthevenet/arcadekit/commit/219e8beedf590ffe5cedeb55397e25395a2d4a26) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The older contract is gone, and with it the `runtime` entries. A game is its declarations ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)): no game in the repository was on the older contract any more, and nothing of it is kept as a compatibility layer. What `arcadekit/runtime` had that a declared game still uses is `arcadekit/game`'s, under the same names. Nothing changed in how a run steps: the kernel under `Game.Loop` steps with the same lines, and no recorded hash moved.

  **Breaking**

  `arcadekit/runtime`, `arcadekit/runtime/browser` and `arcadekit/runtime/testing` are no longer entries of the package, which has nineteen. `arcadekit/game/testing` is new.

  Each name they exported, and what to import or write in its place ([the `arcadekit/game` page](https://github.com/lucasthevenet/arcadekit/blob/main/packages/arcadekit/src/game/README.md) has each section):

  | From `arcadekit/runtime` | Now |
  | --- | --- |
  | `StepInput`, `InputSource` | `arcadekit/game` (and `arcadekit/game/browser`): `Game.StepInput`, `Game.InputSource` |
  | `FrameBudget` | `arcadekit/game`: `Game.FrameBudget` |
  | `PlayerInputs`, `soloInput` | `arcadekit/game`: `Game.PlayerInputs`, `Game.soloInput` ("Several players") |
  | `GameSimulation` | Gone: declare the game's rules with `Game.Simulation` ("The rules"). `create` takes `(config, { seed, report })`, `step` takes `(state, input, { dt, step, report })`, an event is a `Game.Event` class reported with `report` where there was `drainEvents`, and `sample` names its event and takes `every: "100 millis"` where there was `everyMs: 100` |
  | `GameLoop` | Gone from the entries: step a declared simulation with `Game.Loop` ("How a frame becomes steps"). `new Game.Loop(MyGame)` has the same `start`, `frame`, `setPaused`, `stop`, `subscribe`, `state` and `stepIndex`. It has no `modify`: send a `Game.Command`, which the loop applies at the start of the next step ("Refusing a command") |

  | From `arcadekit/runtime/browser` | Now |
  | --- | --- |
  | `AttachError`, `GameCrashed` | `arcadekit/game/browser`: `Game.AttachError`, `Game.GameCrashed`. The classes and their tags are the same, so an app's `Effect.catchTag("GameCrashed", ...)` and its `onError` are unchanged |
  | `FrameSource`, `animationFrames` | `arcadekit/game/browser`: `Game.FrameSource`, `Game.animationFrames` |
  | `GameView` | `arcadekit/game/browser`: `Game.View` |
  | `combineViews` | `arcadekit/game/browser`: `Game.combineViews` |
  | `StepInput`, `InputSource` | `arcadekit/game/browser`: `Game.StepInput`, `Game.InputSource` |
  | `GameDefinition`, `GamePresentation` | Gone: declare the game's browser half with `Game.Engine` ("In the browser"). `createView` is `view` and `createInput` is `input`, each given what the engine `uses` |
  | `makeGameEngine`, `GameEngine` | Gone: `class MyEngine extends Game.Engine("MyEngine", { simulation, uses, view, input }) {}`. The class is the engine service's key and `MyEngine.layer` provides it, so a genre writes no service and no layer for it; `Game.EngineOf<typeof MyGame>` names the running engine. `engine.modify` is `engine.send(command)`, which waits for the rules' answer. A send needs a step: it waits while the engine is paused or not attached, where `modify` changed the state at once, so a screen that paused the engine before a pick now leaves the run stepping and freezes the game in its rules ("Refusing a command"). `engine.start(config)` takes a seed too (`{ seed }`), and `makeGameEngine`'s `frames` option is the `Game.Frames` reference |
  | `attachError` | Gone: `new Game.AttachError({ message, cause })` |
  | `GameSimulation` | Gone: see above |
  | `makeEngineLoader`, `EngineLoader`, `LoadedEngine`, `engineOf` | Gone: an `Asset` and a `Game.Engine` (the loaders' own entry in this changelog has each) |

  | From `arcadekit/runtime/testing` | Now |
  | --- | --- |
  | `manualFrames` | `arcadekit/game/testing` ("Testing an engine"). Provide it as the engine's frames: `Layer.succeed(Game.Frames, manualFrames())` |

  A game that imported only the names in the first rows of each table changes its import paths and nothing else. Before:

  ```ts
  import type { StepInput } from "arcadekit/runtime";
  import { combineViews } from "arcadekit/runtime/browser";
  import type { GameView, InputSource } from "arcadekit/runtime/browser";
  import { manualFrames } from "arcadekit/runtime/testing";
  ```

  After, as `Game.StepInput`, `Game.combineViews`, `Game.View` and `Game.InputSource`:

  ```ts
  import * as Game from "arcadekit/game/browser";
  import { manualFrames } from "arcadekit/game/testing";
  ```

  A game still built with `makeGameEngine` declares itself, as `@arcadekit/push-puzzle` does in [`src/simulation.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/simulation.ts) and [`src/browser/game.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/browser/game.ts):

  ```ts
  // Before
  const simulation: GameSimulation<Config, State, Input, Event> = {
    create: (config, seed) => createState(config, seed),
    step: (state, input, dt) => stepState(state, input, dt),
    drainEvents: (state) => state.events.drain(),
    sample: { everyMs: 100, read: (state) => ({ type: "hud", hp: state.hp }) },
  };
  const engine = makeGameEngine({ ...simulation, createInput, createView });
  const pick = (index: number) =>
    engine.modify((state) => choose(state, index));

  // After
  export class Hud extends Game.Event("Hud", { hp: Schema.Number }) {}
  export class Choose extends Game.Command("Choose", { index: Schema.Int }) {}

  export class MyGame extends Game.Simulation("MyGame", {
    input: Input,
    commands: [Choose],
    create: (config: Config, { seed }) => createState(config, seed),
    step: (state, input, { dt }) => {
      stepState(state, input, dt);
    },
    apply: {
      Choose: (state, { index }) => {
        choose(state, index);
      },
    },
    sample: {
      event: Hud,
      every: "100 millis",
      read: (state) => ({ hp: state.hp }),
    },
  }) {}

  export class MyEngine extends Game.Engine("MyEngine", {
    simulation: MyGame,
    view: createView,
    input: createInput,
  }) {}

  // The engine is the service `MyEngine`, provided by MyEngine.layer.
  const pick = (index: number) =>
    Effect.gen(function* () {
      const engine = yield* MyEngine;
      yield* engine.send(new Choose({ index }));
    });
  ```

  **Unchanged**

  - A run's step order, its fixed clock, the 0.25 s clamp and the five steps a frame may run: `Game.Loop` steps on the same kernel, whose stepping lines moved into `arcadekit/game` as they were. No entry exports it.
  - `arcadekit/foldkit`'s `engineEntry` and `gameViewport`, `arcadekit/net`'s lockstep session and its wire, and the `Coop` declaration.

## 0.4.1

### Patch Changes

- [#71](https://github.com/lucasthevenet/arcadekit/pull/71) [`214b8c6`](https://github.com/lucasthevenet/arcadekit/commit/214b8c6d1f2660ada68a91a4f38a3ae35f0db621) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The package's `homepage` is [arcadekit.dev](https://arcadekit.dev), the docs site, which has a page for each entry. The README links to it. No code changed.

## 0.4.0

### Minor Changes

- [#69](https://github.com/lucasthevenet/arcadekit/pull/69) [`1758082`](https://github.com/lucasthevenet/arcadekit/commit/1758082f621e4a7145b5e90c6844dd94fedaa5e1) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit owns the Co-op client: one player's side of a co-op game, from the lobby to the run. It was the survivors demo's own code, which every game with co-op had to copy. A game now supplies its genre half, and its app keeps the lobby screens (ADR-0019).

  ```ts
  import { browserCoopRooms, makeCoopClient } from "arcadekit/net/browser";

  const play = Effect.gen(function* () {
    const coop = yield* makeCoopClient(myCoopGame, {
      rooms: browserCoopRooms({ url: "wss://game.example.com", iceServers }),
    });
    yield* coop.listen((event) => {
      // lobby, started, run, waiting, failed
    });
    yield* coop.host("knight");
    return yield* coop.attach(element);
  }).pipe(Effect.scoped);
  ```

  **`arcadekit/net`** (DOM-free) gains a Co-op game's lockstep parts:

  - `CoopRules<G>` and the `CoopTypes` bag `G` a game declares once (`Config`, `State`, `Event`, `PlayerInput`, `Answer`, `LocalEvent`, `Content`). The rules hold the `simulation`, whose step input is `PlayerInputs<PlayerInput>`, with `codec`, `hash`, `picks`, `config`, the optional `maxPlayers` and `lockstep: { inputDelay, hashEvery }` (defaults `DEFAULT_ROOM_SIZE`, 4 and 60), and what the local player's seat needs: `localInput`, `settled`, `choosing`, `localEvent` and `runEnded`. The client combines the players' inputs with `combinePlayerInputs`, so the rules have no `combine`.

  The lobby's messages and state, and the content hash peers compare at the start, are behind the client, not exports. Content must be JSON data, and its hash is sensitive to key order.

  **`arcadekit/net/browser`** gains the client:

  - `makeCoopClient(game, { rooms, ticker?, frames? })`, a scoped Effect, and its `CoopClient`: `host(pick)`, `join(code, pick)`, `choose(pick)`, `start`, `answer(answer)`, `setPaused(paused)`, `leave`, `attach(element)`, `listen(onEvent)` and `debug()`. The commands return at once, except `leave`, which returns once the seat has closed; a new seat says nothing until every seat before it has. `attach` and `listen` have the shapes of `arcadekit/foldkit`'s `AttachableEngine`, so `engineEntry` takes the client as it is. `attach` fails with `AttachError`, `GameCrashed` or the game's `LoadError`, and a failed attach leaves the seat.
  - `CoopGame<G, LoadError>`: the rules plus `content`, an Effect run once per host or join, and `presentation`, an Effect run once per attach that gives a `CoopPresentation` (`createInput`, `createView`). The view gets a live `LocalPlayer` (`slot`, `names`) and reads it when it renders.
  - `CoopEvent`: `lobby` (role, code, self, `LobbyPlayer`s, `maxPlayers`, `canStart`), `started` (slot, names), `run` (what the game's `localEvent` makes of a run's event), `waiting` (who stepping waits on, who is choosing) and `failed`, with the kit's English `message` and a `CoopFailure` reason an app can re-word: `content`, `room`, `leftOut`, `unknownPick`, `tooManyPlayers`, `hostLost`, `desync`, `contentMismatch`, `removed`, `badInput` or `bug`. Player names ("Host", "Guest 2") are the kit's too.
  - `CoopRooms` and `browserCoopRooms({ url, iceServers })`. The kit reads no environment: the app passes the signalling worker's URL and its STUN servers.
  - `CoopClientOptions` and `CoopDebug` are the types of the client's options and of `debug()`. Unless given a `ticker`, the client times each run in a dedicated Web Worker, which a hidden tab doesn't throttle.

  **New entry `arcadekit/net/testing`**, for tests only: `fakeCoopRooms()` (the signalling worker and WebRTC in memory, with `drop(peer)`, `closeHost()`, its `code` and a `log`; `FAKE_JOIN_CODE` is the code), `manualTicker()` (a ticker the test drives) and `testCoopGame(options?)`, a small Co-op game with lobby picks, an offer to answer, a pause and an end. Its parts are exported too, so a test can vary the game: `testCoopRules`, `testSimulation`, `testPresentation`, `testContent`, `hashTestState` and the `Test*` types. It needs only `effect`. Frames come from `manualFrames()` in `arcadekit/runtime/testing`.

  Behaviour is ADR-0012's, as the demo's client had it: no late join, the drop rule, a host star. Three things are new for a game that used the demo's client as its model:

  - At the start the host replaces an empty or unknown lobby pick with the game's first, and a guest that receives a pick its own content lacks fails with `unknownPick` instead of starting.
  - The game's `maxPlayers` bounds a run, not the room's size. The host starts the first `maxPlayers` players in lobby order, so a guest that links as the host starts can be left out (`leftOut`), and a guest refuses a start with more players than its own game takes (`tooManyPlayers`: only a host on another build sends one).
  - The lobby's messages on the wire are `pick`, `lobby` (players with `pick`) and `start` (players, picks). Peers on different builds can't share a lobby.

  Per-step and per-frame code is plain, with no Effect: the game's `settled`, `choosing` and the function `localInput` returns run between steps and must not allocate. The package has eighteen entries. `net/testing` is in the `net` group, so it adds no arrow between entries.

  Nothing breaks for the existing entries: every change is a new export or a new entry, and no export was removed or changed.

- [#68](https://github.com/lucasthevenet/arcadekit/pull/68) [`5e672c3`](https://github.com/lucasthevenet/arcadekit/commit/5e672c3f60c754f7c0c12562beb9c25ff32c1fc6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit owns the step input of a game with several players, and how lockstep fills it. Each game used to carry its own copy of the same type and two helpers.

  - `arcadekit/runtime` exports `PlayerInputs<PlayerInput>`: `players[slot]` is one player's input for the step, or null when that player has none, and `leaving` lists the slots that leave the run at this step, in ascending order. A slot is a player's place in the run's player order, host first in lockstep. A game uses it as its `GameSimulation`'s `Input`.
  - `arcadekit/runtime` exports `soloInput(source)`: a `StepInput<PlayerInputs<PlayerInput>>` from one player's `StepInput<PlayerInput>`, at slot 0, with nobody leaving. `endStep` and `endFrame` reach the source.
  - `arcadekit/net` exports `combinePlayerInputs(players)`: a lockstep session's `combine` for such a game. `players` is the run's player order, host first; it returns a function from a `ConfirmedStep<PlayerInput>` to `PlayerInputs<PlayerInput>`.

  All three are plain code, with no Effect. `soloInput` and `combinePlayerInputs` refill one object, so a step allocates nothing.

  Nothing breaks for the existing entries: these are new exports, no export changed, and it adds no arrow between entries (`net` already imports `runtime`).

- [#66](https://github.com/lucasthevenet/arcadekit/pull/66) [`93c0d67`](https://github.com/lucasthevenet/arcadekit/commit/93c0d67d44d4914c9294663b299522f5be4dc7e9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - New entry `arcadekit/net/worker`: the signalling worker, for Cloudflare. It was the survivors demo's own code, which every game with co-op had to copy. An app's Worker is now a few lines:

  ```ts
  import { signallingRoom, signallingWorker } from "arcadekit/net/worker";

  export class SignallingRoom extends signallingRoom({ roomSize: 4 }) {}

  export default signallingWorker({ rooms: "ROOMS", assets: "ASSETS" });
  ```

  - `signallingRoom(options?)` returns the Durable Object class of one join code's room, for the app to extend and export under the name its binding declares. `signallingWorker({ rooms, assets })` returns the Worker's `fetch` handler, given the names of the app's two bindings. The app still declares its Worker, bindings and routes itself (the demo's `alchemy.run.ts`).
  - The room size is a setting of the worker: `roomSize`, a whole number from 2 to `MAX_ROOM_SIZE` (16), and `DEFAULT_ROOM_SIZE` (4) if left out. `signallingRoom` throws a `RangeError` for any other size when the Worker's module loads; it never changes it to another one. A lockstep run's own limit on the wire is separate and unchanged.
  - The worker behaves as the demo's did (ADR-0012). Its Effect service key is `arcadekit/net/worker/RoomConnections`.
  - `@cloudflare/workers-types` (^5) is a new optional peer, for this entry's types. The entry imports `cloudflare:workers`, so it runs only on Cloudflare; typecheck a Worker that uses it with Workers types, no DOM `lib`, and `skipLibCheck` (Effect's own type files name DOM types).
  - It adds no arrow between entries: the worker is in the `net` group, which lint checks as one entry, and imports only `net/signalling`'s protocol. Within the group, only the worker's own typecheck (Workers types, no DOM) keeps it apart from `arcadekit/net/browser`.

  **Breaking:**

  - `arcadekit/net/signalling` exports `DEFAULT_ROOM_SIZE` (4) and `MAX_ROOM_SIZE` (16) in place of `MAX_PLAYERS` (4). Use `DEFAULT_ROOM_SIZE` where you used `MAX_PLAYERS`, unless your worker sets another room size.
  - `parseServerMessage` accepts a `welcome` that lists up to `MAX_ROOM_SIZE - 1` peers (it was 3). The bound follows the renamed constant: the worker's `welcome` still lists at most the host, at any room size.

  No other entry changes.

## 0.3.0

### Minor Changes

- [#64](https://github.com/lucasthevenet/arcadekit/pull/64) [`f426e1a`](https://github.com/lucasthevenet/arcadekit/commit/f426e1ae6c295cb71df49953fa168b6e88deba32) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit is one package. `arcadekit` replaces the nine `@arcadekit/*` packages (`core`, `input`, `content`, `save`, `audio`, `render-three`, `runtime`, `net`, `foldkit`), which get no further release (ADR-0018).

  **Breaking:**

  - Replace the `@arcadekit/*` dependencies with `arcadekit`, and change each import from `@arcadekit/<entry>` to `arcadekit/<entry>`: `@arcadekit/runtime/browser` is `arcadekit/runtime/browser`. The sixteen entries and what each exports are unchanged. The package has no root export.
  - `effect` is the one required peer dependency. `three`, `@types/three`, `foldkit` and `@effect/platform-browser` are optional peers: install the ones the entries you import need.
  - The Effect service keys follow the name: `@arcadekit/audio/Audio` is `arcadekit/audio/Audio`, and `@arcadekit/net/PeerConnector` is `arcadekit/net/PeerConnector`.

## 0.2.3

### Patch Changes

- [#62](https://github.com/lucasthevenet/arcadekit/pull/62) [`ec25311`](https://github.com/lucasthevenet/arcadekit/commit/ec25311c214f6a9fd367a73565b62d10b30217bb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Stage.dispose()` releases its WebGL context (`forceContextLoss`). It used to leave the context alive until the canvas was collected, so a game that makes stages one after another (a view per attach) piled them up. Chrome keeps 16 a page and then kills the oldest, which can be a live stage's, and a page that keeps losing them can be refused new ones ("Error creating WebGL context").

## 0.2.2

### Patch Changes

- [#60](https://github.com/lucasthevenet/arcadekit/pull/60) [`5558bd9`](https://github.com/lucasthevenet/arcadekit/commit/5558bd93cfc12f3e4ebbb76d33e224b6b6b6035e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` drags and swipes again on iPhone Safari. It has no pointer lock and leaves `document.pointerLockElement` undefined, which the check for a locked pointer read as locked, so every press was ignored.

## 0.2.1

### Patch Changes

- [#58](https://github.com/lucasthevenet/arcadekit/pull/58) [`9e2651a`](https://github.com/lucasthevenet/arcadekit/commit/9e2651a50ea9de9c41e0f94c96adcc826430d082) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` ignores pointer presses while the document has a pointer lock, such as a game's mouse look on the same surface. It used to call `setPointerCapture`, which throws `InvalidStateError` while the pointer is locked, so every click during mouse look threw from its listener. A locked pointer stays put on screen, so it can't drag or swipe anyway; drags and swipes work again once the lock is released.

## 0.2.0

### Minor Changes

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The mixer keeps its decoded files in Effect's `Cache`, so the library no longer runs an Effect of its own to share a decode. `load` behaves as before: a file is decoded once, even when two loads of it overlap, and a file that failed is tried again by the next load.

  Breaking:

  - `makeAudioMixer(options)` returns `Effect<AudioMixer>` (was `AudioMixer`). Yield it inside your program, or run it where your program starts (`Effect.runSync(makeAudioMixer(options))` in a test).
  - `makeBrowserAudio` in `@arcadekit/audio/browser` is `Effect<AudioMixer, never, Scope>` (was a function returning `{ audio, dispose }`). Closing its scope does what `dispose` did: it removes its listeners, stops its sounds and closes the AudioContext. `BrowserAudioLayer` is unchanged.

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `GameEngine.attach` now fails with a typed `AttachError` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`) when `createView` or `createInput` throws, such as Three.js finding no WebGL, instead of dying. Its new type, `(element) => Effect<never, AttachError | GameCrashed>`, is in the frame loop entry. Nothing is left attached: a view made before `createInput` threw is disposed, and a throwing `dispose` still disposes the view and lets the engine attach again. `makeEngineLoader` now frees the assets of a load whose `game` throws.

  `engineEntry` hands an attach failure to `onError`, so the app gets a Message instead of a blank viewport. `EngineEntryConfig` takes a sixth type parameter, `A`, for what `attach` fails with, and `onError` receives `E | A`.

  `AudioSystem.load` now decodes a file once when two loads of it overlap.

  Breaking:

  - `engineEntry` with a `GameEngine` (or `engineOf(loader)`) now requires `onError`, which also receives `AttachError`. An entry for a plain `GameEngine` that had no `onError` must add one.
  - `EngineEntryConfig<Model, Message, Event, R, E>` is now `EngineEntryConfig<Model, Message, Event, R, E, A>`; `engine` is `Effect<AttachableEngine<Event, A>, E, R>`.

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The browser frame loop is an Effect now. `GameEngine.attach(element)` makes the view and the input source, then runs the frame loop itself for as long as it stays attached: each frame waits for the next animation frame, steps the run, then draws, all in one go. A frame whose step, render or event listener throws is the last one: the run ends, the loop asks for no more frames, the view and input source are disposed, and `attach` fails with the new `GameCrashed` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`). Before, the loop kept running after a throw and nothing on the Effect side was told. The first frame no longer steps by a negative time when `requestAnimationFrame`'s time is before attach.

  `engineEntry` runs `attach` instead of waiting forever after it, so a crash reaches `onError` as a Message, sent once, like a failed attach.

  Breaking:

  - `GameEngine.attach` is `(element) => Effect<never, AttachError | GameCrashed>` (was `Effect<void, never, Scope>`). It runs until interrupted instead of returning once attached, and it needs no `Scope`. Interrupt it to detach. It fails with `AttachError` when `createView` or `createInput` throws, and with `GameCrashed` when a frame throws. It never succeeds, so run it last: start the run, then `return yield* engine.attach(element)`. Its failures reach only what waits on it: a forked `attach` that nothing joins (`Effect.forkScoped(engine.attach(element))` alone) loses them silently, so join its fiber (`Fiber.join`) or race the rest of the program against it (`Effect.raceFirst(rest, engine.attach(element))`).
  - A crash ends the run, as `stop` does: attached again, the engine draws no run until the app starts a new one. Before, the run stayed live after a throw, and the next frame ran the step that threw again.
  - `AttachableEngine<Event, E>.attach` is `(element) => Effect<never, E>` (was `Effect<void, E, Scope>`): it runs until interrupted, and fails with `E` if it can't attach or stops on its own. An engine that draws on its own timer ends its `attach` with `Effect.never`, scoped.
  - `onError` in `engineEntry` for a `GameEngine` (or `engineOf(loader)`) also receives `GameCrashed`.
  - `GameDriver` is removed from `@arcadekit/runtime/browser`. Use `makeGameEngine` to step and draw in the browser, or `GameLoop` to step without drawing.

- [#55](https://github.com/lucasthevenet/arcadekit/pull/55) [`f7a8e30`](https://github.com/lucasthevenet/arcadekit/commit/f7a8e3080caba32b1c7f0662d752830881db3501) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The browser's signalling client is an Effect program. `hostRoom(options)` and `joinRoom(options, code)` are scoped Effects that succeed once the signalling server welcomes the peer, so the room's `code` and `self` are always known. The scope owns the socket until the start, and every peer connection and link after it: closing it is leaving, and a room that fails has already closed what it opened. `room.events` is a `Stream` of what happens after the welcome, which ends with `started` and fails with the room's `RoomError`; events wait until they are read, and leaving interrupts a reader that is still reading. `browserRoomLayer(rtc)` provides what a room needs in a browser: the new `PeerConnector` service (`rtcPeerConnector`, over WebRTC) and `Socket.WebSocketConstructor` from `effect/socket`. Tests provide fakes of both and drive the timeouts with a `TestClock`. Also new: `PeerConnectorApi`, `PeerLinkOptions`, `PeerConnectionLike`, `IceCandidateLike`, `DataChannelLike` and `RoomServices` (`PeerConnector | Socket.WebSocketConstructor`).

  Fixes:

  - A room whose socket opens but whose welcome never comes fails with `no-welcome` after `welcomeTimeout` (10 seconds by default), instead of connecting forever.
  - A server message the client can't read fails the room with `bad-server-message` (a server on another version of the protocol), instead of being dropped.
  - A data channel that can't be made no longer leaks its `RTCPeerConnection`: each part of a link has its own release in the link's scope.
  - A connection that fails after its link opened now ends the link (`link.closed`). Before the start, a host then drops that guest, and a guest's room fails.
  - `TextChannel.onClose` on a channel that has already closed calls its handler at once, once.

  Breaking:

  - `hostRoom` and `joinRoom` return `Effect<SignallingRoom, RoomError, Scope | PeerConnector | Socket.WebSocketConstructor>` (were plain functions returning a room at once). They take `RoomOptions` (`url`, `openTimeout`, `welcomeTimeout`), which replaces `SignallingOptions`: `rtc`, `connectPeer` and `openSocket` are gone. Provide `browserRoomLayer(rtc)` instead, or fakes of its two services.
  - `SignallingRoom` lost `status`, `subscribe` and `close`. It gained `events: Stream<RoomEvent, RoomError>`, and `start` is now `Effect<void>` (was `() => void`). `code` and `self` are `string` (were `string | undefined`). Close the room's scope to leave.
  - `RoomEvent` lost `welcome` (the acquire succeeds instead) and `failed` (the room fails with a `RoomError` instead). `RoomStatus`, `SignallingSocket` and `SignallingSocketHandlers` are removed.
  - `RoomFailure` gained `no-welcome` and `bad-server-message`. Failures are `RoomError` (with `reason`, `message` and the socket's `cause`), exported with the new `PeerLinkError`.
  - The `ConnectPeer` seam (`ConnectPeer`, `ConnectPeerOptions`, `PeerConnecting`) became the `PeerConnector` service, whose `connect(options)` is `Effect<PeerLink, PeerLinkError, Scope>` and reads the peer's signals from a `Queue`. The socket seam became `Socket.WebSocketConstructor`.
  - `PeerLink.close` is removed: the scope `connect` ran in owns the link. `PeerLink.closed` is new, an `Effect<void>` that succeeds once the link has closed: a channel closed, the connection failed, or the scope closed.
  - `RtcOptions.timeoutMs` became `openTimeout` (a `Duration.Input`, still 20 seconds by default). `RtcOptions.makeConnection` is new, for tests.
  - `TextChannel.onClose` now fires on a channel that has already closed, at once, inside the `onClose` call.

  Nothing else changes: `linksTransport`, the signalling protocol and the lockstep session are as they were.

- [#53](https://github.com/lucasthevenet/arcadekit/pull/53) [`f1942ba`](https://github.com/lucasthevenet/arcadekit/commit/f1942ba33d3c3bd91cb531c9d8686d7f88f0a66f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Lockstep sessions have an Effect shell. `hostLockstepScoped(options)` and `joinLockstepScoped(options)` take the same options as `hostLockstep` and `joinLockstep` and return `Effect<ScopedLockstepSession, never, Scope>`: closing the scope stops the session listening to its transport, and the session's time is Effect's `Clock` (its monotonic time, so a `TestClock` drives it in tests). `session.run(ticker?)` ticks it until it stops, then fails with its `LockstepError`, instead of the caller polling `session.error` after each tick; interrupting it stops the ticking. After a desync it fails a second after the stop, its ticks resending the desync until then (the transport may lose it), so every peer stops with the same desync. A run left going after its scope closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock. A `Ticker` (exported) is `(onTick) => stop`, such as a dedicated worker's timer; each tick is a plain call, done before `onTick` returns, with no Effect run per tick, and the run ends once the `onTick` it stops in has returned. `session.listen(onEvent)` hears the run's events while its scope is open, each call with a listener of its own.

  `hostLockstep` no longer leaks its transport listener when starting throws (a simulation whose `create` throws, an input source whose `read` throws): it stops listening, then rethrows.

  Nothing breaks: the plain sessions, their options and the wire format are unchanged.

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Lockstep sessions check what arrives on the wire, so a peer on other code, or a forged message, can no longer freeze a run.

  - Every lockstep message is decoded with an Effect Schema (integer steps, at most 64 inputs, steps or hashes per message, at most 16 players). A message that doesn't decode is dropped, and the rest of what arrived is still handled.
  - The host decodes each peer's input when it arrives and keeps at most 64 steps of it ahead of the last confirmed step. A peer whose input doesn't decode is removed from the run; a peer that can't decode a step from the host stops with a `badInput` error.

  Breaking:

  - `InputCodec.decode` returns `Result<Input, string>` (from `effect`'s `Result`) instead of returning the input or throwing. `jsonCodec` and `schemaCodec` follow; a custom codec must return `Result.succeed(input)` or `Result.fail(why)`.
  - `StopReason` has a new `badInput` kind (`player`, `step`, `issue`), and the `removed` kind has a `why` (`"stalled"` or `"badInput"`, exported as `RemovedWhy`). A `switch` over `reason.kind` needs the new case.
  - `hostLockstep` throws a `RangeError` for more than 16 players.
  - The wire format changed: the `removed` message carries `why`, and senders send at most 64 hashes per message. Peers on this version and an older one can't play together.

- [#54](https://github.com/lucasthevenet/arcadekit/pull/54) [`7c2b526`](https://github.com/lucasthevenet/arcadekit/commit/7c2b526ac444df4606e7afca12dc059b32c119a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The signalling protocol (`@arcadekit/net/signalling`) is now Effect Schemas, and its parsers bound what they read.

  - Each message is a Schema, exported under its type's name: `PeerId`, `Signal`, `ClientMessage`, `ServerMessage` and `ErrorReason` (a `Schema.Literals`, so `ErrorReason.literals` lists every reason), plus a new `JoinCode`. The types are the Schemas' types, with the same shapes and the same wire format as before. `parseClientMessage` and `parseServerMessage` still return the message or `undefined`.
  - New `MAX_PEER_ID_LENGTH` (32) and `MAX_TOKEN_LENGTH` (256) are the bounds of a peer id and of an `sdpMid` or ICE username fragment, beside `MAX_MESSAGE_LENGTH` (16 KB) and `MAX_PLAYERS`.
  - `normalizeJoinCode` checks a code with `JoinCode`.

  Breaking:

  - `@arcadekit/net/signalling` now imports `effect` at runtime (it was dependency-free). `effect` is already the package's peer dependency. Its Schemas are built when it loads, so importing anything from it, even a constant or a join-code helper, bundles Effect Schema: about 77 KB minified and 25 KB gzipped (a bundler that inlines constants may still leave it out for a numeric one such as `MAX_PLAYERS`).
  - The parsers refuse messages they used to accept: a peer id over `MAX_PEER_ID_LENGTH` characters, an `sdpMid` or ICE username fragment over `MAX_TOKEN_LENGTH`, an SDP or candidate line over `MAX_MESSAGE_LENGTH`, an `sdpMLineIndex` outside 0 to 65535, and a `welcome` whose `code` isn't a join code or that lists more than `MAX_PLAYERS - 1` peers. A signalling server must send messages within these bounds: `hostRoom` and `joinRoom` ignore a server message they can't decode, so a `welcome` outside them leaves the room `connecting` with no error.

### Patch Changes

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The host no longer ends a lockstep run on a peer's word. Before, any peer could stop the run for everyone by sending a desync message with any step and hashes. Now a peer's desync claim counts only as that peer's own hash for the step: the run stops only when the host's own hash for that step differs. A claim about the host's hash, or one with no hash for the sender, is ignored. The host also ignores a peer's hash for a step that isn't a hash step or that no peer can have reached yet, so those don't pile up.

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.
