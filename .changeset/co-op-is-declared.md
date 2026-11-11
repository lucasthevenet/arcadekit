---
"arcadekit": minor
---

Co-op is a declaration: `Coop` (`arcadekit/net/browser`), made from the game's `Game.Engine` ([ADR-0021](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0021-co-op-is-declared-from-the-games-engine.md)). It replaces `CoopRules`, the `CoopTypes` bag, `CoopGame` and `makeCoopClient`. Nothing changed on the wire, in the lockstep session or in how a command travels.

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
const coop =
  yield *
  makeCoopClient(
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

const coop = yield * SurvivorsCoop;
// ...provided by SurvivorsCoop.layer, over
// browserCoopRoomsLayer(() => ({ url, iceServers }))
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

- **The client's own events are Schema classes**, told by `_tag`: `LobbyChanged`, `RunStarted`, `WaitingChanged` and `SeatFailed`, where `CoopEvent` had `type: "lobby" | "started" | "waiting" | "failed"`. An app puts one in a Message or its Model as it is. A run's event comes as `{ _tag: "RunEvent", event, local }`, where it was `{ type: "run", event }` with what the game's `localEvent` made.
- **The rooms are a service**, `CoopRooms`, with a Layer for each implementation: `browserCoopRoomsLayer(() => ({ url, iceServers }))`, which replaces `browserCoopRooms(options)` and reads its options when the layer is built, and `fakeCoopRooms().layer`. **The ticker is a reference**, `CoopTicker`, whose default is the worker's timer; a test provides `manualTicker().layer`. The frame clock is the engine's `Game.Frames`. `CoopClientOptions` is gone.

**`Game.Engine`** (`arcadekit/game/browser`)

- **`view` is told the local player**: `view(container, uses, { local })`, and it reads `local.slot` when it draws. The engine seats its one player at slot 0 and a `Coop` at the slot the lobby gave, so one view follows the local player in both. A view that takes two arguments compiles as before. `LocalPlayer` moved here from `arcadekit/net/browser`, with `ViewContext`.
- **`input` is unchanged**: the whole step's input, so an engine can still fill several slots.
- **`EngineClass` is typed by what the engine uses** (`EngineClass<Name, Config, State, Input, Event, Command, U, Refusals>`, where it had the error and the services of those as two parameters), and has the engine's `definition`, which a `Coop` reads.

**The Co-op client**

- `CoopClient<State, Event, Command, E, Refusals>` has five type parameters, as `Game.Engine`'s service has, where it had the type bag. Its methods are the same.
- On attach it makes the view first, then the input source, as an engine does. It made the input first.
- It calls nothing of the game's between steps but the local player's input source.

**`arcadekit/net/testing`**

- `fakeCoopRooms()` has a `layer`, and so has `manualTicker()`.
- The test game has no `testCoopRules`, `testCoopGame`, `TestCoop` bag or `TestLocalEvent` any more. `testCoopParts(options)` is the test game as plain parts and `testCoopClient(parts, { rooms, ticker?, frames? })` its Co-op client, for a test that replaces one of them; `testPresentation` makes `{ view, input }`. Its sample `Score` says who still owes the open offer an answer (`owes`). To test a `Coop` of your own, provide its layer with `fakeCoopRooms().layer`.

**Removed**

- `arcadekit/net`: `CoopRules`, `CoopTypes`.
- `arcadekit/net/browser`: `makeCoopClient`, `CoopGame`, `CoopPresentation`, `CoopClientOptions`, `browserCoopRooms`, the `CoopRooms` interface (now the service; its shape is `Rooms`), `LocalPlayer` (now in `arcadekit/game/browser`).
