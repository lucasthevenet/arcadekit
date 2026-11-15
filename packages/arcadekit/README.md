# arcadekit

A framework for building games of any genre on [Effect](https://effect.website) 4, built around an entity component system (ECS).

This is the first cut of the revamped design. It is a working prototype, not a finished kit: see [Not done yet](#not-done-yet).

1. **Storage core** (`src/ecs/`): archetype tables with typed-array columns, opt-in sparse storage, cached queries, a command buffer. No Effect.
2. **Tick scheduler**: Effect around the core. One fiber per tick, systems as generators, yieldable queries and resources, coroutine scripts, and a custom Effect `Scheduler` that only runs fibers when the tick says so.
3. **Events and rules**: typed events every system sees exactly once, and actions with handlers that validate a move and refuse it with a typed error. Payloads are checked against a schema, applied actions are logged as JSON-safe data, and the log replays the game and checks the replay against the world's hash.
4. **Plugins**: one value that bundles a feature's systems, handlers, services and setup, and names the plugins it depends on.

From the repository root:

```sh
pnpm install
pnpm test                          # 139 tests
pnpm typecheck
pnpm --filter arcadekit demo       # real-time simulation
pnpm --filter arcadekit duel       # turn-based game
pnpm --filter arcadekit bench
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

const program = Effect.gen(function* () {
  const app = yield* App.make({ systems: [Movement] });
  app.world.spawn(Position.of({ x: 0, y: 0 }), Velocity.of({ x: 1, y: 0 }));
  app.tick(1 / 60); // turn-based or tests
  yield* Driver.interval(app, { hz: 60 }); // real time
});
```

Systems run in the order they are registered unless told otherwise: `System.after(Other)` and `System.before(Other)` pull whatever has to run first forward to just before the system that needs it.

## Plugins

```ts
const Physics = Plugin.make("Physics", {
  systems: [Movement, Walls],
  layer: Layer.succeed(Bounds, { width: 10 }), // services for the whole app
  setup: spawnTheBall, // runs once at start
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
- Components, events and actions are plain values, so a plugin does not list them. It exports them from its module.

## Names

A string that identifies something at run time carries the name of the feature it belongs to.

- The built-in services are keyed `"arcadekit/World"`, `"arcadekit/Time"`, `"arcadekit/Commands"`, `"arcadekit/Script"`, `"arcadekit/Events"`, `"arcadekit/Random"` and `"arcadekit/Actions"`, so a game is free to key a service of its own `"World"`.
- A component's name is its identity in a world: `Component.define("physics/Position", ...)`. Nothing is shared between worlds, so two apps in one process, or a module evaluated twice, can each define a component with the same name. A world that meets two different components with one name refuses the second, where it is spawned, added, queued or queried.
- `world.component(name)` gives the component a world holds under a name. A world learns a component the first time it stores or queries it; `world.register(component)` tells it sooner.

## Events

```ts
const Collided = Event.define<{ a: Entity; b: Entity }>("Collided");

// in a system
const collided = yield * Collided;
collided.emit({ a, b }); // a plain call, fine inside loops
for (const hit of collided.read()) {
} // everything this system has not seen

// in a script
const hits = yield * collided.wait; // suspend until some arrive
```

Every system sees every event exactly once, whatever order the systems run in: a system that runs before the emitter sees the event on the next tick. Events are dropped once every system has had that chance.

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
- the state of the random number generator.

So two worlds built by the same operations in the same order hash equal, and changing one field of one entity always changes the hash: a single change cannot cancel out. Two different worlds hash equal by chance about once in four billion.

It does not depend on what cannot be told apart: how much room a table has, what is left in a column past its last row, which queries have been made, the order a sparse component's members joined in, or the order the program defined its components in. Every NaN counts as the same NaN, because its bits are the one thing engines do not agree on; 0 and -0 are different.

- A `ref` field counts by value when it holds a string, a number, a boolean, a bigint, null or undefined. An object or a function only counts as being there, so two different objects hash alike.
- It is 32-bit integer arithmetic on the bits of each field, so it is the same on every machine and in every JavaScript engine.
- It reads and changes nothing, so it can be called at any time. It costs about 7 ns per entity for four float fields, 0.7 ms for 100,000 entities; see the [benchmark](#benchmark-100000-entities-pos--vel--dt).

## Actions (the rules layer)

```ts
const Strike = Action.define(
  "Strike",
  Schema.Struct({ attacker: EntityId, target: EntityId })
);

const strike = Action.handler(Strike, function* ({ attacker, target }) {
  if ((yield* whoseTurn) !== owner) return yield* new NotYourTurn();
  // ...check the rules first, then change things and emit events
  return hpLeft;
});

const app = yield * App.make({ handlers: [strike] });

app.dispatch(Strike, { attacker, target }); // Exit<number, NotYourTurn | InvalidPayload>, applied now
app.enqueue(Strike, { attacker, target }); // applied at the start of the next tick
```

- A refused action changes nothing: its queued commands and emitted events are discarded. Direct writes to component data are not undone, so handlers should check first and write last.
- `dispatch` is for turn-based input: the caller gets the typed outcome immediately. `enqueue` is for real-time input and for systems (AI issues the same actions as players); a refusal becomes an `Action.Rejected` event.
- Dispatching an action with no handler, or with the wrong payload, does not compile.

### Payloads, saves and the network

- The payload type comes from the schema, and every payload is checked against it before the handler runs, including refinements the compiler cannot see (an amount between 1 and 10, say). A mismatch is an `Action.InvalidPayload` failure.
- Input that arrives as data goes through `app.dispatchByName(name, json)` or `app.enqueueByName(name, json)`. An unknown name or a malformed payload is a failure or a `Rejected` event, never a crash.
- `app.actionLog` holds every applied action with its payload in JSON form (a bigint or a date in the payload is converted for you), and checkpoints of the world's hash among them. `Action.encodeLog` and `Action.decodeLog` turn it into text and back; `Action.isCheckpoint(entry)` tells the two kinds of entry apart.
- `App.replay(freshApp, log, { delta, ticks })` reproduces the game in an app made with the same seed and started from the same state, and checks itself as it goes; see below.
- `Action.define<Payload>()("Name")` still defines an action with no schema. Only the compiler checks it, so keep those for actions that never leave the program.

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
- An entry that is refused still stops the replay, as before, with the refusal as the `reason`. Without checkpoints that was the only check: a replay that had gone wrong ran on until an action happened to be refused, and one whose fault broke no rule ran to its end and gave another game.
- `checkpointEvery` is 60 unless told otherwise. A checkpoint costs one hash of the world, 0.7 ms for 100,000 entities, so a smaller number finds a divergence closer to where it happened at that price per checkpoint, and adds an entry to the log each time. A turn-based game ticks once a move and wants 1. With 0 the app records none.
- Once a game has started, what changes its world has to be in the log or come from the simulation: an action, a system, a script. A coin spawned straight into `app.world` between two ticks is in neither, so a replay cannot know of it, and stops at the next checkpoint.

## Files

| File | What it is |
| --- | --- |
| `src/ecs/component.ts` | Fields, components, entity ids, generated accessors |
| `src/ecs/world.ts` | Tables, sparse sets, queries, world, command buffer |
| `src/ecs/random.ts` | The seeded random number generator a world owns |
| `src/ecs/hash.ts` | The arithmetic of the world's hash |
| `src/TickScheduler.ts` | The Effect scheduler owned by the game loop |
| `src/App.ts` | Builds the context, orders systems, runs a tick, applies actions |
| `src/Event.ts`, `src/Action.ts` | Events and the rules layer |
| `src/Plugin.ts` | Plugins and their dependency order |
| `src/Schemas.ts` | Schemas for framework types, such as `EntityId` |
| `src/System.ts`, `src/Query.ts`, `src/Resource.ts`, `src/Services.ts` | The rest of the user-facing API |
| `src/Driver.ts` | Fixed-step and timer drivers |
| `src/index.ts` | The package's one entry: `import { App, System } from "arcadekit"` |
| `test/` | Storage, runtime, rules, plugin, schema, random, hash and replay tests, including a randomized comparison against a simple model, the generator checked against its published algorithm, and replays of a faulty build of a game |
| `bench/accessors.ts` | Accessor objects vs raw columns vs alternatives |
| `examples/demo.ts`, `examples/duel.ts` | A real-time simulation, and a turn-based game built from two plugins, each started with `NodeRuntime.runMain` |

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
| `each`: accessors, only caller in the program              | 6.6       |
| `each`, excluding a sparse tag 1% have                     | 7.4       |
| `each`: accessors, after 6 other systems used `each`       | 9.6       |
| `eachChunk`, excluding a sparse tag half the entities have | 11.4      |
| Array of plain objects (no ECS)                            | 16.0      |
| One Effect per entity                                      | 69.3      |
| Accessors without code generation                          | 102.8     |

Hashing the same 100,000 entities, in the same units:

| Variant                                                   | ns/entity |
| --------------------------------------------------------- | --------- |
| `world.hash()`, one table                                 | 7.0       |
| `world.hash()`, the same entities spread over 32 tables   | 7.4       |
| `world.hash()`, with a sparse one-field component on each | 13.6      |

- A query that requires a sparse tag 1 in 100 entities have takes about 38 µs per pass to visit its 1,000 matches.
- A tick with ten systems that do nothing costs about 4.6 µs, and going through `app.tick` adds nothing measurable to a 100,000-entity loop.
- A sparse tag that many entities have, mixed in with ones that do not, breaks tables into short runs and `eachChunk` loses its edge. A component like that is better off with table storage.
- A checkpoint is one hash of the world every `checkpointEvery` ticks, 60 by default: 12 µs a tick on average for 100,000 entities. The per-tick lines above are medians, so they do not show it.
- Hashing a world costs about two and a half raw passes over it: 1.4 ns per 32-bit field per entity, and about four times that for a field of a sparse component, whose members are hashed one by one so that their order does not matter.

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

- Nothing here draws, plays sound or reads input. It is the simulation side only, with no Foldkit or Three.js integration.
- One package entry. The storage core has no Effect dependency and could be its own entry (`arcadekit/ecs`).

- Plugins cannot be added or removed while the app runs, and one plugin cannot replace or disable another's systems.
- The log replays a game from its start. There is no snapshot of the world itself, so loading a long game means replaying all of it.
- A game whose systems or scripts issue actions through `Actions.enqueue` does not replay. Such an action is in the log, and the replay's own system issues it again, so it is applied twice. The next checkpoint stops the replay; before there were checkpoints it went unnoticed. The log has to tell an action that came from outside from one the simulation issued itself, which is one of the roadmap's open decisions.
- The log does not say when a script was started from outside, nor the delta and the number of ticks of the game it records. A replay is told those by its caller.
- The hash covers the world and nothing else: not the events waiting to be read, the actions queued for the next tick, or how far each script has got.
- An object in a `ref` field is not hashed (see [The world's hash](#the-worlds-hash)), and nothing yet says how such a field would be saved.
- A schema checks a payload's shape. Whether an entity id in it is still alive, or belongs to the player who sent it, is for the handler to check.
- Event payloads are typed but have no schema, so events cannot be sent over a network yet.
- A refused action's direct component writes are not undone (see above).
- Accessors are generated with `new Function`, which a strict Content Security Policy blocks. The obvious fallback is about 40x slower than raw columns.
- `Effect.sleep`, promises and other real-time waits resume outside the tick. Scripts should wait with `Script.nextTick`, `Script.sleep` (game time) or an event's `wait`.
- Only scripts started with `app.spawnScript` or `Script.spawn` are watched. Effect has no hook that would let the app see a fiber started with `Effect.forkDetach`.
- Entity generations are 10 bits: a handle kept across 1,024 reuses of the same slot can alias a newer entity.
- Systems run in sequence on one thread. No parallelism, no change detection.
