# A game is declared

A game is written as declarations: each part of it is one named class, such as `class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}`. The class is the part's type, its name in a trace and an error, and, for what an app provides, the key of its service. A declaration runs nothing by itself: a host runs it. Together, a genre's declarations are its domain, written as [domain-driven design](domain-driven-design.md) writes one.

## The declarations

| Declaration | From | What it declares | Guide |
| --- | --- | --- | --- |
| `Game.Event` | `arcadekit/game` | What a run reports: a rare fact for the app, or the sample a HUD reads | [The simulation](../guides/simulation.md) |
| `Game.Command` | `arcadekit/game` | What a player decides outside what their devices hold, such as an upgrade to pick | [Commands and refusals](../guides/commands.md) |
| `Game.Rejection` | `arcadekit/game` | Why the rules may refuse a command | [Commands and refusals](../guides/commands.md) |
| `Game.Simulation` | `arcadekit/game` | The rules: what a run's state is made from, how a step advances it, what it reports and which commands it takes. No DOM | [The simulation](../guides/simulation.md) |
| `Game.Engine` | `arcadekit/game/browser` | A simulation with the view that draws it and the input source that reads its input | [The engine](../guides/engine.md) |
| `Content` | `arcadekit/content` | A game's content files, checked by a Schema | [Content and assets](../guides/content.md) |
| `Asset` | `arcadekit/content` | What the app loads once for a game, such as a sprite sheet | [Content and assets](../guides/content.md) |
| `Save` | `arcadekit/save` | A game's records, kept between sessions | [Saves and settings](../guides/saves.md) |
| `Setting` | `arcadekit/save` | One value kept apart from the save, such as the volume | [Saves and settings](../guides/saves.md) |
| `CueTable` | `arcadekit/audio` | A genre's sound cues, which the app gives its sounds | [Audio](../guides/audio.md) |
| `Coop` | `arcadekit/net/browser` | An engine played by several players, in lockstep from a lobby | [A Co-op game](../guides/coop.md) |

Every other module of a game is a namespace, as the kit's are: `Rng`, `EntityPool`, `InputController`.

## Hosts

| Host | What it runs | Where |
| --- | --- | --- |
| `Game.makeLoop(simulation)` | A simulation, one frame at a time, as its caller says ([Steps and frames](steps-and-frames.md)) | Anywhere: a replay, a server, a test |
| `Scenario.make(simulation)` | A simulation through a loop, checking what it reports and refuses ([Scenarios](../testing/scenarios.md)) | A test |
| An engine's `layer` | The engine service an app drives: `start`, `send`, `listen`, `attach` | The browser |
| `LockstepSession.host` and `join` | A simulation on every peer, stepped on every player's input ([Lockstep](lockstep.md)) | Anywhere with a transport |
| A `Coop`'s `layer` | One player's Co-op client: the lobby, the run and its drawing | The browser |
| The `layer` of a `Content`, an `Asset`, a `Save`, a `Setting` or a `CueTable` | The service that loads it, keeps it or gives it | The app |

## Two halves

A genre is written in two halves. Its rules, the events, commands, rejections, simulation and content, import nothing of the browser, so they run wherever a loop does: in a test in Node, in a replay, on a lockstep peer. Its engine, the view and the input source and what they are made from, is the half that needs a browser. The push-puzzle demo's genre has one public file for each: `src/push-puzzle/index.ts` and `src/push-puzzle/browser/index.ts`.

## Plain inside, Effect outside

The handlers inside a declaration, `create`, `step`, `apply`, `view` and `input`, are plain functions. A step runs inside a frame or a tick, finishes in the call that runs it, and gives the same bits everywhere ([Determinism](determinism.md)), and a view draws inside the frame the browser shows. What has a lifecycle is Effect: loading content and assets, an engine's attach, saves, connections.

A run changes only at a step: by its input, and by a command the loop applies at the start of the next step. A view reads the state and never changes it, and the app hears what a run reports as events.

[Making a game](../making-a-game.md) walks through a genre's declarations, from the rules to the app. The push-puzzle demo is the example to copy.
