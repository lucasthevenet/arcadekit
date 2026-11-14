# Domain-driven design

arcadekit is built for domain-driven design: a game's rules are its domain, written as a model in the game's own words and kept apart from the browser, the screens and the network. Every part of that model is a declaration, so it can be named before it is written, read by its name, and checked in a test with no browser. This page maps the building blocks of domain-driven design to the kit's, and says where the kit departs from them on purpose, and why.

## The domain is the rules

A game's domain is its rules: what a run is made of, what can happen in it, and what a player may decide. In the kit, that is a genre's DOM-free half, its events, commands, rejections, simulation and content ([Two halves](declarations.md#two-halves)). Everything else is around it: the engine that draws a run and reads the devices, the app's screens, the saves, the sound and the network.

The domain is named first. A game's events, commands and rejections are declarations that compile before any rule exists:

```ts
import * as Game from "arcadekit/game";
import { Schema } from "effect";

// A tower defence's domain, before any rule: what happens,
// what a player decides, and why the rules may say no.
class TowerBuilt extends Game.Event("TowerBuilt", {
  cell: Schema.Int,
  tower: Schema.String,
}) {}
class WaveCleared extends Game.Event("WaveCleared", { wave: Schema.Int }) {}

class NotEnoughGold extends Game.Rejection("NotEnoughGold", {
  needed: Schema.Int,
}) {}
class CellTaken extends Game.Rejection("CellTaken", { cell: Schema.Int }) {}

class BuildTower extends Game.Command(
  "BuildTower",
  { cell: Schema.Int, tower: Schema.String },
  { rejects: [NotEnoughGold, CellTaken] }
) {}
```

A scenario can then say what the rules must do, in those words, before the simulation is written ([Scenarios](../testing/scenarios.md)). Keep the game's words in a glossary beside its code, as the kit keeps its own in [`CONTEXT.md`](../../CONTEXT.md): one meaning for each word, in the code, the tests and the talk about them.

## The building blocks

| Domain-driven design | In arcadekit | Guide |
| --- | --- | --- |
| Ubiquitous language | The names of a game's declarations and modules, in the game's own words: `LevelSolved`, `ChooseUpgrade`, `OfferClosed`. An event is named as a fact, in the past tense; a command in the imperative; a rejection for what is wrong. | [Declarations](declarations.md) |
| Bounded context | A genre: its rules behind one public file, which the demos check with no DOM types, and its engine behind another, `browser/`. Each entry of the kit is a context of its own, which a genre uses by its import path. | [Two halves](declarations.md#two-halves) |
| Domain event | `Game.Event`: a fact a run reports, such as `LevelSolved`, heard by the app and by a scenario. | [The simulation](../guides/simulation.md) |
| Command | `Game.Command`: a decision a player sends, such as `ChooseUpgrade`, which the loop applies at the start of the next step. | [Commands and refusals](../guides/commands.md) |
| Invariant | `Game.Rejection`: why the rules refuse a command. Its handler decides first, then changes, so a refused command leaves the run as it was. | [Refusing a command](../guides/commands.md#refusing-a-command) |
| Aggregate | A run: one state object, made by `create` and changed only at a step, by its input and its commands. The step is the boundary inside which the rules hold. | [Steps and frames](steps-and-frames.md) |
| Factory | `create(config, { seed })`, which makes a run's state from its config and its seed. | [The simulation](../guides/simulation.md) |
| Repository | `Save`: a game's records by id, such as a level's best moves, kept between sessions. `Content`: the game's reference data, such as its levels, read once. | [Saves and settings](../guides/saves.md), [Content and assets](../guides/content.md) |
| Domain service | A plain function of the genre over the state, such as survivors' `Offer.roll` and `Hero.upgrade`. | [The simulation](../guides/simulation.md) |
| Application service | An engine's `start`, `send` and `listen`, and a Co-op client's. The app sends a command through one and handles a rejection by its tag. | [The engine](../guides/engine.md) |
| Anti-corruption layer | The input controller, which reads the devices as the game's named axes and buttons, so a step never sees a device. `Content`'s Schema, which checks each file as it loads and refuses one that doesn't fit. | [Input](../guides/input.md), [Content and assets](../guides/content.md) |
| Ports and adapters | Services, provided by Layers: frames, storage, content sources, transports. A test provides others: `ManualFrames` for frames, `KeyValueStore.layerMemory` for storage, `FakeCoopRooms` for the network. | [Testing an engine](../testing/engines.md), [Testing a Co-op game](../testing/coop.md) |

A run is also close to event sourcing: the same seed, config, inputs and commands give the same run ([Determinism](determinism.md)), so a replay is the log of them, and a test pins where it leads by its state hash. What is logged is the inputs and commands, not the events.

## Where the kit departs from it

A step runs sixty times a second unless its simulation declares another rate, on every peer, and gives the same bits on each ([Determinism](determinism.md)). A model of objects that guard their own fields doesn't fit that, so inside a step the kit is data-oriented, on purpose:

- **The state is open.** Every module of a game reads a run's state, and only the step and the commands' handlers write it. That is a convention: no aggregate root guards a field, and one part of a step writes another's, as survivors' contact damage writes a hero's health. The boundary is the step, which runs whole in the call that runs it, not a method of the state.
- **An entity is a slot.** Something a game has many of, such as an enemy, a bolt or a box, is a slot of an [entity pool](../guides/entity-pools.md), its fields in typed arrays, so a step allocates nothing per entity and a state hash walks the arrays. Its identity is its slot, or its id in a pool that gives ids.
- **A value object lives at the boundary.** Inside a step a position is two numbers, and a helper that gives two writes them into a `Point2` its caller owns. Every event, command, rejection and content file is a Schema, checked where it crosses into or out of the rules.
- **A sample is delivered as an event.** A simulation's `sample`, the HUD's read of the state, is declared with `Game.Event`, although it is a snapshot, not a fact. #121 proposes a declaration of its own.
- **An app may hold its genre's types.** The survivors demo's Model keeps `Hud`, `Offer.Choice` and `Hero.Summary` as its genre declares them, so it conforms to its genre rather than translating each event into words of its own. #123 asks which of the two ways the kit advises.

## Designing a game

Work from the domain out:

1. Name the game's words, in its glossary.
2. Declare its events, commands and rejections.
3. Write the scenarios its rules must pass.
4. Write the simulation, its `create`, `step` and `apply`, until they pass.
5. Declare its engine, then write its app.

[Making a game](../making-a-game.md) walks through a genre's declarations, and the push-puzzle demo is the example to copy.
