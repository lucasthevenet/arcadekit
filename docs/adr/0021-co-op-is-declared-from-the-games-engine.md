---
status: accepted
---

# Co-op is declared from the game's engine, and heard through one `match`

[ADR-0020](0020-a-game-is-declared.md) made a game a set of declarations, and [ADR-0019](0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md) had put co-op in the kit. Co-op was the last part still written the older way. A game supplied a `CoopRules` object typed by a bag of eight types written by hand (`CoopTypes`), then a `CoopGame` that added the content and a second presentation, built beside the engine's from the same views. `makeCoopClient(game, options)` ran it, and the app, which heard a single-player run through `Survivors.match`, heard a co-op run through a `switch` on `type` over a second vocabulary of events the game's `localEvent` had made. By then the lockstep run already stepped the declared simulation through `Game.Loop`, and a co-op player's decision was already a command on the wire, so what was left was the shape.

Three designs were written out and tried against the repository, and judged from three sides: a game author's, the lockstep protocol's and the migration's. One kept the game value and only gave it a builder. One mirrored the engine: a second browser declaration with its own `uses`, `view` and `input`. One made the engine serve both hosts, with its `input` switched by the simulation's input. This decision takes from each.

## Decision

**Co-op is one declaration, `Coop`, made from the game's engine** (`arcadekit/net/browser`).

```ts
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
```

The browser half of a game is declared once. The engine's simulation, what its view is made from (`uses`) and its view serve both hosts, and `Coop` names what only a shared run needs: one player's input source, the content every peer loads, the lobby picks and the config they make, the most players, the state hash and the events that end a run. The class is the key of the Co-op client, and its `layer` provides it. Every type comes from the engine's simulation and from `content`: the bag of types is gone, and a game's block needs no type argument, annotation or cast.

**A view is told which seat is the local player's.** `Game.Engine`'s `view` is `view(container, uses, { local })`, and it reads `local.slot` when it draws. The engine seats its one player at slot 0; the Co-op client at the slot the lobby gave. So one view function follows the local player in both, and the Co-op client never makes a view again.

**`Game.Engine`'s `input` keeps its meaning: the whole step's input.** A `Coop` names its own `input`, one player's source, made with what the engine uses so the two can share what an attach made (a camera's state). An engine can then still fill several slots itself, such as two players at one keyboard.

**A run is heard one way in both hosts.** The app turns everything a seat reports into Messages with `SurvivorsCoop.match({ ... })`, as it uses `Survivors.match` for the engine. The Co-op client's own events are `_tag` Schema classes, named in the past tense: `LobbyChanged`, `RunStarted`, `WaitingChanged`, `SeatFailed`. An app puts one in a Message or its Model as it is. The run's events reach every seat as every peer's rules reported them, and their cases stand under `run`, each given `{ local }`, so the app writes `hero === local.slot` where the single-player app writes slot 0. Because the run's cases have a place of their own, no tag of a game's is reserved.

**Which events end a run is data.** `ends: [RunEnded]` replaces the `runEnded` predicate. After one, the others leaving is no failure.

**Who is choosing is the game's to say.** A run that waits on a player to decide something says so in its sample: survivors' HUD has a `choosing` flag for each hero, beside `paused`. The Co-op client reports only who stepping waits on (`WaitingChanged`), which is lockstep's own, and calls nothing of the game's between steps but the local player's input source.

**The rooms are a service and the ticker a reference.** `CoopRooms` has a named Layer for each implementation: `browserCoopRoomsLayer`, over the signalling worker, and `fakeCoopRooms().layer` in `arcadekit/net/testing`. `CoopTicker` is a reference whose default is the worker's timer, and the frame clock is the engine's `Game.Frames`. So `SurvivorsCoop.layer` is a value, like `SurvivorsEngine.layer`.

**A `Coop` refuses what can't work when it is declared.** An engine whose simulation's `input` was not declared with `Game.PlayerInputs` is a type error on `engine` that names it, then a throw as the module loads; so are an `ends` entry the simulation doesn't report and a `maxPlayers` no room can have.

## What this supersedes in ADR-0019

- **"A game supplies its genre half, in two values."** There is one declaration. `CoopRules`, `CoopTypes`, `CoopGame`, `CoopPresentation` and `makeCoopClient` are gone, with no compatibility layer.
- **The game filtered what the local player hears** (`localEvent`), so that "is this my offer" stayed out of each app. It is now the app's, in the `match` it already writes for one player: the local player comes with the event to the place where a Message is made, and `update` still never asks.
- **The kit said who is choosing** (`choosing`, and the `choosing` list of the `waiting` event). The game's sample does.
- **The engine seam was deferred**: "single-player and co-op stay two paths in each game". They are one engine and two hosts. The reasons ADR-0019 gave against it have gone: `GamePresentation` and `GameView` are no longer what a game writes, and the events are not split into two streams, since `match` takes one stream with the run's events in their own place.

What ADR-0019 decided about the signalling worker, the lobby, the client's commands, the ordered stream of events, the kit's English text and the test helpers stands.

## Considered Options

- **Keep the game value and give it a builder** (the smallest move). The Co-op client's tests carry over nearly untouched and each app keeps its `switch`. Rejected as the end state: it left `localEvent`, `runEnded`, `choosing`, a `type`-tagged event union and `layer(options)` as they were, half old, and the browser half was still declared twice. Its order of work was kept: the lockstep host first, then commands on the wire, then the declaration, with the events, `choosing` and the rooms as steps of their own.
- **A second browser declaration that mirrors the engine**: `Coop` with its own `simulation`, `uses`, `view` and `input`. It ran end to end first and it refuses mistakes when declared, which this decision keeps. Rejected in that shape: a game wrote `uses` and `view` twice, `input` meant the step's input in one declaration and one player's in the other, and its flat `match` reserved four tags, refusing a game's own `RunStarted` from another declaration than the one that named it.
- **One engine whose `input` is the local player's**, wrapped by the engine for one player when the simulation's input is a `Game.PlayerInputs`. Nothing would be declared twice. Rejected: one field would have two behaviours chosen by a mark on a Schema, and an engine could no longer fill several slots, so two players at one keyboard could not play a game that also has co-op.
- **A filter in the declaration** (`hears: (event, { local }) => boolean`), so the game still decided what a seat hears. Rejected: it is a second place for a rule the app's `match` states anyway, and it can only drop an event, where an app often rewords one with the players' names.
- **`maxPlayers`, `hash` and the lobby picks in a DOM-free declaration of their own**, so a peer with no browser could read them. Not taken: what was DOM-free in the older rules has mostly dissolved into the simulation, and three one-line functions don't carry a declaration. They are on the class as plain functions (`SurvivorsCoop.definition`), which a test reads in Node.

## Consequences

- **A game's co-op is about ten lines**, and survivors' `coop.ts`, its bag of types, its second event vocabulary and `makeSurvivorsCoopGame` are gone. Its DOM-free co-op is its simulation: a pick and a pause are commands, checked by scenarios, and the peers are held to one another by its lockstep test.
- **The attach order is the engine's**: what the engine uses, the view, then the input source. The Co-op client made the input first.
- **An app says which events are the local player's**, in `match`. For survivors that is two comparisons. Grimbonk's "X left the run" notice moves from its genre to its app, which has the names.
- **Who is choosing shows up to one sample later** (100 ms for survivors) than when the kit read the state after every tick, and each co-op game's sample has to carry it.
- **The lobby's shape in an app's Model is the kit's event.** A field the kit adds reaches the app, as a field of the HUD does.
- **`EngineClass` is typed by what the engine uses** and keeps the engine's `definition`, which the `Coop` builder reads. A `Coop` is typed by its engine, so the two can't disagree about a state or a command.
- **The kit's own client tests run the client from plain parts** (`testCoopClient(testCoopParts())` in `arcadekit/net/testing`), since they build many variants of one game, and one test declares a `Coop` and plays it through its layer.
- **Still on the older contract**: nothing a game writes. The older engine, `GameSimulation` and the `runtime` entry are the kit's own to remove, at the end of the move ([ADR-0020](0020-a-game-is-declared.md)).
