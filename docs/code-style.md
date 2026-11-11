# Code style

How a module of the kit is written, so the next one reads like the ones beside it.

[`AGENTS.md`](../AGENTS.md) has the two rules the rest follows from, "A game is declared" and "Effect and plain code". [What checks it](#what-checks-it) lists the rules that lint and a test enforce: prefer a new rule there to a new sentence here.

## Start from the game's side

Write the block a game would write before the code that makes it work: the `ts` example for the entry's README, as a small game of its own (`Race`), since `pnpm smoke` compiles each block alone. A doc comment's example can use push-puzzle's names. The design is done when that block needs:

- no type argument, apart from [types given first](#the-builder);
- no annotation on a handler's parameter, apart from `create`'s config, which nothing else carries;
- no cast;
- no second statement to finish declaring the part;
- nothing for a part the game doesn't use: `player` defaults to 0 in `loop.send`.

If it needs one of them, change the builder, not the example.

## What kind of module is it

| What you are adding | It is | Written as | Copy |
| --- | --- | --- | --- |
| A part each game supplies under a name of its own | a **declaration** | a builder that returns a class | [`game/event.ts`](../packages/arcadekit/src/game/event.ts) for a value, [`content/asset.ts`](../packages/arcadekit/src/content/asset.ts) for a service |
| What runs a declaration | a **host** | a plain class or function when a step or a frame calls it; the declaration's `layer` when it has a lifecycle | [`game/loop.ts`](../packages/arcadekit/src/game/loop.ts), the `layer` in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts) |
| Something more a host does | a **capability** of it | a method, with a file of types for what it takes or gives. Its section is [A host](#a-host) | `frame` in [`game/loop.ts`](../packages/arcadekit/src/game/loop.ts), `StepInput` in [`game/step-input.ts`](../packages/arcadekit/src/game/step-input.ts) |
| One thing of the app's that has several implementations | a **service** | a `Context.Service` class, and a named Layer for each implementation | [`audio/service.ts`](../packages/arcadekit/src/audio/service.ts), [`net/browser/coop-rooms.ts`](../packages/arcadekit/src/net/browser/coop-rooms.ts) |
| What a host runs on, with a default that suits most apps | a **reference** | a `Context.Reference` | `Frames` in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts), `CoopTicker` in [`net/browser/coop.ts`](../packages/arcadekit/src/net/browser/coop.ts) |
| Data work, a data structure or a device's reads, that no game names | a **primitive** | a plain function or class | [`core/pool.ts`](../packages/arcadekit/src/core/pool.ts), [`core/rng.ts`](../packages/arcadekit/src/core/rng.ts), [`input/input-controller.ts`](../packages/arcadekit/src/input/input-controller.ts) |
| A Schema that a declaration takes as a field and a host must recognise | a **Schema builder** | a plain function that returns a Schema, marked in its annotations, with a type-only mark for the hosts that ask for it | `Game.PlayerInputs` in [`game/player-inputs.ts`](../packages/arcadekit/src/game/player-inputs.ts) |
| A failure a caller should handle | a **typed error** | a tagged error class: a `message` if an app shows it, a `cause` if it wraps a throw, a `reason` if a caller branches on it | `AttachError` in [`game/attach-error.ts`](../packages/arcadekit/src/game/attach-error.ts) |
| The words a test is written in | a **vocabulary** | a module of plain functions, imported as a namespace | [`game/scenario.ts`](../packages/arcadekit/src/game/scenario.ts) |

The test for a declaration: would two games each write one, and call it something of their own? Events, a simulation, an engine, content: yes. The audio system, the frame clock, a pool: no.

A game never calls a `make…` or `create…` function to supply one of its parts: a new declaration moves a factory's callers and deletes it. First look for one that fits (the audio settings are a `Setting` of the kit's Schema and default) and for who needs it: a `CueTable` hands a genre package the app's sounds, so a game that owns its sounds declares none.

## A declaration

A game writes `class <Name> extends <Builder>("<Name>", { ... }) {}`, and that statement is the whole part: its value, its type and its definition, under one name.

### The builder's file

Top to bottom:

1. **The types a game's code names.** What a value or the service looks like (`EventInstance`, `Loaded`), and for a service its key's type and its identity.
2. **`<Noun>Class`.** An interface with everything the returned class has. It is the builder's written return type: what a reader and the type files see.
3. **The doc comment.** What the part is, in the glossary's words, then a `ts` example that declares one and uses it, then what the builder refuses if it throws when declared.
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
- **A builder is a singular noun**: `Event`, `Asset`.
- **What a game declares**: an event in the past tense (`LevelSolved`), a sample for what it shows (`Hud`), a command in the imperative (`ChooseUpgrade`), a rejection by what is wrong (`OfferClosed`), a simulation by the game's name (`PushPuzzle`), an asset or a setting by the game and the thing (`PushPuzzleSheet`, `PushPuzzleAudioSettings`), anything else by the game and the builder's noun (`PushPuzzleEngine`).
- **The kit's words are taken**, each in its place. A definition: `input`, `events`, `commands`, `rejects`, `create`, `step`, `apply`, `sample`, `stepSeconds`, `simulation`, `uses`, `view`, `schema`, `files`, `validate`, `release`, `engine`, `content`, `picks`, `config`, `maxPlayers`, `hash`, `ends`, `lockstep`, `storageKey`, `field`, `record`, `mergeRecord`, `default`, `merge`, `cues`. A context: `seed`, `report`, `dt`, `step`, `player`, `local`. A class: `kind`, `tag`, `definition`, `load` (keeps its first success), `read` (keeps nothing), `layer`, `match`, `merge`. A service: `read`, `write` (stores; a save's merges), `attach`, `listen`, `start`, `send`, `setPaused`, `stop`, `host`, `join`, `choose`, `leave`, `debug`. A new declaration uses the ones that fit, and adds a word only for a new idea. One made from another may take its word for a part of the same thing, and says so: a `Coop`'s `input`.
- **Check Effect's and Foldkit's exports before settling a name a file writes bare.** A word one of them uses for something else is taken there: Foldkit's `Story` is why the kit's is `Scenario`. Behind a namespace a name may clash: `Game.Command`, beside Foldkit's.
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
- [ ] The README block from [the first step](#start-from-the-games-side) is in the entry's README, and `pnpm build:packages && pnpm smoke --no-build` compiles it.
- [ ] A game uses the module as that block shows: push-puzzle or its demo, or a small game declared in the module's test.
- [ ] A simulation's rules are checked by scenarios, anything else by tests beside it; its types by `expectTypeOf` and `@ts-expect-error`, and every refusal's message by a test.
- [ ] The glossary has its term. A choice that was hard to make, or that the next reader would otherwise undo, has an ADR. Both tables of entries (`README.md`, `packages/arcadekit/README.md`) follow an entry's exports.
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
| No new factory without a reason | the style test's `FACTORIES` and `NOT_YET_DECLARED` |
| Library code runs no Effect itself | lint: `Effect.run…` and `ManagedRuntime.make` are refused in `packages/*/src`, outside what a test imports and the worker's entry points. The `…With` forms pass |
| The simulation reads no clock or random source, and a genre's uses only exact math | lint, on the root entry of every genre package. The first also on `arcadekit/game` but its engine and its frame clock: `oxlint.config.ts` lists the other plain files of the kit, so add a new one there |
| A module exports no `then` | lint: `unicorn/no-thenable` |
| Which entry may import which, and which packages | lint's `ENTRY_IMPORTS`, [`packages/arcadekit/test/entry-packages.test.ts`](../packages/arcadekit/test/entry-packages.test.ts) |
| A README's examples compile | `pnpm smoke` |
| Every export of the kit has a written type | the build (`isolatedDeclarations`) |

[`tools/lint/declaration.test.ts`](../tools/lint/declaration.test.ts) runs the linter on a case for each `declaration/…` rule: a new rule gets its cases there, and a new builder gets its own by being registered. The rules are on in tests too: a test's small game is what the next one copies. A test that has to declare what a builder refuses says so on the line: `// oxlint-disable-next-line declaration/class -- <why>`.
