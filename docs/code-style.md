# Code style

How a module of the kit is written, so the next one reads like the ones beside it.

[`AGENTS.md`](../AGENTS.md) has the two rules the rest follows from, "A game is declared" and "Effect and plain code". [What checks it](#what-checks-it) lists the rules that lint and a test enforce: prefer a new rule there to a new sentence here.

## Start from the game's side

Write the block a game would write before the code that makes it work: the `ts` example for the entry's README, as a small game of its own (`Race`), since `pnpm smoke` compiles each block alone. So does it compile a doc comment's example ([The doc comment](#the-doc-comment)), once the entry has Effect's shape: until then, a doc comment's example can use push-puzzle's names. The design is done when that block needs:

- no type argument, apart from [types given first](#the-builder);
- no annotation on a handler's parameter, apart from `create`'s config, which nothing else carries;
- no cast;
- no second statement to finish declaring the part;
- nothing for a part the game doesn't use: `player` defaults to 0 in `loop.send`.

If it needs one of them, change the builder, not the example.

## What kind of module is it

Every kind below is written as [an Effect module](#an-effect-module) is: a namespace, its doc comments, its names. The table says what the module holds.

| What you are adding | It is | Written as | Copy |
| --- | --- | --- | --- |
| A part each game supplies under a name of its own | a **declaration** | a builder that returns a class | [`game/event.ts`](../packages/arcadekit/src/game/event.ts) for a value, [`content/asset.ts`](../packages/arcadekit/src/content/asset.ts) for a service |
| What runs a declaration | a **host** | a plain class or function when a step or a frame calls it; the declaration's `layer` when it has a lifecycle | [`game/loop.ts`](../packages/arcadekit/src/game/loop.ts), the `layer` in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts) |
| Something more a host does | a **capability** of it | a method, with a file of types for what it takes or gives. Its section is [A host](#a-host) | `frame` in [`game/loop.ts`](../packages/arcadekit/src/game/loop.ts), `StepInput` in [`game/step-input.ts`](../packages/arcadekit/src/game/step-input.ts) |
| One thing of the app's that has several implementations | a **service** | a `Context.Service` class with a static `layer`, and a named Layer for each other implementation | [`audio/service.ts`](../packages/arcadekit/src/audio/service.ts), [`net/browser/coop-rooms.ts`](../packages/arcadekit/src/net/browser/coop-rooms.ts) |
| What a host runs on, with a default that suits most apps | a **reference** | a `Context.Reference` | `Frames` in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts), `CoopTicker` in [`net/browser/coop.ts`](../packages/arcadekit/src/net/browser/coop.ts) |
| A data structure, or a device's reads, that no game names | a **data type** | an interface named after its module, its `make`, a guard and functions that take it first | [`core/ring.ts`](../packages/arcadekit/src/core/ring.ts), [`core/rng.ts`](../packages/arcadekit/src/core/rng.ts), [`core/entity-pool.ts`](../packages/arcadekit/src/core/entity-pool.ts) for a secondary type |
| Arithmetic a step or a view calls | a **module of functions** | plain functions of numbers, under a namespace | [`core/exact-math.ts`](../packages/arcadekit/src/core/exact-math.ts), [`core/tween.ts`](../packages/arcadekit/src/core/tween.ts) |
| A Schema that a declaration takes as a field and a host must recognise | a **Schema builder** | a plain function that returns a Schema, marked in its annotations, with a type-only mark for the hosts that ask for it | `Game.PlayerInputs` in [`game/player-inputs.ts`](../packages/arcadekit/src/game/player-inputs.ts) |
| A failure a caller should handle | a **typed error** | a `Schema.TaggedError` class: [Errors](#errors) | `AttachError` in [`game/attach-error.ts`](../packages/arcadekit/src/game/attach-error.ts) |
| The words a test is written in | a **vocabulary** | a module of plain functions, imported as a namespace | [`game/scenario.ts`](../packages/arcadekit/src/game/scenario.ts) |

The test for a declaration: would two games each write one, and call it something of their own? Events, a simulation, an engine, content: yes. The audio system, the frame clock, a pool: no.

A game never calls a constructor to supply one of its parts: a part a game supplies is a declaration, and a new declaration moves a factory's callers and deletes it. A module's `make` makes a data type of the kit's, which no game names (`Ring.make`). First look for a declaration that fits (the audio settings are a `Setting` of the kit's Schema and default) and for who needs it: a `CueTable` hands a genre package the app's sounds, so a game that owns its sounds declares none.

## An Effect module

Every module of the kit is shaped and documented as a module of Effect 4 is ([ADR-0024](adr/0024-the-kit-is-written-as-effect-modules.md)). [`arcadekit/core`](../packages/arcadekit/src/core/index.ts) is the reference: copy it, and read Effect's own `MutableRef.ts` and `MutableHashMap.ts` (in `node_modules/effect/src/`) beside it. An entry listed in `NOT_YET_EFFECT_STYLE` in [the style test](../packages/arcadekit/test/style.test.ts) keeps its older shape until the change that reworks it, which takes it off the list: the test then holds it to this section. Where a rule below has nothing to show in core yet, it names the entry where it first applies.

### An entry and its namespaces

- **A namespace per module.** An entry's public file exports each module as a namespace, and nothing else: `export * as Ring from "./ring"`. A game writes `import { Ring } from "arcadekit/core"`, and the type is `Ring.Ring<L>`, as Effect's is `MutableRef.MutableRef<A>`.
- **An entry a game imports whole is one module**: `arcadekit/game` and its `./browser` (`import * as Game`), and `arcadekit/game/scenario` (`import * as Scenario`). Their public file is the module, and its declarations are its callable members (`Game.Event`). First applies in `arcadekit/game`.
- **A builder a game writes bare** is exported from its entry's public file beside the namespaces, under its noun, with the types [the builder](#the-builder) lists (`Content`, `ContentClass`). First applies in `arcadekit/content`.
- **A sub-entry's module that makes its parent's type is named for its mechanism and the parent's module**, as Effect's `FetchHttpClient` is, and its `fromX` returns the parent module's type, as Effect's `NodeStream.fromReadable` gives a `Stream`: `arcadekit/content/browser`'s `FetchContentSource.fromUrl` makes a `ContentSource.ContentSource`. A sub-entry can't add to its parent's namespace, and a second namespace by the parent's name would clash in a file that imports both entries. A sub-entry that exports namespaces is a folder, [`content/browser/index.ts`](../packages/arcadekit/src/content/browser/index.ts) as `net/browser/index.ts` is, so its modules are apart from its parent's: `doc-examples.test.ts` reads an entry's modules from its folder.
- **A file is one module, its name the namespace's in kebab-case**: `entity-pool.ts` is `EntityPool`, `point2.ts` is `Point2`.
- **A namespace is named for the glossary's word, and collides with nothing a file has in scope**: no JavaScript or DOM global (`Math`, `Event`, `Number`, `Image`) and no module of Effect (`Pool`, `Clock`, `Hash`, `Channel`). Where the word collides, the term takes a word more: core's pool is an **entity pool** (`EntityPool`), its clock a **fixed-step clock**, its hash a **state hash** (`StateHash`), its math **exact math** (`ExactMath`). A rename changes `CONTEXT.md` in the same change.
- **A namespace exports only public API.** What an entry's files share and no game calls is in `src/<entry>/internal/`, which no public file exports: core's `internal/fields.ts` makes the typed arrays of a pool, a ring and a tile map.
- **A module imports another of its entry by relative path**, as a namespace for its types (`import type * as Layout from "./layout"`) or by name for a function it calls (`import { hypot2 } from "./exact-math"`).

### A data type

- **An interface named after its module**, `Rng.Rng`, `EntityPool.EntityPool<L>`, with a `TypeId` of `"~arcadekit/<entry>/<Module>"`: a `const` the module keeps to itself, and the interface's first member, `readonly [TypeId]: typeof TypeId`. It extends `Pipeable.Pipeable`, and `Inspectable.Inspectable` where a printed value helps debugging, which every data type of core does.
- **Its values come from a prototype**: `Object.create(Proto)`, where `Proto` holds the `TypeId`, `...Pipeable.Prototype` and `...Inspectable.BaseProto`, and a `toJSON` that gives `_id`, the module's name, and the fields worth reading in a log: a pool's capacity, count and field names, not its arrays.
- **State lives in fields, and behaviour in the module's functions.** The prototype has no method but `pipe` and the printing ones. A field a caller reads is in the interface, `readonly` unless the caller may write it too (`Point2`'s `x` and `y`). A field only the module reads stays off the interface, in an internal type its functions cast to (`Types.Mutable<Ring<L>> & { arrays: … }`).
- **A guard**, `isX(value: unknown): value is X`, built on `Predicate.hasProperty(value, TypeId)`: `Rng.isRng`. A look-alike with the same fields is no `X`.
- **A secondary type** is one that exists only as a kind of the module's type. It lives in the module, with a marker and a guard of its own: `EntityPool.Identified`, `EntityPool.isIdentified`. A type with a life and functions of its own is a module of its own: `RingReader`, beside `Ring`.
- **A type a game writes as a literal is no data type**: a layout (`Layout.Layout`) or an options object (`SpatialGrid.Options`). It has no `TypeId` and no guard. Neither has **a module of functions over numbers**: `ExactMath`, `Timer`, `Tween`.

### Constructors

- **`make`** makes the module's type; **`empty`**, an empty collection that has a `make` from items; **`fromX`**, one from another shape; and **`makeX`**, a secondary type (`EntityPool.makeIdentified`, as Effect has `Effect.makeSemaphore`). Nothing is named `create…`. Core needs no `empty`: `EventBuffer.make` is the empty buffer, as Effect's `MutableList.make` is. `fromX` first applies in `arcadekit/content`, whose `ContentSource.fromRecord` makes a content source from a record of files, as Effect's `Migrator.fromRecord` makes a loader from one.
- **A caller writes `new` only for a Schema class, an error or a declaration.** A data type is an interface and its `make`, never a class.
- **A constructor that is handed a mistake throws**, as [Refusing a mistake](#refusing-a-mistake) says, and its message names it: `Ring.make needs a whole capacity of 1 or more, got 0`.

### Functions

- **`self` first.** A function of the module's type takes it first, named `self`: `Ring.push(self)`, `Ring.slotOf(self, n)`. In a module of numbers the first operand is `self`, and keeps the name of what it is: `ExactMath.clamp(value, min, max)`, `Tween.progress(now, startedAt, duration)`.
- **`dual` when it takes more than `self`**, from `effect/Function`, typed with both overloads, data-last first, as Effect's `MutableRef.ts` writes them (isolatedDeclarations needs the written type anyway):

  ```ts
  export const slotOf: {
    (n: number): <L extends Layout.Layout>(self: Ring<L>) => number;
    <L extends Layout.Layout>(self: Ring<L>, n: number): number;
  } = dual(
    2,
    <L extends Layout.Layout>(self: Ring<L>, n: number): number =>
      n % self.capacity
  );
  ```

  A caller then writes `Ring.slotOf(ring, n)`, or `ring.pipe(Ring.slotOf(n))`. A function whose last parameter is optional can't be told apart by how many arguments it got: its `dual` takes a predicate on the first, `dual((args) => isSpatialGrid(args[0]), …)`, as `SpatialGrid.build` and `SpatialGrid.nearest` do. A constructor, a guard, a function of `self` alone (`Ring.push`), a function of one number (`ExactMath.sin`) and a declaration builder, which takes the name and then the definition ([The builder](#the-builder)), are no `dual`.

- **A function that gives two numbers writes them into a point it is handed**, the point first (`Point2.clampLength(wish, x, y, 1)`), so a step that calls it for every entity allocates nothing.
- **An exported function or a service's method that returns an Effect is `Effect.fn("Module.name")`**, so a trace shows it; one only its module calls is `Effect.fnUntraced`. `arcadekit/content`'s `ContentSource.read` and a content's `read` (`Effect.fn("PushPuzzleContent.read")`) are, and so is a save's or a setting's `write` (`Effect.fn("PushPuzzleSave.write")`); `arcadekit/net/browser` (the Co-op client's methods) is next.
- **A declaration's static that is one Effect is traced on its service.** `load` is an Effect, not a function, so `Effect.fn` doesn't fit it: the service's own `load` carries the span, `Effect.withSpan(load, "<Name>.load")`, as [`content/internal/loaded.ts`](../packages/arcadekit/src/content/internal/loaded.ts) gives it, so `PushPuzzleSheet.load` and `(yield* PushPuzzleSheet).load` trace the same. The static stays `Effect.andThen(Key, (service) => service.load)`.
- **Plain or Effect is [`AGENTS.md`](../AGENTS.md)'s question**, "Effect and plain code". A plain module's functions run no Effect: core imports `effect` only for its shape (`Pipeable`, `Inspectable`, `Predicate`, `Types` and `dual`).

### Errors

- **A failure a caller should handle is a `Schema.TaggedError`**, its base named first with its type written out, as kit source names every class's base: isolatedDeclarations needs the type of a base an exported class extends. Name that type first, so the call starts the base's line:

  ```ts
  type AttachErrorClass = Schema.Class<
    AttachError,
    Schema.TaggedStruct<
      "AttachError",
      { readonly message: Schema.String; readonly cause: Schema.Defect }
    >,
    Cause.YieldableError
  >;

  // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
  const AttachErrorBase: AttachErrorClass = Schema.TaggedError<AttachError>()(
    "AttachError",
    { message: Schema.String, cause: Schema.Defect() }
  );

  export class AttachError extends AttachErrorBase {}
  ```

  Lint's `unicorn/throw-new-error` reads the call as an error made without `new`, and `pnpm fix` rewrites it to `new Schema.TaggedError…`, which doesn't compile. Disable it on the line above the call, with that reason, as [`content/content-source.ts`](../packages/arcadekit/src/content/content-source.ts) and [`game/rejection.ts`](../packages/arcadekit/src/game/rejection.ts) do.

- **An error lives in the module whose values fail with it**, as Effect's `ConfigProvider.SourceError` does: a content source fails with `ContentSource.ContentError`, and so does a load of content, which reads through a source. One that several modules fail with alike gets a module of its own, as Effect's `PlatformError` is. An entry's public file exports only namespaces and its builders, so a game reaches an error through its namespace, and catches it by its tag.
- **Its fields say what it is for**: a `message` if an app shows it, a `cause: Schema.Defect()` if it wraps a throw, a `reason` if a caller branches on it.
- **A mistake in a game's code is no typed error**: it throws, as [Refusing a mistake](#refusing-a-mistake) says.
- `arcadekit/content`'s `ContentSource.ContentError` is one. `arcadekit/game` (`AttachError`, `GameCrashed`) and `arcadekit/net` (`LockstepError`) are next, which are `Data.TaggedError`s until their rework.

### Services and references

- **A service is a `Context.Service` class, and a reference a `Context.Reference`**, each with a static `layer` for the implementation the kit gives, and a named Layer for each other one. A service of the kit's is keyed `arcadekit/<entry>/<Name>` (`arcadekit/audio/Audio`), and a declaration's as [A declaration with a service](#a-declaration-with-a-service) says.
- **Its methods that return an Effect are `Effect.fn("Name.method")`.**
- First applies in `arcadekit/audio` (`Audio`), `arcadekit/game/browser` (`Game.Frames`) and `arcadekit/net/browser` (`CoopRooms`, `CoopTicker`).

### The doc comment

**Every module file opens with a module comment**: what the module is, in the glossary's words, and why it is as it is, ending in `@since`.

**Every export has a doc comment in Effect's structure**, written in the kit's own prose voice and the glossary's words:

1. **A summary**: what it is or does, in a sentence or two.
2. **`**When to use**`**: the moment in a game where it is the thing to reach for.
3. **`**Details**`**, when there is more to say: its edge cases, what it costs, what it refuses (`It throws a RangeError for …`).
4. **At least one `**Example** (Title)`**, each a `ts` block that imports from `arcadekit/<entry>`, as a game would, and shows results as `// =>` comments, which are true. `pnpm smoke` compiles every block alone. A result ends one line: name what spans lines first, then show it.
5. **"Throws when declared"**, for a declaration builder whose body throws ([the builder's file](#the-builders-file)). First applies in `arcadekit/game` (`Game.Simulation`).
6. **`@category`**, from the list below, then **`@since`**: the version that added the export in this shape, `@since 0.7.0` for all of core. No `@stability`, and no other tag.

A `dual` function's doc comment is on its export, not repeated on each overload: an editor shows it and the API page renders it. A field of a data type has a one-line comment when its name doesn't say it all.

**The categories are one closed list**, which the style test's `CATEGORIES` holds. A new category is a change to both.

| Category | What goes in it |
| --- | --- |
| `models` | A data type's interface, a secondary type, a type a game writes (a layout, options) and a set of constants (`TileMap.Side`) |
| `constructors` | `make`, `empty`, `fromX`, `makeX` |
| `guards` | `isX` |
| `getters` | What reads a value, and a query that writes only into what its caller hands it (`SpatialGrid.within`) |
| `mutations` | What changes the value it is given, or draws from it (`Rng.next`) |
| `combinators` | What takes values of the module and returns a new one |
| `math` | A function of numbers |
| `utility types` | A type computed from another (`Layout.Fields<L>`) |
| `schemas` | A Schema, or what builds one |
| `services` | A `Context.Service` |
| `layers` | A Layer |
| `references` | A `Context.Reference` |
| `errors` | A typed error |
| `declarations` | A declaration builder |
| `testing` | What only a test imports |

## A declaration

A game writes `class <Name> extends <Builder>("<Name>", { ... }) {}`, and that statement is the whole part: its value, its type and its definition, under one name.

### The builder's file

Top to bottom:

1. **The types a game's code names.** What a value or the service looks like (`EventInstance`, `Loaded`), and for a service its key's type and its identity.
2. **`<Noun>Class`.** An interface with everything the returned class has. It is the builder's written return type: what a reader and the type files see.
3. **The doc comment**, in Effect's structure ([The doc comment](#the-doc-comment)): what the part is, in the glossary's words, **When to use**, then a `ts` example that declares one and uses it, then what the builder refuses if it throws when declared, then `@category declarations` and `@since`.
4. **The builder**, last.

Anything else goes anywhere above the doc comment: the definition's interface, `Any<Noun>`, types that read the class (`StateOf`).

### The builder

- **`(name, definition)`**, or `(tag, fields)` and then `options` for a class that is a Schema. Its file exports it under its noun (`Content`, `Coop`). Only `arcadekit/game` and its `./browser` give builders through a namespace: theirs are exported as `make`, and the entry's public file names each (`export const Event: typeof makeEvent = makeEvent`), so a game writes `Game.Event`.
- **The name is typed by a type parameter**, `<Name extends string>(name: Name, ...)`, or `Tag` for a `_tag`: typed `string`, two declarations share one type, and two services one identity.
- **Types given first.** A type that nothing in the definition carries comes first, in an empty call, as `Context.Service` takes it: `Asset<SpriteSheet, SpriteSheetError>()("PushPuzzleSheet", { ... })`.
- **The other type parameters are words** (`Config`, `State`), or a letter with one meaning: Effect's `A`, `E` and `R`, `F` for fields, `S` for a Schema (a declaration typed by one is generic over it), `U` for `uses`. One that an optional field decides defaults to none (`= readonly []`).
- **It returns a class** with `static readonly kind = "<Noun>" as const`, the name (`tag` for a `_tag`, `<noun>Name` otherwise, never `name`, which a class has already), and what a host reads from the definition (`definition`, `simulation`, `rejects`).
- **Its result is cast to its written type**: `return class ... as unknown as <Noun>Class<...>`, with any base named first (`const Key = ...; return class extends Key { ... }`).
- **It checks, when declared, what the types can't**, and throws: [refusing a mistake](#refusing-a-mistake).
- **The entry's public file exports its types with it**: `<Noun>Class`, and where it has them `Any<Noun>`, the definition's type, `<Noun>Id` and `<Noun>Service`.

### A declaration with a service

The class is the service's key, as in [`content/asset.ts`](../packages/arcadekit/src/content/asset.ts):

- The key is `` `arcadekit/<folder>/<Noun>/${name}` `` as `<Noun>Id<Name>`, with the entry's first folder under `src/`.
- Its identity is `<Noun>Service`, a `Context.ServiceClass.Shape<Id, Service>`: the type of the class's own values, so the class names it (`Layer.Layer<PushPuzzleEngine>`).
- `layer` provides it, and loads nothing until the first use. It takes what the app knows, as its argument (`layer(source)`) or as a service it reads (`CoopRooms`), and takes that context once: the service's Effects require none of it.
- A service that is one Effect has it as a static: `PushPuzzleSheet.load` for `(yield* PushPuzzleSheet).load`. One with methods is reached with `yield* PushPuzzleEngine`, however few: a save's `read` and `write` are no statics, and a Command writes `(yield* PushPuzzleSave).read`.
- No field of a definition has the name of a static the class has for something else: a service's has `key`, so a storage key is `storageKey`.

### Register it

Add the builder to `DECLARATIONS` in [`packages/arcadekit/test/style.test.ts`](../packages/arcadekit/test/style.test.ts) and to `DECLARATION_BUILDERS` in [`tools/lint/declaration.ts`](../tools/lint/declaration.ts), with its entry in `BUILDER_ENTRIES` there if no builder came from that entry before. Name it in `AGENTS.md`, in the sentence that begins "They are", and in the glossary's **Declaration** entry. Lint and the test then say what the declaration still lacks.

## The definition a game writes

- **One object.** A field holds data, a Schema, another declaration's class (`simulation: PushPuzzle`, `events: [LevelSolved]`) or a plain function, there or one object down (`apply`, `sample`). TypeScript infers a handler's parameters from the fields beside it, but not through a call or a spread: there the game has to annotate. A `create` written in place comes before the other handlers.
- **An Effect is a field's value, which the host runs**: a service's key, a declaration's `load`, one built in place (`Effect.succeed("#e0b040")`). The handlers beside it take their types from it. Building it with a data-first call can break that, in `uses` and `content` alike (`Effect.map(load, fn)`, `Effect.as(load, value)`): pipe it (`load.pipe(Effect.map(fn))`) or name it first.
- **A name a game gives is a key of an object**, which takes a doc comment and whose value is what the kit reads: an event's fields, `files`, `uses`, `apply`, `cues`. A list holds other declarations' classes.
- **A declaration made from another takes its class**, and every type from it: `Coop`'s `engine`. The builder is generic over the other's types, so the two can't disagree, and a mistake is a type error on that field.
- **What handlers share is a named field** that the host resolves and passes in: `uses` in `Game.Engine`.
- **A handler's parameters come in one order**: what it acts on, what it acts with, then one context object the host fills. `step(state, input, { dt, report })`, `view(container, uses, { local })`. Something new a handler needs is a new field of that context.
- **A handler that changes state returns `Nothing`** ([`game/simulation.ts`](../packages/arcadekit/src/game/simulation.ts)), a type no value has by accident, so returning the next state, a promise or an Effect is a type error.
- **A game reads its types from the class**: `StateOf<typeof PushPuzzle>`, `PushPuzzle.match({ ... })`. A type that reads a class takes `Any<Noun>`, so it refuses a look-alike. `Game.Simulation` keeps them on a types-only `"~types"` field.
- **`NoInfer<T>`** goes on a handler's parameter or result that is checked against a type another field decides: the view's state in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts), the content `picks` takes in [`net/browser/coop.ts`](../packages/arcadekit/src/net/browser/coop.ts). A type read off a Schema (`S["Type"]`) needs none: nothing is inferred from it. `S` is `const` where a handler builds that value, so a literal keeps its type ([`save/save.ts`](../packages/arcadekit/src/save/save.ts)).

## A host

- **It takes the declaration, and nothing a game would repeat**: `new Game.Loop(PushPuzzle)`, `PushPuzzleEngine.layer`, `Scenario.make(PushPuzzle)`.
- **It owns what every game would otherwise write**: the event buffer, the command queue, the sample, what an attach acquires and releases.
- **One way to do each thing.** A run changes only at a step; an asset loads only through `load`. Replace the path that exists: a second path, or an option that switches behaviours, is two things to learn. A content's `read(source)` is another thing: it keeps nothing.
- **What it does besides its work only watches**: a listener changes nothing a handler is given.
- **Its time comes from its caller**, so a test drives it with no timer and no browser: `nowMs` in `Game.Loop`, `Frames` in the engine. A scenario, which runs a script in one call, makes it from the step number.
- **An Effect that waits ends when what it waits on ends, and interrupting it takes back what hasn't happened.** `engine.send` fails with `CommandDropped` when its run ends first, and an interrupted send removes its command from the queue.
- **A sender is told once the host is out of the call that ended its command**, and the engine resumes it after a yield, so the line after `yield* engine.send(...)` may start or stop a run. A listener runs inside the frame, and must not call back in.

## Names

- **The glossary's word**, the same in code, docs, tests and messages ([`CONTEXT.md`](../CONTEXT.md)). A new concept gets its term in the same change, with the words to avoid. A two-word name is headed as prose writes it: **Player inputs**, whose entry names `PlayerInputs`.
- **A namespace is the glossary's word, and its file the same word in kebab-case**, as [An Effect module](#an-entry-and-its-namespaces) says: `EntityPool` in `entity-pool.ts`. Its members are short, since the namespace says what they are of: `Ring.make`, `Ring.push`, `Rng.next`, `EntityPool.Identified`.
- **A constructor is `make`, `empty`, `fromX` or `makeX`** ([Constructors](#constructors)), and a guard `isX`, where `X` is the type it makes or knows.
- **A constant a module exports is camelCase**, as Effect's are (`Duration.zero`): `InputController.moveAxes`. One that is a type as well is PascalCase, as types are: `TileMap.Side`, which names a side and holds the four. A constant only its module reads may be written in capitals (`DEADZONE`).
- **A rename moves every caller and every living doc in the same change**, with no alias ([`AGENTS.md`](../AGENTS.md), "Project status"), and an earlier ADR that names the old API gets a note that says so, as [ADR-0004](adr/0004-one-press-one-step.md) has. The records keep their wording, since they say what was true when they were written: `packages/arcadekit/CHANGELOG.md`, the findings (`docs/push-puzzle-findings.md`, `docs/co-op-findings.md`), `docs/architecture-review.md` and `docs/research/`. A change's search for its old names leaves them out, and its changeset has the table of old and new names they are read through.
- **A builder is a singular noun**: `Event`, `Asset`.
- **What a game declares**: an event in the past tense (`LevelSolved`), a sample for what it shows (`Hud`), a command in the imperative (`ChooseUpgrade`), a rejection by what is wrong (`OfferClosed`), a simulation by the game's name (`PushPuzzle`), an asset or a setting by the game and the thing (`PushPuzzleSheet`, `PushPuzzleAudioSettings`), anything else by the game and the builder's noun (`PushPuzzleEngine`).
- **The kit's words are taken**, each in its place. A definition: `input`, `events`, `commands`, `rejects`, `create`, `step`, `apply`, `sample`, `stepSeconds`, `simulation`, `uses`, `view`, `schema`, `files`, `validate`, `release`, `engine`, `content`, `picks`, `config`, `maxPlayers`, `hash`, `ends`, `lockstep`, `storageKey`, `record`, `mergeRecord`, `default`, `merge`, `cues`. A context: `seed`, `report`, `dt`, `step`, `player`, `local`. A class: `kind`, `tag`, `definition`, `load` (keeps its first success), `read` (keeps nothing), `layer`, `match`, `merge`. A service: `read`, `write` (stores; a save's merges), `attach`, `listen`, `start`, `send`, `setPaused`, `stop`, `host`, `join`, `choose`, `leave`, `debug`. A new declaration uses the ones that fit, and adds a word only for a new idea. One made from another may take its word for a part of the same thing, and says so: a `Coop`'s `input`.
- **Check Effect's and Foldkit's exports before settling a name a file writes bare.** A word one of them uses for something else is taken there: Foldkit's `Story` is why the kit's is `Scenario`, and Effect's `Pool` why core's is `EntityPool`. Behind a namespace a name may clash: `Game.Command`, beside Foldkit's, and `Ring.make`, beside every other `make`.
- **A declaration's other names are its glossary entry's**: the type its service gives (`CoopClient`), and the one word its examples bind it to (`coop`).
- **A static has one job**: it is not another static plus a suffix, nor an export of its entry under other arguments.
- **A module imported as a namespace exports no `then`**, or the namespace is a thenable, and under vitest a test file that imports it never starts.

## Refusing a mistake

At the earliest moment that can see it, in this order:

1. **A type error**, for whatever the definition itself shows: an inferred type parameter costs a game nothing (`RequireApply` in [`game/simulation.ts`](../packages/arcadekit/src/game/simulation.ts), with its throw behind it). A test holds each one: `// @ts-expect-error` on the line directly above the wrong line.
2. **A throw when the part is declared**, as the module loads: `Simulation "Jar" declares the command "Deposit" but has no apply.Deposit to handle it`.
3. **A throw from the host**, for what a cast gets past the types: `Game.Loop` throws on a handler's stray return, a `CueTable`'s `layer` on sounds that don't fit its cues.

Never drop it in silence. A refusal throws `Error`, or `RangeError` for a number out of range, never `TypeError`. A message names the declaration and says what to write.

## Done when

- [ ] `pnpm check`, `pnpm typecheck` and `pnpm test` pass; `pnpm fix` formats what `pnpm check` reports.
- [ ] The module has [Effect's shape](#an-effect-module), and its entry is off `NOT_YET_EFFECT_STYLE`, so the style test holds it there. Every export has its doc comment, every example's `// =>` is true, and `pnpm build:packages && pnpm smoke --no-build` compiles the examples.
- [ ] The README block from [the first step](#start-from-the-games-side) is in the entry's README, and `pnpm build:packages && pnpm smoke --no-build` compiles it.
- [ ] A game uses the module as that block shows: push-puzzle or its demo, or a small game declared in the module's test.
- [ ] A simulation's rules are checked by scenarios, anything else by tests beside it; its types by `expectTypeOf` and `@ts-expect-error`, and every refusal's message by a test.
- [ ] A test of an Effect that can fail compares the error (`Effect.flip`) or its cause's reasons, not the whole `Exit`: an `Effect.fn` or a span annotates the cause with its stack, so `Exit.fail(error)` doesn't equal it. [`content/declarations.test.ts`](../packages/arcadekit/src/content/declarations.test.ts) has a `failures(exit)` that lists the reasons.
- [ ] The glossary has its term. A choice that was hard to make, or that the next reader would otherwise undo, has an ADR. Both tables of entries (`README.md`, `packages/arcadekit/README.md`) follow an entry's exports.
- [ ] A change that moves code to Effect, or that touches a step, a frame or a lockstep tick, gives `pnpm bench`'s numbers against [`docs/perf-baseline.md`](perf-baseline.md) in its PR.
- [ ] A changeset says what breaks, or that nothing does (`minor` either way). [`.changeset/README.md`](../.changeset/README.md) has the file's format.

## What checks it

What one file shows is a lint rule, in [`tools/lint/declaration.ts`](../tools/lint/declaration.ts) or [`oxlint.config.ts`](../oxlint.config.ts). What takes several files is a test, [`packages/arcadekit/test/style.test.ts`](../packages/arcadekit/test/style.test.ts).

| Rule | Checked by |
| --- | --- |
| A declaration is a class with the name it is declared with, and no second class extends it | lint: `declaration/named`, `declaration/class`. They find a builder by what the file imports, under any local name; in a file of the kit, only one imported from an entry's public file |
| A builder is given no type argument, apart from types given first | lint: `declaration/inferred` |
| A function in a definition is not async and not a generator | lint: `declaration/plain-handler` |
| A simulation's `create`, written in place, comes before its other handlers | lint: `declaration/create-first` |
| A step or an `apply` returns nothing | the `Nothing` type, and `Game.Loop` at run time |
| A builder's shape: the name first, typed by a type parameter, `kind` and the name as statics, `<Noun>Class` written out and exported with the statics the class sets, the base named, one builder for each kind, and "Throws when declared" in its doc comment if its own body throws | lint: `declaration/builder`, on the kit's source |
| Every builder is listed where [Register it](#register-it) says, and has its doc comment, its README block, its glossary term and a test that declares one. A service's key, identity and `layer` | the style test's `DECLARATIONS` |
| An entry with Effect's shape: its public file exports namespaces, each named for its file and colliding with no global or Effect module, beside the builders a game writes bare and their types; an entry a game imports whole is one module | the style test's `NOT_YET_EFFECT_STYLE`, which lists the entries it doesn't hold yet |
| Every export of such an entry has its doc comment: a summary, **When to use**, an **Example** whose `ts` imports from its entry and shows a `// =>`, a `@category` from `CATEGORIES` and a `@since`, and no `@stability`; and every module opens with a comment that ends in `@since` | the style test |
| A data type has its `TypeId` and its guard on `Predicate.hasProperty`; a constructor is no `create…`, and a `makeX` makes a type of its module; a function of more than `self` is `dual`, but for a constructor or a declaration builder; a module re-exports nothing; a data type is no class; an exported constant is not written in capitals | the style test |
| The doc comments' examples compile, and the results they show hold | `pnpm smoke` compiles them against the packed package, and [`packages/arcadekit/test/doc-examples.test.ts`](../packages/arcadekit/test/doc-examples.test.ts) runs them against `src/`, each `expression; // => value` checked: both for every entry off `NOT_YET_EFFECT_STYLE` |
| No new factory without a reason | the style test's `FACTORIES` and `NOT_YET_DECLARED`, in the entries on `NOT_YET_EFFECT_STYLE`. In the others a constructor is a module's `make` |
| Library code runs no Effect itself | lint: `Effect.run…` and `ManagedRuntime.make` are refused in `packages/*/src`, outside what a test imports and the worker's entry points. The `…With` forms pass |
| The simulation reads no clock or random source, and a genre's uses only exact math | lint, on the root entry of every genre package and on `arcadekit/core`, whose functions a step calls. The first also on `arcadekit/game` but its engine and its frame clock: `oxlint.config.ts` lists the other plain files of the kit, so add a new one there |
| A module exports no `then` | lint: `unicorn/no-thenable` |
| Which entry may import which, and which packages | lint's `ENTRY_IMPORTS`, [`packages/arcadekit/test/entry-packages.test.ts`](../packages/arcadekit/test/entry-packages.test.ts) |
| A README's examples compile | `pnpm smoke` |
| Whether the hot paths got slower | `pnpm bench`, read against [`docs/perf-baseline.md`](perf-baseline.md) in review |
| Every export of the kit has a written type | the build (`isolatedDeclarations`) |

[`tools/lint/declaration.test.ts`](../tools/lint/declaration.test.ts) runs the linter on a case for each `declaration/…` rule: a new rule gets its cases there, and a new builder gets its own by being registered. The rules are on in tests too: a test's small game is what the next one copies. A test that has to declare what a builder refuses says so on the line: `// oxlint-disable-next-line declaration/class -- <why>`.
