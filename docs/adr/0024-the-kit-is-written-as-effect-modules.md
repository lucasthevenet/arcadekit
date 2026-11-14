---
status: accepted
---

# The kit is written as Effect's modules are, and is plain only where correctness needs it

> Amended on 2026-11-13, by what [`arcadekit/input`'s rework](https://github.com/lucasthevenet/arcadekit/pull/100) found, and the text below says so where it changed. Host events a frame or a step reads as state keep plain listeners; a resource that a plain handler makes has its host's lifecycle; every rework's records keep their wording, as core's did; and a module's constants are camelCase.
>
> Amended on 2026-11-14, when `arcadekit/net` took Effect's shape: the WebRTC transport the table below names is `RtcTransport.fromLinks`, and `dataChannelText` is in `net/browser/internal/`.

The kit is an Effect library: `effect` is its one required peer, and every game on it is an Effect program. Its modules were not written as Effect's are. Each took a shape of its own: a class with methods (`StateHasher`, `SpatialGrid`, `FixedStepClock`, `RingReader`), a factory that returns an object of closures (`createPool`, `makeRng`), loose functions (`clamp`, `hypot2`), each documented its own way. A reader who knows `MutableRef` or `Option` learned the kit module by module, and an agent writing a new module had nothing to copy but the module beside it.

[ADR-0017](0017-effect-at-the-edges-plain-code-inside.md) also kept much of the kit plain, for two kinds of reason. One is correctness: a step gives the same bits on every peer, finishes in the call, and reads no clock or random source of its own ([ADR-0011](0011-a-step-uses-only-exact-math.md), and [ADR-0020](0020-a-game-is-declared.md)'s reasons for plain handlers). The other is cost: allocation, a fiber per frame, an Effect per entity. The maintainer has decided that cost no longer decides.

## Decision

### Every module is an Effect module

Every module of the kit is shaped and documented as a module of Effect 4 is. [`docs/code-style.md`](../code-style.md) ("An Effect module") is where the rules are written, once; in short:

- **A namespace per type.** An entry's public file exports each module as a namespace (`export * as Ring from "./ring"`), a game writes `import { Ring } from "arcadekit/core"`, and the type is `Ring.Ring<L>`. A namespace is named for the glossary's word, never for a JavaScript or DOM global or an Effect module: `pool.ts`, `clock.ts` and `hash.ts` would have been `Pool`, `Clock` and `Hash`. An entry a game imports whole (`Game`, `Scenario`) is one module, and its declarations are its callable members.
- **A data type is an interface named after its module**, with a `TypeId` of `~arcadekit/<entry>/<Module>`. It is `Pipeable`, and `Inspectable` where a printed value helps. Its values come from a prototype, its state is in fields, its behaviour is in the module's functions, and an `isX` guard recognises it.
- **Constructors are `make`, `empty` and `fromX`**, and `makeX` for a secondary type. A caller writes `new` only for a Schema class, an error or a declaration.
- **A constant is camelCase**, as Effect's are (`Duration.zero`), unless it is a type as well (`TileMap.Side`).
- **A function takes `self` first, and is `dual` when it takes more**, with both overloads written. An exported function that returns an Effect is `Effect.fn("Module.name")`.
- **Errors are `Schema.TaggedError`s; services and references are `Context.Service` and `Context.Reference`** with a static `layer`.
- **Every export has Effect's doc comment**: a summary, **When to use**, **Details** when there is more to say, an **Example** that compiles, a `@category` from one closed list, and `@since`.

Declarations keep their builders ([ADR-0020](0020-a-game-is-declared.md)): a game still writes `class LevelSolved extends Game.Event(...) {}`. Their builders gain the same doc comment.

Why this shape, and not another:

- **A reader of Effect reads the kit.** `Ring.make`, `Ring.push(ring)` and `ring.pipe(...)` work as `MutableHashMap.make` and `MutableRef.set` do, and the kit's API pages read as Effect's, which are rendered from the same doc comments.
- **One shape to copy, which a test checks.** Each entry's rework is done by copying `arcadekit/core`, and `packages/arcadekit/test/style.test.ts` holds every entry that has moved to the shape, so it can't drift back.
- **A value is data.** A pool, a ring or an `Rng` is fields on a prototype, not a closure: a debugger, a log line or a test prints what it holds, and a guard tells it from a look-alike.
- **Short names that collide with nothing.** Behind a namespace a function can be called `make` or `add`, and the namespace's own name is checked against what a file already has in scope.

### Plain only where correctness needs it

The line between Effect and plain code is drawn by one question: **would we write it plain if performance were free?** Code stays plain for one of these reasons, all of them correctness:

1. **It must give the same bits on every peer and every replay.** A step reads no clock or random source of its own: its time is an argument and its randomness the run's seeded `Rng`. Effect's `Clock` and `Random` are not the run's.
2. **It must finish in the call that runs it.** A step finishes inside the frame or the tick that runs it, and a frame's drawing inside the frame the browser shows. An Effect's type can't say that it finishes: a rule written as one can sleep or wait and keep its type, a synchronous run of one that waits throws, and on a fiber Effect's scheduler cuts a long run after 2,048 operations with no wait written anywhere (ADR-0020). In a step that is a desync; in a frame, a frame drawn late or half.
3. **It is pure data work, of the kind Effect writes plain itself.** Effect's `Array`, `Number` and `MutableRef` are plain functions over data, and so are a pool's, a ring's and the exact math's.
4. **A framework's contract makes it pure.** Foldkit's `update` and `view` return values; their effects are Commands, Subscriptions and Mounts.

Cost is not on the list. Code that was plain only for cost (to save an allocation, a fiber per frame, per tick or per message, or an Effect per entity outside a step) becomes Effect wherever Effect buys something: a lifecycle, interruption, a typed failure in place of a throw, a service, a stream in place of listeners, a span. Where it buys nothing, the code stays plain: no Effect for consistency alone, as Foldkit's rule says.

What did not change: everything with a lifecycle is Effect, untrusted input is decoded with Schema where it arrives, and a failure a caller should handle is a typed error. Plain code meets Effect through the same bridges (`Effect.callback`, `Stream.callback` or a `Queue` fed with `Queue.offerUnsafe`, a runner captured once, and a run at each entry point a platform owns), and library code runs no other `Effect.run*`.

Two more places where plain code meets Effect were written down after `arcadekit/input`'s rework. Host events that a frame or a step reads as state keep plain listeners, which write it during the event's dispatch: on a stream the write would wait for a fiber, which a browser resumes a task later, so a frame could read the state first (2). `Stream.callback` is for events an Effect reacts to. And what a plain handler makes, such as an `input`'s controller, has a plain constructor and `dispose`: the handler can run no Effect, so the resource's lifecycle is the host's `acquireRelease` around the handler's result.

### Each kind of plain code, under the new line

These are the kinds `AGENTS.md` listed as plain on purpose before this decision. Each entry's rework applies its line to its own files, and moves its line in `AGENTS.md`.

| What was plain | Now | Why |
| --- | --- | --- |
| `arcadekit/core`: pools, rings, tile maps, the grid, the clock, the `Rng`, the event buffer, the exact math | Plain | A step calls it, so it gives the same bits (1) and finishes in the call (2), and it is data work (3). Its modules take Effect's shape. Its ledger is in the pull request that reworked it. |
| Each genre's step (`world.ts`, survivors' `hero.ts` and `hash-world.ts`) | Plain | (1) and (2): it is the step. |
| A declared simulation's `create`, `step` and `apply` | Plain | (1) and (2), as ADR-0020 decided for handlers. |
| `Game.Loop` and the kernel under it | Plain where it steps | It runs the steps in its caller's frame or tick (2). What it does around them (its listeners, a sender told of its command) is the game entry's to weigh. |
| The scenarios that check a simulation | Plain | They run the plain loop in one call, and a failed expectation is a test's throw. |
| The step input built from the players' inputs (`player-inputs.ts`) | Plain | Every peer steps on it (1), and it is data work (3). |
| The lockstep protocol (`lockstep.ts`) and a player's step payload codec (`codec.ts`) | Split | The step it runs and the codec whose value every peer steps on stay plain (1, 2). Its ticking, resends, stall timers and listeners were plain for cost ("a fiber resumed per tick makes 1.5 to 3 KB"), so they move to Effect where it buys interruption, a Clock or a stream. |
| Per-frame drawing: render-three's drawing, the genres' views and sound views, a `Game.Engine`'s `view`, `Game.View` and `combineViews` | Plain | A frame draws whole before the browser shows it (2). Their lifecycles are Effect already. |
| Reads of a ring (`RingReader`) | Plain | Data work a view does in its frame (2, 3). |
| Input reads (a `Game.Engine`'s `input`, `InputController`'s reads, a `Coop`'s `input`) | Plain | A step reads its input inside the frame or tick that runs it (2). The listeners that fill a controller were plain for cost, and stay plain for (2): they write what they hear during the event's dispatch, where a stream would write it a task later, after a frame may have read the controller. Adding and removing them is the host's `acquireRelease` around the input source, since the `input` handler that makes the controller can run no Effect. |
| The `FrameSource` adapter | Plain | It is the bridge: the host's callback, which `Effect.callback` waits on. |
| The audio mixer's play calls | Plain | A sound view calls them inside its frame (2). The mixer's lifecycle is Effect. |
| Per-message channel code (`dataChannelText`, `RtcTransport.fromLinks`) | Effect | Plain for cost (a fiber per message). Messages become a stream or a queue where that buys a lifecycle or interruption. What a plain tick calls stays a plain call while the tick is plain. |
| Rules behind an Effect shell: `room-state.ts` and the worker's `room.ts` | Plain | Reducers: inputs in, outputs out, a rejection as a value (3). |
| The worker's `sockets.ts`, which carries out a room's outputs on its sockets | Effect | It does I/O, plain for cost; Effect buys a typed failure and a span. |
| Foldkit's `update` and `view` | Plain | (4). |

### Performance is deferred

The rework is not slowed down to keep the kit fast. `pnpm bench` (`scripts/bench/`) times survivors' step, an engine's frames and a lockstep run's ticks and counts what they allocate, and [`docs/perf-baseline.md`](../perf-baseline.md) holds their numbers from before the rework. Each entry's rework gives its numbers against that table in its pull request. Making them fast again is later work, measured against the same table.

## Considered Options

- **Keep ADR-0017's line**, with cost as a reason for plain code. Rejected by the maintainer: it kept code out of Effect that a scope, an interruption or a typed failure would serve, to save costs that can be measured and fixed later. The correctness half of its reasons is kept whole.
- **Effect everywhere, the step included.** Rejected again, for ADR-0020's reasons, which are correctness: an Effect's type can't say a step finishes in the call, and Effect's `Random` is not the run's seeded `Rng`.
- **Effect's doc comments without its module shape**, keeping the classes and factories. Rejected: what the next module copies is the code, not its comment, and a class with methods can't be piped or checked by a guard.
- **A namespace per entry** (`import * as Core from "arcadekit/core"`, `Core.makePool`). Rejected: the names are a type's (`Ring.make`, `Ring.push`), which a namespace per entry would have to prefix, as the factories did.
- **The doc comment on each overload of a `dual` function**, as Effect writes it. Rejected: the same text twice on every function, kept equal by hand. The comment is on the export, which is what an editor shows and the API page renders.

## Consequences

- **Every entry changes its exports, one at a time.** `arcadekit/core` changed first and is the reference. The others are listed in `NOT_YET_EFFECT_STYLE` in the style test, and each leaves the list in the change that reworks it. An entry off the list is checked: its public file exports namespaces, and every export has the doc comment's parts with a category from the list.
- **`pnpm smoke` compiles the doc comments' examples** of every entry off the list, as it compiles the READMEs'.
- **Core's names changed** with its shape, and so did every caller's, with no alias left behind. `pool.ts`, `clock.ts` and `hash.ts` were renamed so their namespaces collide with nothing, and so were `math.ts` (`Math` is the platform's), `events.ts` (`Event` is the DOM's), `ease.ts`, `timers.ts` and `grid.ts`, to the word their module holds. The glossary has a term for each module. The earlier ADRs that named core's API use the new names, each with a note that says so. The findings, the research notes and the changelog keep their wording, as [ADR-0018](0018-one-package-with-entries.md)'s did: read their names through the table below.

  | Before | Now |
  | --- | --- |
  | `createPool`, `Pool<L>`, `pool.add()`, `pool.remove(i)`, `pool.clear()` | `EntityPool.make`, `EntityPool.EntityPool<L>`, `EntityPool.add(pool)`, `EntityPool.remove(pool, i)`, `EntityPool.clear(pool)` |
  | `createIdentifiedPool`, `IdentifiedPool<L>`, `idOf`, `indexOf`, `addWithId` | `EntityPool.makeIdentified`, `EntityPool.Identified<L>`, `EntityPool.idOf`, `EntityPool.indexOf`, `EntityPool.addWithId` |
  | `PoolLayout`, `PoolFields<L>` | `Layout.Layout`, `Layout.Fields<L>` |
  | `visitPool(pool, visit)` | `EntityPool.visit(pool, f)` |
  | `createRing`, `Ring<L>`, `push`, `pop`, `slotOf`, `clear` | `Ring.make`, `Ring.Ring<L>`, `Ring.push`, `Ring.pop`, `Ring.slotOf`, `Ring.clear` |
  | `new RingReader()`, `reader.take(ring)`, `reader.reset()` | `RingReader.make()`, `RingReader.take(reader, ring)`, `RingReader.reset(reader)` |
  | `createTileMap`, `TileMap<L>`, `Side`, `cellAt`, `colOf`, `rowOf`, `neighbor`, `flood` | `TileMap.make`, `TileMap.TileMap<L>`, `TileMap.Side`, and `TileMap.cellAt(map, …)` and so on |
  | `new SpatialGrid(options)`, `SpatialGridOptions`, `build`, `query`, `within`, `nearest` | `SpatialGrid.make(options)`, `SpatialGrid.Options`, `SpatialGrid.build(grid, …)` and so on |
  | `new FixedStepClock(stepSeconds, maxStepsPerFrame)`, `advance`, `reset` | `FixedStepClock.make({ stepSeconds, maxStepsPerFrame })`, `FixedStepClock.advance(clock, …)`, `FixedStepClock.reset(clock)` |
  | `makeRng(seed)`, `Rng`, `rng.next()`, `int`, `range`, `pickDistinct` | `Rng.make(seed)`, `Rng.Rng`, `Rng.next(rng)`, `Rng.int`, `Rng.range`, `Rng.pickDistinct` |
  | `new EventBuffer<E>()`, `push`, `drain` | `EventBuffer.make<E>()`, `EventBuffer.push(buffer, event)`, `EventBuffer.drain(buffer)` |
  | `new StateHasher()`, `number(value)`, `digest()`, `reset()` | `StateHash.make()`, `StateHash.add(hash, value)`, `StateHash.digest(hash)`, `StateHash.reset(hash)` |
  | `clamp`, `lerp`, `hypot2`, `sin`, `cos`, `powInt`, `hashCell` | `ExactMath.clamp` and so on |
  | `Point2`, `clampLength(x, y, max, out)`, `moveToward(x, y, tx, ty, step, out)` | `Point2.make(x, y)`, `Point2.clampLength(out, x, y, max)`, `Point2.moveToward(out, x, y, tx, ty, step)` |
  | `countDown`, `takeWhole` | `Timer.countDown`, `Timer.takeWhole` |
  | `progress`, `easeIn`, `easeOut`, `easeOutCubic`, `smoothstep` | `Tween.progress` and so on |

- **Each rework renames as core's did.** Every caller and every living doc moves to the new names in the same change, with no alias, and an earlier ADR that names the API gets a note that says so. The records keep their wording: the changelog, the findings (`docs/push-puzzle-findings.md`, `docs/co-op-findings.md`), `docs/architecture-review.md` and the research notes (`docs/research/`). A rework's search for its old names leaves them out, and its changeset has the table of old and new names to read them through.
- **The kit is slower for a while.** A `dual` function costs a call, and Effect costs fibers and allocations where code moves to it. Each rework reports by how much.
- **The replay and determinism hashes don't move.** A step does the same arithmetic in the same order, behind new names.
- [ADR-0017](0017-effect-at-the-edges-plain-code-inside.md) is amended by this decision: its line between Effect and plain code is this one.
