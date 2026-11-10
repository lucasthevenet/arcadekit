# Code style

How a module of the kit is written, so the next one reads like the ones beside it. The kit is meant to be learned from: a game written with it shows its parts by name, and the kit's own source shows how each part works.

[`AGENTS.md`](../AGENTS.md) has the two rules the rest follows from, "A game is declared" and "Effect and plain code". This page is the detail for whoever adds a module or reshapes one. [What checks it](#what-checks-it) lists the rules that lint and a test enforce: prefer a new rule there to a new sentence here.

## Start from the game's side

Write the block a game would write before the code that makes it work: the `ts` example for the entry's README, with push-puzzle's names. The design is done when that block needs:

- no type argument, apart from [types given first](#the-builder);
- no annotation on a handler's parameter;
- no cast;
- no second statement to finish declaring the part.

If it needs one of them, change the builder, not the example.

## What kind of module is it

| What you are adding | It is | Written as | Copy |
| --- | --- | --- | --- |
| A part each game supplies under a name of its own | a **declaration** | a builder that returns a class | [`game/event.ts`](../packages/arcadekit/src/game/event.ts) for a value, [`content/asset.ts`](../packages/arcadekit/src/content/asset.ts) for a service |
| What runs a declaration | a **host** | a plain class when a step or a frame calls it; the declaration's `layer` when it has a lifecycle | [`game/loop.ts`](../packages/arcadekit/src/game/loop.ts), the `layer` in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts) |
| One thing of the app's that has several implementations | a **service** | a `Context.Service` class, and a named Layer for each implementation | [`audio/service.ts`](../packages/arcadekit/src/audio/service.ts) |
| A setting with a default that suits most apps | a **reference** | a `Context.Reference` | `Frames` in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts) |
| Data work, or a data structure, that no game names | a **primitive** | a plain function or class | [`core/pool.ts`](../packages/arcadekit/src/core/pool.ts), [`core/rng.ts`](../packages/arcadekit/src/core/rng.ts) |
| A Schema that a declaration takes as a field and a host must recognise | a **Schema builder** | a plain function that returns a Schema, marked in its annotations, with a type-only mark for the hosts that ask for it | `Game.PlayerInputs` in [`game/player-inputs.ts`](../packages/arcadekit/src/game/player-inputs.ts) |
| A failure a caller should handle | a **typed error** | a tagged error class with a `reason` | `CommandDropped` in [`game/command.ts`](../packages/arcadekit/src/game/command.ts) |
| The words a test is written in | a **vocabulary** | a module of plain functions, imported as a namespace | [`game/scenario.ts`](../packages/arcadekit/src/game/scenario.ts) |

The test for a declaration: would two games each write one, and call it something of their own? Events, a simulation, an engine, content: yes. The audio system, the frame clock, a pool: no.

A game never calls a `make…` or `create…` function to supply one of its parts. The kit still exports a few from the older contract, and that list only gets shorter.

## A declaration

A game writes `class <Name> extends <Builder>("<Name>", { ... }) {}`, and that statement is the whole part: its value, its type and its definition, under one name.

### The builder's file

Top to bottom:

1. **The types a game's code names.** What a value or the service looks like (`EventInstance`, `Loaded`), `Any<Noun>` when another declaration takes one, and the service's identity when it has one.
2. **`<Noun>Class`.** An interface with everything the returned class has. It is the builder's return type, written by hand, and it is what a reader and the type files see.
3. **The doc comment.** What the part is, in the glossary's words, then a `ts` example that declares one and uses it.
4. **The builder.**

### The builder

- **`(name, definition)`**, and it is exported as `make`. The entry's `index.ts` gives it its noun (`export const Event: typeof makeEvent = makeEvent`), so a game that imports the entry as `Game` writes `Game.Event`. An entry with one or two declarations exports the builder under its noun (`Content`, `Asset`).
- **The name is typed by a type parameter**: `<Name extends string>(name: Name, ...)`, or `Tag` when it is the `_tag` of the class's values, so each declaration's type carries its own name. Typed `string`, two declarations share one type, and two services one identity.
- **Types given first.** A type that nothing in the definition carries comes first, in an empty call, as `Context.Service` takes it: `Asset<SpriteSheet, SpriteSheetError>()("PushPuzzleSheet", { ... })`. Every other type is inferred.
- **It returns a class** with `static readonly kind = "<Noun>" as const`, the name, and what a host reads from the definition (`definition`, `simulation`, `rejects`). The name's static is `tag` for a `_tag`, and `<noun>Name` otherwise (`simulationName`). `name` is taken: a class has one already, and a minifier changes it.
- **Its result is cast to its written type**: `return class ... as unknown as <Noun>Class<...>`. The base is named before the class extends it (`const Key = ...; return class extends Key { ... }`), so the class reads as its statics alone.
- **It checks, when declared, what the types can't**, and throws: [refusing a mistake](#refusing-a-mistake).

### A declaration with a service

The class is the service's key, as in [`content/asset.ts`](../packages/arcadekit/src/content/asset.ts):

- The key is `` `arcadekit/<entry>/<Noun>/${name}` ``.
- The service's identity is `Context.ServiceClass.Shape<Id, Service>`: the type of the class's own values. So the class names the requirement, and `Layer.Layer<PushPuzzleEngine>` reads as it does for a hand-written service.
- `layer` provides it. Building the layer loads nothing; the first use does.
- An Effect every caller would otherwise write is a static of the class: `PushPuzzleSheet.load` for `(yield* PushPuzzleSheet).load`.

### Register it

Add the builder to `DECLARATIONS` in [`packages/arcadekit/test/style.test.ts`](../packages/arcadekit/test/style.test.ts) and to `DECLARATION_BUILDERS` in [`tools/lint/declaration.ts`](../tools/lint/declaration.ts), with its entry in `BUILDER_ENTRIES` there if no builder came from that entry before. Lint and the test then say what the declaration still lacks.

## The definition a game writes

- **One flat object.** A field holds data, a Schema, another declaration's class (`simulation: PushPuzzle`, `events: [LevelSolved]`) or a plain function. TypeScript infers a handler's parameters from the fields beside it only while the handler is a field itself. Inside a call, an Effect or a nested generic, inference stops and the game has to annotate.
- **What handlers share is a named field** that the host resolves and passes in: `uses` in `Game.Engine`.
- **A handler is a plain function**, and what hosts it is Effect ("Effect and plain code" in `AGENTS.md` says which code is which).
- **A handler's parameters come in one order**: what it acts on, what it acts with, then one context object the host fills. `step(state, input, { dt, report })`, `apply.Deposit(jar, command, { player })`, `view(container, uses)`. Something new a handler needs is a new field of that context.
- **A handler that changes state returns `Nothing`** ([`game/simulation.ts`](../packages/arcadekit/src/game/simulation.ts)), a type no value has by accident, so returning the next state, a promise or an Effect is a type error. Its host refuses the same at run time.
- **A game reads its types from the class**: `StateOf<typeof PushPuzzle>`, `PushPuzzle.match({ ... })`. The builder carries them on a `"~types"` field that exists only as a type.
- **`NoInfer<T>`** goes on a parameter that is checked against a type another field decides: the `view`'s state in [`game/engine.ts`](../packages/arcadekit/src/game/engine.ts).

## A host

- **It takes the declaration, and nothing a game would repeat**: `new Game.Loop(PushPuzzle)`, `PushPuzzleEngine.layer`, `Scenario.make(PushPuzzle)`.
- **It owns what every game would otherwise write**: the event buffer, the command queue, the sample, what an attach acquires and releases. Lines a second game would copy from the first belong in the host.
- **One way to do each thing.** A run changes only at a step; an asset loads only through `load`. Replace the path that exists; a second path, or an option that switches between two behaviours, is two things to learn.
- **Its time comes from its caller**: `nowMs` in `Game.Loop`, `Frames` in the engine. A test then drives it with no timer and no browser.
- **An Effect that waits ends when what it waits on ends, and interrupting it takes back what hasn't happened.** `engine.send` fails with `CommandDropped` when its run ends first, and an interrupted send removes its command from the queue.
- **App code never runs in the middle of the host's work.** `Game.Loop` tells a sender how its command ended once it is out of the frame, and the engine resumes the sender after a yield, so the line after `yield* engine.send(...)` may start or stop a run.

## Names

- **The glossary's word**, the same in code, docs, tests and messages ([`CONTEXT.md`](../CONTEXT.md)). A new concept gets its term in the same change, with the words to avoid.
- **A builder is a singular noun**: `Event`, `Asset`.
- **What a game declares**: an event in the past tense (`LevelSolved`), a command in the imperative (`ChooseUpgrade`), a rejection by what is wrong (`JarFull`), a simulation by the game's name (`PushPuzzle`), anything else by the game and the noun (`PushPuzzleEngine`, `PushPuzzleContent`).
- **The definition's words are taken**: `create`, `step`, `apply`, `report`, `send`, `sample`, `uses`, `view`, `input`, `load`, `layer`, `match`. A new declaration uses the ones that fit, and adds a word only for a new idea.
- **Check Effect's and Foldkit's exports before settling a name.** A word one of them uses for something else, in a file that would import both, is taken: Foldkit's `Story` is why the kit's is `Scenario`.
- **A module imported as a namespace exports no `then`.** The namespace would be a thenable, and under vitest a test file that imports it never starts.

## Refusing a mistake

At the earliest moment that can see it, in this order:

1. **A type error.** A test holds each one: `// @ts-expect-error` on the line directly above the wrong line.
2. **A throw when the part is declared**, as the module loads: `Simulation "Jar" declares the command "Deposit" but has no apply.Deposit to handle it`.
3. **A throw from the host**, for what a cast gets past the types: `Game.Loop` throws on a handler's stray return.

Never drop it in silence. A message names the declaration and says what to write. A test holds each message.

A failure the caller should handle is a different thing: a typed error, in the Effect's error channel.

## Done when

- [ ] `pnpm check`, `pnpm typecheck` and `pnpm test` pass.
- [ ] The README block from [the first step](#start-from-the-games-side) is in the entry's README, and `pnpm build:packages && pnpm smoke --no-build` compiles it.
- [ ] A game uses the module as that block shows: push-puzzle or its demo, or a small game declared in the module's test.
- [ ] Its rules are checked by scenarios, its types by `expectTypeOf` and `@ts-expect-error`, and every refusal's message by a test.
- [ ] The glossary has its term. A choice that was hard to make, or that the next reader would otherwise undo, has an ADR.
- [ ] A changeset says what breaks.

## What checks it

What one file shows is a lint rule, in [`tools/lint/declaration.ts`](../tools/lint/declaration.ts) or [`oxlint.config.ts`](../oxlint.config.ts). What takes several files is a test, [`packages/arcadekit/test/style.test.ts`](../packages/arcadekit/test/style.test.ts). A rule of this page that can be checked gets a check, and each check's message says what to write.

| Rule | Checked by |
| --- | --- |
| A declaration is a class with the name it is declared with, and no second class extends it | lint: `declaration/named`, `declaration/class`. They find a builder by what the file imports, under any local name |
| A builder is given no type argument, apart from types given first | lint: `declaration/inferred` |
| A function in a definition is not async and not a generator | lint: `declaration/plain-handler` |
| A step or an `apply` returns nothing | the `Nothing` type, and `Game.Loop` at run time |
| New code is written with the declarations | lint: `declaration/older-contract` |
| A builder's shape: the name first, typed by a type parameter, `kind` and the name as statics, `<Noun>Class` written out and exported with the statics the class sets, the base named, one builder for each kind | lint: `declaration/builder`, on the kit's source |
| Every builder is listed, and has its doc comment, its README block, its glossary term and a test that declares one. A service's key, identity and `layer` | the style test's `DECLARATIONS` |
| No new factory without a reason | the style test's `FACTORIES` |
| Library code runs no Effect itself | lint: `Effect.run…` and `ManagedRuntime.make` are refused in `packages/*/src`, outside what a test imports |
| The simulation reads no clock or random source, and uses only exact math | lint, on the root entry of every genre package and on `arcadekit/game` but its engine. `oxlint.config.ts` lists the other plain files of the kit: add a new one there |
| A module exports no `then` | lint: `unicorn/no-thenable` |
| Which entry may import which, and which packages | lint's `ENTRY_IMPORTS`, [`packages/arcadekit/test/entry-packages.test.ts`](../packages/arcadekit/test/entry-packages.test.ts) |
| A README's examples compile | `pnpm smoke` |
| Every export of the kit has a written type | the build (`isolatedDeclarations`) |

[`tools/lint/declaration.test.ts`](../tools/lint/declaration.test.ts) runs the linter on a case for each `declaration/…` rule: a new rule gets its cases there. The rules are on in tests too, since a test's small game is what the next one copies. A test that has to declare what a builder refuses says so on the line: `// oxlint-disable-next-line declaration/class -- <why>`.

The rest of this page is checked by review.
