---
name: declarations
description: Declaration builders and their hosts. Use when adding or changing a declaration builder (`Game.Event`, `Content`, `Coop`, `Save`…), the definition a game writes for one, or the host that runs it.
---

A game writes `class <Name> extends <Builder>("<Name>", { ... }) {}`, and that statement is the whole part: its value, its type and its definition, under one name. The kit's own source is checked with `isolatedDeclarations`, so it names a declaration's base first, with its type written out (`const ScoreBase: Game.EventClass<...> = Game.Event(...)`, then `class Score extends ScoreBase {}`), as [`net/testing/test-game.ts`](../../../packages/arcadekit/src/net/testing/test-game.ts) does. [`content/asset.ts`](../../../packages/arcadekit/src/content/asset.ts) is the builder to copy, and the push-puzzle demo's genre (`apps/push-puzzle-demo/src/push-puzzle`) the game. The module around a builder follows the kit-modules skill.

## Start from the game's side

Write the block a game would write before the code that makes it work: the `ts` example for the entry's README, as a small game of its own (`Race`), since `pnpm smoke` compiles each block alone. The design is done when that block needs no type argument but the types given first, no annotation on a handler's parameter but `create`'s config, no cast, no second statement to finish declaring the part, and nothing for a part the game doesn't use. If it needs one, change the builder, not the example.

## The builder's file

Top to bottom:

1. The types a game's code names: what a value or the service looks like, and for a service its key's type and its identity.
2. `<Noun>Class`: an interface with everything the returned class has, the builder's written return type.
3. The doc comment (the doc-comments skill), whose example declares one and uses it, with "Throws when declared" if the builder throws.
4. The builder, last.

## The builder

- It takes `(name, definition)`, or `(tag, fields)` then `options` for a class that is a Schema, and its file exports it under its noun (`Content`). `arcadekit/game` exports its builders as `make` in each file and names them in its public file (`export const Event: typeof makeEvent = makeEvent`), so a game writes `Game.Event`.
- The name is typed by a type parameter (`<Name extends string>`), or two declarations share one type and two services one identity.
- A type nothing in the definition carries comes first, in an empty call, as `Context.Service` takes it: `Asset<SpriteSheet, SpriteSheetError>()("PushPuzzleSheet", { ... })`.
- Other type parameters are words (`Config`, `State`) or a letter with one meaning: Effect's `A`, `E`, `R`, `F` for fields, `S` for a Schema, `U` for `uses`.
- It returns a class with `static readonly kind = "<Noun>" as const`, the name (`tag`, or `<noun>Name`, never `name`), and what a host reads from the definition. The result is cast to its written type: `return class ... as unknown as <Noun>Class<...>`.
- The entry's public file exports `<Noun>Class` with it, and where it has them `Any<Noun>`, the definition's type, `<Noun>Id` and `<Noun>Service`.

## A declaration with a service

The class is the service's key:

- The key is `` `arcadekit/<folder>/<Noun>/${name}` `` as `<Noun>Id<Name>`, and its identity `<Noun>Service`, a `Context.ServiceClass.Shape<Id, Service>`.
- `layer` provides it and loads nothing until the first use. It takes what the app knows, as its argument (`layer(source)`) or as a service it reads (`CoopRooms`), once: the service's Effects require none of it.
- A service that is one Effect has it as a static (`PushPuzzleSheet.load`). One with methods is reached with `yield* PushPuzzleEngine`.
- No field of a definition has the name of a static the class has for something else: a service's has `key`, so a storage key is `storageKey`.

## Register it

Name the builder in the sentence of `.agents/AGENTS.md` that begins "They are" and in the glossary's **Declaration** entry, and give it a README block, a doc comment and a test that declares one.

## The definition a game writes

- The class is named as it is declared (`class LevelSolved extends Game.Event("LevelSolved", ...)`), and no second class extends it.
- One object. A field holds data, a Schema, another declaration's class (`simulation: PushPuzzle`, `events: [LevelSolved]`) or a plain function, never an async function or a generator. TypeScript infers a handler's parameters from the fields beside it, but not through a call or a spread. A `create` written in place comes before the other handlers.
- An Effect is a field's value, which the host runs. Build it piped (`load.pipe(Effect.map(fn))`), since a data-first call can break the inference of the handlers beside it.
- A name a game gives is a key of an object (an event's fields, `files`, `uses`, `cues`).
- A declaration made from another takes its class (`Coop`'s `engine`), and every type from it.
- What handlers share is a named field the host resolves and passes in: `uses` in `Game.Engine`.
- A handler's parameters come in one order: what it acts on, what it acts with, then one context object the host fills: `step(state, input, { dt, report })`. Something new a handler needs is a new field of that context.
- A handler that changes state returns `Nothing` ([`game/simulation.ts`](../../../packages/arcadekit/src/game/simulation.ts)), so returning the next state, a promise or an Effect is a type error.
- A game reads its types from the class (`StateOf<typeof PushPuzzle>`, `PushPuzzle.match({ ... })`), and a type that reads a class takes `Any<Noun>`.
- `NoInfer<T>` goes on a handler's parameter or result that another field decides, as the view's state in [`game/engine.ts`](../../../packages/arcadekit/src/game/engine.ts).
- The kit's words are taken, each in its place: `input`, `events`, `commands`, `rejects`, `create`, `step`, `apply`, `sample`, `uses`, `view`, `schema`, `files`, `load`, `read`, `layer`, `match` and the rest the existing declarations use. Reuse the one that fits; add a word only for a new idea.

## A host

- It takes the declaration and nothing a game would repeat: `Game.makeLoop(PushPuzzle)`, `PushPuzzleEngine.layer`, `Scenario.make(PushPuzzle)`.
- It owns what every game would otherwise write: the event buffer, the command queue, the sample, what an attach acquires and releases.
- One way to do each thing. Replace the path that exists rather than add a second path or an option that switches behaviours.
- What it does besides its work only watches: a listener changes nothing a handler is given.
- Its time comes from its caller (`nowMs` in `Game.Loop`, `Frames` in the engine), so a test drives it with no timer and no browser.
- An Effect that waits ends when what it waits on ends, and interrupting it takes back what hasn't happened: `engine.send` fails with `CommandDropped` when its run ends first.

## Refusing a mistake

At the earliest moment that can see it, in this order:

1. A type error, for whatever the definition itself shows (`RequireApply` in `game/simulation.ts`). A test holds each one with `// @ts-expect-error` on the line above.
2. A throw when the part is declared, as the module loads: `Simulation "Jar" declares the command "Deposit" but has no apply.Deposit to handle it`.
3. A throw from the host, for what a cast gets past the types: `Game.Loop` throws on a handler's stray return.

Never drop a mistake in silence. A refusal throws `Error`, or `RangeError` for a number out of range, never `TypeError`, and its message names the declaration and says what to write.
