# arcadekit

A framework for building games of any genre on [Effect](https://effect.website) 4, built around an entity component system (ECS).

This is the first cut of the revamped design. It is a working prototype, not a finished kit: see [Not done yet](#not-done-yet).

1. **Storage core** (`src/ecs/`): archetype tables with typed-array columns, opt-in sparse storage, cached queries, a command buffer. No Effect.
2. **Tick scheduler**: Effect around the core. One fiber per tick, systems as generators, yieldable queries and resources, coroutine scripts, and a custom Effect `Scheduler` that only runs fibers when the tick says so.
3. **Events and rules**: typed events every system sees exactly once, and actions with handlers that validate a move and refuse it with a typed error. Payloads are checked against a schema, applied actions are logged as JSON-safe data, and the log replays the game.
4. **Plugins**: one value that bundles a feature's systems, handlers, services and setup, and names the plugins it depends on.

From the repository root:

```sh
pnpm install
pnpm test                          # 78 tests
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
- `app.actionLog` holds every applied action with its payload in JSON form (a bigint or a date in the payload is converted for you). `Action.encodeLog` and `Action.decodeLog` turn it into text and back.
- `App.replay(freshApp, log, { delta, ticks })` reproduces the game. If an entry is refused, because the save was edited or the game has changed, the replay stops there with `App.ReplayDiverged` naming the entry.
- `Action.define<Payload>()("Name")` still defines an action with no schema. Only the compiler checks it, so keep those for actions that never leave the program.

## Files

| File | What it is |
| --- | --- |
| `src/ecs/component.ts` | Fields, components, entity ids, generated accessors |
| `src/ecs/world.ts` | Tables, sparse sets, queries, world, command buffer |
| `src/tick-scheduler.ts` | The Effect scheduler owned by the game loop |
| `src/app.ts` | Builds the context, orders systems, runs a tick, applies actions |
| `src/event.ts`, `src/action.ts` | Events and the rules layer |
| `src/plugin.ts` | Plugins and their dependency order |
| `src/schemas.ts` | Schemas for framework types, such as `EntityId` |
| `src/system.ts`, `src/query.ts`, `src/resource.ts`, `src/services.ts` | The rest of the user-facing API |
| `src/driver.ts` | Fixed-step and timer drivers |
| `src/index.ts` | The package's one entry: `import { App, System } from "arcadekit"` |
| `test/` | Storage, runtime, rules, plugin and schema tests, including a randomized comparison against a simple model and replay tests |
| `bench/accessors.ts` | Accessor objects vs raw columns vs alternatives |
| `examples/demo.ts`, `examples/duel.ts` | A real-time simulation, and a turn-based game built from two plugins |

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

- A query that requires a sparse tag 1 in 100 entities have takes about 38 µs per pass to visit its 1,000 matches.
- A tick with ten systems that do nothing costs about 4.6 µs, and going through `app.tick` adds nothing measurable to a 100,000-entity loop.
- A sparse tag that many entities have, mixed in with ones that do not, breaks tables into short runs and `eachChunk` loses its edge. A component like that is better off with table storage.

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

- Nothing here draws, plays sound or reads input. It is the simulation side only, with no Foldkit or Three.js integration.
- One package entry. The storage core has no Effect dependency and could be its own entry (`arcadekit/ecs`).

- Plugins cannot be added or removed while the app runs, and one plugin cannot replace or disable another's systems.
- The log replays a game from its start. There is no snapshot of the world itself, so loading a long game means replaying all of it.
- Replay assumes a fixed delta and the same starting state. Anything random has to come from a seeded service, not `Math.random`.
- A schema checks a payload's shape. Whether an entity id in it is still alive, or belongs to the player who sent it, is for the handler to check.
- Event payloads are typed but have no schema, so events cannot be sent over a network yet.
- A refused action's direct component writes are not undone (see above).
- Accessors are generated with `new Function`, which a strict Content Security Policy blocks. The obvious fallback is about 40x slower than raw columns.
- `Effect.sleep`, promises and other real-time waits resume outside the tick. Scripts should wait with `Script.nextTick`, `Script.sleep` (game time) or an event's `wait`.
- A script that fails does so silently unless its fiber is observed.
- Entity generations are 10 bits: a handle kept across 1,024 reuses of the same slot can alias a newer entity.
- Systems run in sequence on one thread. No parallelism, no change detection.
