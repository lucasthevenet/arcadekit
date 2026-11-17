# arcadekit

A framework for building games of any genre on [Effect](https://effect.website) 4, built around an entity component system (ECS).

This is the first cut of the revamped design. It is a working prototype, not a finished kit: see [Not done yet](#not-done-yet).

1. **Storage core** (`src/ecs/`): archetype tables with typed-array columns, opt-in sparse storage, cached queries, queries for what changed, a command buffer. No Effect.
2. **Tick scheduler**: Effect around the core. One fiber per tick, systems as generators, yieldable queries and resources, coroutine scripts, and a custom Effect `Scheduler` that only runs fibers when the tick says so. Beside the tick, a frame stage that draws the game between ticks and cannot change it, and an input stage that turns what the devices say into actions.
3. **Events and rules**: typed events every system sees exactly once, and actions with handlers that validate a move and refuse it with a typed error. Payloads are checked against a schema, applied actions are logged as JSON-safe data, and the log replays the game and checks the replay against the world's hash.
4. **Plugins**: one value that bundles a feature's systems, handlers, services and setup, and names the plugins it depends on.

What draws a game is a plugin in a package of its own: [`@arcadekit/three`](../three/README.md) draws one with Three.js.

From the repository root:

```sh
pnpm install
pnpm test                          # 871 tests, 95 of them of @arcadekit/three
pnpm typecheck
pnpm --filter arcadekit demo       # real-time simulation
pnpm --filter arcadekit duel       # turn-based game
pnpm --filter arcadekit page       # a game in a page, at http://localhost:5173
pnpm --filter arcadekit bench
pnpm --filter arcadekit bench:compare ../base   # is this checkout slower than that one?
```

## What it looks like

```ts
const Position = Component.define("Position", { x: Field.f32, y: Field.f32 });
const Velocity = Component.define("Velocity", { x: Field.f32, y: Field.f32 });
const Stunned = Component.tag("Stunned", { storage: "sparse" });

const Moving = Query.all(Position, Velocity).pipe(Query.without(Stunned));

const Movement = System.make("Movement", function* () {
  const moving = yield* Moving;
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
    pos.y += vel.y * delta;
  });
});

// A game that runs: sixty ticks a second, until the page goes away.
Browser.runMain(App.run({ systems: [Movement] }, { hz: 60 }));

// One tick at a time, for a game that waits for its players, or a test.
const program = Effect.gen(function* () {
  const app = yield* App.make({ systems: [Movement] });
  app.world.spawn(Position.of({ x: 0, y: 0 }), Velocity.of({ x: 1, y: 0 }));
  app.tick(1 / 60);
});
```

Systems run in the order they are registered unless told otherwise: `System.after(Other)` and `System.before(Other)` pull whatever has to run first forward to just before the system that needs it. That is within a stage. A tick has three, `"preUpdate"`, `"update"` and `"postUpdate"`, and each runs whole before the next; a system is in `"update"` unless `System.inStage` says otherwise. Which of two systems runs first is often an accident of where they were listed: a system that [says what it reads and writes](#what-a-system-reads-and-writes) lets the app find the pairs for which that matters.

## Entries

```ts
import { App, Input, System } from "arcadekit"; // everything, or
import * as App from "arcadekit/App"; // one module at a time
import * as Browser from "arcadekit/Browser"; // what only a page can use
import { Component, Field, World } from "arcadekit/ecs"; // the storage core alone
```

Every module is an entry of its own, named as the module is: `arcadekit/App`, `arcadekit/Input`, `arcadekit/System` and the rest, as Effect's own are. `arcadekit` gives them all together, but for `Browser`.

| Entry | What it has | Imports |
| --- | --- | --- |
| `arcadekit` | Every module below, as `import { App, Input } from "arcadekit"` | `effect` |
| `arcadekit/App`, `arcadekit/Input`, … | One module each: `Action`, `App`, `Assets`, `Driver`, `Event`, `Field`, `Input`, `Lockstep`, `Migrate`, `Plugin`, `Query`, `Relay`, `Resource`, `Rollback`, `Save`, `Schemas`, `Services`, `Singleton`, `Sound`, `State`, `System`, `TickScheduler`, `Transform3d`, `Transform2d`, `Transport`, `View` | `effect` |
| `arcadekit/Browser` | What only a page can use: its display, its devices, its pictures, its sound, and `Browser.runMain`, which starts a game in it | `effect` and `@effect/platform-browser`, an optional peer |
| `arcadekit/ecs` | The [storage core](#snapshots) on its own: components, the world, queries, commands, snapshots, the hash | Nothing |

- A server, a replay and a test of a game do not import `arcadekit/Browser`. No other entry names anything that only a page has, so they run under Node as they are.
- Only what belongs to the page imports `arcadekit/Browser`: the module that starts the game there, and a plugin that draws it, for its pictures (`Browser.image`). The plugins that hold a game's rules do not, so a server installs no browser package.
- What needs a library of its own is a package of its own, with `arcadekit` as a peer: [`@arcadekit/three`](../three/README.md) is the Three.js plugin. Nothing in `arcadekit` imports Three.js, and it is no longer a peer dependency of it.
- An entry of a module is the module, imported whole: `import * as Input from "arcadekit/Input"` is the `Input` of `import { Input } from "arcadekit"`, the same object. `arcadekit` gives three modules by their names in place of the module: `EntityId` from `Schemas`, the services of `Services`, and the two classes of `TickScheduler`.
- `arcadekit/ecs` is not a module of that kind: it gives the storage core's names as they are, and its world is `World`, which `arcadekit` calls `EcsWorld` beside its service of that name.
- What two entries share is built once: a world made through `arcadekit/ecs` is one `arcadekit` knows, and a component is the same component.
- `pnpm lint:packages` checks what each built entry imports, and a test checks the same of the sources, and that every module has its entry.

## Fields

```ts
const Hero = Component.define("game/Hero", {
  hp: Field.i32, // a number, in a typed array
  target: Field.entity, // an entity id
  name: Field.json<string>(), // plain data
  inventory: Field.json<readonly string[]>(),
  born: Field.schema(Schema.Date), // any value a schema describes
  sprite: Field.transient<Sprite>(), // not saved
});
```

A number goes in a typed field: `f32`, `f64`, `i32`, `u32`, `u16`, `u8`, `entity`, which is [an entity's id](#an-entitys-id) and takes eight bytes. Anything else says, where it is defined, what a snapshot and the hash do with it.

| Field | Holds | Saved and hashed |
| --- | --- | --- |
| `Field.json<T>()` | Plain data: text, a number, a boolean, a bigint, null or undefined, or an array or object made of text, numbers, booleans and null | As it is. An array or object as the text `JSON.stringify` gives for it |
| `Field.schema(schema)` | Any value an Effect schema describes: a Date, a bigint inside an object, a class with a schema | In the schema's JSON form |
| `Field.ref<T>(codec)` | Any value at all, with `encode` and `decode` of your own to plain data and back | In its encoded form |
| `Field.transient<T>()` | A handle, a cache, anything another system can make again | No. It is undefined in a world loaded from a snapshot |

- The hash covers exactly what a snapshot saves, in the form it is saved in, so a world that loads a snapshot hashes the same.
- A value that is not plain data in a `json` field, or one a codec or schema will not take, cannot be saved: the snapshot is refused and names the field. A loaded value that a codec refuses is refused the same way.
- What comes back from a `json` field is what JSON makes of it: a Date inside an object comes back as text. Give such a value a schema.
- A `schema` or `ref` field is encoded once per value for every hash, and an array or object in a `json` field is turned into text. Keep them for what is small or rare; numbers that change every tick belong in typed fields.

## An entity's id

```ts
const rock = world.spawn(Position.of({ x: 0, y: 0 }));
entityIndex(rock); // the slot it lives in
entityGeneration(rock); // how often that slot was given out before
world.despawn(rock);
world.isAlive(rock); // false, now and for good
```

An entity is known by a number: its id. An id is a slot, its index, and above the index's 22 bits a generation, which counts how often the slot was given out before. A slot that comes free is given out again with the next generation, so an id that was kept across the reuse names nobody: `isAlive` is false of it, `get` gives nothing, and a relation that held it is gone.

- **An id never names another entity than its own.** The generation has 31 bits. It had ten, in an id of 32 bits, and a slot that is given out again every tick, as a bullet's is, came round to its first generation in seventeen seconds at sixty ticks a second: an id kept that long was a live entity's again, and nothing said so. At 31 bits the same slot lasts more than a year. When its generations are used up it is given out no more.
- An id is a whole number below 2^53, kept in arrays of 64-bit floats, which hold every such number exactly: a table's `entities`, which `eachChunk` hands out, and the column of an `entity` field are `Float64Array`s. It is a whole number in JSON, in a save and in an action's payload, where `EntityId` is its schema.
- The id of an entity whose slot was given out fewer than 1,024 times is the number it was when ids were 32 bits. One past that is larger than 32 bits hold: code that packs ids into a `Uint32Array`, or reads a generation with a shift, cuts it short. `entityIndex` and `entityGeneration` read the two halves.
- A world holds at most 4,194,304 entities at a time, which is what 22 bits of index are.
- It costs four bytes more wherever an id is kept, and nothing that was measured in a loop: see the [benchmark](#benchmark-100000-entities-pos--vel--dt).

## Singletons

```ts
const Turn = Singleton.define("duel/Turn", { player: Field.u8 }, { player: 1 });

const pass = Action.handler(Pass, function* ({ player }) {
  const turn = yield* Turn;
  if (turn.player !== player) {
    return yield* Effect.fail(new NotYourTurn({ waitingFor: turn.player }));
  }
  turn.player = player === 1 ? 2 : 1;
});
```

A singleton is one instance of some data per world: whose turn it is, the score, the level being played. `yield* Turn` gives the world's value of it, an object whose fields are read and written in place, with no entity, no query and no loop.

- Its fields are a component's, of the same [kinds](#fields), and its third argument is the value it has in a world that has not written it.
- The value is the world's. It is in the world's [snapshot](#snapshots) and [hash](#the-worlds-hash), so it is saved with a game and checked by a replay, and what a refused action wrote to it is taken back with the rest.
- Until it is written it is as good as absent: not saved, and not in the hash. Reading it changes nothing, so a plugin that only reads a singleton does not change the hash of the game it watches. A game loaded from a save in which it had never been written starts it at the initial value of the build that loads.
- Its name is one of the world's component names. List it in a plugin's `components`, beside the components, so that a save which names it can be loaded.
- No entity has it and no query visits it: spawning or adding it throws.
- A migration changes it by name with `Migrate`, as it changes a component.
- A `Resource` is the other kind of single value: configuration with a default that a layer can override. It is not game state, and is not saved.
- With the storage core on its own: `Component.singleton(name, fields, initial)` and `world.singleton(spec)`.

## Where a thing is

```ts
const Rock = Component.tag("game/Rock");

commands.spawn(
  Rock,
  Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
  Transform3d.Rotation.of(Transform3d.axisAngle(0, 0, 1, Math.PI / 2)),
  Transform3d.Scale.of({ x: 2, y: 2, z: 2 })
);

const Drift = System.make("game/Drift", function* () {
  const { delta } = yield* Time;
  (yield* Query.all(Transform3d.Position)).eachChunk((start, end, position) => {
    for (let i = start; i < end; i++) position.x[i] += 2 * delta;
  });
});

const Rules = Plugin.make("game/Rules", {
  plugins: [Transform3d.plugin], // lists the three, so a save that names them can be read
  components: [Rock],
  systems: [Drift],
});
```

`Transform3d` is three components for where a thing is in three dimensions: its position, which way it is turned, and how large it is. `Transform2d`, below, is the same for a flat game. They are in the package so that whatever needs to know where things are agrees on it: the rules that move them, what draws them, and what comes after.

| Component | Fields | Named |
| --- | --- | --- |
| `Transform3d.Position` | `x`, `y`, `z`, in the units of the game's space | `"arcadekit/Transform3d.Position"` |
| `Transform3d.Rotation` | `x`, `y`, `z`, `w`: a quaternion | `"arcadekit/Transform3d.Rotation"` |
| `Transform3d.Scale` | `x`, `y`, `z`: 1 is the size a thing is made at | `"arcadekit/Transform3d.Scale"` |

- They are ordinary components: 32-bit floats in columns of a table, written by the game's systems with a loop over `eachChunk`, saved, hashed and replayed. Nothing here draws, and the module imports no renderer.
- An entity has the ones it needs. One that is only somewhere has a `Position`; `Rotation` and `Scale` are for the ones that turn or have a size of their own.
- `Transform3d.plugin` lists them. A plugin that stores them depends on it, as the plugin of a renderer that reads them does.
- `Transform3d.axisAngle(x, y, z, angle)` gives the value of a `Rotation` that turns by `angle` radians about an axis, which is a direction of any length. It makes an object, so it is for a spawn or a `world.set`, not for a loop over columns.
- A `Rotation` is its turn and not its length: a quaternion of any length stands for the turn of the one of length 1 along it, and what reads one takes it so. One that a game's rules let drift from length 1 is drawn as the same turn, and all zeros, which is what a `Rotation` added with no value is, as not turned at all.
- A component added with no value is all zeros: a `Position` at the origin, and a `Rotation` that [`@arcadekit/three`](../three/README.md) draws as not turned. A number left out of a value is 0 as well. `of` takes every field, so the compiler asks for each, and a flat game gives every `z`; from JavaScript, or past a cast, a number that is left out is 0 in the world, and never NaN. `world.set` writes the fields it is given: a number it names and gives no value for is left as it was.
- [`@arcadekit/three`](../three/README.md) draws from them, and has no components of its own.

**A flat game** has `Transform2d`: the same three components with no third dimension.

```ts
commands.spawn(
  Card,
  Transform2d.Position.of({ x: 120, y: 80 }),
  Transform2d.Rotation.of({ angle: Math.PI / 6 }),
  Transform2d.Scale.of({ x: 2, y: 2 })
);
```

| Component | Fields | Named |
| --- | --- | --- |
| `Transform2d.Position` | `x`, `y` | `"arcadekit/Transform2d.Position"` |
| `Transform2d.Rotation` | `angle`, in radians | `"arcadekit/Transform2d.Rotation"` |
| `Transform2d.Scale` | `x`, `y` | `"arcadekit/Transform2d.Scale"` |

- A positive `angle` turns from the x axis towards the y axis: anticlockwise where y points up, clockwise where it points down.
- `Transform2d.plugin` lists them, as `Transform3d.plugin` lists the others.
- They are different components from `Transform3d`'s, with names of their own. A game uses one of the two for a thing: nothing keeps one in step with the other, and a system that queries `Transform3d.Position` does not find an entity that has only `Transform2d.Position`.
- `@arcadekit/three` draws from either, in the plane of x and y for these.

## Relations

```ts
const ChildOf = Component.relation("scene/ChildOf", {
  onTargetDespawn: "despawn", // a child goes with its parent
});
const Targets = Component.relation("ai/Targets", {
  onTargetDespawn: "remove", // whoever aimed at it aims at nothing
  storage: "sparse",
});

const turret = world.spawn(
  Position.of({ x: 0, y: 1 }),
  ChildOf.of({ target: tank })
);
world.get(turret, ChildOf)?.target; // its parent
world.sources(tank, ChildOf); // the tank's children, in order of id

commands.despawn(tank); // the turret goes with it, and whatever hangs from the turret
```

A relation is a component that points at another entity, its `target`, and is kept correct when that entity is despawned: a parent and its children, a target, an owner.

- `onTargetDespawn` says what a target's despawn does to whoever points at it. `"despawn"` takes them with it, and what points at them in turn, however deep. `"remove"` takes the relation off them and leaves them be.
- Either way nothing is left pointing at an entity that is gone, so a dangling reference cannot be read as a live entity, not even once its slot has been given to a new one. A plain `Field.entity` field is not kept this way: it holds whatever id was written to it, and whether that entity is alive is for whoever reads it to check.
- `world.sources(target, ChildOf)` gives the entities that point at one. The world keeps track of who points at whom, so neither this nor a despawn looks at any other entity.
- A relation's target is changed by adding the relation again, `commands.add(turret, ChildOf.of({ target: truck }))`. It is not written like a field: assigning to it, in `each` or with `world.set`, throws, and its raw column is typed as read-only. Fields of a relation's own, given as `fields`, are written like any others.
- A relation needs a target that is alive. Given none, it is refused where the mistake is. Given one that is gone already, what that entity's despawn would have done is done at once: the child does not outlive the call, or the relation is not added.
- In every other way it is a component: kept in tables or in a sparse set, read in a query, watched with `Query.added` and `Query.removed`, saved in a snapshot and counted in the hash. Who points at whom is worked out from it, and worked out again by a world that loads a snapshot, which refuses one whose relation points at nothing.
- A despawn goes through relations in order of name and through the entities that point in order of id, so the same world always loses the same entities in the same order, whatever order its relations were made in.
- An action's handler changes relations through `Commands`, like everything else that changes which entities exist.
- An entity has one target per relation. Another kind of link is another relation.

## Plugins

```ts
const Physics = Plugin.make("Physics", {
  systems: [Movement, Walls],
  layer: Layer.succeed(Bounds, { width: 10 }), // services for the whole app
  components: [Position, Velocity, Wind], // components and singletons, so a save that names them can be read
  setup: spawnTheBall, // runs once, on a fresh start
  scripts: [Gusts], // started with the app, and again after a load
});

const Combat = Plugin.make("Combat", {
  plugins: [Physics], // installed first
  systems: [BumpDamage],
  handlers: [heal],
});

const app = yield * App.make({ plugins: [Combat] });
app.dispatch(Heal, { amount: 5 }); // typed from Combat's handler
```

- A plugin that several others depend on is installed once: its systems are registered once and its layer is built once.
- A plugin's layer can use the built-in services and whatever its declared dependencies provide while it builds. Resources it acquires are released when the app's scope closes.
- Whatever systems, handlers and setups need that no plugin provides stays an ordinary Effect requirement of `App.make`, so it is provided the usual way and a missing one is the usual compile error:

  ```ts
  App.make({ plugins: [Sfx] }).pipe(Effect.provide(AudioLive));
  ```

- A layer or setup that fails makes `App.make` fail with that typed error.
- Events and actions are plain values, so a plugin does not list them. It exports them from its module. It does list its `components`, singletons among them, and its `scripts`, which loading a saved game needs; see [Saving and loading](#saving-and-loading).
- `setup` runs on a fresh start and not on a load. A plugin's scripts start after it, run like any other script, and are watched the same way.

## Names

A string that identifies something at run time carries the name of the feature it belongs to.

- The built-in services are keyed `"arcadekit/World"`, `"arcadekit/Time"`, `"arcadekit/Frame"`, `"arcadekit/Commands"`, `"arcadekit/Script"`, `"arcadekit/Ticks"`, `"arcadekit/Events"`, `"arcadekit/Random"` and `"arcadekit/Actions"`, so a game is free to key a service of its own `"World"`. The screen a frame loop follows is keyed `"arcadekit/Display"`, the devices `"arcadekit/Input.Devices"` and where they come from `"arcadekit/Input.Source"`.
- The bridge to a UI is `"arcadekit/View.Bridge"` and an app's end of it `"arcadekit/View.Port"`; the plugin is `"arcadekit/View"`, its system `"arcadekit/View.Send"`, and the system that publishes a view is named after it, `"View.publish(game/Hud)"`.
- What carries a session's messages is `"arcadekit/Transport"`.
- Where sound goes is `"arcadekit/Sound.Output"` and an app's player of cues `"arcadekit/Sound.Player"`; the plugin is `"arcadekit/Sound"`.
- An app's assets are kept under `"arcadekit/Assets.Store"` and fetched through `"arcadekit/Assets.Loader"`; the plugin is `"arcadekit/Assets"`, and the system that keeps a bundle is named after it, `"Assets.during(game/Forest)"`.
- What `Input.plugin` adds to a game is named the same way: the plugin and its singleton `"arcadekit/Input"`, its action `"arcadekit/Input.Report"` and its system `"arcadekit/Input.Read"`.
- A component's name is its identity in a world, and part of its type: `Component.define("physics/Position", ...)`. Nothing is shared between worlds, so two apps in one process, or a module evaluated twice, can each define a component with the same name. A world that meets two different components with one name refuses the second, where it is spawned, added, queued or queried.
- `world.component(name)` gives the component a world holds under a name. A world learns a component the first time it stores or queries it; `world.register(component)` tells it sooner.

## Events

```ts
const Collided = Event.define(
  "physics/Collided",
  Schema.Struct({ a: EntityId, b: EntityId })
);

// in a system
const collided = yield * Collided;
collided.emit({ a, b }); // a plain call, fine inside loops
for (const hit of collided.read()) {
} // everything this system has not seen

// in a script
const hits = yield * collided.wait; // suspend until some arrive
```

Every system sees every event exactly once, whatever order the systems run in: a system that runs before the emitter sees the event on the next tick. Events are dropped once every system has had that chance.

- The payload type comes from the schema. Emitting is still a plain call that checks nothing, so it stays cheap inside a loop.
- The schema is for when an event leaves the program: `Event.encode(Collided, payload)` gives its JSON form and `Event.decode(Collided, data)` reads one back, each as an `Exit` that fails with `Event.InvalidEvent`.
- `Event.define<Payload>("Name")` still defines an event with a type and no schema. It cannot be written down, so keep those for events that never need to be.
- An event's name is its identity in an app: two different events with one name are refused when the second is first used.

## Change queries

```ts
const Moved = Query.all(Position, Sprite).pipe(Query.changed(Position));
const Born = Query.all(Sprite).pipe(Query.added(Sprite));
const Gone = Query.removed(Sprite);

const Draw = System.make("Draw", function* () {
  (yield* Born).each((sprite, entity) => {}); // gained a Sprite since Draw last looked
  (yield* Moved).each((pos, sprite) => {}); // had its Position written since then
  for (const entity of (yield* Gone).read()) {
  } // lost its Sprite, or was despawned
});
```

A change query visits only the entities something happened to since whoever is asking last visited: `Query.changed` for a component that was written, `Query.added` for one that was gained. `Query.removed` gives the ids of the entities that lost one. So a system reacts to a change without looking at anything else, and when nothing changed a visit costs under 100 ns, whatever the size of the world.

- Every system has its own place in what changed, as it has in events, and sees every change once, whatever order the systems run in. A system that was not run misses nothing: what changed meanwhile is there when it runs again.
- The first visit is of every entity that matches: to a query that has never run, everything is new. A system that builds something for each `added(Sprite)` needs no other code for the entities that were there before it, or that came out of a save.
- An entity is visited once, however often it was written, and in the order any query visits entities in. One that has lost the component since, or was despawned, is not visited.
- A write is noticed per entity: by `world.set`, by adding a component with a value, and by assigning to a field in `each`. A component an entity has just gained counts as written. Reading notes nothing.
- `eachChunk` hands out raw columns and cannot tell a read from a write, so every row it hands out counts as written, unless the query says it only reads the component: `Query.all(Position, Velocity).pipe(Query.reads(Velocity))`. For the same reason a change query cannot `eachChunk` over a component it watches itself without saying so, which throws: it would take its own visit for a change. See [Saying what a query only reads](#saying-what-a-query-only-reads).
- Only a watched component is noticed. A component that no query watches costs nothing more to write than before.
- `each`, `eachChunk` and `entities` are visits; `count` looks without visiting. With several components, or with `changed` and `added` together, an entity is visited when any one of them fired.
- A system that writes what it watches sees its own writes the next time it runs.
- A refused action's writes are not changes: they are taken back with the rest, and so are the visits its handler made.
- A handler has a place of its own. Outside a system or a handler (in a script, a test, the entry point) there is one place per query, shared by whoever uses it there.
- `Query.removed` reports once per removal, oldest first, from the first time a reader asks. The id of a despawned entity is no longer alive.
- What a query has yet to visit is saved with a game by `app.save()`, with each system's place in it, so a loaded game reacts to what the saved one had not got to yet. It is not in `world.snapshot()` or in the world's hash: it belongs to the readers, and a plugin that only watches must not change the hash of the game it watches. With the storage core on its own, `world.saveChanges()` and `world.restoreChanges()` carry it beside a snapshot.
- Writes are noticed per row, not per table or per column. Either of those would cost nothing to write, but one `world.set` would then have every watching query visit the whole table. The cost is in the [benchmark](#benchmark-100000-entities-pos--vel--dt).

## Scripts

A script is an Effect that runs across many ticks: ordinary sequential code that waits for time to pass or for something to happen.

```ts
const Fountain = Effect.gen(function* () {
  const script = yield* Script;
  const commands = yield* Commands;
  for (let wave = 1; wave <= 5; wave++) {
    commands.spawn(Position.of({ x: 0, y: 0 }), Velocity.of({ x: 0, y: wave }));
    yield* script.sleep(0.5); // game time
  }
});

// From outside: it runs now, up to its first wait.
app.spawnScript(Fountain);

// From a system: it first runs when the tick flushes, after the systems.
const Opening = System.make("Opening", function* () {
  if ((yield* Time).tick === 1) {
    yield* (yield* Script).spawn(Fountain);
  }
});
```

- A script advances only during ticks. It waits with `script.nextTick`, `script.sleep` or an event's `wait`.
- The app watches the scripts started these two ways. One that fails is logged at once, with its cause, through Effect's logger, so the loggers provided to `App.make` receive it. One that is interrupted has not failed, and every script still running is interrupted when the app's scope closes.
- By default the game goes on without the failed script. `App.make({ onScriptFailure: "stop" })` stops the app instead: the tick the script failed in runs to its end and then fails with `App.ScriptFailed`, a defect that carries the script's cause, and so does every tick after it, without running anything. A driver stops on it.
- A fiber started with `Effect.forkDetach` is the caller's to observe: the app does not report its failure or interrupt it.

## States and run conditions

```ts
const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);

const Movement = System.make("Movement", function* () {
  // ...
}).pipe(System.runIf(State.is(Phase, "playing")));

const StartLevel = System.make("StartLevel", function* () {
  // ...
}).pipe(State.onEnter(Phase, "playing"));

const resume = Action.handler(Resume, function* () {
  const phase = yield* Phase;
  if (!phase.is("paused")) return yield* Effect.fail(new NotPaused());
  phase.set("playing"); // entered at the start of the next tick
});
```

A game is in the menu, playing or paused, and systems run only in some of those. A state is one of a few named values; a system says when it runs with a condition; and what has to happen once, on the way into a state or out of it, is a hook.

- `State.define` takes the state's name and its values. A game starts in the first, or in the one given as a third argument. `yield*` gives a handle: `value`, `is(...values)`, `set(value)`, and `next`, the state that was asked for and is not entered yet.
- `set` asks. The game enters the state at the start of the next tick: the hooks for leaving the old state run, seeing the old state; then the state changes; then the hooks for entering the new one run; then the tick's systems, as the new state has them. One move a tick: the last ask before it counts, and asking for the state the game is in takes an earlier ask back and is not a move.
- On a game's first tick, the hooks for entering the state it starts in run, followed in the same tick by a move that was asked for before it. What a hook asks for waits for the next tick.
- `State.onEnter(Phase, "playing")` and `State.onExit` make a system a hook. It runs then, and no longer every tick. Hooks of one moment run in the order they were given, or as `System.after` and `System.before` say, and the commands of each are applied before the next.
- `System.runIf(condition)` runs a system only on the ticks when the condition holds. `State.is(Phase, "playing", "paused")` is one; any Effect that gives a boolean is, and can read whatever a system can. Given several, a system runs when all of them hold. What a condition needs and can fail with are the system's.
- `System.otherwise(effect)` gives a system something to do in place of running, each time its condition does not hold. A system that keeps something outside itself as it should be, a picture on the screen or a track that plays, leaves it as it last was when it is not run; this is how it says what that thing should be then. It runs as the system, in its stage: in a tick its commands are applied, and in a frame it may change nothing. `Sound.music` uses it, so that music which is not asked for is not played. What it needs and can fail with are the system's too.
- A system with no condition is asked nothing and costs what it did. A condition costs about 0.35 µs a tick, and a system that does not run costs that and no more; see the [benchmark](#benchmark-100000-entities-pos--vel--dt).
- A system that does not run does not read. The events of the ticks it sat out are gone when it runs again, as for any system an event is older than. What its [change queries](#change-queries) have yet to visit is kept, however long it was away.
- A state is a [singleton](#singletons) of the world. It is saved with a game, with what was asked for, and counted in the hash; a refused action's `set` is taken back. List it in a plugin's `components`. A loaded game does not run its starting hooks again: the save holds what they did.
- With several states, the ones asked for are entered in order of name.

## What a system reads and writes

```ts
const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));

const Movement = System.make("Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
  });
}).pipe(System.access({ queries: [Moving] }));

const Scoring = System.make("Scoring", function* () {
  const score = yield* Score;
  for (const hit of (yield* Hit).read()) score.points += hit.damage;
}).pipe(System.access({ reads: [Hit], writes: [Score] }));

const app = yield * App.make({ systems: [Movement, Aiming, Scoring] });
app.conflicts; // the pairs whose order matters, and that nothing says
app.undeclared; // the systems that have not said
```

A system can say what it reads and writes, with `System.access`. Most of it is its queries, which already say which of their terms they only read. Beside them it names what it touches some other way.

| It says | For |
| --- | --- |
| `queries` | The queries it visits, `Query.removed` among them. A query's terms are written, but for the ones it [only reads](#saying-what-a-query-only-reads); what it requires, excludes or watches for changes is read |
| `reads` | What it reads and does not change: a singleton or a state, an event it reads, a component it reads through `World` |
| `writes` | What it changes: a singleton or a state, an event it emits, a component it sets through `World` or spawns, adds or removes through `Commands` |
| `random: true` | It draws from `Random` |
| `actions: true` | It issues actions with `Actions.enqueue` |
| `scripts: true` | It starts scripts with `Script.spawn` |

- **It is all of what the system does, and the app holds the system to it.** A query, a singleton, an event, a read or a write through the world, a command, an action or a script that was left out throws where it is made, names the system and what it did, and says what to add. A draw from `Random` is found when the system has run. So what a system says can be relied on: by the check below, and by what will run systems side by side.
- What a system may write it may read. A query it did not name is let through when everything it touches is within what the system said.
- A despawn takes everything an entity has, whatever was said. It is held to this much: the entity has a component the system said it writes, which is how the system knows it. A system that despawns bullets says `writes: [Bullet]`.
- What a condition given with `System.runIf(State.is(...))` reads is known, and need not be said. A condition of the game's own is the system's to say, as is what `System.otherwise` does.
- `Time` and `Ticks` are not said, nor is the picture of the devices, `Input.Keyboard` and its kind: no system writes the time or the picture, and asking for a tick is the same whoever asks first.
- A system that has not said may do anything, as before, and costs a tick nothing more. One that has costs it about 50 ns: a tick of ten systems that do nothing takes 6.1 µs when each has said, against 5.6. Nothing is checked inside a loop.
- Scripts and handlers are not systems, and are held to nothing.
- With the storage core on its own: `world.guard`, which is what an app sets before such a system runs.

**The order of systems can then be checked.** Systems run in the order they are listed in unless `System.after` or `System.before` says otherwise, and a plugin's are listed before the app's own: which of two runs first is often an accident. `app.conflicts` lists the pairs for which the accident decides something:

```ts
[
  {
    first: "Movement", // runs first, as things stand
    second: "Aiming",
    over: [
      {
        what: "physics/Position",
        kind: "component",
        first: "writes",
        second: "reads",
      },
    ],
  },
];
```

- Two systems are in conflict when both touch a component, a singleton, a state or an event, one of them at least to write it; or both draw from `Random`, both issue actions, or both start scripts: what comes of either then depends on which went first.
- They are not when their order is said: one is `after` or `before` the other, directly or through others; they are in different stages; or one is a hook, which runs before a tick's systems. Hooks of one moment are checked among themselves.
- `"watches"` is a read through a change query. A system listed ahead of the one that writes what it watches reacts a tick late, and that pair is in the list until its order is said.
- A game settles a conflict by saying the order, which changes nothing when it is the order they run in already. A test holds the list to empty: `expect(app.conflicts).toEqual([])`, and `expect(app.undeclared).toEqual([])` for a game that wants every system to have said.
- The systems of the frame stage and of the input stage change nothing, and are in neither list.
- `System.conflicts(systems)` is the same check of any list of systems, and `System.accessOf(system)` what one of them said, worked out.

## The tick and the frame

```ts
const Draw = System.make("Draw", function* () {
  const { alpha } = yield* Frame; // how far this frame is between two ticks
  const { delta } = yield* Time; // the length of a tick
  (yield* Moving).eachChunk((start, end, pos, vel) => {
    for (let i = start; i < end; i++) {
      draw(pos.x[i]! + vel.x[i]! * delta * alpha, pos.y[i]!);
    }
  });
}).pipe(System.inStage("frame"));

const app = yield * App.make({ systems: [Movement, Draw] });
const advance = Driver.fixedStep(app, { hz: 60 });
advance(secondsSinceTheLastFrame); // the ticks that are due, then the frame stage
```

The simulation ticks at a fixed rate. Drawing happens every frame, between ticks, and must not change the world. So an app has two stages: the tick, which is everything above, and the frame. A third, the input stage, runs before a tick and is described under [Input](#input).

- A system made with `System.inStage("frame")` runs when `app.frame(alpha, delta)` is called, and not in the tick. `Driver.fixedStep` calls it after the ticks of each frame; so does `Driver.interval`.
- `yield* Frame` tells it about the frame: `alpha`, how far the frame is between the last tick and the next, from 0 to 1; `delta`, the real seconds since the frame before; and `count`. That is real time, so a system that runs in the tick cannot read it: it throws and says to read `Time`.
- The world is frozen while the frame stage runs, and whatever would change the game throws where it is made and says why: spawning, despawning, adding and removing, `world.set`, a write to a singleton or a state, a command, an assignment in `each`, an event emitted, a script started, an action dispatched.
- It reads all it likes: queries with `each` and `eachChunk`, singletons, states, `Time`, and events and [change queries](#change-queries) from a place of its own. Events are kept for it until it has run, so it hears each one once however many ticks ran since the last frame (for up to 600 ticks, after which a frame stage that never ran is taken to be gone). Nothing is written in a frozen world, so there a change query may read what it watches with `eachChunk`.
- Its random numbers come from a generator of its own, seeded like the world's and not part of it: sparks do not change the game.
- An action issued there with `Actions.enqueue` is input from outside, as a button is: it is logged, applied at the start of the next tick, and replayed without a frame being drawn.
- The simulation cannot tell that it is being drawn. A game drawn every frame has the same hash, the same log and the same save as the same game never drawn, so a replay or a server runs it with no frame stage at all. The frame stage's places in events and changes are not saved: a loaded game has everything still to draw.
- Two changes are not stopped where they are made, because stopping them there would cost every loop and every draw. A draw from `world.random` is found when the frame ends: the generator is put back, so the game is as it was, and `frame` throws. A write through the raw columns of `eachChunk` is not found unless it is looked for: `App.make({ verifyFrames: true })` takes the world's hash before the stage and after each of its systems, and `frame` dies with `App.FrameChangedWorld`, which names the system. That is for development and tests, and checks the input stage the same way.
- A frame has three stages, as a tick has, and each runs whole before the next: `"preFrame"`, `"frame"` and `"postFrame"`. A game's systems are in `"frame"`. `"preFrame"` is for what they all stand on: [`Assets.during`](#assets) is there, so that every system of a frame finds the same assets loaded, wherever it is listed. `"postFrame"` is for what needs everything drawn: [`@arcadekit/three`](../three/README.md) puts the picture on the screen there, so a system that moves the camera says nothing about when. All three are the frame stage in every other way: the world is frozen, `Frame` is there to read, and `app.frameOrder` lists them in the order they run.
- `System.before` and `System.after` order a system within its stage. Said of a system in another stage they are true already or cannot be: `before` one of a later stage is accepted and changes nothing, and `before` one of an earlier stage throws when the app is made, and says which stage runs first. The same holds of a tick's stages. A frame's systems and a tick's are never ordered against each other.
- A frame system takes a condition with `System.runIf` like any other. A hook does not belong there: a state is entered by a tick.
- With the storage core on its own: `world.freeze()` and `world.thaw()`, which is where a draw from the world's generator is found.

## In a page

```ts
import { App } from "arcadekit";
import * as Browser from "arcadekit/Browser";

Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas });
```

`App.run` is the entry point: it makes the app and runs it until it is interrupted. It is `App.make` and the frame loop, `Driver.frames`, in a scope of their own.

`Browser.runMain` starts it in a page. It is the platform's `runMain` around the game, with the page's display and its devices provided to the whole of it: the frame loop follows `requestAnimationFrame`, and the [input stage](#input) hears the keyboard, the pointer and the gamepads. Its options are those of `Browser.layer`. A game that needs services of its own is given them first, `App.run(...).pipe(Effect.provide(Screen.layer))`, and one that still needs something does not compile.

- It never ends by itself. `Browser.runMain` interrupts it when the page goes away for good, as the platform's `runMain` does under Node when the process is told to stop, and that stops the loop and closes the scope. Nothing is left running: no frame asked for, no listener, no script, and whatever the plugins' layers acquired let go.
- What the game needs from outside is provided to it as to `App.make`, and a missing service is the same compile error. It stays provided for as long as the game runs, which is what a layer that listens, such as [`Browser.layer`](#input), needs.
- `ready` runs once, when the app is made and before its first frame, with the app: to wire what is outside the game to it, or to keep hold of it. A menu or a heads-up display needs no hold of the app: it is given [the view bridge](#the-view-bridge). What it acquires is let go with the app, and what it needs and can fail with are `run`'s.

  ```ts
  App.run(
    { plugins: [Game] },
    {
      hz: 60,
      ready: (app) =>
        Effect.sync(() => {
          button.onclick = () => app.dispatch(NewGame, {});
        }),
    }
  );
  ```

- Given a `save`, it goes on from it with `App.load` in place of a fresh start, and can fail with `Save.LoadRefused`.
- It fails with what `App.make` and `ready` can fail with, and dies with what a tick throws.
- It runs wherever there is a display, which outside a page is a timer: `NodeRuntime.runMain(App.run(...))` is the same game under Node, with no import but `arcadekit`, and `examples/demo.ts` is started that way.

`Driver.frames` is the frame loop underneath, for a program that makes its app itself. It follows the display until it is interrupted: each time a frame is due it runs the ticks that are due, at a fixed `hz`, and then the [frame stage](#the-tick-and-the-frame), as `Driver.fixedStep` does. In a page a frame is due once per repaint, which is `requestAnimationFrame`.

- The first frame draws the game as it stands and runs no tick. Time is counted from it.
- While the tab is hidden the loop asks for no frame, and the time spent hidden does not count. A game that comes back is where it was left, and does not run to catch up.
- Interrupting it takes back the frame it had asked for and stops watching the tab. It is interrupted with the fiber that runs it: `runMain` interrupts the program when the page goes away, and a loop started with `Effect.forkScoped` stops when its scope closes. So closing the app's scope leaves nothing running: no frame asked for, no listener, no script, and whatever the plugins' layers acquired let go.
- If a tick or a frame throws, the loop stops the same way and dies with what was thrown.
- A page that froze without being hidden runs at most `maxStepsPerCall` ticks in its next frame, 5 unless told otherwise, and drops the rest of the backlog.
- It reaches the screen through `Driver.Display`, a `Context.Reference` whose default is a timer of 60 frames a second that is never hidden, which is all there is under Node. A page's display, `requestAnimationFrame` and the document's visibility, is `Browser.display`, which `Browser.runMain` and `Browser.layer` provide.
- A test turns the display by hand:

  ```ts
  const display = Driver.makeManualDisplay();
  const fiber = Effect.runFork(
    main.pipe(Effect.scoped, Effect.provideService(Driver.Display, display))
  );
  display.frame(0); // a frame is due, at this many milliseconds
  display.frame(1000 / 60);
  display.hide(); // the tab goes away
  display.pending; // 0: no frame is asked for
  ```

- `examples/page` is a game in a page. `pnpm --filter arcadekit page` serves it.

### A game that moves when its player does

```ts
Browser.runMain(
  App.run({ plugins: [Chess] }, { hz: 60, ticks: "whenNeeded" }),
  { target: board }
);
```

A game of turns, a puzzle or a menu has nothing to do between two moves, and a game that ticks sixty times a second regardless runs its systems, passes its time and fills its log with checkpoints for nothing. With `ticks: "whenNeeded"`, `App.run` and `Driver.frames` draw every frame and tick only while something is waiting for a tick.

- The [input stage](#input) runs every frame, so a key, a button of the UI's or a message is heard in the frame it comes in, and the tick it asks for runs in that frame.
- It ticks while the app is not settled, at `hz` like any game, and once more after, for the systems that react a tick late to what a system listed after them did. Then it rests: no tick runs and the game's time stands still.
- `app.settled` says whether anything is waiting: an action to apply, a state to enter, a script that waits for the next tick or sleeps, a fiber that is due, or an event that some system has not had its chance at. Looking changes nothing.
- A system that has work of its own says so. One that does something every tick for as long as a condition of its own holds, a clock that runs down, a body in flight, is none of those: it asks for the next tick itself, `(yield* Ticks).more()`, each tick it has more to do. The tick in which nobody asks is the last. A handler and a script may ask too; between ticks it throws, since what draws the game does not decide when it ticks; and under a driver that ticks in real time it does nothing.
- An app that has just been made, or loaded from a save, is not settled: it runs one tick, in which every system can ask, and the one that follows it, before it rests. What was asked is not in a save.
- A script that sleeps keeps the game ticking for as long as it sleeps, at `hz`, so what takes the game's time (a piece sliding for three tenths of a second) takes it. A script that should let the game rest waits for an event.
- The frame stage runs every frame, at rest too. It is told the frame is all the way to the last tick, a `Frame.alpha` of 1: what draws between two ticks draws the game where it is.
- Resting is no part of the game. Its log holds the actions and the ticks they were applied in, and a replay given how many ticks it ran, `app.time.tick`, runs them one after the other and ends on the same hash.
- What is not counted: a system that does something every tick and does not say so. Its work stops when the game rests, and nothing tells it apart from one that had nothing to do.
- A frame of a game at rest costs 5.3 µs with the picture of the devices, a state and a view: the devices read, the app asked, and the frame stage.

### Drawing with Three.js

```ts
import { Three } from "@arcadekit/three";
import { Transform3d } from "arcadekit";

// The rules say where a rock is, with arcadekit's own components.
commands.spawn(Rock, Transform3d.Position.of({ x: 0, y: 4, z: 0 }));

// The page says how a rock looks: every one is an instance of one mesh.
const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  geometry: new IcosahedronGeometry(1),
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
});
const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin, Rules],
  systems: [Rocks],
});

Browser.runMain(
  App.run({ plugins: [Look] }, { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas }))
  ),
  { target: canvas }
);
```

[`@arcadekit/three`](../three/README.md) is the plugin that draws a game with Three.js, in a package of its own. It is made of what is above: systems of the frame stage that read the world and cannot change it, a service that holds the scene from one frame to the next, and a renderer that comes from outside as the display does.

- Where a thing is drawn comes from [`Transform3d` or `Transform2d`](#where-a-thing-is), which are this package's. The rules import nothing of `@arcadekit/three`, so a server and a replay install neither it nor Three.js.
- `Three.instances` draws every entity of a kind as one instance of one mesh, from the raw columns, with nothing allocated per entity per frame: ten thousand moving objects cost 0.1 to 0.4 ms of a frame before Three.js takes over. With `color`, each instance is drawn in a colour that a component of the game's gives it, and with `from`, in a look made of a bundle's assets for as long as they are loaded: `Three.texture(url)` is the asset that is a texture, and `Gltf.model(url)`, from `@arcadekit/three/Gltf`, the one that is a glTF model. `Three.objects` keeps an Object3D per entity for the few things that are more than that. With `smooth: true` either draws each entity between its last two places, at `Frame.alpha` of the way, so that a game whose ticks and frames do not line up moves evenly.
- A game that draws with something else does not install it.

## Input

```ts
// The picture: what the devices say, as the game has it this tick.
const Steer = System.make("Steer", function* () {
  const keys = yield* Input.Keyboard;
  const pointer = yield* Input.Pointer;
  const left = keys.down("ArrowLeft"); // held
  const jump = keys.pressed("Space"); // went down in this tick
  const aim = pointer.down() ? { x: pointer.x, y: pointer.y } : undefined;
});

// Bindings: the devices turned into the game's own actions.
const Controls = Input.bind(
  "game/Controls",
  Input.onPress(["KeyP", Input.padButton(0, 9)], TogglePause, {}),
  Input.onPress(Input.pointerButton(), Fire, (devices) => ({
    x: devices.axes.get(Input.pointerX) ?? 0,
  }))
);

const Game = Plugin.make("Game", {
  plugins: [Input.plugin], // keeps the picture
  systems: [Steer, Controls],
  handlers: [togglePause, fire],
});

// In a page: the page's devices, for the whole program.
Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas });
```

The keyboard, the pointer and the gamepads are outside the game. What they say reaches it as actions, through the same [log](#payloads-saves-and-the-network) as everything else that comes from outside. So a replay needs no devices at all: it is given no source and reads none, and the actions are in its log.

**The input stage.** An app has a third stage beside the tick and the frame. A system made with `System.inStage("input")` runs just before a tick. `Driver.fixedStep` calls `app.input()` there, and so `Driver.frames` and `Driver.interval` with it; and a tick that finds nobody did runs the stage itself, so a game that steps its app by hand with `app.tick(delta)` hears its keys and its UI with no more than that.

- The devices are read once per run, and every system of the stage is given that one sample as `Input.Devices`: the buttons that are `down`, the ones `pressed` and `released` since the sample before, the `axes`, and the ones that `moved`. A frame in which no tick is due reads nothing, and what was pressed meanwhile is there for the next tick, so a quick tap is never lost between two frames.
- The world is frozen there, as in the frame stage, and whatever would change the game throws. What a system makes of the devices it issues with `Actions.enqueue`, which is logged and applied at the start of the tick that follows.
- It hears events from a place of its own, each once, as the frame stage does: what a tick's systems emitted, what its actions emitted, and `Action.Rejected`, so a system that issued an action hears that it was refused. They are kept for it until it has run, the first tick's among them, and for up to 600 ticks when it does not run at all, as in a replay.
- `Input.Devices` is no part of the game, so a system in the tick or in the frame stage cannot read it: its fields throw there and say what to read.
- A replay does not run it: what the devices said is in its log, and `App.replay` ticks with `app.tick(delta, { input: false })`, a tick that reads nothing, whatever the machine it runs on is doing. Anything else that runs a game again from a log does the same. The simulation cannot tell whether its devices are read: a game played from a keyboard and its replay have the same hash at every tick.

**The picture.** `Input.plugin` keeps what the devices say in the world, for systems to read.

- `yield* Input.Keyboard` gives `down(code)`, `pressed(code)` and `released(code)`. `Input.Pointer` has `x`, `y` and the same three for a button, the main one unless told. `Input.Gamepad(index)` has `axis(n)` and the three for a button.
- `pressed` and `released` are true in the one tick that first sees the change, for every system of that tick, and for the handlers of the actions that tick applies: an action bound to a key sees the press that issued it. A key that went down and up between two ticks was pressed and released in the same tick and is not down; a held key that was let go and pressed again between two ticks was released and pressed in the same tick, and is down.
- What changed since the last tick is one action, `Input.Report`, and only when something did: holding a key still, or doing nothing, logs nothing.
- The picture is a [singleton](#singletons): saved with a game, put back by a refusal, and counted in the hash once something was pressed. A game nobody has touched hashes as one that has no input at all.
- The devices are the truth. A loaded game whose save had a key held, where the key is no longer down, lets it go at the first reading.
- Where no source is provided there are no devices, which is not the same as devices with nothing pressed: the picture is left as it was last reported. So a game that is given its reports from a log or from another machine can be run by a driver, input stage and all, and goes the same way.
- It is one picture, of one player's devices.

**Bindings.** `Input.bind(name, ...)` makes a system of the input stage out of `Input.onPress`, `Input.onRelease` and `Input.onMove`: when one of its codes is pressed, released or moved, it issues an action of the game's own.

- The handlers know nothing of keys, so the keys can change without the game or its replays changing, and the log says `Fire` and not which button.
- Given several codes, a binding issues its action once when any of them does it. The payload is a value, or a function of the sample for an action that needs to know where the pointer is. The compiler checks it against the action.
- Bindings do not need `Input.plugin`, and a game can use both.
- What a binding cannot say is a system of the input stage, which reads the world as well:

  ```ts
  const Pick = System.make("Pick", function* () {
    const devices = yield* Input.Devices;
    if (!devices.pressed.includes(Input.pointerButton())) return;
    const card = cardAt(yield* Cards, devices.axes.get(Input.pointerX) ?? 0);
    if (card !== undefined) (yield* Action.Actions).enqueue(PlayCard, { card });
  }).pipe(System.inStage("input"));
  ```

**Codes.** A button is a code and an axis is a code. A key's is the one the browser gives it, `KeyboardEvent.code`: `"KeyA"`, `"Space"`, `"ArrowLeft"`. The others are made by `Input.pointerButton(n)`, `Input.padButton(pad, n)` and `Input.padAxis(pad, n)`, and the pointer's place is `Input.pointerX` and `Input.pointerY`.

**Where the devices come from** is `Input.Source`, a `Context.Reference` whose default has no devices.

- `Browser.layer(options)`, from `arcadekit/Browser`, is a page's: the keyboard, the pointer (a mouse, a pen or a finger) and the gamepads, with the page's display. `Browser.runMain(game, options)` provides it. `target` is the element the pointer is pressed on and measured from, in CSS pixels from its top left corner; `preventDefault` lists the keys that must not scroll the page; `deadzone` is how far a stick has to be from its middle to count, a tenth unless told. A key held down went down once, and everything held is let go when the page loses focus. The buttons of a mouse held together are followed one by one, though a page tells of all but the first press and the last release as moves.
- It listens until its scope closes, so it is provided to the whole program. Provided to `App.make` alone it is let go as soon as the app is made, and says so when it is read.
- `Input.makeManualSource()` is a source worked by hand, for a test, a tool or controls drawn on the screen: `press`, `release`, `tap`, `move`.

  ```ts
  const source = Input.makeManualSource();
  const made = App.make({ plugins: [Game] }).pipe(
    Effect.provideService(Input.Source, source)
  );
  // With the app that gives:
  source.press("Space");
  app.tick(1 / 60); // hears the devices first
  ```

- Reading the devices when nothing changed costs 1.4 µs a tick. A tick in which a key went down or up costs 5.2 µs in all: the reading, the action and the tick that applies it. See the [benchmark](#benchmark-100000-entities-pos--vel--dt).

## The view bridge

```ts
// protocol.ts: what the UI may see, and what it may ask for. The UI imports this.
export const Hud = View.define("game/Hud", { score: 0, lives: 3 });
export const NewGame = Action.define("game/NewGame", Schema.Struct({}));

// game.ts: the game says what a view is, once per frame.
const ShowHud = View.publish(Hud, function* () {
  const score = yield* Score;
  return { score: score.points, lives: score.lives };
});
const Game = Plugin.make("Game", {
  plugins: [View.plugin],
  systems: [ShowHud],
  handlers: [newGame],
});

// ui.ts: the UI is handed the bridge, and nothing else.
export const mount = (root: Element, ui: View.Bridge) => {
  const label = root.querySelector("output")!;
  label.textContent = `${ui.get(Hud).score}`;
  ui.subscribe(Hud, ({ score }) => {
    label.textContent = `${score}`;
  });
  root.querySelector("button")!.onclick = () => ui.send(NewGame, {});
};

// main.ts: the entry point makes the bridge and gives each side its end.
const ui = View.makeBridge();
mount(document.body, ui);
Browser.runMain(
  App.run({ plugins: [Game] }, { hz: 60 }).pipe(Effect.provide(View.layer(ui))),
  { target: canvas }
);
```

A game's menus and its heads-up display are built with whatever the game chooses: the page's own DOM, React, anything. The package depends on none of them. What it gives is the bridge between the two: the game says which values the UI may see, and the UI acts by sending actions.

**A view** is a value the UI may see, declared with `View.define(name, initial)`. `initial` is what the UI has of it until the game first says, and gives it its type.

- It is a key and nothing of the game, like an action. The module that declares the views and the actions is the one thing the UI and the game share.
- Its value is plain data: text, numbers, booleans, and arrays and objects of them.

**The game publishes.** `View.publish(view, body)` makes a system of the [frame stage](#the-tick-and-the-frame): each frame it works the value out, and publishes it if it is not the value the UI already has.

- Two values are compared as data, field by field and however deep. So a body returns a new object each frame, and the UI is told only when something in it differs: a value that did not change costs the UI nothing, not a call.
- It reads what a frame system can (singletons, states, queries, events, assets) and cannot change the game. In the tick, publishing throws.
- Several ticks and one frame are one publication, of the latest value.
- It takes `System.runIf`: a view that is not published keeps the value it had, which is what a view that is costly to work out, and is worked out now and then, wants. One that belongs to a part of the game, and should not be seen when the game is elsewhere, says so: `System.otherwise(View.reset(Hud))` publishes the value the view was defined with while its system does not run.
- A frame system of the game's own publishes through `(yield* View.Port).publish(view, value)`, which says whether the value was news.
- Where no UI is there, on a server, in a replay, in most tests, no body runs at all.

**The UI holds the bridge**, `View.Bridge`, and nothing of the game.

- `ui.get(view)` is the value as last published. It is the same object until the view is published with another value, so `===` tells a UI library whether anything changed.
- `ui.subscribe(view, listener)` calls the listener each time the view is published with a new value, and returns what stops it. A listener that throws fails the frame, as any bug in the frame stage does, once every other listener was told.
- `ui.send(action, payload)` asks the game for an action. It is issued in the [input stage](#input), before the next tick, by `View.plugin`: logged, and applied or refused by its handler, exactly as a key bound to it would be. So a replay needs no UI, and a button is as good as a key.
- An action the game has no handler for is a bug, and `send` throws for it there, in the UI's own code: `View.plugin` tells the bridge which actions the game handles when the app is made, and until the app ends. One sent before the game is made, when nobody can tell, throws in the game's first input stage.
- A UI can be mounted before the game is made: it sees every view at its initial value, and what it sends waits.
- A bridge refuses two different views with one name.

**Binding it to a UI library** is a few lines, in the game. For React:

```ts
const useView = <A>(ui: View.Bridge, view: View.View<A>): A =>
  useSyncExternalStore(
    (changed) => ui.subscribe(view, changed),
    () => ui.get(view)
  );
```

- `View.Bridge` is a `Context.Reference` whose default is no UI. `View.makeBridge()` makes one and `View.layer(ui)` provides it.
- A game with a UI and the same game with none have the same hash, log and save, given the same actions.
- `examples/page` builds its menu and its heads-up display twice on one bridge, with the DOM (`ui-dom.ts`) and with React (`ui-react.ts`, shown by `?ui=react`). Neither imports anything of the game but `protocol.ts`. `test/page.test.ts` mounts both in a document and plays the game through them: while stars fall and none is caught, the UI is told nothing and nothing in the document changes.

## Sound

```ts
// The simulation says what happened. It knows nothing of sound.
const Bounced = Event.define(
  "physics/Bounced",
  Schema.Struct({ speed: Schema.Finite })
);

// What it sounds like: a system of the frame stage.
const Cues = Sound.cues(
  "game/Cues",
  Sound.on(Scored, "coin"),
  Sound.on(Bounced, ({ speed }) =>
    speed < 2 ? undefined : { cue: "thud", volume: Math.min(1, speed / 10) }
  )
);

const Game = Plugin.make("Game", {
  plugins: [Sound.plugin],
  systems: [Physics, Cues],
});

// Where it goes: in a page, the files of the cues.
Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), {
  target: canvas,
  sounds: { coin: "/coin.wav", thud: "/thud.wav" },
});
```

A sound is a named cue, and it is played because something happened: the simulation emits an [event](#events), and what the event sounds like is said elsewhere. The simulation never plays.

- `Sound.cues(name, ...lines)` makes a system of the [frame stage](#the-tick-and-the-frame). Each frame it plays what the events since the last frame sound like. It hears every event once, however many ticks ran in between, as any frame system does.
- `Sound.on(event, cue)` is a line: a cue's name, a name with a `volume` and a `rate`, or a function of the event's payload that gives either, or nothing. Several lines may be of one event, and each hears it.
- A cue that several events of one frame ask for is played once, as the loudest of them asked: forty coins caught in one tick are one sound, not forty on top of each other. That is the player's doing and not the system's, so it holds across systems: two that play the same cue in a frame, a plugin's and the game's, make one sound of it.
- What a frame's systems ask to hear is played when they have all run, by a system of [`"postFrame"`](#the-tick-and-the-frame) that `Sound.plugin` brings, in the order it was first asked for.
- `Sound.Player` is the service that plays, which `Sound.plugin` provides. A frame system plays through it for a sound no event stands for: `(yield* Sound.Player).play("click", { volume: 0.5 })`. It is heard with the rest of its frame, and is one sound with whatever else asked for the same cue. Asked for in the input stage, it is heard with the frame that follows. In the tick it throws and says what to do instead, and an action's handler that plays dies of the same.
- Sound follows real time and is no part of the game. A game that is heard has the same hash, log and save as one that is not, and a replay or a server, which run no frame stage, play nothing.
- What a refused action emitted is taken back with the rest, so it is never heard.
- `Sound.Output` is where sound goes: a `Context.Reference` whose default is nowhere, and there the cues' system reads nothing. `Sound.layer(output)` provides one, and `Sound.makeRecorder()` is one that plays nothing and notes what it was asked, for a test: its cues in `played`, what each channel was told in `scored`, and what each is playing now in `playing`.

  ```ts
  const sound = Sound.makeRecorder();
  const made = App.make({ plugins: [Game] }).pipe(
    Effect.provide(Sound.layer(sound))
  );
  // With the app that gives:
  app.tick(1 / 60);
  app.frame(0);
  sound.played; // [{ cue: "coin", volume: 1, rate: 1 }]
  ```

### Music

```ts
const Score = Sound.music(
  "game/Score",
  function* () {
    const level = (yield* Level).value;
    if (level === "menu") return undefined; // silence
    if ((yield* Paused).on) return { track: "theme", volume: 0.2 };
    return level === "cave" ? { track: "drip", fade: 2 } : "theme";
  },
  { fade: 1 }
);
```

Music is not an event. It is what the game, as it is, should sound like, for as long as it is so. `Sound.music(name, body)` makes a system of the frame stage that says so each frame, and the player starts, fades and stops what that takes.

- The body gives a track: a name the output knows, or one with a `volume` and a `fade` of its own, or `undefined` for silence. A track plays over and over until the body says another.
- `{ track: "fanfare", once: true }` plays to its end and no further. It is still what the channel is playing: it is not started again while the body says the same, another track fades it out if it has not ended, and it plays again from its start once the body has said something else in between. A sound that only marks a moment, and need not be faded or stopped, is a [cue](#sound).
- Nothing happens while it says the same. When it says another track the first fades out and the second fades in, over `fade` seconds; another volume is the same track, turned up or down as long. Half a second when nothing says.
- It is worked out from the game and kept nowhere in it. A game that is loaded from a save, or an app that starts in the middle of a level, has its music from its first frame, and a game with music has the same hash, log and save as one with none.
- Every such system is of one score, on the channel `"music"`. Of a menu's music and a level's, each a system that runs while the game is there, the one that has something to play is heard, and a track that both play goes on from the one to the other with nothing told. What a frame's systems say of a channel is made one thing when they have all run: silence gives way to a track, whichever was said first.
- Two systems that say different tracks of one channel in one frame, or one track at two volumes, is a bug: the frame fails where the second is said, with an error that names the channel and both.
- What plays beside the score has a channel of its own, any name: `Sound.music("game/Wind", body, { channel: "wind" })`. Two channels play together, and several systems can share that one too.
- The body reads what a frame system can: singletons, states, queries, events, [assets](#assets). Where sound goes nowhere it is not run at all.
- Under `System.runIf` it says nothing should play while the condition does not hold, as if the body had said so: music that is for a level stops when the level is left, with the fade it was given, unless another system of its channel plays. Run again, the body says what plays, from the start of the track.
- When the app's scope closes, every channel that was playing is told silence at once.
- `(yield* Sound.Player).music(channel, track, { volume, fade })` is what it is made of, for a frame system of your own. It tells the output of a change and of nothing else, so it can be said every frame, and in the tick it throws, as `play` does. The output is told at the end of the frame, as for a cue; said in the input stage, with the frame that follows.

### A level's sounds

```ts
const Forest = Assets.bundle("game/Forest", {
  creak: Browser.sound("/creak.wav"),
  wind: Browser.sound("/wind.ogg"),
});

// Its cues: lines made of what the bundle holds.
const ForestCues = Sound.cues("forest/Cues", Forest, ({ creak }) => [
  Sound.on(Stepped, ({ hard }) => ({ cue: creak, volume: hard ? 1 : 0.4 })),
]);

// Its music: a clip of the bundle, while the bundle is loaded.
// Beside the score, so on a channel of its own.
const Air = Sound.music(
  "forest/Air",
  function* () {
    const forest = yield* Forest;
    return forest._tag === "Ready"
      ? { track: forest.assets.wind, volume: 0.3 }
      : undefined;
  },
  { channel: "air" }
);
```

The sounds a page is given by name are there for as long as the page. A level's own are [assets](#assets) of its bundle, loaded when the game enters it and let go when it leaves.

- A loaded sound is a `Sound.Clip`, and goes wherever a cue's or a track's name goes: `Sound.on(event, clip)`, `{ cue: clip, volume }`, `{ track: clip }`, `player.play(clip)`.
- `Sound.cues(name, bundle, (assets) => lines)` makes the lines of what the bundle holds, once each time it is loaded. While the app does not hold the bundle loaded it plays nothing, and what happened meanwhile is not played later.
- A level's music is a body that reads the bundle and gives one of its clips once it is `Ready`. Entered again, the level is loaded again, and its music starts again.
- Both need `Assets.plugin`, which the type of the cues' system says.
- In a page the asset is `Browser.sound(url)`. It is decoded whole as it arrives. Let go with its bundle, what is still sounding of it plays to its end, or until its channel is told otherwise.
- `Sound.clip(name, data)` makes one by hand, for an output of your own or for a test, which needs nothing to play: a recorder notes a clip by its `name`, and the clip itself as `clip`.

### In a page

The output is Web Audio, and `Browser.runMain` and `Browser.layer` provide it. `sounds` gives the files of the sounds the page has for as long as it lasts, by the name a cue or a track is played by; `Browser.layerSound(files)` is the layer on its own.

- The files are fetched when the page starts, through `Assets.Loader`, and decoded as they arrive.
- A page may not make a sound before its user has touched it. The audio is made at the first key or pointer press, and a cue asked for in the frame after is played. A cue that was asked for before that, or before its file was there, is not played: a sound that is late is worse than none. The first cue that comes before the first touch is said, once, through Effect's logger, by its name: a game that opens with a sound is told why it is not heard.
- A cue is played only by audio that is running. While the audio sleeps, or is still waking, which takes a moment when the page is seen again or a laptop's lid is opened, a cue is dropped: started then, it would wait, and every cue that waited would be heard at once.
- Music is never late: it is what should be playing. A track that was asked for before the first touch, or before its file was there, starts when it can.
- `volume` is how loud everything is played, and `rate` is a cue's speed, and so its pitch.
- A cue or a track that has no file, or whose file could not be fetched or decoded, is said once through Effect's logger and plays nothing.
- A long piece of music is streamed: `sounds: { theme: Browser.stream("/theme.ogg") }`, or `Browser.stream(url)` as it is wherever a track is said. A file given by its URL, and `Browser.sound`, are fetched whole and held decoded, which for minutes of music is tens of megabytes; a stream is fetched as it plays and decoded as it goes. It is no asset and is in no bundle: nothing is fetched until it is played, and there is nothing to let go. It is started, faded and stopped as any track, and is for a track only: played as a cue it is said once through the logger and not played.
- While the page is hidden its audio sleeps, music and all, and wakes when the page is seen again: the frame loop rests then, and a game that stands still is not heard.
- A page with no files of its own still has sound, for the clips of its levels. `sounds: false` is a page with none: no audio is made, and the game is told that nothing is heard.
- When the page goes away the audio is closed, and a request still on its way is given up.

## Assets

```ts
const Forest = Assets.bundle("game/Forest", {
  backdrop: Browser.image("/forest.png"), // from "arcadekit/Browser"
  layout: Assets.json("/forest.json", Layout), // checked against a schema
});

const Game = Plugin.make("Game", {
  plugins: [Assets.plugin],
  systems: [Assets.during(State.is(Level, "forest"), Forest), Draw],
});

const Draw = System.make("Draw", function* () {
  const forest = yield* Forest; // what the app holds of it now
  if (forest._tag === "Ready") draw(forest.assets.backdrop);
}).pipe(System.inStage("frame"));
```

Loading is a scoped resource: what was loaded is let go when the scope it was loaded in closes. A bundle is the assets that are loaded together and let go together, a level's as a rule.

- `Assets.during(condition, bundle)` gives a level its scope. It is a system that keeps the bundle loaded while the condition holds, one of [`System.runIf`'s](#states-and-run-conditions), usually a state. From the frame after the game enters the level the bundle is loading, in a scope of its own; from the frame after it leaves, that scope is closed. It is of the stage before a frame's own, `"preFrame"`, so every system of that frame finds the bundle as it then is, wherever the two are listed. What was loaded is let go, a picture is closed, and a file that was still on its way is given up. Entered again, the level loads again.
- `yield*` on the bundle gives what the app holds of it: `Absent`, `Loading`, `Ready` with the `assets`, each under its name and with its type, or `Failed` with the error. A bundle that failed is logged once, keeps nothing of what did load, and is tried again when the level is next entered.
- Whatever is still loaded when the app's scope closes goes with it.
- Loading takes real time, so it is no part of the simulation. `Assets.during` is a system of the frame stage, and a bundle can be asked for in the frame stage and the input stage only: in the tick it throws. A replay or a server, which draw nothing, load nothing, and the game they run is the same game.
- What the game itself needs from a file, such as where the walls are, comes in as an action. A system of the input stage issues it once the file is there, with what it read as the payload, and from then on it is in the log, so a replay has it without the file:

  ```ts
  const Begin = System.make("Begin", function* () {
    const forest = yield* Forest;
    if (forest._tag === "Ready" && (yield* Walls).count() === 0) {
      (yield* Action.Actions).enqueue(Build, forest.assets.layout);
    }
  }).pipe(System.inStage("input"));
  ```

- Anywhere there is a scope, `Assets.load(bundle)` loads into it and waits: every asset at once, failing with `Assets.AssetFailed`, which names the URL, at the first that does. That is for the entry point and for a plugin's `layer`, which holds what it loads for as long as the app: `Layer.effect(Fonts, Assets.load(Common))`.
- An asset is `Assets.bytes(url)`, `Assets.text(url)` or `Assets.json(url, schema)`, and in a page `Browser.image(url)`, from `arcadekit/Browser`, which gives an `ImageBitmap` and closes it. One of a kind of your own is `Assets.make(url, decode)`, with `Effect.acquireRelease` for what has to be let go.
- A load is given what the app was given from outside and none of the app's own services, so nothing it does is the game's doing: the random numbers a loader draws, to wait a while before it tries again, say, are not the world's.
- The bytes come through `Assets.Loader`, a `Context.Reference` whose default is `fetch`, given up when the load is interrupted. A test provides its files with `Assets.layerMemory({ "/forest.json": "..." })`.
- A system of the game's own, in the frame stage or the input stage, can keep a bundle too, with `(yield* Assets.Store).hold(bundle, name)` and `drop`: it stays loaded while anyone holds it. In the tick the store throws, whatever it is asked, as a bundle does.

## Randomness

```ts
const Scatter = System.make("Scatter", function* () {
  const random = yield* Random;
  const sparks = yield* Sparks;
  sparks.each((spark) => {
    spark.x += random.next() - 0.5; // from 0 up to, not including, 1
  });
  const roll = random.int(1, 6); // a whole number, both ends included
  const cue = random.pick(["thud", "clang"]);
  const deck = random.shuffle([1, 2, 3, 4]); // in place
});

const app = yield * App.make({ systems: [Scatter], seed: 2024 });
```

- `Random` is the one source of randomness in a simulation. Its methods are plain calls, so they are fine inside a loop; a draw costs about 4 ns.
- The same seed gives the same numbers on every machine and in every JavaScript engine: the generator (xoshiro128\*\*) uses 32-bit integer arithmetic only, and `next()` is 32 random bits divided by 2^32. With no seed, the seed is 0, so a game is repeatable until it is given a seed from outside, such as the time at the entry point. `int` gives every value equal odds, and `shuffle` every order.
- The generator's state is four numbers in the world, `app.world.random.state`. A replay draws the same numbers as the game it replays, as long as it is made with the same seed, and copying the state back resumes the sequence where it was.
- Effect's own `Random` module is seeded from the same generator inside an app, so `Random.next` from `"effect"`, or anything built on it, replays too. It costs an Effect per draw, so it is not for loops.
- It is not for secrets: a few outputs give away the rest.

## The world's hash

```ts
const hash = app.world.hash(); // one whole number, from 0 to 2^32 - 1
```

`world.hash()` is one number for everything in the world that a simulation can tell apart. Two machines that have run the same game hold the same number, and a replay that has gone the same way does too.

It covers:

- every entity and the value of every field of every component it has, a component being known by its name and its fields;
- the order queries visit entities in: tables in creation order, rows ascending;
- the ids the next entities will get: the freed slots, in the order they will be reused, and their generations;
- every [singleton](#singletons) that has been written, by name;
- the state of the random number generator.

So two worlds built by the same operations in the same order hash equal, and changing one field of one entity always changes the hash: a single change cannot cancel out. Two different worlds hash equal by chance about once in four billion.

It does not depend on what cannot be told apart: how much room a table has, what is left in a column past its last row, which queries have been made, the order a sparse component's members joined in, or the order the program defined its components in. Every NaN counts as the same NaN, because its bits are the one thing engines do not agree on; 0 and -0 are different.

- A field that is not a number counts as it is saved: a `json` field as the plain data it holds, a `schema` or `ref` field in its encoded form, and a `transient` field not at all. See [Fields](#fields).
- It is 32-bit integer arithmetic on the bits of each field, so it is the same on every machine and in every JavaScript engine.
- It reads and changes nothing, so it can be called at any time. It costs about 8 ns per entity for four float fields, 0.8 ms for 100,000 entities; see the [benchmark](#benchmark-100000-entities-pos--vel--dt).

## Snapshots

```ts
const bytes = world.snapshot(); // a Uint8Array

const copy = new EcsWorld();
copy.load(bytes, [Position, Velocity, Burning]); // the components it may name
copy.hash() === world.hash(); // true
```

`world.snapshot()` is the whole world as bytes: every table and sparse set, the singletons that have been written, the ids to come, and the state of the random generator. A world that loads them hashes the same as the one they were taken from and goes on the same: the same order of iteration, the same ids for the next entities, the same random numbers.

- It is about as big as the data. A column of numbers is written as its bytes, so an entity with two `f32` fields takes 20 bytes: 8 of id, 8 of floats and 4 of generation.
- A component is written under its name, with the names and kinds of its fields, so a snapshot does not depend on the order a program defines its components in. A world knows a component by its name and an empty world knows none, so `load` is given the components the snapshot may name.
- `load` fills an empty world: one that has never held an entity or written a singleton.
- The format is numbered. This version writes format 3, which widened an [entity's id](#an-entitys-id), and reads formats 1 and 2 as well: an id of theirs is the same number, read from a narrower place. Format 2 added singletons.
- Every problem is a `SnapshotError`, whose `problem` says which kind and whose message names the component or field: `"not a snapshot"`, `"newer format"`, `"truncated"`, `"corrupt"`, `"unknown component"`, `"component changed"` (with its fields then and now), `"world not empty"`, `"cannot be saved"`.
- Damaged bytes are refused, not trusted: every count is checked against the bytes that are there before anything is allocated for it, an entity may not be in two rows or in a freed slot, and text has to be text. A damaged number inside a column cannot be told from another number, and loads as that.
- A `json` field is saved as the plain data it holds, exactly for text, numbers, booleans, bigints, null and undefined (`-0` and `NaN` come back as they were), and as JSON text for an array or an object. A `schema` or `ref` field is saved in its encoded form, and a `transient` field is not saved. See [Fields](#fields).
- A snapshot is refused while a spawn is queued on a `CommandBuffer` and not applied.
- It costs 7 ns per entity to take and 21 ns to load, for four float fields; see the [benchmark](#benchmark-100000-entities-pos--vel--dt).
- `world.restore(bytes)` puts a snapshot back into a world that is in use, in place of everything it holds: the world is emptied and loaded. Afterwards it is what a new world that loaded the snapshot would be, hash, order, ids to come and random numbers, which a test holds it to over random operations. It is for a snapshot the world took itself. A singleton's value stays the object it was, and `world.random` the generator it was. A view or a `removed` reader that was asked for before throws when it is used and says to ask again, as a system does every tick; what change queries had yet to visit is forgotten, and `restoreChanges` takes back what `saveChanges` gave. It costs 16 ns per entity.

## Actions (the rules layer)

```ts
const Strike = Action.define(
  "Strike",
  Schema.Struct({ attacker: EntityId, target: EntityId })
);

const strike = Action.handler(Strike, function* ({ attacker, target }) {
  if ((yield* whoseTurn) !== owner)
    return yield* Effect.fail(new NotYourTurn());
  // ...check the rules, change things, emit events; a refusal undoes all of it
  return hpLeft;
});

const app = yield * App.make({ handlers: [strike] });

app.dispatch(Strike, { attacker, target }); // Exit<number, NotYourTurn | InvalidPayload>, applied now
app.enqueue(Strike, { attacker, target }); // applied at the start of the next tick
```

- A refused action changes nothing. A handler may refuse at any point, even after it has written: what it wrote to components, the random numbers it drew, the commands it queued, the events it emitted and the actions it enqueued are all taken back, and the events it read are unread again. So is everything done by a handler that dies of a bug half-way. See [Refusals leave nothing behind](#refusals-leave-nothing-behind).
- `app.dispatch` is for turn-based input: the caller gets the typed outcome immediately. `app.enqueue` is for real-time input: the action waits for the start of the next tick, and a refusal becomes an `Action.Rejected` event. Both are for code outside the simulation. A system, a script or a handler issues an action with the `Actions` service, `(yield* Action.Actions).enqueue(...)`, so AI plays by the same rules as players. `handles(action)` of the same service says whether the game has a handler for an action, which `enqueue` throws without.
- A handler is told where the action came from, beside its payload: `function* (payload, { from })`. In a game of several peers `from` is the name of the peer that issued it, on every peer alike; in a game of one it is undefined, as it is for an action the simulation issues itself. Who may do a thing is checked against that, and not against a name in the payload, which whoever sent it wrote. It is in the log, kept with an action that waits in a save, and told with a refusal: `Action.Rejected` has it, so that a UI shows a player their own.
- Dispatching an action with no handler, or with the wrong payload, does not compile.

### Payloads, saves and the network

- The payload type comes from the schema, and every payload is checked against it before the handler runs, including refinements the compiler cannot see (an amount between 1 and 10, say). A mismatch is an `Action.InvalidPayload` failure.
- Input that arrives as data goes through `app.dispatchByName(name, json)` or `app.enqueueByName(name, json)`. An unknown name or a malformed payload is a failure or a `Rejected` event, never a crash. Either takes who issued it as a third argument, for a program that brings actions in on someone else's behalf, a server for its clients: `app.enqueueByName(name, json, client)`.
- `app.actionLog` holds what came into the game from outside, in the order it came, with payloads in JSON form (a bigint or a date in the payload is converted for you): every dispatched action that was accepted, and every action enqueued through the app, marked `queued` and, if it was refused when its turn came, `refused` with the reason in a few words. Checkpoints of the world's hash are among them. What the simulation issued itself through `Actions` is not in the log: a replay's own systems issue it again. `Action.encodeLog` and `Action.decodeLog` turn the log into text and back; `Action.isCheckpoint(entry)` tells the two kinds of entry apart.
- `App.replay(freshApp, log, { delta, ticks })` reproduces the game in an app made with the same seed and started from the same state, and checks itself as it goes; see below.
- `Action.define<Payload>()("Name")` still defines an action with no schema. Only the compiler checks it, so keep those for actions that never leave the program.

### Refusals leave nothing behind

A refused action is not in the log, so a replay never runs it. Anything it left in the world would be a difference between the game and its replay. A handler therefore runs in a transaction of the world:

```ts
const strike = Action.handler(Strike, function* ({ attacker, target }) {
  const world = yield* World;
  const roll = (yield* Random).int(1, 6); // drawn, and put back on refusal
  world.set(attacker, Fighter, { energy: 0 }); // written, and put back
  (yield* Commands).spawn(Spark.of({ at: target })); // queued, and discarded
  if (roll === 1) return yield* Effect.fail(new Fumbled()); // refused: none of it happened
});
```

- What a handler is about to write is saved first: one row for `world.set`, and for `each` and `eachChunk` the columns of the query's terms in every table the loop visits, once each, but for the terms the query [only reads](#saying-what-a-query-only-reads). A refusal copies them back and restores the random generator.
- A handler changes which entities exist through `Commands`. `world.spawn`, `despawn`, `add` and `remove` throw inside a handler: rows must stay where they are for a write to be put back by a plain copy. A discarded spawn gives its id back exactly, so the next entities get the ids they would have had.
- A handler reads its own writes while it runs, and an accepted action costs one save and no copy back.
- The events a handler read count as unread again after a refusal, and so do the visits its change queries made: the next action hears what a replay, which never ran the refused one, will have it hear.
- A handler cannot dispatch another action; it issues one with `Actions.enqueue`, and a refusal takes that back too.
- The storage core has this on its own: `world.begin()`, then `world.commit()` or `world.rollback()`.
- The cost is in the [benchmark](#benchmark-100000-entities-pos--vel--dt): 0.2 µs more for a handler that sets one entity, and one copy of the visited columns for a handler that loops.

### Saving and loading

```ts
const saved = app.save(); // Exit<Save, SaveRefused>
const bytes = Save.encode(save); // a Uint8Array, for a file

const read = Save.decode(bytes); // Exit<Save, LoadRefused>
const app = yield * App.load(save, { plugins: [Rules] }); // the game, where it was
```

A save is taken between two ticks. It holds the world as a [snapshot](#snapshots), the game's time, the actions waiting for the next tick (the simulation's own among them), the events waiting to be read, with how far each system had read them, and what [change queries](#change-queries) had yet to visit. A game loaded from it goes on exactly as the saved one did.

- `App.load` takes the plugins and options the game was made with. No plugin's `setup` runs: the save holds what setup spawned.
- A save cannot hold a script in mid-flight. A plugin lists its `scripts`, and they start again from their beginning when the app is loaded. So a script keeps what it must not lose in the world, and picks up from what it finds there.
- A world knows a component by its name, so every component and singleton a save names has to be listed in a plugin's `components` or the app's. A load that meets one that is not fails with `LoadRefused` and names it.
- **A save is a snapshot plus the log since.** The save says how long the log was (`save.logLength`). A game that keeps its last save and the entries logged after it comes back to the present by loading the save and replaying only that tail, which costs the same however long the game has run: `App.replay(app, log.slice(save.logLength), { delta, ticks })`. The replay checks itself against the tail's checkpoints, so a save that did not bring the game back faithfully is caught on the next tick.
- `app.save()` fails with `Save.SaveRefused` and says what is in the way: an action or an event with no schema is waiting, a field holds a value it cannot save, or commands are queued and not applied. `App.load` and `Save.decode` fail with `Save.LoadRefused`, whose `problem` is one of a snapshot's, or `"not a save"`.
- A save is the snapshot and a little text: for 100,000 entities with four float fields, 2.8 MB and about 0.7 ms to take.

### Versions and migrations

```ts
const migrations: Save.Migration[] = [
  {
    from: 1, // takes a save of version 1 to version 2
    migrate: ({ world, queued }) => {
      Migrate.renameComponent(world, "game/Hp", "game/Health");
      Migrate.addField(world, "game/Health", "armor", "i32", 0);
      Migrate.mapField(world, "game/Health", "points", "f32", (hp) => hp / 2);
    },
  },
];

const app = yield * App.load(save, { plugins, version: 2, migrations });
```

A game has a `version`, a whole number it raises when it changes its components or what its saves hold. A save records the version that wrote it, and its world names every component with its fields.

- A save of the game's own version loads as it is. An older one is brought up one version at a time, by the migration `from` each version. A newer one is refused.
- A migration is given the save in a plain form that describes itself, `Save.Contents`: the world as the snapshot lists it (components by name with their fields, tables, sparse sets, one column of values per field), and the waiting actions and events in JSON form. It needs none of the game's old component definitions.
- What change queries had yet to visit is in `Save.Contents` too, under each component's name. For a component a migration renames, the queries that watch it start over after the load: every entity counts as changed.
- `Migrate` has the usual changes to a world: `renameComponent`, `removeComponent`, `renameField`, `addField`, `removeField`, `mapField`. Each refuses what is not there, by name. Entities keep their ids, and two tables that a removed component had kept apart become one.
- `readSnapshot` and `writeSnapshot` are the two halves on their own, for a tool that inspects or edits a snapshot.
- Every refusal is a `Save.LoadRefused` that says why: `"newer version"`, `"no migration"` (and from which version to which), `"migration failed"` (which one, and what it threw), or, when the migrations did not bring the save all the way, `"component changed"` or `"unknown component"` with the component's fields then and now.
- A migration makes a new game of an old save, so the log recorded before it no longer replays against it.

### Replays that check themselves

```ts
const app = yield * App.make({ plugins: [Rules], seed, checkpointEvery: 1 });
// ...the game is played...
const saved = Action.encodeLog(app.actionLog);

const again = yield * App.make({ plugins: [Rules], seed, checkpointEvery: 1 });
App.replay(again, loaded, { delta: 1, ticks }); // throws App.ReplayDiverged
```

- A checkpoint is the world's [hash](#the-worlds-hash) at one point of the game: `{ tick, hash }`. The app records one before the first action or tick, which is the state the game starts from, and one at the end of every tick whose number divides by `checkpointEvery`. `app.checkpoint()` records one more, between ticks, for a point the game wants checked, such as the moment it is saved.
- A replay compares its own world with each checkpoint as it reaches it, and stops at the first that does not match, before applying anything recorded after it. It throws `App.ReplayDiverged`, whose `tick` is that checkpoint's tick and whose `reason` is an `App.HashMismatch` with the hash that was `expected`, the `actual` one and `agreedAt`, the tick of the last checkpoint that did match. With a checkpoint every tick, that is the tick the replay diverged on.
- A replay made with another seed, or into a world that does not hold what the game's world held, stops before its first tick.
- A dispatched action that is refused still stops the replay, with the refusal as the `reason`. An enqueued one is enqueued again at the point it arrived, so it takes its turn among the actions the replay's own simulation issues; if the replay refuses what the game accepted, or the other way round, the replay stops after the tick that applied it. Without checkpoints those were the only checks: a replay that had gone wrong ran on until an action happened to be refused, and one whose fault broke no rule ran to its end and gave another game.
- `checkpointEvery` is 60 unless told otherwise. A checkpoint costs one hash of the world, 0.8 ms for 100,000 entities, so a smaller number finds a divergence closer to where it happened at that price per checkpoint, and adds an entry to the log each time. A turn-based game ticks once a move and wants 1. With 0 the app records none.
- Once a game has started, what changes its world has to be in the log or come from the simulation: an action, a system, a script. A coin spawned straight into `app.world` between two ticks is in neither, so a replay cannot know of it, and stops at the next checkpoint.

## More than one player

```ts
const app = yield * App.make({ plugins: [Game], seed });
const session = Lockstep.make(app, {
  peer: "ada", // this machine's player
  peers: ["ada", "grace"], // everyone: the same names on every machine
  delta: 1 / 60, // the seconds a tick simulates, the same on every machine
});

app.enqueue(Move, { player: "ada", dx: 1 }); // as in a game of one

session.receive(message); // a message that came from another peer
session.tick(); // true if the tick ran, false if it waits for a peer
for (const message of session.outgoing()) send(message); // to every other peer
```

Every peer runs the same simulation, and what they send each other is the actions their players issue and nothing else, each stamped with the tick it applies on. That is lockstep. A game is the same game on two machines when both apply the same actions on the same ticks in the same order, which is what the [log](#payloads-saves-and-the-network) already says of a game of one, so a session is little more than the log, shared.

- A session takes its app over. What comes into the game from outside is no longer queued for the next tick: `app.enqueue`, a key [bound](#input) to an action, a button of [the UI](#the-view-bridge). Each goes into this peer's message for the tick `delay` ticks ahead, and every peer applies it on that tick, the one that issued it among them. So a game issues its input as a game of one does, and goes from one player to several without changing how.
- A peer runs a tick once it holds every peer's message for it. There is one message from every peer for every tick, empty more often than not, since it is also how a peer says it has nothing more for that tick. `session.tick()` says whether the tick ran, and `session.waitingFor` names the peers it waits for.
- `delay` is how long a message has to arrive before anyone waits: 2 ticks unless told. A player sees their own move that much later, and a network that takes longer than that slows the game to its pace. Each peer may have its own.
- A tick's actions are applied peer by peer in the order of the peers' names, and each peer's in the order it issued them, whatever order the messages arrived in. Two players who go for the same coin on the same tick get the same answer on every machine: one has it, and the other is refused, with the same `Action.Rejected`.
- Messages arrive in any order and more than once. One that is held already, is for a tick that has run, or comes from a name that is no peer of the game, is dropped. Every message has to arrive in the end.
- A session holds no socket and no timer. `session.receive` is given what arrived and `session.outgoing()` gives what to send; `Lockstep.encode` and `Lockstep.decode` turn a message into text and back, the second as an `Exit` that refuses what is not one. A payload is checked against its action's schema when it is applied, by every peer alike.
- The session steps the app. `app.tick` and `app.dispatch` throw from then on, and say why: either would move this machine's game and nobody else's. A driver is given the session in the app's place, `Driver.frames(session, { hz: 60 })`, and draws the game through it; a driver at another rate than the session's `delta` is refused.
- A tick hears the devices first, as an app's own does, and a key that is pressed while the peer waits for another is in its next message.
- What the simulation issues itself with `Actions`, a bot's move, is not sent: every peer's own simulation issues it.
- Every peer's handler is told which peer issued an action, `{ from }`, beside the payload. The session stamps it from the message it came in, so a player's move need not say whose it is, and cannot say it is someone else's:

  ```ts
  const pass = Action.handler(Pass, function* (_, { from }) {
    const turn = yield* Turn;
    if (turn.player !== from) return yield* Effect.fail(new NotYourTurn());
    turn.player = other(from);
  });
  ```

- Every peer is made alike: the same plugins, the same seed, the same state to start from. A session begins at whatever tick its app is at, so a game can go on from a save that every peer loaded.
- The log of a peer is an ordinary log. Every peer's is the same, entry for entry, and `App.replay` plays it back into a game of one.
- `app.divert(take)` is what a session is made with, for a session of another kind: it hands over what comes in from outside, and returns the one way left to queue an action and to run a tick.

### Without waiting: rollback

```ts
const session = Rollback.make(app, {
  peer: "ada",
  peers: ["ada", "grace"],
  delta: 1 / 60,
  ahead: 8, // how many ticks it may run past what every peer has said
});

app.enqueue(Move, { player: "ada", dx: 1 });
session.tick(); // the move is in the world, whatever the network takes
session.confirmed; // how many ticks are final
```

A lockstep session shows a player their own move `delay` ticks late, and a network slower than that slows everyone. A rollback session does not wait. It runs the tick at once, as if the peers it has not heard from had nothing to say for it, which is true of most ticks; and when a message comes for a tick that has run, and it did have something to say, the session goes back to before that tick and runs forward again with what it knows now.

- It is the same session, with the same messages, and everything above holds of it: it takes its app over, is given what arrived and gives what to send, is stepped by a driver, and applies a tick's actions in the order of the peers' names. A lockstep session is one that runs no tick ahead.
- A player's own move is applied on the next tick: `delay` is 0 unless told. A delay of a tick or two spares the other peers a rewind for every move, for that much lag on one's own.
- `ahead` is how far it runs past what every peer has said, 8 ticks unless told. A peer that far ahead waits, as a lockstep session does, and `waitingFor` says for whom. It is also the furthest a rewind goes back.
- The peers end the same game. Every peer applies every action on the tick it is stamped with, whenever it heard of it: in the tests, peers under a network that takes up to seven ticks hold the same world and the same log once the messages are in, and the log replays into a game of one that never went back, tick for tick.
- A message that says nothing for a tick that has run costs nothing: the guess was right. One that says something costs a rewind and the ticks since, run again. `session.rewinds` and `session.resimulated` count them, and `session.confirmed` is how many ticks are final: what is after it may still be run another way.
- Before a tick it is not sure of, the session keeps the game as it is, with `app.capture()`, and lets go of it once every peer has spoken for that tick: `session.kept` of them at a time, never more than `ahead`. A tick that every peer has spoken for is not captured at all, so a fast network pays nothing.
- A peer may see a move accepted that is then refused. Two players who take the same coin on the same tick each see themselves take it, until the other's message arrives: then both have the one whose name comes first take it, and the other's take is refused, in the log and in the world.
- The peers compare the hashes of the ticks that are final, and stop with `Lockstep.Drifted` as lockstep peers do. A tick's hash is sent once every peer has spoken for it, so a difference is found within `checkpointEvery - 1 + delay + 2 × ahead` ticks.
- `session.tickExit()` can also fail with `Save.SaveRefused`, when the game cannot be captured: a field holds a value no snapshot can hold. The tick is not run.
- What a rewind puts back is what `app.capture()` holds, below, and what it does not is the game's to keep out of the simulation's way.

**Going back to a moment** is the app's own, for a session or a tool:

```ts
const moment = app.capture(); // Exit<App.Moment, Save.SaveRefused>
app.tick(1 / 60);
app.rewind(moment.value); // the same app, as it was
```

- A moment holds what a [save](#saving-and-loading) does: the world, the game's time, the actions waiting for the next tick, the events waiting to be read with everyone's place in them, what change queries had yet to visit, and how long the log was. `rewind` puts all of it back in place and cuts the log back: the app, its world and its services are the ones they were.
- It is kept in memory and is of one app in one run of the program. So what is waiting needs no schema: a game with an action or an event of a type alone can be captured where it cannot be saved.
- Scripts are not in it, as they are not in a save. A rewind interrupts every script the app watches and starts each plugin's `scripts` again from their beginning. A script that keeps its place in its own variables plays its part a second time, so a game that is played with rollback does in a system what such a script would do, or keeps the script's place in the world.
- Nor is what a service of the game's own holds, or a field that is `transient`, which is undefined afterwards, as in a loaded game.
- What draws starts over. The frame stage's and the input stage's change queries visit everything again, as in a loaded game, and they hear the events of a tick that is run again a second time: a sound may be played twice.

### Carrying the messages

```ts
const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game], seed });
  const session = Rollback.make(app, { peer, peers, delta: 1 / 60 });
  return yield* Driver.frames(yield* Transport.connect(session), { hz: 60 });
}).pipe(
  Effect.scoped,
  Effect.provide(Transport.layerBroadcastChannel("game/room-7"))
);

Browser.runMain(program, { target: canvas });
```

A session holds no socket. What carries its messages is a service, `Transport`, with two plain calls: `send(message)`, to every other peer, and `receive()`, which gives the messages that have arrived since it was last asked.

- `Transport.connect(session)` joins a session to the transport and gives what a driver steps in the session's place. Each tick it hands the session what has arrived, runs the session's tick, and sends what the session has to say, whether the tick ran, waited or failed: a session that stops because the peers have come apart says so to the others first.
- There is no default. A game of several peers that is given no transport does not compile, as with any service: every way of reaching the others is a choice.
- It asks little of a wire: that every message arrives, in whatever order. A message that arrives twice is dropped by the session.
- `Transport.layerBroadcastChannel(name)` is the transport between the tabs, the windows and the workers of one browser, or the threads of one process. Every peer that opens the same name hears every other, with no server. It reaches no other machine. The channel is closed with the layer's scope, so the layer is provided to the whole program, and a transport that is used after its scope has closed throws and says so, in place of a game that waits for ever.
- `Transport.layerWebSocket(url)` is the transport between machines: a WebSocket to [a relay](#a-relay), which passes each message on to the other peers of the room. The address says the room and the peer, as `Relay.address` writes it. What is sent before the socket has opened is kept and sent when it has. It uses the `WebSocket` every platform has, a page, a worker and Node 22 alike, and is closed with its layer's scope.
- A socket that closes for any other reason is the end of the game over it: `send` and `receive` throw `Transport.Closed` from then on, with the close code and what the relay said, so the tick fails and its driver stops. It does not connect again, since a message lost on the way would be lost for good.
- `Transport.text(wire)` makes a transport of anything else that carries text, a data channel or a port: `{ send(text), listen(onText) }`. A message travels as `Lockstep.encode` writes it, and a text that is not a message is dropped and counted in `dropped`: nothing that comes off a wire is trusted.

- `Transport.makeHub({ delay, seed })` is a network in memory, for tests. `hub.layer(peer)` is a peer's end of it. Nothing is lost and nothing happens until the test says so: a message is on its way for as many steps as its delay, a number or a range from which each message's is drawn, so that they overtake each other, and time passes when the test calls `hub.step()`. The same seed is the same network.

  ```ts
  const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 1 });
  const ada =
    yield * Transport.connect(session).pipe(Effect.provide(hub.layer("ada")));
  hub.step();
  ada.tick();
  ```

- The frame loop rests while its tab is hidden, and a peer that rests is waited for. Two peers in one browser are two windows side by side, not two tabs of one.

### A relay

```ts
// What a peer connects to.
const url = Relay.address("wss://relay.example.com/rooms", {
  room: "blue",
  peer: "ada",
});
// "wss://relay.example.com/rooms/blue?peer=ada"

// What a host does with a peer that asks to come in, and with what one sent.
const member = Relay.join(request.url, present); // Exit<Member, Refused>
const deliveries = Relay.forward(member, data, present); // Exit<Delivery[], Refused>
for (const { to, text } of deliveries.value) socketOf(to).send(text);
```

Peers on different machines meet at a relay: each opens a WebSocket to it, at an address that names a room and the peer, and what one sends the relay passes on to the others in the room. It runs no game and keeps nothing of one.

`arcadekit/Relay` is the relay as a handler, and no server: plain functions that say what to do with a connection and with what it sent, for whatever accepts the sockets to call. It imports Effect alone, so it runs wherever that does.

- `Relay.join(url, present, options)` says whether a peer may come in, from the address it asked for and whoever is in the room already, and gives its `Member`, `{ room, peer }`, for the host to keep with the connection. It is refused when the address names no room or no peer, when the name is taken in that room, when the room is full (`maxPeers`, 8 unless told), or when the room lets in only `peers` this is not one of.
- `Relay.forward(member, data, present, options)` says what to pass on of something a member sent: one text for every other member of its room. What is passed on is the message as the relay read it, written out again, so nothing rides along. It is refused when it is not a message, when it is longer than `maxLength` (65,536 characters unless told), or when it says it is from anyone but the member that sent it.
- A refusal is a `Relay.Refused`. A host closes the socket with it, `socket.close(refused.code, refused.reason)`: the reason is a few words, `"name taken"`, since a close frame carries 123 bytes at most, and `Transport.layerWebSocket` hands it to the peer it was closed on. Its `message` says more, with the names, for a log, and `status` is the HTTP status for a host that turns the request away instead; a page is told nothing of that, so a host that wants the peer to know why accepts the socket and closes it.
- **The relay vouches for the sender.** A peer says who it is once, when it connects, and is held to it: a message in another's name is refused and the socket closed. So the `from` [a handler is told](#actions-the-rules-layer) is the peer the relay let in under that name.
- Whether to let that peer in under that name is the host's to decide before it calls `join`, with whatever the request carries: a token, a session, a list of players. The relay asks nothing of it.
- `present` is whoever is connected, as the host knows them. The functions keep nothing between two calls, which is what a host that is put to sleep between two messages needs: on Cloudflare a Durable Object reads its members back from its sockets' attachments, and `Relay.Member` is the schema to keep one with; behind an API gateway they are the rows of a table of connections.
- `Relay.make(options)` keeps them itself, for a host that stays in memory: `relay.connect(url, send)` gives a connection to `receive` what the peer sent and to `close`. `examples/relay.ts` is that behind a WebSocket server under Node, forty lines, and `pnpm --filter arcadekit relay` runs it: two machines on one network play through it as it is.
- A room is named by its address and belongs to nobody: the first peer to ask opens it, and it is gone when the last has left.

**On Cloudflare, with [Alchemy](https://alchemy.run).** `examples/relay-cloudflare` is the relay as a Worker and a Durable Object per room, declared and deployed with Alchemy: three files, of which `src/room.ts` is the host.

```ts
export default class Room extends Cloudflare.DurableObject<Room>()(
  "Rooms",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const present = /* every socket of the room, with the member it carries */;
      return {
        fetch: Effect.gen(function* () {
          const joined = Relay.join(request.url, members(yield* present));
          if (Exit.isFailure(joined)) return turnedAway(joined);
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* socket.setAttachment(Relay.Member, joined.value);
          return response;
        }),
        webSocketMessage: Effect.fn(function* (socket, data) {
          const from = yield* socket.getAttachment(Relay.Member);
          const deliveries = Relay.forward(from, data, members(yield* present));
          if (Exit.isFailure(deliveries)) return yield* close(socket, deliveries);
          for (const { to, text } of deliveries.value) yield* socketOf(to).send(text);
        }),
      };
    });
  })
) {}
```

- The room keeps nothing in memory. Cloudflare puts a Durable Object to sleep between two messages and keeps its sockets open, and each socket carries its member as an attachment, which is read back on every call: that is all `join` and `forward` ask to be told.
- `pnpm --filter arcadekit relay:cloudflare` runs it on this machine, in workerd, with no Cloudflare account: `alchemy dev`, with the stack's state kept in a folder beside it. `alchemy deploy`, from `examples/relay-cloudflare`, puts it on an account.
- `pnpm --filter arcadekit relay:check <address>` checks a relay wherever it runs: two peers of a small game play through it and have to end on the same world, a second peer of a taken name has to be refused, and so does a message in another's name. It passes against the Node relay (`ws://localhost:8787`) and against this one under `alchemy dev` (`ws://localhost:1337/rooms`). It has not been run against a deployed Worker: that needs an account.
- A peer that is refused there is turned away with the HTTP status, before there is a socket, and so learns only that it did not connect. Accepting the socket and closing it with the reason, as the Node relay does, left the socket half-closed under workerd.
- Alchemy and its Cloudflare package are dev dependencies of this package, for that example alone, as React is for the page's. They are a beta (2.0.0-beta.87), and ask for Effect 4.1.4, which is what the repository now installs.
- Behind an API gateway on AWS the same two functions are called from a function per event, with who is connected kept in a table: `join` on connect, `forward` on a message, and the row deleted on disconnect. There is no example of that here.

### Peers that come apart

```ts
const exit = session.tickExit(); // Exit<boolean, E | Lockstep.Drifted>
session.drifted; // why the session stopped, once it has

// The peers are no longer playing the same game. At tick 120 the hashes of
// their worlds are: ada 2860666740, grace 3734032547 (found by "ada"). They
// last agreed at tick 60, so they came apart in one of the 60 ticks after it: ...
```

Lockstep rests on every peer's simulation going the same way. One system that reads the clock, `Math.random` or the order of a `Set`, and the peers hold different games, each sure of its own. So the peers compare: each tells the others the [checkpoints](#replays-that-check-themselves) its log records, the hash of its world at a tick, in the messages it sends anyway.

- When every peer has said its hash for a tick and they are not all the same, the session stops. Its tick fails with `Lockstep.Drifted`, and so does every tick after it; `session.drifted` is the same value, for a UI to show. `session.tick()` throws it, which stops a driver.
- The report says the tick, the hash every peer had at it, by name, so that with three or more the one that is not as the others stands out, and `agreedAt`, the last tick at which they were all the same. With a checkpoint every tick that is the tick before they came apart.
- It is found within a known number of ticks. A checkpoint travels with the peer's message for the tick `delay` ahead, which no peer runs without. So no peer runs more than `checkpointEvery - 1 + delay` ticks past the first whose world differed, however slow the network, `delay` being the largest any peer has: with a checkpoint every tick and a delay of 2, two ticks.
- The state the peers start from is compared before anyone's first tick, whatever `checkpointEvery` is: a session records a checkpoint when it begins. Peers made with another seed, or with something else spawned at the start, never run a tick, and the report says they did not start from the same state.
- After that the peers compare what their logs record, every 60 ticks unless the app was told otherwise, and with `checkpointEvery: 0` nothing more. Peers with different schedules compare the ticks both record, and a checkpoint one peer takes by hand, `app.checkpoint()`, is not held against the others.
- A peer that stops says its hash first, so the others stop with the same report in place of waiting for it.
- It costs a message 30 bytes or so per checkpoint and the session a comparison: the hash is the one the app takes for its log anyway.
- What is compared is the world's hash, so what the [hash](#the-worlds-hash) does not cover is found only when it shows in the world: an event that one peer alone has waiting, or a system's own variables.

## Files

| File | What it is |
| --- | --- |
| `src/ecs/component.ts` | Fields, components, relations, singletons, entity ids, and the accessors `each` hands out |
| `src/ecs/world.ts` | Tables, sparse sets, queries, change logs, relations, world, transactions, command buffer |
| `src/ecs/random.ts` | The seeded random number generator a world owns |
| `src/ecs/hash.ts` | The arithmetic of the world's hash |
| `src/ecs/snapshot.ts` | The bytes of a world's snapshot, and `SnapshotError` |
| `src/TickScheduler.ts` | The Effect scheduler owned by the game loop |
| `src/App.ts` | Builds the context, orders systems, runs a tick, applies actions; and `App.run`, the entry point |
| `src/Event.ts`, `src/Action.ts` | Events and the rules layer |
| `src/Plugin.ts` | Plugins and their dependency order |
| `src/Save.ts` | A saved game, as a value and as bytes, and its migrations |
| `src/Migrate.ts` | The usual changes a migration makes to an old save's world |
| `src/Field.ts` | The fields of a component, with `Field.schema` |
| `src/Singleton.ts` | One instance of some data per world |
| `src/Transform3d.ts`, `src/Transform2d.ts` | Where a thing is: the position, rotation and scale that the rules write and a renderer reads, in three dimensions and in two |
| `src/State.ts` | States, their hooks, and the condition that a game is in one |
| `src/Input.ts` | The devices and where they come from, the picture of them in the world, and bindings to actions |
| `src/Assets.ts` | Assets and bundles of them, loading as a scoped resource, and the store that keeps a level's while the level lasts |
| `src/Sound.ts` | Cues played from the game's events and music kept to what the game is, both in the frame stage, clips, the player, and where sound goes |
| `src/View.ts` | The view bridge: the values a UI may see, published once per frame when they changed, and the actions it sends |
| `src/Lockstep.ts` | A session of several peers: the messages they exchange, the tick that waits for every peer's, and the hashes they compare |
| `src/Rollback.ts` | The session that does not wait: it runs ahead of the network and goes back when it was wrong |
| `src/Transport.ts` | What carries a session's messages: the service, what joins a session to it, the transport between machines, the one between tabs, one over any text, and a network in memory for tests |
| `src/Relay.ts` | The relay between machines, as a handler: who may come into a room, and what to pass on of what a member sent |
| `src/Schemas.ts` | Schemas for framework types, such as `EntityId` |
| `src/System.ts`, `src/Query.ts`, `src/Resource.ts`, `src/Services.ts` | The rest of the user-facing API |
| `src/Driver.ts` | The fixed step, the frame loop that follows the display, and a timer: each runs the ticks that are due and then the frame stage |
| `src/index.ts` | The `arcadekit` entry: `import { App, System } from "arcadekit"`. Every other module here is an entry too, `arcadekit/App` and so on |
| `src/Browser.ts` | The `arcadekit/Browser` entry: a page's display, devices, pictures and sound, and `Browser.runMain` |
| `src/ecs/index.ts` | The `arcadekit/ecs` entry: the storage core alone |
| `test/` | Storage, runtime, rules, plugin, schema, random, hash, replay, transaction, snapshot, field, save, migration, change, singleton, relation, state, frame, read-only query, driver, input, asset, entry point, browser, view, sound, music, transform, page, lockstep, rollback, rewind, restore, transport, relay, origin, policy, benchmark verdict, access, id and entries tests, the two transforms among them, including randomized comparisons of the storage, of change queries and of relations against simple models, the generator checked against its published algorithm, and replays of a faulty build of a game, a game played from a keyboard and replayed with none, peers of one game joined by a network that delays and reorders, peers with a system that is not deterministic, a world that is restored compared with a new one that loaded the same snapshot, and a game played in a process that may not make code from text. `test/peers.ts` is the game and the network those of several peers share, and `test/policy-game.ts` the game of the last |
| `bench/accessors.ts` | The benchmark: every line of the tables below, each variant in a process of its own |
| `bench/core.ts` | The storage core's variants of it, which import `arcadekit/ecs` and nothing else |
| `bench/compare.ts`, `bench/verdict.ts` | The check of a pull request: those variants for two checkouts, turn and turn about, and the rule that says whether one is slower |
| `bench/ci-workflow.yml` | The workflow that runs that check on a pull request, to be moved to `.github/workflows/bench.yml` |
| `bench/parallel/` | A measurement, and no part of the package: a loop's rows shared between workers and the main thread over shared memory, `pnpm --filter arcadekit bench:parallel` |
| `examples/demo.ts` | A real-time simulation, started with `NodeRuntime.runMain` around `App.run` |
| `examples/relay.ts` | A relay under Node: `Relay.make()` behind a WebSocket server (`ws`, a dev dependency for this and for the relay's tests) |
| `examples/relay-cloudflare/` | The relay on Cloudflare, declared with Alchemy: a Worker, and a Durable Object per room that reads who is connected back from its sockets |
| `examples/relay-check.ts` | Checks a relay at an address: two peers play through it, and a taken name and a message in another's name have to be refused |
| `examples/duel.ts` | A turn-based game built from two plugins, which makes its app and steps it one move at a time |
| `examples/page/` | A game in a page: played with the keyboard and the pointer, drawn on a canvas, heard through a cue of the page's, one of the level's and music that follows the game, with a level whose assets come and go, started with `Browser.runMain` around `App.run`. Its menu and heads-up display are built twice on the view bridge: `ui-dom.ts` with the DOM and `ui-react.ts` with React, both from `protocol.ts`, the views and actions they share with `game.ts` |

## Two ways to loop

```ts
// each: one callback per entity, through reusable accessors. The default.
moving.each((pos, vel, entity) => {
  pos.x += vel.x * delta;
});

// eachChunk: raw columns and a range of rows. For hot systems.
moving.eachChunk((start, end, pos, vel) => {
  for (let i = start; i < end; i++) pos.x[i] += vel.x[i] * delta;
});
```

(In this repository the raw loop needs an assertion on each read; see [Raw columns and strict indexing](#raw-columns-and-strict-indexing).)

Both work with every query, including ones that require, exclude or read sparse components, and both visit entities in the same order: tables in creation order, rows ascending. With sparse conditions, `eachChunk` splits each table into runs of consecutive matching rows.

### Under a Content Security Policy

Nothing in the package makes code from text: no `eval` and no `new Function`. A page whose policy has no `'unsafe-eval'`, `script-src 'self'` say, runs a game as it is, with nothing to switch on and nothing that goes slower there.

- What `each` hands its callback is an object with a getter and a setter per field, each a closure over the field's column and the row the loop is at. They were classes generated with `new Function`, which such a policy refuses: a game stopped at its first `Component.define`.
- It costs a little more than the generated classes did where a program has one or two components, 1 ns an entity, and much less in a real game, 10 ns against 18 in a program of ten: see the [benchmark](#benchmark-100000-entities-pos--vel--dt). `eachChunk` never went through accessors, and a view that is only ever given to `eachChunk` makes none.
- A test plays a game in a process that forbids making code from text, which is what such a page is to the engine, and holds it to the same world as one played without. The same game was run by hand in a page served with `Content-Security-Policy: default-src 'self'; script-src 'self'`, in headless Chromium, and ended on the same hash. Other browsers were not tried.

### Saying what a query only reads

```ts
const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));
const Drawn = Query.all(Position, Sprite).pipe(Query.reads()); // all of them

moving.eachChunk((start, end, pos, vel) => {
  for (let i = start; i < end; i++) pos.x[i] += vel.x[i] * delta;
  // vel.x[i] = 0 does not compile
});
```

A query can say which of its terms its loops only read, or, given none, that they only read any of them.

- `each` hands out an accessor for such a term whose fields cannot be assigned to: the compiler refuses it, and at run time it throws and names the field.
- `eachChunk` hands out its columns typed as read-only, and does not count their rows as written. A system that reads a [watched](#change-queries) component in a raw loop does not set off the queries that watch it, and a change query may read, raw, what it watches itself.
- In an action's handler, its columns are not copied for a rollback.
- The compiler tells two components with the same fields apart by their names, which are part of their types: in the query above `pos.x` is written and `vel.x` is not, though both are `{ x, y }`.

### Sparse components in a raw loop

A sparse component used as query data is an ordinary accessor in `each`. In `eachChunk` it arrives as `{ columns, indexOf }`, because its rows do not line up with the table's:

```ts
Query.all(Position, Burning); // Burning has storage: "sparse"
view.eachChunk((start, end, pos, burning, entities) => {
  for (let i = start; i < end; i++) {
    burning.columns.seconds[burning.indexOf(entities[i])] -= delta;
  }
});
```

## Benchmark (100,000 entities, `pos += vel * dt`)

Best of three runs per variant on a cloud Linux VM, Node 22. The machine is shared and noisy (a variant can come out twice as slow from one run to the next), so trust the ratios more than the absolute numbers.

| Variant                                                    | ns/entity |
| ---------------------------------------------------------- | --------- |
| `eachChunk`: raw typed-array columns                       | 2.6       |
| `eachChunk`, excluding a sparse tag 1% of entities have    | 4.8       |
| `each`: accessors, only caller in the program              | 8.0       |
| `each`, excluding a sparse tag 1% have                     | 8.8       |
| `each`: accessors, in a program of ten components          | 10.2      |
| `each`: accessors, after 6 other systems used `each`       | 10.7      |
| `eachChunk`, excluding a sparse tag half the entities have | 11.4      |
| Array of plain objects (no ECS)                            | 16.0      |
| One Effect per entity                                      | 69.3      |

Hashing the same 100,000 entities, in the same units:

| Variant                                                       | ns/entity |
| ------------------------------------------------------------- | --------- |
| `world.hash()`, one table                                     | 8.3       |
| `world.hash()`, the same entities spread over 32 tables       | 8.7       |
| `world.hash()`, with a sparse one-field component on each     | 15.0      |
| `world.snapshot()`, one table (2.8 MB)                        | 6.7       |
| `world.load()` of that snapshot, into a new world             | 21.0      |
| `world.restore()` of it, into the world it came from          | 16.0      |
| `app.capture()`: a game of those entities, kept to go back to | 6.9       |
| `app.rewind()`: the game put back to that moment              | 16.2      |

Change detection in the same world, with a query that watches `Position`:

| Variant | Cost |
| --- | --- |
| A change query's visit when nothing changed | 62 ns |
| One `world.set` among 100,000 entities, and the visit after it | 200 ns |
| Visiting the 1,000 entities that were written, of 100,000 | 42 µs |
| Visiting all 100,000, every one written | 22.4 ns/entity |
| `each` writing the watched component: every row noted | 17.2 ns/entity |
| The same, when every row is noted already | 13.8 ns/entity |
| `eachChunk` handed the watched component: every row noted | 6.3 ns/entity |
| The same through a query that only reads it (`Query.reads`) | 2.6 ns/entity |

A game that ticks when it is needed, at rest, with the picture of the devices, a state and a view:

| Variant                                                    | Cost   |
| ---------------------------------------------------------- | ------ |
| One frame: the devices read, the app asked, drawn, no tick | 5.3 µs |

The input stage, with `Input.plugin`, three buttons held and the pointer somewhere:

| Variant                                                 | Cost    |
| ------------------------------------------------------- | ------- |
| `app.input()`: the devices read, nothing changed        | 1.39 µs |
| `app.input()` and `app.tick()`: one key went down or up | 5.22 µs |

The view bridge, with one view of four fields read from a singleton:

| Variant                                                   | Cost    |
| --------------------------------------------------------- | ------- |
| `app.frame()`: no UI is there, the view is not worked out | 0.58 µs |
| `app.frame()`: a UI is there, the value is what it has    | 2.90 µs |
| `app.frame()`: the value is new, and one listener told    | 2.57 µs |

Sound, with one system that plays cues for two kinds of event, or one that keeps a channel's music, to an output that does nothing:

| Variant                                                   | Cost    |
| --------------------------------------------------------- | ------- |
| `app.frame()`: cues, nothing happened                     | 1.43 µs |
| `app.frame()`: cues, one event, and its cue is played     | 1.63 µs |
| `app.frame()`: music that goes on as it was, nothing told | 1.24 µs |

Entities coming and going in the same world:

| Variant                                                    | Cost   |
| ---------------------------------------------------------- | ------ |
| Spawn 1,000 entities with two components and despawn them  | 561 µs |
| The same, each also pointing at one entity with a relation | 693 µs |
| Despawn 100 parents, each taking its 10 children with it   | 143 µs |

One action in that world of 100,000 entities, before and after handlers ran in a transaction:

| Variant                                              | Before  | After   |
| ---------------------------------------------------- | ------- | ------- |
| Handler reads and sets one entity, accepted          | 1.07 µs | 1.31 µs |
| The same, refused after its write                    | 10.3 µs | 10.5 µs |
| Handler loops over all 100,000 with `each`, accepted | 0.70 ms | 0.81 ms |
| The same, refused after its loop                     | 0.73 ms | 0.94 ms |

- Writes are noticed per row. A component that no query watches costs what it did: the lines of the first table were measured before and after and did not move. A watched one costs about 3 ns more for an assignment in `each` to a row that is noted already, about 5 ns for the first assignment to a row since the last visit, and 2.8 ns per row that `eachChunk` hands out. Noticing per table or per column would cost nothing to write, but one `world.set` would then send every watching query through the whole table: 0.25 ms to 0.64 ms for 100,000 rows, where it now takes 0.2 µs.
- What `each` hands out is made of closures, where it was classes generated with `new Function`, which a page's [Content Security Policy](#under-a-content-security-policy) may refuse. Measured one against the other, turn and turn about: 8.0 ns an entity against 6.7 where one callback is all the program has, 10.7 against 9.6 after six other systems, and 10.2 against 17.7 in a program of ten components with fields of six kinds, which is the one that is like a game. A generated class kept the row it was at in a field of its own, and the loop that moved it on had by then met too many classes to know where that field was; a loop now has one row, whatever it hands out. The getters are written out once per kind of column: one getter for every kind measured 112 ns in a program with seven kinds of field. Pointing the accessors at a table costs about 75 ns a term, and a loop that visits the table it visited the last time is not pointed at it again, so that is paid by a query of several tables, once for each, and a world of very many very small tables pays for it: 100,000 entities in 8,192 tables measured 19.8 ns an entity against 15.3.
- About one run in six of any of these is half as fast again as the rest, whichever build it is of: the machine, or where the arrays happened to land. The lines here are the best of three.
- An [entity's id](#an-entitys-id) is eight bytes where it was four, and its generation four where it was two. For 100,000 entities with four float fields, measured one against the other: a snapshot is 2.8 MB against 2.2 and takes 6.7 ns an entity against 5.3; a load 20 ns against 14, since every id is checked for being one; a restore 16 against 13.6; the hash 8.4 against 7.0, one word more in six. A raw loop that is handed a watched component reads each row's id to note it, 6.3 ns against 5.9, and a despawn that takes others with it 162 µs against 154 for a hundred parents. No other line moved by more than the noise: the loops, the filters, the change queries, a thousand spawns and despawns.
- A change query is for what changes now and then. Visiting everything because everything was written costs three and a half plain passes, since each entity is looked up from the log: a system that wants every entity every tick asks for them with an ordinary query.
- The input stage runs before every tick, so its cost when nothing happens is the one that counts: one sample of the devices, compared with what the world holds, 1.4 µs for a keyboard, a pointer and a few buttons held. An app with no system in that stage reads nothing and pays nothing.
- A view costs the game its body and one comparison a frame, 2.3 µs for four fields, and the UI nothing at all until a field differs. A value that is new is found to be at the first field that differs, which is why it costs less than one that is not. Where no UI is there the system asks whether one is and stops.
- Sound costs a frame two reads of events that are not there, 0.7 µs over a frame that does nothing, and 0.2 µs more for a cue that is played. Where sound goes nowhere the system asks whether it does and stops.
- A frame of ten systems that do nothing costs 5.8 µs, about what a tick of ten does: freezing the world is setting a flag. Checking a frame with `verifyFrames` costs a hash of the world before the stage and one after each of its systems, 1.7 ms more for one system over 100,000 entities.
- A relation costs its component and a few assignments to link and unlink: 0.13 µs more per entity that is spawned and despawned with one. A despawn that takes others with it costs what despawning each of them does, 130 ns apiece here. A world with no relation does one comparison more per despawn than before: the first line was 587 µs before relations and 561 µs after, which is the machine's noise.
- A query that requires a sparse tag 1 in 100 entities have takes about 38 µs per pass to visit its 1,000 matches.
- A tick with ten systems that do nothing costs about 5 µs, and going through `app.tick` adds nothing measurable to a 100,000-entity loop. Run conditions did not change that: 4.99 to 5.47 µs before them and 5.00 to 5.81 µs after, over four runs each. With a condition on each of the ten that holds, the tick costs 8.5 µs; with one that does not, 3.5 µs.
- A sparse tag that many entities have, mixed in with ones that do not, breaks tables into short runs and `eachChunk` loses its edge. A component like that is better off with table storage.
- A handler that loops pays one copy of the columns it visits, 0.11 ms for four float columns of 100,000 rows, and as much again to copy them back if it is refused. It pays for none it only reads: a handler that looks at all 100,000 entities takes 0.78 ms through a plain query and 0.67 ms through one made with `Query.reads()`. The copies are kept and written over by the next action; allocating them afresh each time cost 0.35 ms. A refusal itself costs about 9 µs, which is Effect building the failure.
- A checkpoint is one hash of the world every `checkpointEvery` ticks, 60 by default: 14 µs a tick on average for 100,000 entities. The per-tick lines above are medians, so they do not show it.
- Predicting a tick costs a capture, 0.69 ms for 100,000 entities and 7 µs for a thousand, and only for a tick the session is not sure of. Being wrong costs a rewind, 1.6 ms for 100,000, and the ticks since, run again. `world.restore` did not change what the lines above cost: `eachChunk` 2.65 ns before and 2.70 after, `each` 6.61 and 6.80, a snapshot 5.26 and 5.57, a load 15.37 and 15.08, a tick of ten idle systems 5.49 µs and 5.48, which is the machine's noise.
- Hashing a world costs about three raw passes over it: 1.4 ns per 32-bit field per entity, an entity's id being two of them, and about four times that for a field of a sparse component, whose members are hashed one by one so that their order does not matter.

### Benchmarks in CI

```sh
git worktree add ../base origin/next
(cd ../base && pnpm install --frozen-lockfile)
pnpm --filter arcadekit bench:compare "$PWD/../base"
```

`bench:compare` says whether this checkout's storage core is slower than another's by more than the noise, and fails if it is. The `Benchmarks` workflow runs it on a pull request that touches the storage core, against what the pull request would be merged into.

**The workflow is written and not in place.** It is `bench/ci-workflow.yml`, and runs once it is moved to `.github/workflows/bench.yml`, which takes credentials that may change workflows; the session that wrote it had none. Until then the check is run by hand, as above.

- It runs the variants of `bench/core.ts`, which are the lines above that go through `arcadekit/ecs` alone: the loops, the filters, the hash, a snapshot and a load, change queries, and entities coming and going. Both builds run this checkout's copy of that file, so the two are asked the same thing; a variant the base cannot run is new. The copy is in the base for as long as the comparison lasts and no longer.
- Each variant is run up to fifteen times by each build, turn and turn about, each run a process of its own. A run is now and then half as slow again as the rest, one in six on the machine this was written on, and never much faster, so a build is known by its fastest run.
- A variant is slower when two things hold. Its fastest run is more than 5% slower than the base's: less than that is what moving code about does to a loop that was not touched. And so many of the base's runs were faster than every run of its own that two builds alike would look so less than once in a thousand comparisons, which with fifteen runs each is nine of the fifteen. The second is the noise, counted as the check goes and with nothing assumed about its shape: where runs are far apart, a difference has to be plainer to count.
- A variant whose two builds are within 2.5% of each other after six runs each is not run again, which is most variants of most changes: the whole check took five minutes for two builds that were the same, and eight for two of which eight variants differed.
- A change that slows a variant on purpose says so, in the message of one of its commits, and the check then reports the variant and does not fail on it:

  ```
  Bench-slower: each, eachMany
  ```

  It travels with the commit, so nothing is left to take out afterwards. The list may go on over the lines that follow, indented.

- What it finds: on a machine as noisy as that one, a slowdown of 15% nine times in ten. The first time it was run it found one that the full benchmark had shown and that had been put down to the machine: a change query's visit of one entity, a fifth slower. What it does not: one of less than 5%, or several such one after the other; and anything outside the storage core, a tick or an action's dispatch, which `pnpm --filter arcadekit bench` reports and nothing compares.

## Raw columns and strict indexing

This repository compiles with `noUncheckedIndexedAccess`, under which reading `pos.x[i]` gives `number | undefined`. A raw-column loop therefore needs an assertion on each read:

```ts
moving.eachChunk((start, end, pos, vel) => {
  for (let i = start; i < end; i++) {
    pos.x[i] = pos.x[i]! + vel.x[i]! * delta;
  }
});
```

`each` does not have this problem, because its accessors return `number`. A project without that compiler option can write `pos.x[i] += vel.x[i] * delta`.

## Not done yet

The [roadmap](../../docs/roadmap.md) puts these in order.

- [`@arcadekit/three`](../three/README.md) draws a game with Three.js, and says what it does not do yet; the example page of this package draws on a canvas by hand.
- A game picks one of the two transforms for a thing, and a plugin written for one does not read the other: code that should work in both asks for both. A `Transform2d` has no depth: what is in front of what in a flat game is for what draws it to say.
- A cue is played once and left to end: it cannot be stopped, and nothing is heard from where it is. A track that plays once says nothing when it has ended: the body that asked for it cannot tell, and what follows it is for the game to say.
- A streamed track that goes round may be heard to join where it does: the page's own player is not exact about it. A short piece that has to go round without a seam is given by its URL and decoded. A stream is fetched by the page and not through `Assets.Loader`, so a test plays `Sound.clip(name)` in its place.
- A channel fades in a straight line, from one track to the next in the same time. Two tracks are not kept in step, a track does not start where the last one was, and nothing is timed to a beat.
- A cue is one sound a frame, whatever speed each asked for it at: the loudest's. Two sounds of one file at once, a chord, are two names for it.
- A page's audio sleeps while the page is hidden, always, as its frame loop does. A game that is to be heard in the background cannot say so.
- The first sound a page can make is the one its user's first key or press sets off. Nothing is heard before that.
- A view is worked out and compared whole, every frame a UI is there. A game with a view that is costly to work out says when it is worth it with `System.runIf`.
- The UI is not told what became of an action it sent. A refusal is an `Action.Rejected` event, which a frame system can read and the game can publish as a view.
- What the UI sends is applied by the next tick, which under a driver is the frame it was sent in or the one after. A game that steps its app by hand runs a tick itself when its UI has sent something.
- A view's value is an object of this program, with no schema: a UI in another thread or on another machine is not served.
- `ui.send` takes any action as far as the compiler knows. That the game has a handler for it is checked when it is sent, and a bridge is not typed by the game it will be given to.
- An asset is a picture, text, JSON or bytes. A font is for whoever draws with it to decode, with `Assets.make`.
- A bundle is loaded or it is not: it does not say how far along it is, and a file that two bundles name is fetched for each.
- A bundle that failed stays failed until its level is entered again. Nothing tries again by itself.
- `Assets.load` waits in real time. In a script it would resume in whatever tick the file happened to arrive in, and a replay of that script would fetch the file again: a script does not load.
- The picture of the devices is one player's. Several players on one machine, or on several, bind their devices to actions that say whose they are.
- A gamepad's button is down or it is not: how far a trigger is pressed is not read. Nor are the wheel, text as it is typed, more than one finger at a time, or a pointer that is locked to the page.
- A button that is pressed twice between two readings of the devices was pressed once.
- The pointer's place is in CSS pixels of its target. A canvas that is drawn larger or smaller than its own size has to convert.
- Bindings are fixed when the system is made. A game that lets its player choose the keys writes a system of the input stage that looks them up.
- A tick reads the devices unless it is told not to. What runs a game again from its log by hand, with `dispatchByName` and `tick`, says `{ input: false }` as `App.replay` does, or the machine's own keys join in.
- A game that ticks when it is needed rests when nothing is waiting, and what is waiting is what the app can see, actions, states, scripts and events, and what a system said with `Ticks.more`. A system that has work every tick and does not say so stops with the game. A system that reacts to a change through a change query, listed before the system that makes the change, reacts a tick late, and the one tick that follows the last is all it is given; two such systems in a row are a tick short. Order them with `System.after`, or have the one that changed something ask for a tick.
- The frame loop always pauses while the tab is hidden. A game that has to go on in the background, such as one peer of several, cannot say so.
- The example page is opened in a browser by hand. No test in CI runs a page: the frame loop is tested against a display turned by hand, and `arcadekit/Browser` against stand-ins for `requestAnimationFrame`, the document and the window.
- Neither the frame stage nor the input stage can stop a write through the raw columns of `eachChunk`. `verifyFrames` finds one afterwards, at the cost of a hash of the world per system of those stages. A draw from `world.random` there is found when the stage ends, not where it is made.
- A frame system of the game's own that draws between two ticks works the place out itself, from a velocity or a previous position the simulation keeps: there is no helper for it in this package. [`@arcadekit/three`](../three/README.md#between-two-ticks) does it for what it draws, with `smooth: true`, and keeps the place before to itself.
- `arcadekit/ecs` has no helper for writing a query: `world.view` is given a description written out as an object, `{ terms, withDefs, withoutDefs }`. `Query.all` and its kind are Effect's side of it, in `arcadekit`.
- `arcadekit/Browser` is one entry for everything a page has.
- The relay is a handler, and hosting it is the game's. The examples have a WebSocket server under Node and a Durable Object on Cloudflare, declared with Alchemy, and neither is a package to install: a game copies the one it needs. The Cloudflare one was run under `alchemy dev` and never deployed from here, and there is none for AWS. A relay does not say who has come and gone, does not slow a peer that sends too much, and does not ask who a peer is: letting a peer in under a name is the host's to settle before `Relay.join`.
- A rollback session keeps a snapshot of the whole world for each tick it is not sure of, and loads one to go back. For a very large world that is the cost of every such tick: nothing keeps only what changed.
- A game played with rollback is drawn and heard as it is predicted. A sound for something that is then taken back was played, an event of a tick that is run again is heard again by the frame stage, and its change queries visit everything after each rewind. Nothing tells what draws which ticks are final but `session.confirmed`.
- A script is started again by every rewind, and what a service of the game's own holds is not put back. With rollback, what the simulation reads is in the world.
- Peers that have come apart stop. Nothing brings them back together: a game that wants to go on has every peer load one peer's save and makes its sessions again.
- A session's peers are fixed when it is made. Nobody joins a game in progress or leaves one, and a peer that stops is waited for.
- Every message has to arrive. One that is lost stops the game for everyone: nothing asks for it again, and a transport whose socket has closed does not connect again. Nothing says that a peer has gone quiet but `session.waitingFor`.
- Who issued an action is who its message says it is from, and only a relay vouches for that. Through `Transport.layerBroadcastChannel`, or a transport of the game's own that does not, a peer can send a message in another's name. The peers that took it and the one whose name it was then hold different games, and stop with `Lockstep.Drifted`: it is found, not prevented.
- A game in a session ticks all the time. One that ticks when it is needed, `ticks: "whenNeeded"`, is not for several peers yet: a session does not say when it is settled.

- What a system says it reads and writes is held as it runs, not proved when the app is made: a system that reaches for something it left out only in some ticks is refused in the first of them. Scripts and handlers say nothing and are in no check, and neither are the systems of the package's own plugins that run between ticks.
- A despawn is said by one component the entity has, and takes the rest with it, and whatever a relation hangs from it: a system that visits those entities by other components is not found to be in conflict with the one that despawned them.
- A conflict in the order of systems is settled by saying an order. Two systems that conflict and whose order does not matter cannot say so.
- Plugins cannot be added or removed while the app runs, and one plugin cannot replace or disable another's systems.
- A save does not hold scripts, so a script that keeps its progress in its own variables starts over when a game is loaded. Nor does it hold what a game's own services hold.
- A save is refused while an action or an event with no schema is waiting, which for a game that emits such an event every tick is always.
- An action enqueued with a payload its schema rejects is refused when its turn comes, as an event, and is not in the log, since it has no JSON form. A replay therefore does not repeat that one refusal, and in a session the other peers never hear of it.
- The log does not say when a script was started by hand with `app.spawnScript`, nor the delta and the number of ticks of the game it records. A replay is told those by its caller.
- The hash covers the world and nothing else: not the events waiting to be read, what change queries have yet to visit, the actions queued for the next tick, or how far each script has got.
- What a query only reads is the query's word. A raw column is a typed array all the same: a loop that writes one past the compiler has written it, and no change query hears of it and no refusal takes it back.
- `Query.removed` gives the ids of the entities that lost a component, not the values it held.
- A singleton cannot be watched for changes: a change query is of entities.
- An entity points at one target per relation, and a query cannot ask for what points at a given entity: `world.sources` gives those as a list.
- A run condition is given to one system at a time: a plugin cannot be given one for all its systems. A script is not stopped by a state; it asks.
- A schema checks a payload's shape. Whether an entity id in it is still alive, or belongs to the player who sent it, is for the handler to check, which is told who that is.
- A refused action does not undo what is outside the world: an object held in a field that the handler changed in place, a call to a service of the game's own, a script it started.
- `Effect.sleep`, promises and other real-time waits resume outside the tick. Scripts should wait with `Script.nextTick`, `Script.sleep` (game time) or an event's `wait`.
- Only scripts started with `app.spawnScript` or `Script.spawn` are watched. Effect has no hook that would let the app see a fiber started with `Effect.forkDetach`.
- The workflow that compares benchmarks on a pull request is not in `.github/workflows/` yet: see [Benchmarks in CI](#benchmarks-in-ci). The check is of the storage core alone, and lets through a slowdown of less than a twentieth.
- A world holds at most 4,194,304 entities at once, and an id takes eight bytes wherever it is kept.
- Systems run in sequence on one thread. Running them side by side on workers was measured and not built: `pnpm --filter arcadekit bench:parallel` shares a loop's rows between four threads over shared memory, and a flock of 100,000 goes from 3.7 ms to 1.3 ms, where the 100,000 entities of the benchmark above move in a quarter of a millisecond on one. The [roadmap](../../docs/roadmap.md#7-speed-and-scale) has the numbers and what it waits on.
