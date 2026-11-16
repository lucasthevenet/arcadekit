# Code conventions

How code in arcadekit is written, so that it reads like Effect code and like the rest of the package. Read this before adding or changing a module.

When this guide and Effect's own guidance disagree, this guide wins inside the simulation (the storage core and anything a tick runs), because that code has constraints Effect's guidance does not have in mind. Everywhere else, Effect's guidance wins and the disagreement is a bug in this guide.

## Where to look things up

In this order:

1. **The installed source.** `packages/arcadekit/node_modules/effect/src/<Module>.ts` is the version this repository builds against, and every export has a doc comment with examples. It cannot be out of date.
2. **Effect's guide for writing Effect code**, [LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md), and the runnable examples it links to under [ai-docs/src](https://github.com/Effect-TS/effect/tree/main/ai-docs/src). This is the closest thing Effect has to a house style.
3. **The v4 documentation**: the [guides](https://effect.website/docs/v4/guides) and the [API reference](https://effect.website/docs/v4/api/effect).
4. **The migration notes**, [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md), when something you remember from Effect 3 does not exist. Most tutorials, answers and examples on the web are Effect 3. See [Effect 3 habits](#effect-3-habits-that-do-not-exist-in-effect-4).

Do not use any other copy of Effect's documentation. Effect's own guide says the same: mirrors and older pages are often wrong for v4.

## Two kinds of code

Everything in the package is one of two kinds, and the first decision for any new code is which.

|  | Plain code | Effect code |
| --- | --- | --- |
| Where | `src/ecs/`, and the inside of any loop that runs once per entity | Everything else |
| Looks like | Synchronous functions and classes, typed arrays, mutation | `Effect.gen`, services, layers, typed errors |
| May import `effect` | No | Yes |
| Why | It runs tens of thousands of times a tick. One Effect per entity measured about 25 times slower than a loop over columns. | It runs a handful of times a tick, and needs what Effect gives: dependencies, typed failure, resources, cancellation. |

The boundary is the system. A system is one Effect per tick; the loops inside it are plain.

```ts
const Movement = System.make("Movement", function* () {
  // Effect code: ask for what the system needs.
  const moving = yield* Moving;
  const { delta } = yield* Time;
  // Plain code: no `yield*` in here, however convenient it would be.
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
  });
});
```

If a loop body needs a service, take it out of the service before the loop and call it as a plain function inside.

## Modules and names

Effect's convention, kept as it is:

- **One module per concept, named in PascalCase**, imported as a namespace: `src/Query.ts` is used as `Query.all(...)`, `Query.without(...)`. A module's functions are named for how they read after the namespace, so `System.make`, not `System.makeSystem`.
- **Functions, not methods**, for anything a user composes. A function tree-shakes and takes part in `.pipe()`; a method does neither. Methods are for the plain objects a hot loop touches (`view.each`, `commands.spawn`).
- **Constructors are `make`** (`System.make`, `Plugin.make`, `App.make`). A declaration the user writes once at module level, with a name that identifies it at run time, is `define` (`Component.define`, `Event.define`, `Action.define`).
- **Suffixes mean what they mean in Effect**: `Unsafe` for a call that can throw or skips a check (`fiber.pollUnsafe`), `Option` for a result that may be absent, `Exit` for a result returned as a value, where the plain name throws (`app.tickExit` beside `app.tick`).
- **`ByName`** for the variant of a typed call that takes data from outside (`app.dispatchByName`).
- **Files under `src/ecs/` and `index.ts` are lower case.** They are not namespaces.
- **A string that identifies something at run time is prefixed**: `"arcadekit/World"` for a service, `"physics/Position"` for a component. Two services with the same key silently become one. A component's name is its identity in a world, which refuses a second component with a name it already holds.

Import Effect's modules from the package root, `import { Context, Effect, Layer } from "effect"`, and a single function from its module's path, `import { dual } from "effect/Function"`. See [Importing Effect](https://effect.website/docs/v4/getting-started/importing-effect).

## Writing Effects

- **`Effect.gen` with `yield*`** for a block of Effect code. See [Using Generators](https://effect.website/docs/v4/getting-started/using-generators).
- **`Effect.fn("Module.name")`** for a reusable function that returns an Effect and is worth seeing in a trace. **`Effect.fnUntraced`** for one that is not, which is most of a library's internals. Do not write a function whose whole body is `return Effect.gen(...)`: that is what these two are for. See the [Effect.fn example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/01_basics/02_effect-fn.ts).
- **Not for anything that runs every tick.** `Effect.fn` records a stack trace on each call. A system is built once with `Effect.gen` and the same Effect value is run every tick; `System.make` does this for you.
- **`.pipe()` to add behaviour** to an Effect or a domain value: `effect.pipe(Effect.withSpan("load"), Effect.catchTag("NotFound", ...))`. See [Building Pipelines](https://effect.website/docs/v4/getting-started/building-pipelines).
- **Write the arrow function.** `Effect.map((x) => f(x))`, not `Effect.map(f)`, and no `flow`. Passing a function by name can lose its generics and gives worse stack traces. This is from Effect's [code style guidelines](https://effect.website/docs/v4/code-style/guidelines).
- **Fail with `Effect.fail`, and return it**: `return yield* Effect.fail(new NotYourTurn(...))`. A tagged error can also be yielded on its own (`yield* new NotYourTurn()`), and Effect treats the two alike; this package writes the failure out, so that it reads as one to someone who has not met yieldable errors, and looks the same whatever kind of value the error is. Without `return`, TypeScript does not know the code below is unreachable.

```ts
export const loadLevel = Effect.fn("Level.load")(function* (name: string) {
  const assets = yield* Assets;
  return yield* assets.read(`levels/${name}.json`);
});
```

## Services, resources and layers

- **A service is a class that extends `Context.Service`**, with its interface as the second type parameter. Give it a static `layer` when there is one obvious implementation.
- **A value with a sensible default is a `Context.Reference`** (`Resource.make` in this package). Nothing has to provide it; a layer can override it. Do not mutate a reference's default: it is created once and shared by every app in the process. A resource is configuration. Game state of which there is one is a `Singleton`: it is in the world, so it is saved, hashed, and put back when an action is refused.
- **Services are how code reaches the outside world.** Sound, storage, the network, the clock and randomness are services, never imports of a module that does the work directly. That is what lets a test swap them and a replay control them.
- **A plugin's `layer` is where its services are built.** A layer that needs another plugin's service lists that plugin in `plugins`. A resource is acquired with `Effect.acquireRelease` inside `Layer.effect`, so it is released when the app's scope closes.
- **What the platform gives everywhere is a `Context.Reference` whose default is the platform's.** `Driver.Display` is the screen a frame loop follows: `requestAnimationFrame` in a page, a timer elsewhere. Its default holds nothing, so sharing it is safe, and a test provides one it turns by hand, `Driver.makeManualDisplay()`.
- **Do not build a layer by hand** with `Layer.build`. `App.make` is the one place that does.
- **A program is started with the platform's `runMain`**, `NodeRuntime.runMain` under Node and `BrowserRuntime.runMain` in a browser, which reports a failure and interrupts the program cleanly, closing the app's scope. `Effect.runSync` and `Effect.runPromise` are for tests and benchmarks. Inside a program, an Effect is yielded, never run. See [Running Effects](https://effect.website/docs/v4/getting-started/running-effects); `examples/` are the examples.

```ts
export class Audio extends Context.Service<
  Audio,
  { readonly play: (cue: string) => Effect.Effect<void> }
>()("arcadekit/Audio") {
  static readonly layer = Layer.succeed(Audio, {
    play: (cue) => Effect.log(`play ${cue}`),
  });
}
```

References: [Managing Services](https://effect.website/docs/v4/requirements-management/services), [Managing Layers](https://effect.website/docs/v4/requirements-management/layers), [Layer Memoization](https://effect.website/docs/v4/requirements-management/layer-memoization), [Scope](https://effect.website/docs/v4/resource-management/scope); examples for [a service](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/03_services/01_service.ts), [Context.Reference](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/03_services/10_reference.ts), [composing layers](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/03_services/20_layer-composition.ts) and [acquireRelease](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/05_resources/10_acquire-release.ts); API for [Context](https://effect.website/docs/v4/api/effect/Context) and [Layer](https://effect.website/docs/v4/api/effect/Layer).

## Errors

Effect separates two kinds of failure, and so does this package. See [Two Types of Errors](https://effect.website/docs/v4/error-management/two-error-types).

- **An expected failure is a value in the error channel.** A move that breaks the rules, a payload that does not match its schema, a save file that will not load. Each is a class with a `_tag`, so a caller can handle it by name and the type says what can go wrong:
  - `Data.TaggedError` for an error that stays inside the program.
  - `Schema.TaggedError` for one that has to be written down or sent somewhere, because it can be encoded.
- **A bug is a defect, and is not caught.** Calling `dispatch` during a tick, registering two systems with one name, changing the world while a query is iterating. Synchronous code throws an `Error` whose message says what to do instead; Effect code uses `Effect.die`. Nothing in the package recovers from a defect.
- **Tags are unique across the package.** Two error classes with the same tag are caught by the same `catchTag`, and nothing warns you.
- **Handle by tag**: `Effect.catchTag`, `Effect.catchTags`, or `Effect.catch` for everything expected.

```ts
export class NotYourTurn extends Data.TaggedError("NotYourTurn")<{
  readonly waitingFor: number;
}> {}
```

References: [Expected Errors](https://effect.website/docs/v4/error-management/expected-errors), [Unexpected Errors](https://effect.website/docs/v4/error-management/unexpected-errors), [Yieldable Errors](https://effect.website/docs/v4/error-management/yieldable-errors); [error handling example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/04_errors/01_error-handling.ts); API for [Data](https://effect.website/docs/v4/api/effect/Data) and [Exit](https://effect.website/docs/v4/api/effect/Exit).

## Schema at the boundary

Data that comes from outside the program, or leaves it, has a `Schema`: an action's payload, a save file, a network message. Nothing outside is trusted, and nothing is checked by hand.

- **Derive the type from the schema**, never the other way round: `Action.define("Strike", Schema.Struct({ ... }))` gives the handler its payload type.
- **Decode with the `Exit` forms** (`Schema.decodeUnknownExit`) in synchronous code, so a mismatch is a value and not an exception.
- **Store and send the JSON form.** `Schema.toCodecJson(schema)` gives a codec whose encoded side is JSON, converting the values Schema knows how to convert (a bigint, a date).
- **Use the `Predicate` module** for a type guard that is not worth a schema, not a hand-written `isString`.
- **Inside the simulation there are no schemas.** Component data is columns of numbers. A schema checks what comes in; after that it is trusted.

References: Schema [introduction](https://effect.website/docs/v4/schema/introduction), [basic usage](https://effect.website/docs/v4/schema/basic-usage), [filters](https://effect.website/docs/v4/schema/filters), [canonical codecs](https://effect.website/docs/v4/schema/canonical-codecs) and [class APIs](https://effect.website/docs/v4/schema/classes); the full guide, [SCHEMA.md](https://github.com/Effect-TS/effect/blob/main/packages/effect/SCHEMA.md); API for [Schema](https://effect.website/docs/v4/api/effect/Schema) and [Predicate](https://effect.website/docs/v4/api/effect/Predicate).

## Domain values you can yield and pipe

The package's own values behave like Effect's, using the same three mechanisms.

- **Yieldable.** A value a system asks for is an Effect: `yield* Moving` gives a query's view, `yield* Collided` an event's channel, `yield* Gravity` a resource. A new kind of value like these extends `Effectable.Class` and implements `asEffect()`. `src/Query.ts` and `src/Event.ts` are the examples. API: [Effectable](https://effect.website/docs/v4/api/effect/Effectable).
- **Pipeable.** A value that is refined step by step has `.pipe()`: `Query.all(A).pipe(Query.without(B))`, `System.make(...).pipe(System.after(Other))`. A class that extends `Effectable.Class` has it already; anything else implements `pipe() { return pipeArguments(this, arguments); }`. API: [Pipeable](https://effect.website/docs/v4/api/effect/Pipeable).
- **Dual.** A function that refines a value works both ways: `System.after(system, other)` and `system.pipe(System.after(other))`. Define it with `dual` and write both signatures out. See [Dual APIs](https://effect.website/docs/v4/code-style/dual) and [Function](https://effect.website/docs/v4/api/effect/Function).

```ts
export const inStage: {
  (stage: Stage): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, stage: Stage): System<E, R>;
} = dual(2, <E, R>(self: System<E, R>, stage: Stage): System<E, R> =>
  build(self.name, stage, self.after, self.before, self.run)
);
```

Values like these are immutable descriptions. `System.after` returns a new system; it does not change the one it was given.

## The parts of a game

Each part has one shape. A new feature is made of these, not of a new kind of thing.

| Part | Is | Rules |
| --- | --- | --- |
| Component | Data, declared with `Component.define` | Numbers go in typed fields. Anything else is `Field.json` (plain data), `Field.schema` (a value with a schema) or `Field.transient` (not part of the game's state, so not saved or hashed): a field says which where it is defined. Use `storage: "sparse"` for one that is added and removed often or that few entities have. |
| Relation | A component that points at another entity, declared with `Component.relation` and what a target's despawn does to it | Use it, and not a bare `Field.entity`, for a reference that must not dangle. Its target is changed by adding it again, never by assigning. |
| Singleton | Data of which the world has one, declared with `Singleton.define` and its initial value | Fields as a component's. Listed in a plugin's `components`. Read and written through what `yield*` gives, by a system, a handler or a script. |
| State | One of a few named values a game is in, declared with `State.define` | A singleton, listed in `components`. Changed with `set`, and entered at the start of the next tick. A system that belongs to some states says so with `System.runIf(State.is(...))`; what happens once on the way in or out is a hook, `State.onEnter` or `State.onExit`, not a flag a system checks. |
| System | A generator given to `System.make` | In the tick unless it draws, in which case `System.inStage("frame")`: see [Determinism](#determinism). Finishes within its tick. Changes the set of entities only through `Commands`. Reacts to what changed with a change query (`Query.changed`, `Query.added`, `Query.removed`), not by comparing with a copy it keeps. |
| Event | A fact, declared with `Event.define` and a schema | Named in the past tense, with the feature it belongs to in front: `"physics/Collided"`. Emitted, never awaited by a system. An event with a type and no schema cannot be written down. A system that can be switched off with `System.runIf` does not rely on an event for anything it must not miss, since the events of the ticks it sat out are gone when it runs again: it watches the state, with a change query or a singleton. |
| Action | A request from outside, declared with `Action.define` and a schema | Its handler may refuse at any point: the world takes back what it wrote. It changes which entities exist only through `Commands`, and issues another action only with `Actions.enqueue`. |
| Script | An Effect listed in a plugin's `scripts`, or started with `app.spawnScript`, or with `Script.spawn` from a system | Waits only with `Script.nextTick`, `Script.sleep` or an event's `wait`. Its failure is logged, and stops an app made with `onScriptFailure: "stop"`. A save cannot hold a script in mid-flight: one listed in a plugin starts again after a load, so it keeps what it must not lose in the world. |
| Plugin | `Plugin.make` | Lists the plugins whose services its layer uses, the components its feature stores, and its scripts. `setup` is for a fresh start only: a load has what it spawned. |

Once a game has started, its world changes only through these: a system, an action's handler, a script. Code outside the simulation (UI, the network, a test, the entry point) changes the world with `app.dispatch` or `app.enqueue`, and that is what the log holds. A system, a script or a handler that issues an action uses the `Actions` service, which is not logged: a replay's own simulation issues it again. Calling `app.enqueue` from inside a system would put the action in the log and have it applied twice on replay. What it writes into `app.world` directly is not in the log, so a replay cannot repeat it, and stops at the next checkpoint. Spawning the first entities before the first tick is the exception: that is the state the game starts from.

## Determinism

A tick gives the same result from the same inputs, on every machine and every replay. Code that a tick runs:

- reads time from `Time`, never `Date.now()`, `performance.now()` or Effect's `Clock`;
- waits with `Script`, never `Effect.sleep`, a `Schedule`, a timer or a promise, all of which resume outside the tick;
- takes randomness from `Random` (`const random = yield* Random`, then plain calls such as `random.next()`), never `Math.random()`. The generator's state is in the world, so a replay draws the same numbers. Effect's own `Random` is seeded from it inside an app, at the cost of an Effect per draw;
- does not depend on the order of a `Map` or `Set` it did not fill itself in a fixed order;
- is not what draws. Drawing, and anything else that follows real time, is a system of the frame stage, `System.inStage("frame")`. It runs between ticks with the world frozen, reads real time from `Frame`, and changes nothing: a game that has been drawn is the same game. What it has to remember from one frame to the next (a mesh, a sound that is playing) it keeps in a service of its own, not in the world;
- does not start a fiber with `Effect.forkChild` from a system: a child is interrupted when the tick's fiber ends. Use `Script.spawn`, which the app watches: it reports a failure and interrupts the script when its scope closes. `Effect.forkDetach` also survives the tick, but the app cannot see that fiber, so its failure is silent unless the caller observes it.

The scheduler is why this holds. `src/TickScheduler.ts` replaces Effect's, so a fiber only resumes when the tick flushes it. Do not provide another `Scheduler` to code inside an app. API: [Scheduler](https://effect.website/docs/v4/api/effect/Scheduler), [Fiber](https://effect.website/docs/v4/api/effect/Fiber); guide: [Fibers](https://effect.website/docs/v4/concurrency/fibers).

Events have their own implementation in `src/Event.ts` and do not use Effect's `PubSub`. Each system keeps a read position from one tick to the next, and a refused action has to be able to take back the events it emitted and the reads it made.

## Plain code: the storage core and hot loops

- **No `effect` import in `src/ecs/`.** It is usable, and tested, with no Effect at all.
- **Nothing is shared between worlds.** A world keeps the names of the components it stores; the module holds no registry. The one module-level value is the counter that numbers component definitions, and that number is never saved, hashed or compared between processes.
- **Columns, not objects.** Numeric data is in typed arrays, one per field. Do not allocate inside a per-entity loop.
- **Reads from a column need an assertion**, `pos.x[i]!`, because the repository compiles with `noUncheckedIndexedAccess`. That is what `!` is for here, and almost the only place it belongs.
- **A structural change during iteration throws.** Queue it on `Commands`.
- **Iteration order is fixed**: tables in creation order, rows ascending, whichever strategy finds the rows. A change that makes order depend on data breaks replays.
- **Every way to write component data saves it first, inside a transaction.** `set` saves its row, `each` and `eachChunk` save the columns they hand out, once per table and never per entity, but for the terms the query says it only reads. A new way to write does the same when `world._recording` is true, or a refused action leaves a trace and its replay diverges. `test/transaction.test.ts` has a list of writers that every rollback is checked against: add the new one to it.
- **Every way to write component data notes the write**, for the change queries that watch the component: `this._changed[def.id]?.note(index)` for a row, `noteRows` for rows handed out raw (but for the terms a query only reads), and the accessors of `each` note the rows they assign to. A new way to write does the same, or a change query misses it. `test/changes.test.ts` checks every writer against a model kept by hand: add the new one to it.
- **Who points at whom is worked out, not stored.** A relation's columns are the truth, saved and hashed like any component's; the index beside them is rebuilt by `load` and is in neither. So every change of a target goes through the world (`_place`, `add`, `remove`, `despawn`), and nothing that reads the index may let the order of its lists show: a despawn goes through relations by name and holders by index.
- **Every way to change the world refuses a frozen one.** `world._frozen` is true while an app's frame stage runs. `spawn`, `despawn`, `add`, `remove`, `set`, a singleton's setters and a command check it, and `each` hands out accessors whose setters throw. A new way to change the world checks it too. The random generator is checked once, by `thaw`, which puts it back and throws if it was drawn from: a check in every draw would cost every draw. `test/frame.test.ts` has a list of changes that a frozen world must refuse: add the new one to it.
- **What a simulation can tell apart is in `world.snapshot()` too**, so that a world which loads one goes on exactly as the world it was taken from. State added to the hash is added to the snapshot in the same change, and read back by `load`, which trusts nothing it reads: a count is checked against the bytes that are left before anything is allocated for it.
- **What a simulation can tell apart is in `world.hash()`**, and nothing else is. State that a system can observe, or that decides what it will observe later, is added to the hash in the change that adds the state, in an order that does not depend on the process: by name, never by id. State nobody can observe (a cache, spare capacity) stays out, or two equal worlds would hash differently.
- **What waits for a reader is the reader's, not the world's.** The events a system has yet to read and the changes a query has yet to visit are kept per reader, outside `world.hash()` and `world.snapshot()`: a plugin that only watches must not change the hash of the game it watches. `app.save()` holds them, with each reader's place, so a loaded game goes on as the saved one did.
- **A query says what it only reads.** A loop that reads a component and does not write it is given a query made with `Query.reads(...)`. Then the compiler refuses a write, `eachChunk` does not count the rows as written for the queries that watch the component, and a handler does not pay for a copy. Leaving it out is never wrong, only slower; saying it and then writing past the compiler is a bug nothing catches.
- **Measure.** A change to the storage core or to a query comes with a run of `pnpm --filter arcadekit bench`, before and after, in the pull request.

## Types

- **Let the compiler infer** an export's type when it can. Declarations are generated by the TypeScript compiler.
- **`unknown`, not `any`.** `any` is for the few places where variance leaves no alternative (`ComponentDef<any>` in a list of mixed components); say why in a comment.
- **A component's name is in its type**, inferred from `Component.define("physics/Position", ...)`. That is how the compiler tells two components with the same fields apart, as `Query.reads` needs it to. A name built at run time is just `string`, and such a component is told apart from nothing.
- **Type parameters carry what the user will need later.** An `App` knows its handlers so `dispatch` can be checked; a `Plugin` knows what it provides and needs so a missing service is a compile error. A new feature that takes user definitions keeps their types.
- **Requirements stay in `R`.** What a system or a plugin needs flows into the `R` of `App.make`, and the user satisfies it with `Effect.provide`. Do not write a custom "is everything provided?" check: one was tried, and it reported false errors whenever a layer was written inline.
- **Infer a list with `readonly [...T]`** when the list is optional, so leaving it out gives the default and not the constraint.

## Tests

- **A test name is a sentence** about the thing under test: `it("are dropped a tick after they were emitted, read or not")` inside `describe("events")`.
- **Test through the public API**, the way a game would use it. Build an app, tick it, look at the world.
- **Compare against something obviously right.** The storage tests run thousands of random operations against a `Map` and compare; a new data structure gets the same.
- **Check that a test can fail.** Break the code it covers and see it go red. Several bugs in this package were found only because a deliberate break went unnoticed.
- **A type error is tested with `// @ts-expect-error` on the line directly above the expression that errors.** The formatter moves expressions, so put the comment inside the call, above the argument.
- **A frame loop is tested against a display turned by hand**, `Driver.makeManualDisplay()`, never against real timers: `display.frame(now)` is a frame coming due, and `display.pending` and `display.watching` say what the loop has left behind.
- **A test that is itself an Effect** can use `it.effect` from `@effect/vitest`; see Effect's [testing example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/09_testing/10_effect-tests.ts). It is not installed yet. Do not use `TestClock` for game time: game time is `Time`, and a test advances it by ticking.

## Effect 3 habits that do not exist in Effect 4

Checked against Effect's [rename map](https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md).

| Effect 3 | Effect 4 |
| --- | --- |
| `Context.Tag`, `Context.GenericTag`, `Effect.Tag`, `Effect.Service` | `Context.Service` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/services.md)) |
| `FiberRef` | `Context.Reference` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/fiberref.md)) |
| `Effect.catchAll`, `Effect.catchAllCause` | `Effect.catch`, `Effect.catchCause` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/error-handling.md)) |
| `Effect.fork`, `Effect.forkDaemon` | `Effect.forkChild`, `Effect.forkDetach` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/forking.md)) |
| `Effect.async` | `Effect.callback` |
| `Either`, `Effect.either` | `Result`, `Effect.result` |
| `Effect.zipRight` | `Effect.andThen` |
| `Runtime<R>`, `Effect.runtime` | `Effect.context` and `Effect.runForkWith` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/runtime.md)) |
| Yielding an `Option` or an `Either` | `Effect.fromOption`, `Effect.fromResult` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/yieldable.md)) |
| `@effect/platform`, `@effect/schema` and others as separate packages | Part of `effect` |

## Where the code does not follow this yet

Nothing at the moment. When code has to depart from this guide for a while, list it here with what is missing, and remove the entry with the fix.

The references to Effect's repository and documentation were checked on 2026-11-15, against Effect 4.1.
