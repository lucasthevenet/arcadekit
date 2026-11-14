---
name: game-modules
description: Game module shape. Use when adding, reshaping or naming a module of a genre package (`packages/push-puzzle`, `packages/survivors`) or a demo (`apps/*`), or writing its doc comments.
---

A game is shaped as the kit is, at a game's size: read the kit-modules and doc-comments skills, and take this as what differs. Whether code is Effect or plain is the effect-or-plain skill's question, everywhere. Push-puzzle (`packages/push-puzzle`) is the example to copy: [`world.ts`](../../../packages/push-puzzle/src/world.ts) for a run's state and step, [`level.ts`](../../../packages/push-puzzle/src/level.ts) for a module of a type and its constructor, [`browser/internal/board-sprites.ts`](../../../packages/push-puzzle/src/browser/internal/board-sprites.ts) for a view's drawing over a type with internal fields, [`events.ts`](../../../packages/push-puzzle/src/events.ts) and [`browser/engine.ts`](../../../packages/push-puzzle/src/browser/engine.ts) for declarations, and [`index.ts`](../../../packages/push-puzzle/src/index.ts) for a public file.

## Declarations and namespaces

- A declaration stays as the declarations skill writes it, `class PushPuzzle extends Game.Simulation("PushPuzzle", { ... }) {}`, in a file of declarations that belong together (`events.ts`, `simulation.ts`, `content.ts`, `browser/engine.ts`, `browser/sheet.ts`, `browser/cue-table.ts`), and the public file exports it bare under its name. A file of declarations exports nothing else.
- Every other module is a namespace. The public file says `export * as World from "./world"`, a caller writes `World.make(config)`, and the module's file is its name in kebab-case (`puzzle-content.ts` is `PuzzleContent`). A public file exports its declarations and its namespaces, and nothing else.
- A module only the package's own files call is in `internal/` (`src/browser/internal/controls.ts`), which no public file exports: push-puzzle's engine is made of its controls and its views, and an app names only the engine.
- A namespace is the glossary's word, and collides with no JavaScript or DOM global, no module of Effect, and no namespace of the kit a game imports beside it (`Content`, `Game`).
- A declaration's handler is its module's function by name (`create: World.make`, `step: World.step`, `input: Controls.make`), or written in place when it is a line (`version: (puzzle) => puzzle.turns`).
- Inside the package a module imports another as its namespace, values and types alike (`import * as World from "./world"`, `import type * as World from "../../world"`), so the package's code reads as a caller's; and a declaration by name (`import { LevelSolved } from "./events"`).

## Types

- A run's state, and any type a game writes as a literal, is a plain interface: no `TypeId`, no `Pipeable`, no `Inspectable` and no guard, since nothing outside the game recognises it. A game reads it, and its step writes it in place. So is every other type of a game's.
- The state's module is `World`, and its type has the genre's word for a run's state (`World.Puzzle`). Any other module's type is named after it (`Level.Level`, `BoardSprites.BoardSprites`, `PuzzleContent.PuzzleContent`).
- What a module's functions keep and no caller reads stays off the interface, in an internal type they cast to, as core's do (`Internal` in `board-sprites.ts`).
- A view and an input source are the kit's types, made by a module's `make`: `SpriteView.make(container, sheet)` gives a `Game.View<World.Puzzle>`, and `Controls.make(surface)` a `Game.InputSource<World.Input>`, each an object of closures. A game writes no class but its declarations.
- A Schema and its type share one name, each with its own doc comment: `export const Input = Schema.Struct(...)` (`schemas`), then `export type Input = typeof Input.Type` (`models`). So does a set of constants and its type (`Level.Tile`, `World.Change`).

## Functions

- `make` makes the module's type, and a function that reads text into it may be named for that (`Level.parse`). Nothing is named `create…`. A constructor handed a mistake throws an `Error`, or a `RangeError` for a number out of range, with a message that names it: `World.make` refuses a level the content lacks.
- An exported function takes what it acts on first, as `self`. A helper only its module calls names it for what it is (`puzzle`, `sprites`).
- A function is `dual` only where a caller would pipe a value that has `pipe`. A game's state has none, and its step and its views call its functions data-first, so push-puzzle has no `dual`.
- An exported constant is camelCase (`Level.characters`, `Art.tags`, `Controls.buttons`), and one that is a type as well PascalCase (`Level.Tile`). A constant only its module reads may be in capitals (`HISTORY_LAYOUT`).

## Doc comments

As the doc-comments skill says, with these differences:

- No `@since`: a genre package and a demo never release.
- An example imports from the package as the demo does (`@arcadekit/push-puzzle`, `@arcadekit/push-puzzle/browser`), beside `arcadekit/<entry>` and `effect`. Nothing compiles it, so before you finish, compile and run each one and check its `// =>` results.
- A game's declaration takes `@category declarations`.
- A module in `internal/` is documented as the kit's `internal/` modules are: a module comment, and a doc comment for each export that says what it is and, where there is more, how it behaves. No example and no `@category`, since no game imports it.

## Tests and lint

- Tests are in the package's `test/`, in the folder the module has in `src/`, named for it (`test/browser/internal/board-sprites.test.ts`). The testing skill says the rest.
- Lint holds a genre's root entry to the simulation's rules, and lets its public files be barrels of namespaces (`GENRES` in `oxlint.config.ts`): a new genre goes in that list.

## A demo

A demo is a Foldkit app over a genre, shaped as above where Foldkit leaves it room. The push-puzzle demo (`apps/push-puzzle-demo/src/app/`) is the example to copy.

- **Foldkit's contract keeps Foldkit's names and shapes**: `Model` in `model.ts`, a Schema, beside the Schemas it is made of (`Phase`, `LevelSummary`); `Message` in `message.ts`; `init` and `update` in `update.ts`, with the `Services` the Commands run against; `view` in `view.ts`; `subscriptions` in `subscriptions.ts`; the Commands in `commands.ts`, each a `Command.define("LoadContent", ...)` under its own PascalCase name; and `resources` in `main.ts`, the Layer of the app's services, which gathers the rest for `src/entry.ts` to hand to `Runtime.makeApplication`. These files are no namespaces and keep their names.
- **Every other module of the app is a declaration or a namespace**, as above. The save and the settings are declarations, each in a file of its own (`save.ts`, `audio-settings.ts`), and what a save keeps is a namespace (`LevelRecords`, with `LevelRecords.fromSolve` and `isNewBest`). The app's sounds (`Sounds`) and where its sheet is (`Sheet`) are namespaces. An exported constant is camelCase, in a Foldkit file too (`retryButtonId`).
- **Its Effects live in three places**: the Commands, each one Effect against the app's services that reports a Message; the Subscriptions, Streams of Messages (`EngineEntry.make`, `KeyPresses.make`); and `resources`. `update` and `view` are pure, Foldkit's contract (the effect-or-plain skill's fourth reason), and the other modules are data and plain functions that `update` calls. Foldkit's runtime is the app's one runner (`Runtime.run` in `src/entry.ts`).
- **What the app hands the genre is named for what the genre takes**: its sounds for the cue table are `Sounds.cues` (`PushPuzzleCueTable.layer(Sounds.cues)`), its sheet comes from `Sheet.url` (`PushPuzzleSheet.layer(SpriteSheet.fromUrl(Sheet.url))`), and its save and its settings are named for the game and the thing (`PushPuzzleSave`, `PushPuzzleAudioSettings`), as the glossary's **Setting** says. A type the kit has is the kit's (`AudioSystem.Bus`), never a copy.
- **Doc comments**: nothing imports an app, so its modules are documented as the kit's `internal/` modules are, Foldkit's included: a module comment, and a doc comment for each export, with no example and no `@category`.
- **Tests** are in `test/` for the content and `test/app/` for the app, named for what they check (`save.test.ts`, `retry.test.ts`), since each runs the app's `update` and Commands together (Foldkit's `Story` and `Scene`).
