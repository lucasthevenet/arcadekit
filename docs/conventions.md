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

## Learning from other engines

Before designing a complex feature (change detection, hierarchies, scheduling, relations, states, physics, networking), find out how established engines and ECS frameworks solved it. [Bevy](https://bevy.org/) is the first place to look: it is an ECS built around systems, queries, commands, events, resources and plugins, as this package is, and its design discussions and [examples](https://github.com/bevyengine/bevy/tree/main/examples) say why each part works the way it does and what was tried before. Other engines and ECS libraries are worth reading for the same reason.

- **Borrow the design, not the API.** What is worth taking is which problems a feature has to solve, the cases it has to handle and the mistakes the engine made on the way. The interface is then written the way this guide says, with Effect's idioms, not translated from Rust or C++.
- **The rules here still hold.** A design borrowed from elsewhere still has to keep a tick deterministic, change the set of entities only through `Commands`, run one Effect per system and not per entity, and keep the storage core free of Effect. Where another engine's design breaks one of these, the design changes, not the rule.
- **Say where it came from.** Name the engine and link the part of it that was used, in the pull request and, when it explains a choice the code makes, in a comment.

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
- **Every module is an entry, and an entry makes a promise about what it imports.** `src/App.ts` is `arcadekit/App`, and `arcadekit` (`src/index.ts`) gives them all together. Each imports Effect and nothing else, and names nothing that only a page has: no `document`, no `requestAnimationFrame`, no `navigator`. `arcadekit/ecs` (`src/ecs/index.ts`) is the storage core and imports nothing at all. A new module gets its entry in `package.json` in the same change, and its line in `src/index.ts`.
- **What only a page can use is in `arcadekit/Browser`** (`src/Browser.ts`), all of it: the page's display, its devices, its pictures, and what starts a game in it, with the one import of a browser package. New code goes where its imports allow, not where its subject suggests: a page's keyboard is in `Browser`, though it is input. `arcadekit` does not give it, and no other module imports it, so a program that does not run in a page never loads it. `test/entries.test.ts` checks all of this in the sources and `scripts/lint-entries.mjs` in the build.
- **An entry is named as its namespace is**, and imported whole: `import * as Input from "arcadekit/Input"`, `import * as Browser from "arcadekit/Browser"`.
- **What depends on a library a game may not have is a package of its own**, under `packages/`, named `@arcadekit/<library>`: `@arcadekit/three` draws with Three.js. `arcadekit`, Effect and the library are its peer dependencies, never its dependencies, so that a game has one copy of each and a component or a service is the same object in both packages. It imports `arcadekit` by its entries (`arcadekit/Query`, `arcadekit/ecs`), and its own modules are entries too, named as here. `packages/three/test/entries.test.ts` and `scripts/lint-entries.mjs` check what it imports.
- **What a game's rules write is in `arcadekit`, never in such a package.** Where a thing is, `arcadekit/Transform3d` and `arcadekit/Transform2d`, is read by the renderer and defined here: a component that lived in the renderer's package would have a server install the renderer to run the rules. Such a package defines no component of its own; it reads the game's.
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
- **What every platform has some form of is a `Context.Reference` whose default works everywhere.** `Driver.Display` is the screen a frame loop follows, and its default is a timer, which Node, a worker and a page all have. A page's own, `requestAnimationFrame`, is `Browser.display`, provided by `Browser.layer` and `Browser.runMain`. The default holds nothing, so sharing it is safe, and a test provides one it turns by hand, `Driver.makeManualDisplay()`.
- **What only some programs have is a `Context.Reference` whose default is to have none.** `Input.Source` is where the devices come from, and by default there are none, which is what a replay, a server and most tests want. A page provides `Browser.layer()`. `View.Bridge`, the UI, and `Sound.Output`, where sound goes, are two more: where there is none, the systems that would publish or play do nothing at all. A layer that listens, as that one does, lasts as long as what it is provided to: provide it to the whole program, and have it say so when it is used after it was let go.
- **What a program cannot do without, and has no default, is a `Context.Service` with plain calls.** `Transport` carries a session's messages to the other peers: `send` and `receive`, neither of which waits, so that the tick that uses them stays one synchronous step. A game that is given none does not compile. What listens behind it, a channel or a socket, fills a list in its own time, and `receive` hands the list over. A test provides a network in memory, `Transport.makeHub`.
- **What a platform hosts is a handler of plain functions.** A relay is accepted sockets, which are a different thing in a Node server, a Durable Object and a function behind a gateway, and a decision about each, which is the same. `Relay.join` and `Relay.forward` are that decision: they take what the host knows, the address, the text, who is connected, and give back what to do as a value, an `Exit` with a `Relay.Refused` that carries the status and the close code. They keep nothing between two calls, so a host that is put to sleep between messages can call them. New code of this kind goes the same way, and what binds it to one platform is an example or a package of its own.
- **What has to be let go is acquired in a scope.** An asset is loaded with `Assets.load`, into the scope it is run in, or kept by `Assets.during` in a scope that lasts as long as a state does. A plugin that needs something for as long as the app loads it in its `layer`. Nothing is loaded into a module-level variable, which no scope closes.
- **Do not build a layer by hand** with `Layer.build`. `App.make` is the one place that does.
- **A program is started with the platform's `runMain`**, which reports a failure and interrupts the program cleanly, closing the app's scope: `NodeRuntime.runMain` under Node, and in a page `Browser.runMain`, which is `BrowserRuntime.runMain` with the page's display and devices provided. A game that runs in real time gives it `App.run(options, { hz })`, the entry point, and one that moves when its player does `App.run(options, { hz, ticks: "whenNeeded" })`: `Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas })`. What the game needs from outside is provided to `App.run`, so that it lasts as long as the game. A program that steps its app itself gives it `Effect.scoped(program)`. `Effect.runSync` and `Effect.runPromise` are for tests and benchmarks. Inside a program, an Effect is yielded, never run. See [Running Effects](https://effect.website/docs/v4/getting-started/running-effects); `examples/` are the examples.

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
| Transform | Where a thing is: `Transform3d.Position`, and `Transform3d.Rotation` and `Transform3d.Scale` for the entities that turn or have a size; in a flat game, the same three of `Transform2d` | The game's own components, listed by `Transform3d.plugin` and `Transform2d.plugin`. A game uses them, and not a position of its own, for anything that is drawn, so that the rules and what draws agree; one of the two for a thing, never both. Written in a loop over columns; `Transform3d.axisAngle` is for a spawn. What reads where things are, a renderer for one, reads both. |
| Relation | A component that points at another entity, declared with `Component.relation` and what a target's despawn does to it | Use it, and not a bare `Field.entity`, for a reference that must not dangle. Its target is changed by adding it again, never by assigning. |
| Singleton | Data of which the world has one, declared with `Singleton.define` and its initial value | Fields as a component's. Listed in a plugin's `components`. Read and written through what `yield*` gives, by a system, a handler or a script. |
| State | One of a few named values a game is in, declared with `State.define` | A singleton, listed in `components`. Changed with `set`, and entered at the start of the next tick. A system that belongs to some states says so with `System.runIf(State.is(...))`; what happens once on the way in or out is a hook, `State.onEnter` or `State.onExit`, not a flag a system checks. |
| System | A generator given to `System.make`, and what it reads and writes, said with `System.access` | Says its access when it belongs to a plugin, so that the game it is installed in can check its order: its queries, and beside them the singletons, states and events it touches, what it changes through `Commands` or `World`, and whether it draws from `Random`, issues actions or starts scripts. It is all of what the system does: the app refuses the rest. In the tick unless it draws, in which case `System.inStage("frame")` (or `"preFrame"` for what every system of a frame stands on, as `Assets.during` is, and `"postFrame"` for what needs everything drawn, as a renderer's last step is), or turns the devices into actions, in which case `System.inStage("input")`: see [Determinism](#determinism). Finishes within its tick. Changes the set of entities only through `Commands`. Reacts to what changed with a change query (`Query.changed`, `Query.added`, `Query.removed`), not by comparing with a copy it keeps. |
| Event | A fact, declared with `Event.define` and a schema | Named in the past tense, with the feature it belongs to in front: `"physics/Collided"`. Emitted, never awaited by a system. An event with a type and no schema cannot be written down. A system that can be switched off with `System.runIf` does not rely on an event for anything it must not miss, since the events of the ticks it sat out are gone when it runs again: it watches the state, with a change query or a singleton. |
| Binding | A line of `Input.bind`: `Input.onPress`, `onRelease` or `onMove`, a code and an action | Issues one of the game's own actions when a device does something, so that handlers know nothing of keys. For what a line cannot say, a system of the input stage reads `Input.Devices` and the world and issues the action with `Actions.enqueue`. |
| Bundle | Assets that are loaded and let go together, declared with `Assets.bundle` | Kept by `Assets.during(condition, bundle)` for as long as a state lasts, and read with `yield*` in the frame stage, which draws with it, or the input stage. What the game needs from a file reaches it as an action issued there, never by a system that reads the bundle in the tick, which throws. |
| Action | A request from outside, declared with `Action.define` and a schema | Its handler may refuse at any point: the world takes back what it wrote. It changes which entities exist only through `Commands`, and issues another action only with `Actions.enqueue`. It is told who issued the action, `{ from }`, beside the payload: who may do a thing is checked against that, never against a name in the payload, which whoever sent it wrote. |
| View | A value the UI may see, declared with `View.define` and its initial value, and published by a system made with `View.publish` | Plain data, compared field by field: the body returns a new object each frame and the UI is told only when it differs. Declared in a module of its own with the actions the UI may send, which is all the UI imports of the game. Never read by the game: it is what the UI sees, not state. |
| Track | What a channel plays, over and over or with `once` to its end, said by the body of `Sound.music` | Says what the game, as it is, should sound like: worked out each frame from states and singletons, kept nowhere, so a loaded game has its music. Not for what happened once, which is a cue. For silence the body returns `undefined`, and a system that does not run is silent too. |
| Clip | A sound that was loaded, `Sound.Clip`: an asset of a bundle, `Browser.sound(url)` in a page | Goes wherever a cue's or a track's name goes. A level's cues are `Sound.cues(name, bundle, (assets) => lines)`, and its music a body that reads the bundle. A sound the page has for as long as it lasts is a name in `sounds`, and a long piece of music is `Browser.stream(url)` there, fetched as it plays. |
| Cue | A sound, by its name or as a clip, played by a line of `Sound.cues`: `Sound.on`, an event and a cue | Says what an event sounds like, in the frame stage. The simulation emits the event and never plays: `Sound.Player` throws in the tick. A sound that no event stands for is played by a frame system through the player. |
| Work of a system's own | `(yield* Ticks).more()`, from a system, a handler or a script | Said each tick the game has more to do that no action, state, script or event stands for: a clock that runs, a body in flight. It is what keeps a game that ticks when needed from resting in the middle of it. In real time it does nothing, so a system that might ever run in such a game says it. |
| Session | One peer of a game of several, made with `Lockstep.make` around an app, or with `Rollback.make` for one that does not wait for the network, and joined to what carries its messages with `Transport.connect` | Takes the app over (`app.divert`): what comes in from outside is put in a message, stamped with the tick it applies on, and applied by every peer on that tick. Plain synchronous code that holds no socket and no timer: it is given the messages that arrived and gives the ones to send. Stepped by a driver in the app's place. An action that is to reach the other peers has a schema. A game that is played with rollback keeps everything its simulation reads in the world, where a rewind puts it back: no script that keeps its place in its own variables, and no service that counts. |
| Script | An Effect listed in a plugin's `scripts`, or started with `app.spawnScript`, or with `Script.spawn` from a system | Waits only with `Script.nextTick`, `Script.sleep` or an event's `wait`. Its failure is logged, and stops an app made with `onScriptFailure: "stop"`. A save cannot hold a script in mid-flight: one listed in a plugin starts again after a load, so it keeps what it must not lose in the world. In a game that ticks when it is needed, a script that sleeps or waits for a tick keeps the game ticking; one that should let it rest waits for an event. |
| Plugin | `Plugin.make` | Lists the plugins whose services its layer uses, the components its feature stores, and its scripts. `setup` is for a fresh start only: a load has what it spawned. |
| What draws | Systems of the frame stage, in a plugin that only the page installs; with Three.js, `Three.instances` and `Three.objects` from `@arcadekit/three` | Tells what to draw from the components an entity has, and where from `Transform3d.Position`: the rules say what a thing is, never how it looks. A crowd is drawn from raw columns into one buffer, with nothing made per entity per frame. What is kept from one frame to the next (a mesh, a scene, where a thing was a tick ago, to draw it between two) is in a service, made in the plugin's `layer` and let go with the app's scope, and never in the world. What it draws through (a renderer, a canvas) comes from outside, as a service the game provides. |

Once a game has started, its world changes only through these: a system, an action's handler, a script. Code outside the simulation (the network, a test, the entry point) changes the world with `app.dispatch` or `app.enqueue`, and that is what the log holds. In a game of several peers it is `app.enqueue` alone: a session has taken the app over, and has every peer apply the action on the same tick, so `dispatch` and the app's own `tick`, which would move one machine's game, throw. A UI does not hold the app: it is handed a `View.Bridge`, reads the game's views from it, and sends actions through it, which the input stage issues and logs. A system, a script or a handler that issues an action uses the `Actions` service, which is not logged: a replay's own simulation issues it again. Calling `app.enqueue` from inside a system would put the action in the log and have it applied twice on replay. In the frame stage and the input stage it is the other way round: they are outside the simulation, a replay runs neither, and `Actions.enqueue` there is logged. What it writes into `app.world` directly is not in the log, so a replay cannot repeat it, and stops at the next checkpoint. Spawning the first entities before the first tick is the exception: that is the state the game starts from.

## Determinism

A tick gives the same result from the same inputs, on every machine and every replay. Code that a tick runs:

- reads time from `Time`, never `Date.now()`, `performance.now()` or Effect's `Clock`;
- waits with `Script`, never `Effect.sleep`, a `Schedule`, a timer or a promise, all of which resume outside the tick;
- takes randomness from `Random` (`const random = yield* Random`, then plain calls such as `random.next()`), never `Math.random()`. The generator's state is in the world, so a replay draws the same numbers. Effect's own `Random` is seeded from it inside an app, at the cost of an Effect per draw;
- does not depend on the order of a `Map` or `Set` it did not fill itself in a fixed order;
- does not read a device. What the keyboard, the pointer and the gamepads say comes in as actions, issued in the input stage, `System.inStage("input")`, which runs before a tick with the world frozen and is told what the devices say as `Input.Devices`. A system in the tick reads the picture the game has of them, `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad`, which those actions keep and a replay therefore has too;
- does not load, and cannot tell whether anything was loaded. A file arrives when it arrives, and a replay loads none. Assets belong to what draws: `Assets.during` is a system of the frame stage, and a bundle read in the tick throws. What the game needs from a file comes in as the payload of an action, issued from the input stage once the file is there;
- makes no sound. It emits an event for what happened, and a system of the frame stage, made with `Sound.cues`, plays what the event sounds like. A replay is silent and the same game;
- is not what draws. Drawing, and anything else that follows real time, is a system of the frame stage, `System.inStage("frame")`. It runs between ticks with the world frozen, reads real time from `Frame`, and changes nothing: a game that has been drawn is the same game. What it has to remember from one frame to the next (a mesh, a sound that is playing) it keeps in a service of its own, not in the world;
- does not start a fiber with `Effect.forkChild` from a system: a child is interrupted when the tick's fiber ends. Use `Script.spawn`, which the app watches: it reports a failure and interrupts the script when its scope closes. `Effect.forkDetach` also survives the tick, but the app cannot see that fiber, so its failure is silent unless the caller observes it.

In a game of several peers a break of these rules does not go unnoticed for long: the peers compare the hashes of their worlds, and a session stops with `Lockstep.Drifted`, which says the tick they last agreed at. A test of a game that is to be played by several runs two apps of it side by side and compares their hashes, as `test/lockstep.test.ts` does.

The scheduler is why this holds. `src/TickScheduler.ts` replaces Effect's, so a fiber only resumes when the tick flushes it. Do not provide another `Scheduler` to code inside an app. What has to go on in real time while the game runs, as loading does, is not code inside the app: a service started in a plugin's `layer`, which is built before the app's scheduler is in place, forks it with the context it found there (`Effect.context`, then `Effect.runForkWith`), less the app's own services, as `src/Assets.ts` does. Those are the game's: inside an app Effect's `Random` is the world's generator, and whatever runs in real time and draws from it has changed the game. API: [Scheduler](https://effect.website/docs/v4/api/effect/Scheduler), [Fiber](https://effect.website/docs/v4/api/effect/Fiber); guide: [Fibers](https://effect.website/docs/v4/concurrency/fibers).

Events have their own implementation in `src/Event.ts` and do not use Effect's `PubSub`. Each system keeps a read position from one tick to the next, and a refused action has to be able to take back the events it emitted and the reads it made.

## Plain code: the storage core and hot loops

- **No `effect` import in `src/ecs/`.** It is usable, and tested, with no Effect at all.
- **Nothing is shared between worlds.** A world keeps the names of the components it stores; the module holds no registry. The one module-level value is the counter that numbers component definitions, and that number is never saved, hashed or compared between processes.
- **Columns, not objects.** Numeric data is in typed arrays, one per field. Do not allocate inside a per-entity loop.
- **Nothing is made from text.** No `eval`, no `new Function`, here or anywhere in the package: a page under a strict Content Security Policy refuses both, and the package runs there as it is. What has to be fast for every kind of column is written out once per kind, as the accessors of `each` are in `src/ecs/component.ts`, which says why that is as fast as generating it: an engine keeps what it learns about a function with its place in the source, so one function for every kind of array is slow and seven that differ in a type are not. `test/entries.test.ts` reads the sources for it, and `test/policy.test.ts` plays a game in a process that forbids it.
- **Reads from a column need an assertion**, `pos.x[i]!`, because the repository compiles with `noUncheckedIndexedAccess`. That is what `!` is for here, and almost the only place it belongs.
- **A structural change during iteration throws.** Queue it on `Commands`.
- **Iteration order is fixed**: tables in creation order, rows ascending, whichever strategy finds the rows. A change that makes order depend on data breaks replays.
- **Every way to write component data saves it first, inside a transaction.** `set` saves its row, `each` and `eachChunk` save the columns they hand out, once per table and never per entity, but for the terms the query says it only reads. A new way to write does the same when `world._recording` is true, or a refused action leaves a trace and its replay diverges. `test/transaction.test.ts` has a list of writers that every rollback is checked against: add the new one to it.
- **Every way to write component data notes the write**, for the change queries that watch the component: `this._changed[def.id]?.note(index)` for a row, `noteRows` for rows handed out raw (but for the terms a query only reads), and the accessors of `each` note the rows they assign to. A new way to write does the same, or a change query misses it. `test/changes.test.ts` checks every writer against a model kept by hand: add the new one to it.
- **Who points at whom is worked out, not stored.** A relation's columns are the truth, saved and hashed like any component's; the index beside them is rebuilt by `load` and is in neither. So every change of a target goes through the world (`_place`, `add`, `remove`, `despawn`), and nothing that reads the index may let the order of its lists show: a despawn goes through relations by name and holders by index.
- **Every way into the world asks the guard.** `world.guard` is what the code that is running said it would read and write, and an app sets one before each system that said, with `System.access`. `view`, `removed`, `singleton` and a singleton's setters, `get`, `has`, `sources`, `set`, `spawn`, `despawn`, `add`, `remove` and every command check it where they are called, and nothing does inside a loop. A new way to read or to change the world checks it too, with a message that says who, what, and whether it is a read or a write that was not said. `test/access.test.ts` holds a world with a guard to each: add the new one to it.
- **Every way to change the world refuses a frozen one.** `world._frozen` is true while an app's frame stage or its input stage runs. `spawn`, `despawn`, `add`, `remove`, `set`, a singleton's setters and a command check it, and `each` hands out accessors whose setters throw. A new way to change the world checks it too. The random generator is checked once, by `thaw`, which puts it back and throws if it was drawn from: a check in every draw would cost every draw. `test/frame.test.ts` has a list of changes that a frozen world must refuse: add the new one to it.
- **What a simulation can tell apart is in `world.snapshot()` too**, so that a world which loads one goes on exactly as the world it was taken from. State added to the hash is added to the snapshot in the same change, and read back by `load`, which trusts nothing it reads: a count is checked against the bytes that are left before anything is allocated for it.
- **What the world holds is emptied by `world.restore()`**, which puts a snapshot back into a world that is in use. State added to the world is reset there in the same change, or a restored world is not what a new one that loaded the snapshot would be. `test/restore.test.ts` holds the two against each other over random operations, and has a view asked for before a restore throw: an object that is made of the world's tables and handed out notes `world._restored` and refuses to be used after.
- **What a simulation can tell apart is in `world.hash()`**, and nothing else is. State that a system can observe, or that decides what it will observe later, is added to the hash in the change that adds the state, in an order that does not depend on the process: by name, never by id. State nobody can observe (a cache, spare capacity) stays out, or two equal worlds would hash differently.
- **What waits for a reader is the reader's, not the world's.** The events a system has yet to read and the changes a query has yet to visit are kept per reader, outside `world.hash()` and `world.snapshot()`: a plugin that only watches must not change the hash of the game it watches. `app.save()` holds them, with each reader's place, so a loaded game goes on as the saved one did.
- **A query says what it only reads.** A loop that reads a component and does not write it is given a query made with `Query.reads(...)`. Then the compiler refuses a write, `eachChunk` does not count the rows as written for the queries that watch the component, and a handler does not pay for a copy. Leaving it out is never wrong, only slower; saying it and then writing past the compiler is a bug nothing catches.
- **Measure.** A change to the storage core or to a query comes with a run of `pnpm --filter arcadekit bench`, before and after, in the pull request. A change to the loops that draw comes with `pnpm --filter @arcadekit/three bench`. `pnpm --filter arcadekit bench:compare <base checkout>` measures the storage core itself against another checkout's, and fails on a variant that is slower by more than the noise; the `Benchmarks` workflow runs it on a pull request, against what it would be merged into, once `bench/ci-workflow.yml` is in `.github/workflows/`. A commit that slows a variant on purpose says so in its message, `Bench-slower: each, eachMany`, with the reason above it.
- **A variant of the benchmark that goes through the storage core alone is in `bench/core.ts`**, which imports `arcadekit/ecs` and nothing else and is what `bench:compare` compares; one that needs an app is in `bench/accessors.ts`. A loop that is timed reads its constants from its own module: an exported one is read through the module each time, which measured a tenth slower.

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
- **Compare a failure whole**: `expect(error).toEqual(new Assets.AssetFailed({ url, message }))`. To `toEqual` alone, two tagged errors that differ only in their `message` are equal, since it is the one field of an error that is not an enumerable property; `scripts/vitest-setup.ts`, which `pnpm test` runs before every test file, compares it. A test in `test/assets.test.ts` fails if that is ever lost.
- **Assets are tested with files in memory**, `Assets.layerMemory({ ... })`, and with assets made by `Assets.make` that note when they are made and let go. A test of loading that takes time provides a `Loader` whose files arrive when the test says, and waits a turn of the event loop for them.
- **Input is tested with a source worked by hand**, `Input.makeManualSource()`: `source.press("Space")`, then `app.tick(delta)`, which hears the devices first, or a driver. A test of what a game does with a key need not go through a device at all: it dispatches `Input.Report`, or the action the key is bound to. Where a source is provided as well, a report made by hand is put right by the next tick that reads it: `app.tick(delta, { input: false })` is a tick that takes the report's word.
- **What only a page has is tested against stand-ins**, in `test/browser.test.ts`: event targets that count their listeners, and `vi.stubGlobal` for `requestAnimationFrame`, the document and the window's `addEventListener`. Unstub them after each test.
- **What draws is tested with a renderer that draws nothing**, `Layer.succeed(Three.Renderer, { render(scene, camera) { ... } })`, which notes the scene it was handed. Three.js makes its scenes and meshes under Node as in a page, so a test looks at what was put in the scene, and compares a matrix with the one Three.js itself makes of the same place. A claim about allocation is measured: the heap before and after a frame, many times, and the middle one.
- **Sound is tested with an output that notes what it was asked**, `Sound.makeRecorder()`, provided with `Sound.layer`: tick, draw a frame, and look at `played`, and for music at `scored` and `playing`. A level's sound in a test is `Sound.clip(name)` from an asset made with `Assets.make`. The page's own output is tested against a stand-in for its audio, given as `audio` and `decode`, as its devices are.
- **A UI is tested through the bridge it is handed.** A test of the game makes a bridge, `View.makeBridge()`, provides it with `View.layer`, and is the UI: it subscribes, sends, and steps the app. A test of a UI mounts it in a document (`// @vitest-environment happy-dom` at the top of the file) and counts what it was told and what changed in the document, with a `MutationObserver`. `test/page.test.ts` does both for the example page's two UIs.
- **Peers are tested in one process, joined by a network made by hand**: every app in one scope, a session around each, and a list of messages in flight that the test delivers late, shuffled and as text, with delays drawn from a seeded generator so that a failure repeats. A test of a game uses `Transport.makeHub({ delay, seed })`, which is that network as a transport, and steps it with `hub.step()`; each peer's layer is built into the scope the peers share, since a layer provided to one line is gone with that line. `test/peers.ts` has a network of its own, for the tests of the sessions themselves. What is compared is the world's hash after every tick, peer against peer, and the logs whole. `test/peers.ts` is the game and the network they share. Peers that predict are compared once the game has come to rest, with each other and with a game of one that is given the same log by `App.replay` and never goes back.
- **What a platform forbids is tested in a process that forbids it.** `test/policy.test.ts` plays the game of `test/policy-game.ts` in a Node started with `--disallow-code-generation-from-strings`, which is what a page under a strict Content Security Policy is to V8, and compares it with the same game played in the test's own process. Such a test also shows that the flag was in force there, and that it would be noticed if it were not. A Node module a test needs is imported and typed in the test, since the tests are compiled with no types but their own.
- **What speaks to another machine is tested over real sockets on this one.** `test/relay.test.ts` runs the relay behind a WebSocket server (`ws`, a dev dependency) on a port the system picks, and opens `Transport.layerWebSocket` to it. Such a test waits for what it expects, a few milliseconds at a time with a limit, and never for a fixed time; and it is run several times over before it is trusted. An example that hosts the relay on a platform is checked by hand with `pnpm --filter arcadekit relay:check <address>`, against the platform's own emulator where it has one, and what it was not run against is said in the README.
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

The references to Effect's repository and documentation were checked on 2026-11-15, against Effect 4.1. The repository installs 4.1.4, which Alchemy, a dev dependency of the relay's example, asks for; the packages still take any 4.1 from 4.1.2.
