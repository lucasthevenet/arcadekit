---
name: kit-modules
description: Kit module shape. Use when adding or reshaping a module or an export of arcadekit, or naming one.
---

Every module of the kit is shaped and documented as a module of Effect 4 is. [`arcadekit/core`](../../../packages/arcadekit/src/core/index.ts) is the reference: copy it, and read Effect's `MutableRef.ts` and `MutableHashMap.ts` (`node_modules/effect/src/`) beside it. No test checks this shape, so compare a new module with core's before you finish.

Write the block a game would write before the code that makes it work. A part a game supplies is a declaration (the declarations skill), and its doc comments follow the doc-comments skill. Whether its code is Effect or plain is the effect-or-plain skill's question.

## What kind of module is it

| What you are adding | It is | Copy |
| --- | --- | --- |
| A part each game supplies under a name of its own | a **declaration**: a builder that returns a class | [`game/event.ts`](../../../packages/arcadekit/src/game/event.ts), [`content/asset.ts`](../../../packages/arcadekit/src/content/asset.ts) for one with a service |
| What runs a declaration | a **host**: a plain class or function when a step or a frame calls it, the declaration's `layer` when it has a lifecycle | [`game/loop.ts`](../../../packages/arcadekit/src/game/loop.ts), the `layer` in [`game/engine.ts`](../../../packages/arcadekit/src/game/engine.ts) |
| Something more a host does | a **capability**: a method, with a file of types for what it takes or gives | `StepInput` in [`game/step-input.ts`](../../../packages/arcadekit/src/game/step-input.ts) |
| One thing of the app's with several implementations | a **service**: a `Context.Service` class with a static `layer`, and a named Layer for each other implementation | [`net/browser/coop-rooms.ts`](../../../packages/arcadekit/src/net/browser/coop-rooms.ts) |
| What a host runs on, with a default that suits most apps | a **reference**: a `Context.Reference` | `Frames` in [`game/frames.ts`](../../../packages/arcadekit/src/game/frames.ts) |
| A data structure, or a device's reads, that no game names | a **data type** | [`core/ring.ts`](../../../packages/arcadekit/src/core/ring.ts), [`core/rng.ts`](../../../packages/arcadekit/src/core/rng.ts) |
| Arithmetic a step or a view calls | a **module of functions**: plain functions of numbers | [`core/exact-math.ts`](../../../packages/arcadekit/src/core/exact-math.ts) |
| A Schema a declaration takes as a field and a host must recognise | a **Schema builder** | [`game/player-inputs.ts`](../../../packages/arcadekit/src/game/player-inputs.ts) |
| A failure a caller should handle | a **typed error** (below) | [`game/attach-error.ts`](../../../packages/arcadekit/src/game/attach-error.ts) |
| The words a test is written in | a **vocabulary**: plain functions imported as a namespace | [`game/scenario.ts`](../../../packages/arcadekit/src/game/scenario.ts) |

The test for a declaration: would two games each write one, and call it something of their own? Events, a simulation, an engine and content are declarations. The audio system, the frame clock and a pool are not. A game never calls a constructor to supply one of its parts, so a new declaration moves a factory's callers and deletes the factory.

## An entry and its namespaces

- An entry's public file exports each module as a namespace and nothing else: `export * as Ring from "./ring"`. A game writes `import { Ring } from "arcadekit/core"`, and the type is `Ring.Ring<L>`.
- An entry a game imports whole is one module: `arcadekit/game` and its `./browser` (`import * as Game`), and `arcadekit/game/scenario`.
- A builder a game writes bare is exported beside the namespaces under its noun, with its types (`Content`, `ContentClass`).
- A sub-entry's module that makes its parent's type is named for its mechanism and the parent's module, as Effect's `FetchHttpClient` is: `FetchContentSource.fromUrl` makes a `ContentSource.ContentSource`. One that provides a service of Effect's is named for its mechanism and the glossary's word, with its Layer as `layer`: `BrowserSaveStorage.layer`.
- A file is one module, its name the namespace's in kebab-case: `entity-pool.ts` is `EntityPool`.
- A namespace is the glossary's word and collides with no JavaScript or DOM global (`Math`, `Event`) and no module of Effect (`Pool`, `Clock`, `Hash`). Where the word collides, the term takes a word more: `EntityPool`, `StateHash`, `ExactMath`.
- What an entry's files share and no game calls is in `src/<entry>/internal/`, which no public file exports.
- A module imports another of its entry by relative path: as a namespace for its types (`import type * as Layout from "./layout"`), by name for a function it calls.

## A data type

- An interface named after its module (`Rng.Rng`), whose first member is `readonly [TypeId]: typeof TypeId`, a `const` of `"~arcadekit/<entry>/<Module>"` the module keeps to itself. It extends `Pipeable.Pipeable`, and `Inspectable.Inspectable` where a printed value helps.
- Its values come from a prototype (`Object.create(Proto)`) holding the `TypeId`, `...Pipeable.Prototype`, `...Inspectable.BaseProto` and a `toJSON` that gives `_id` and the fields worth reading in a log.
- State lives in fields and behaviour in the module's functions. A field a caller reads is in the interface, `readonly` unless the caller may write it. A field only the module reads stays off it, in an internal type its functions cast to.
- A data type that is a service's shape keeps the service's Effects as fields, as Effect's `KeyValueStore` does: [`save/stored.ts`](../../../packages/arcadekit/src/save/stored.ts).
- A guard, `isX(value: unknown): value is X`, on `Predicate.hasProperty(value, TypeId)`.
- A secondary type, one that exists only as a kind of the module's type, lives in the module with a marker and a guard of its own: `EntityPool.Identified`. A type with functions of its own is a module of its own: `RingReader` beside `Ring`.
- A type a game writes as a literal (a layout, an options object) and a module of functions over numbers have no `TypeId` and no guard.

## Constructors

- `make` makes the module's type, `empty` an empty collection that has a `make` from items, `fromX` one from another shape, and `makeX` a secondary type. Nothing is named `create…`.
- A caller writes `new` only for a Schema class, an error or a declaration. A data type is an interface and its `make`, never a class.
- A constructor handed a mistake throws, and its message names it: `Ring.make needs a whole capacity of 1 or more, got 0`.

## Functions

- A function of the module's type takes it first, named `self`. In a module of numbers the first operand keeps the name of what it is: `ExactMath.clamp(value, min, max)`.
- A function that takes more than `self` is `dual`, from `effect/Function`, typed with both overloads, data-last first, as `Ring.slotOf` is. One whose last parameter is optional takes a predicate on the first argument: `dual((args) => isSpatialGrid(args[0]), …)`. A constructor, a guard, a function of `self` alone and a declaration builder are no `dual`.
- A function that gives two numbers writes them into a point it is handed, the point first (`Point2.clampLength(wish, x, y, 1)`), so a step allocates nothing.
- An exported function or a service's method that returns an Effect is `Effect.fn("Module.name")`; one only its module calls is `Effect.fnUntraced`. A service member that is one Effect carries its span with `Effect.withSpan(load, "<Name>.load")`: [`content/internal/loaded.ts`](../../../packages/arcadekit/src/content/internal/loaded.ts).

## Errors

- A failure a caller should handle is a `Schema.TaggedError`, its base named first with its type written out, since `isolatedDeclarations` needs it: [`game/attach-error.ts`](../../../packages/arcadekit/src/game/attach-error.ts). Lint's `unicorn/throw-new-error` misreads the call, and `pnpm fix` would rewrite it to code that doesn't compile: disable it on the line above, with that reason.
- An error lives in the module whose values fail with it (`ContentSource.ContentError`), and a game catches it by its tag.
- Its fields say what it is for: `message` if an app shows it, `cause: Schema.Defect()` if it wraps a throw, `reason` if a caller branches on it.
- A mistake in a game's code is no typed error: it throws (the declarations skill, "Refusing a mistake").

## Services and references

- A service is a `Context.Service` class and a reference a `Context.Reference`, each with a static `layer` for the kit's implementation and a named Layer for each other one. A service of the kit's is keyed `arcadekit/<entry>/<Name>`.
- Its methods that return an Effect are `Effect.fn("Name.method")`.

## Names

- The glossary's word, the same in code, docs, tests and messages. A new concept gets its term in `CONTEXT.md` in the same change, with the words to avoid.
- Members are short, since the namespace says what they are of: `Ring.make`, `Rng.next`.
- An exported constant is camelCase, as Effect's are (`InputController.moveAxes`); one that is a type as well is PascalCase (`TileMap.Side`). A constant only its module reads may be in capitals.
- A rename moves every caller and every doc in the same change, with no alias, and its changeset has a table of old and new names.
- Check Effect's and Foldkit's exports before settling a name a file writes bare: Foldkit's `Story` is why the kit's is `Scenario`.
- A module imported as a namespace exports no `then`, or the namespace is a thenable and a vitest file that imports it never starts.
