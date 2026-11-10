---
status: proposed
---

# A game is declared, one named block per part, and Layers host it

The kit grew as primitives and factories. A genre wrote a `GameSimulation<Config, State, Input, Event>` object, spread it into a `GameDefinition`, declared its own engine service, its own content service and a layer maker for each, and handed an `EngineLoader` of five type parameters to an app, which reached the engine through `engineOf` and turned events into Messages with a `switch` on `type`. Each piece was sound, but a reader couldn't see a game in it: the glossary named the parts (event, sample, engine, content) and the code spelled each as an interface to satisfy. A run also changed in two ways, `modify` for one player and step input in lockstep, so survivors and grimbonk each wrote every player decision twice.

The kit was meant to be a framework that makes a game easy to write, read and learn from. The reference is [`@alchemy.run/domain`](https://alchemy.run/domain/), which models a business as named declarations (`class DepositMoney extends Domain.Command(...)`) that Layers host, with the rules as plain handlers inside.

## Decision

**Each part of a game is one named declaration.** A declaration is a class made by a builder, `class X extends Game.Y("X", { ... }) {}`. It carries its definition and its types, and runs nothing by itself.

- **`Game.Event`** (`arcadekit/game`): a rare fact a run reports, or its sample. A Schema class, so it goes into a Foldkit Message as it is.
- **`Game.Command`**: a decision a player makes outside what their device holds. Also a Schema class.
- **`Game.Simulation`**: the DOM-free rules. `input` (a Schema), `events`, `commands`, `create`, `step`, one `apply` handler per command, and `sample`.
- **`Game.Engine`** (`arcadekit/game/browser`): a simulation plus the browser half, `view` and `input`, and what they are made from (`uses`).
- **`Content`** and **`Asset`** (`arcadekit/content`): what a game is played with, and what it draws from, each loaded once.

**The rules stay plain.** `create`, `step` and `apply` are plain functions of the state, exactly as `decide` and `evolve` are in the reference. [ADR-0017](0017-effect-at-the-edges-plain-code-inside.md) holds: a step runs no Effect and reads no clock or random source of its own. What changes is the cost rule: a step may allocate where that makes the code clearer (an event is `new LevelSolved({ moves })`). Determinism is correctness, since replays and lockstep depend on it; allocation was performance, and clarity now comes first.

**Layers host a declaration.** `Game.Loop` steps a simulation anywhere and owns what every genre repeated: the event buffer, the command queue and the sample. `MyEngine.layer` provides the engine service, `MyContent.layer(source)` the content, `MyAsset.layer(load)` an asset. A class made by `Game.Engine`, `Content` or `Asset` is its service's key, and the type of its values is the service's identity, so `Layer.Layer<MyEngine>` reads as it does for a hand-written service.

**A run changes only at a step.** `engine.send(command)` queues a command, and the loop applies it at the start of the next step, before `step`, in the order sent. `modify` has no counterpart on the new engine. A replay or a lockstep peer that gets the same input and commands computes the same run, and a game writes each decision once.

**The engine exists before its assets.** `uses` names Effects the engine runs on each attach: a service, an asset's load, something the view and the input share. A failed load is `attach`'s failure, which `engineEntry`'s `onError` already reports. `EngineLoader`, `LoadedEngine` and `engineOf` have no counterpart: an app's loading screen runs the same `MyAsset.load` to show a failure and retry.

**A story checks the rules.** `arcadekit/game/story` runs given/step/send/reported stories through `Game.Loop`, so a rule is stated as an example and a passing story accounts for every event the run reported.

**It lands one game at a time.** The declarations are built on `GameLoop`, which is unchanged, so the step order is one. Push-puzzle and its demo are on them. Survivors and the Co-op client still use `GameSimulation`, `makeGameEngine`, `makeEngineLoader` and `CoopRules`, which stay until they have moved; none of them is kept as a compatibility layer after that.

## Considered Options

- **Effect inside the step**: systems as Effects, with the `Rng` and the event sink as services. The most uniform, and what "an Effect framework" means read literally. Rejected because the step's determinism would then rest on fiber scheduling and on every service implementation, and because the reference itself keeps its handlers plain: its elegance is in the declarations and the hosting, not in wrapping the rules.
- **An event-sourced state**: `decide` returns events and `evolve` folds them into an immutable state, as an aggregate does. Rejected for games: a step moves thousands of entities, and the log a game replays is already its input and commands (`state = fold(step, create(config, seed), inputs)`). Events here are facts for the outside, not the state's source.
- **Keep the factories and add sugar**: helpers that build the same `GameSimulation` and service boilerplate. Rejected: the vocabulary would still live in the glossary and not in the code.
- **The presentation as one Effect** that returns `{ view, input }`. Written first and dropped: TypeScript can't type the view's state through a nested generic call, so every `render` needed an annotation. `uses` with flat `view` and `input` handlers types them from the simulation, and lets the engine own their acquire and release.
- **`Story.then`**, as in the reference. Renamed `Story.reported`: an object with a `then` member is a thenable, which `unicorn/no-thenable` and `promise/valid-params` reject in a game's own tests too.

## Consequences

- **Three entries, one new arrow.** `arcadekit/game`, `arcadekit/game/browser` and `arcadekit/game/story` join the package ([ADR-0018](0018-one-package-with-entries.md)), which now has twenty-one. `game` may import `core` and `runtime`. When the last game has moved, `runtime`'s `GameLoop` moves into `game` and the `runtime` entry goes.
- **[ADR-0001](0001-kit-changes-need-two-genres.md) is set aside for this change.** It is the kit's author picking a shape, which that decision allows, and three games show the needs it answers: both genres repeat the service and event plumbing, and survivors and grimbonk both write each decision twice.
- **[ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md) keeps its split** (a DOM-free simulation, a browser presentation, one loop) under new names: `Game.Simulation`, `Game.Engine`'s `view` and `input`, `Game.Loop`.
- **[ADR-0015](0015-pixel-art-sprites-loaded-by-the-app.md) keeps its ownership rule**: the app owns the sheet, says where it comes from and frees it at its end. The engine loader that enforced it is replaced by the `Asset` the genre declares.
- **Lint.** `eslint/max-classes-per-file` is off, since a declaration is a class and a file of events has several. `vitest/expect-expect` counts `story` as an assertion. The determinism rules cover `game/loop.ts`, `simulation.ts`, `event.ts`, `command.ts` and `story.ts`.
- **The kit's own source can't write `class X extends Game.Event(...) {}` in an exported position**, because it is checked with `isolatedDeclarations`: it names the base first, as `Audio` does. Genre packages and apps aren't, and write it plainly.
- **Still to move**, in this order: survivors' single-player path (events, `ChooseUpgrade` as a command, `SurvivorsEngine`); then co-op, where a command rides a player's step input and replaces `Answer`, `settled` and the optional keys of `HeroInput`, and where the lockstep run becomes another host of the same simulation; then `save` and `audio` as declarations; then grimbonk on the published package.
