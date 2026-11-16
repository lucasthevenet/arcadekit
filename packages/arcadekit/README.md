# arcadekit

A framework for building games of any genre on [Effect](https://effect.website) 4, built around an entity component system (ECS).

This is the first cut of the revamped design. It is a working prototype, not a finished kit: see [Not done yet](#not-done-yet).

1. **Storage core** (`src/ecs/`): archetype tables with typed-array columns, opt-in sparse storage, cached queries, queries for what changed, a command buffer. No Effect.
2. **Tick scheduler**: Effect around the core. One fiber per tick, systems as generators, yieldable queries and resources, coroutine scripts, and a custom Effect `Scheduler` that only runs fibers when the tick says so. Beside the tick, a frame stage that draws the game between ticks and cannot change it, and an input stage that turns what the devices say into actions.
3. **Events and rules**: typed events every system sees exactly once, and actions with handlers that validate a move and refuse it with a typed error. Payloads are checked against a schema, applied actions are logged as JSON-safe data, and the log replays the game and checks the replay against the world's hash.
4. **Plugins**: one value that bundles a feature's systems, handlers, services and setup, and names the plugins it depends on.

From the repository root:

```sh
pnpm install
pnpm test                          # 448 tests
pnpm typecheck
pnpm --filter arcadekit demo       # real-time simulation
pnpm --filter arcadekit duel       # turn-based game
pnpm --filter arcadekit page       # a game in a page, at http://localhost:5173
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

// A game that runs: sixty ticks a second, until the page goes away.
BrowserRuntime.runMain(App.run({ systems: [Movement] }, { hz: 60 }));

// One tick at a time, for a game that waits for its players, or a test.
const program = Effect.gen(function* () {
  const app = yield* App.make({ systems: [Movement] });
  app.world.spawn(Position.of({ x: 0, y: 0 }), Velocity.of({ x: 1, y: 0 }));
  app.tick(1 / 60);
});
```

Systems run in the order they are registered unless told otherwise: `System.after(Other)` and `System.before(Other)` pull whatever has to run first forward to just before the system that needs it.

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

A number goes in a typed field: `f32`, `f64`, `i32`, `u32`, `u16`, `u8`, `entity`. Anything else says, where it is defined, what a snapshot and the hash do with it.

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

- The built-in services are keyed `"arcadekit/World"`, `"arcadekit/Time"`, `"arcadekit/Frame"`, `"arcadekit/Commands"`, `"arcadekit/Script"`, `"arcadekit/Events"`, `"arcadekit/Random"` and `"arcadekit/Actions"`, so a game is free to key a service of its own `"World"`. The screen a frame loop follows is keyed `"arcadekit/Display"`, the devices `"arcadekit/Input.Devices"` and where they come from `"arcadekit/Input.Source"`.
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
- A system with no condition is asked nothing and costs what it did. A condition costs about 0.35 µs a tick, and a system that does not run costs that and no more; see the [benchmark](#benchmark-100000-entities-pos--vel--dt).
- A system that does not run does not read. The events of the ticks it sat out are gone when it runs again, as for any system an event is older than. What its [change queries](#change-queries) have yet to visit is kept, however long it was away.
- A state is a [singleton](#singletons) of the world. It is saved with a game, with what was asked for, and counted in the hash; a refused action's `set` is taken back. List it in a plugin's `components`. A loaded game does not run its starting hooks again: the save holds what they did.
- With several states, the ones asked for are entered in order of name.

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
- A frame system takes a condition with `System.runIf` like any other. A hook does not belong there: a state is entered by a tick.
- With the storage core on its own: `world.freeze()` and `world.thaw()`, which is where a draw from the world's generator is found.

## In a page

```ts
BrowserRuntime.runMain(
  App.run({ plugins: [Game] }, { hz: 60 }).pipe(
    Effect.provide(Input.layerBrowser({ target: canvas }))
  )
);
```

`App.run` is the entry point: it makes the app and runs it until it is interrupted. It is `App.make` and the frame loop, `Driver.frames`, in a scope of their own.

- It never ends by itself. The platform's `runMain` interrupts it when the page goes away, or the process is told to stop, and that stops the loop and closes the scope. Nothing is left running: no frame asked for, no listener, no script, and whatever the plugins' layers acquired let go.
- What the game needs from outside is provided to it as to `App.make`, and a missing service is the same compile error. It stays provided for as long as the game runs, which is what a layer that listens, such as [`Input.layerBrowser`](#input), needs.
- `ready` runs once, when the app is made and before its first frame, with the app: to wire what is outside the game to it, or to keep hold of it. What it acquires is let go with the app, and what it needs and can fail with are `run`'s.

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
- It runs wherever there is a display, which outside a page is a timer: `NodeRuntime.runMain(App.run(...))` is the same game under Node, and `examples/demo.ts` is started that way.

`Driver.frames` is the frame loop underneath, for a program that makes its app itself. It follows the display until it is interrupted: each time a frame is due it runs the ticks that are due, at a fixed `hz`, and then the [frame stage](#the-tick-and-the-frame), as `Driver.fixedStep` does. In a page a frame is due once per repaint, which is `requestAnimationFrame`.

- The first frame draws the game as it stands and runs no tick. Time is counted from it.
- While the tab is hidden the loop asks for no frame, and the time spent hidden does not count. A game that comes back is where it was left, and does not run to catch up.
- Interrupting it takes back the frame it had asked for and stops watching the tab. It is interrupted with the fiber that runs it: `runMain` interrupts the program when the page goes away, and a loop started with `Effect.forkScoped` stops when its scope closes. So closing the app's scope leaves nothing running: no frame asked for, no listener, no script, and whatever the plugins' layers acquired let go.
- If a tick or a frame throws, the loop stops the same way and dies with what was thrown.
- A page that froze without being hidden runs at most `maxStepsPerCall` ticks in its next frame, 5 unless told otherwise, and drops the rest of the backlog.
- It reaches the screen through `Driver.Display`, a `Context.Reference` whose default is the platform's: `requestAnimationFrame` and the document's visibility in a page, and a timer of 60 frames a second anywhere else, so the same program runs under Node.
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

// In a page, around the whole program:
main.pipe(Effect.provide(Input.layerBrowser({ target: canvas })));
```

The keyboard, the pointer and the gamepads are outside the game. What they say reaches it as actions, through the same [log](#payloads-saves-and-the-network) as everything else that comes from outside. So a replay needs no devices at all: it is given no source and reads none, and the actions are in its log.

**The input stage.** An app has a third stage beside the tick and the frame. A system made with `System.inStage("input")` runs when `app.input()` is called, which `Driver.fixedStep` does just before each tick, and so `Driver.frames` and `Driver.interval` with it.

- The devices are read once per run, and every system of the stage is given that one sample as `Input.Devices`: the buttons that are `down`, the ones `pressed` and `released` since the sample before, the `axes`, and the ones that `moved`. A frame in which no tick is due reads nothing, and what was pressed meanwhile is there for the next tick, so a quick tap is never lost between two frames.
- The world is frozen there, as in the frame stage, and whatever would change the game throws. What a system makes of the devices it issues with `Actions.enqueue`, which is logged and applied at the start of the tick that follows.
- `Input.Devices` is no part of the game, so a system in the tick or in the frame stage cannot read it: its fields throw there and say what to read.
- A replay and a server never call `app.input()`. The simulation cannot tell whether its devices are read: a game played from a keyboard and its replay have the same hash at every tick.

**The picture.** `Input.plugin` keeps what the devices say in the world, for systems to read.

- `yield* Input.Keyboard` gives `down(code)`, `pressed(code)` and `released(code)`. `Input.Pointer` has `x`, `y` and the same three for a button, the main one unless told. `Input.Gamepad(index)` has `axis(n)` and the three for a button.
- `pressed` and `released` are true in the one tick that first sees the change, for every system of that tick. A key that went down and up between two ticks was pressed and released in the same tick and is not down.
- What changed since the last tick is one action, `Input.Report`, and only when something did: holding a key still, or doing nothing, logs nothing.
- The picture is a [singleton](#singletons): saved with a game, put back by a refusal, and counted in the hash once something was pressed. A game nobody has touched hashes as one that has no input at all.
- The devices are the truth. A loaded game whose save had a key held, where the key is no longer down, lets it go at the first reading.
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

- `Input.layerBrowser(options)` is a page's: the keyboard, the pointer (a mouse, a pen or a finger) and the gamepads. `target` is the element the pointer is pressed on and measured from, in CSS pixels from its top left corner; `preventDefault` lists the keys that must not scroll the page; `deadzone` is how far a stick has to be from its middle to count, a tenth unless told. A key held down went down once, and everything held is let go when the page loses focus.
- It listens until its scope closes, so it is provided to the whole program. Provided to `App.make` alone it is let go as soon as the app is made, and says so when it is read.
- `Input.makeManualSource()` is a source worked by hand, for a test, a tool or controls drawn on the screen: `press`, `release`, `tap`, `move`.

  ```ts
  const source = Input.makeManualSource();
  const made = App.make({ plugins: [Game] }).pipe(
    Effect.provideService(Input.Source, source)
  );
  // With the app that gives:
  source.press("Space");
  app.input();
  app.tick(1 / 60);
  ```

- Reading the devices when nothing changed costs 1.4 µs a tick. A tick in which a key went down or up costs 5.2 µs in all: the reading, the action and the tick that applies it. See the [benchmark](#benchmark-100000-entities-pos--vel--dt).

## Assets

```ts
const Forest = Assets.bundle("game/Forest", {
  backdrop: Assets.image("/forest.png"),
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

- `Assets.during(condition, bundle)` gives a level its scope. It is a system that keeps the bundle loaded while the condition holds, one of [`System.runIf`'s](#states-and-run-conditions), usually a state. From the frame after the game enters the level the bundle is loading, in a scope of its own; from the frame after it leaves, that scope is closed. What was loaded is let go, a picture is closed, and a file that was still on its way is given up. Entered again, the level loads again.
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
- An asset is `Assets.bytes(url)`, `Assets.text(url)`, `Assets.json(url, schema)` or `Assets.image(url)`, which gives an `ImageBitmap` and closes it. One of a kind of your own is `Assets.make(url, decode)`, with `Effect.acquireRelease` for what has to be let go.
- The bytes come through `Assets.Loader`, a `Context.Reference` whose default is `fetch`, given up when the load is interrupted. A test provides its files with `Assets.layerMemory({ "/forest.json": "..." })`.
- A system of the game's own can keep a bundle too, with `(yield* Assets.Store).hold(bundle, name)` and `drop`: it stays loaded while anyone holds it.

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
- It reads and changes nothing, so it can be called at any time. It costs about 7 ns per entity for four float fields, 0.7 ms for 100,000 entities; see the [benchmark](#benchmark-100000-entities-pos--vel--dt).

## Snapshots

```ts
const bytes = world.snapshot(); // a Uint8Array

const copy = new EcsWorld();
copy.load(bytes, [Position, Velocity, Burning]); // the components it may name
copy.hash() === world.hash(); // true
```

`world.snapshot()` is the whole world as bytes: every table and sparse set, the singletons that have been written, the ids to come, and the state of the random generator. A world that loads them hashes the same as the one they were taken from and goes on the same: the same order of iteration, the same ids for the next entities, the same random numbers.

- It is about as big as the data. A column of numbers is written as its bytes, so an entity with two `f32` fields takes 14 bytes: 4 of id, 8 of floats and 2 of generation.
- A component is written under its name, with the names and kinds of its fields, so a snapshot does not depend on the order a program defines its components in. A world knows a component by its name and an empty world knows none, so `load` is given the components the snapshot may name.
- `load` fills an empty world: one that has never held an entity or written a singleton.
- The format is numbered. This version writes format 2, which added singletons, and reads format 1 as well.
- Every problem is a `SnapshotError`, whose `problem` says which kind and whose message names the component or field: `"not a snapshot"`, `"newer format"`, `"truncated"`, `"corrupt"`, `"unknown component"`, `"component changed"` (with its fields then and now), `"world not empty"`, `"cannot be saved"`.
- Damaged bytes are refused, not trusted: every count is checked against the bytes that are there before anything is allocated for it, an entity may not be in two rows or in a freed slot, and text has to be text. A damaged number inside a column cannot be told from another number, and loads as that.
- A `json` field is saved as the plain data it holds, exactly for text, numbers, booleans, bigints, null and undefined (`-0` and `NaN` come back as they were), and as JSON text for an array or an object. A `schema` or `ref` field is saved in its encoded form, and a `transient` field is not saved. See [Fields](#fields).
- A snapshot is refused while a spawn is queued on a `CommandBuffer` and not applied.
- It costs 6 ns per entity to take and 16 ns to load, for four float fields; see the [benchmark](#benchmark-100000-entities-pos--vel--dt).

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
- `app.dispatch` is for turn-based input: the caller gets the typed outcome immediately. `app.enqueue` is for real-time input: the action waits for the start of the next tick, and a refusal becomes an `Action.Rejected` event. Both are for code outside the simulation. A system, a script or a handler issues an action with the `Actions` service, `(yield* Action.Actions).enqueue(...)`, so AI plays by the same rules as players.
- Dispatching an action with no handler, or with the wrong payload, does not compile.

### Payloads, saves and the network

- The payload type comes from the schema, and every payload is checked against it before the handler runs, including refinements the compiler cannot see (an amount between 1 and 10, say). A mismatch is an `Action.InvalidPayload` failure.
- Input that arrives as data goes through `app.dispatchByName(name, json)` or `app.enqueueByName(name, json)`. An unknown name or a malformed payload is a failure or a `Rejected` event, never a crash.
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
- A save is the snapshot and a little text: for 100,000 entities with four float fields, 2.2 MB and about 0.6 ms to take.

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
- `checkpointEvery` is 60 unless told otherwise. A checkpoint costs one hash of the world, 0.7 ms for 100,000 entities, so a smaller number finds a divergence closer to where it happened at that price per checkpoint, and adds an entry to the log each time. A turn-based game ticks once a move and wants 1. With 0 the app records none.
- Once a game has started, what changes its world has to be in the log or come from the simulation: an action, a system, a script. A coin spawned straight into `app.world` between two ticks is in neither, so a replay cannot know of it, and stops at the next checkpoint.

## Files

| File | What it is |
| --- | --- |
| `src/ecs/component.ts` | Fields, components, relations, singletons, entity ids, generated accessors |
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
| `src/State.ts` | States, their hooks, and the condition that a game is in one |
| `src/Input.ts` | The devices and where they come from, the picture of them in the world, and bindings to actions |
| `src/Assets.ts` | Assets and bundles of them, loading as a scoped resource, and the store that keeps a level's while the level lasts |
| `src/Schemas.ts` | Schemas for framework types, such as `EntityId` |
| `src/System.ts`, `src/Query.ts`, `src/Resource.ts`, `src/Services.ts` | The rest of the user-facing API |
| `src/Driver.ts` | The fixed step, the frame loop that follows the display, and a timer: each runs the ticks that are due and then the frame stage |
| `src/index.ts` | The package's one entry: `import { App, System } from "arcadekit"` |
| `test/` | Storage, runtime, rules, plugin, schema, random, hash, replay, transaction, snapshot, field, save, migration, change, singleton, relation, state, frame, read-only query, driver, input, asset and entry point tests, including randomized comparisons of the storage, of change queries and of relations against simple models, the generator checked against its published algorithm, and replays of a faulty build of a game, and a game played from a keyboard and replayed with none |
| `bench/accessors.ts` | Accessor objects vs raw columns vs alternatives |
| `examples/demo.ts` | A real-time simulation, started with `NodeRuntime.runMain` around `App.run` |
| `examples/duel.ts` | A turn-based game built from two plugins, which makes its app and steps it one move at a time |
| `examples/page/` | A game in a page: played with the keyboard and the pointer, drawn on a canvas, with a level whose assets come and go, started with `BrowserRuntime.runMain` around `App.run` |

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
| `world.snapshot()`, one table (2.2 MB)                    | 6.0       |
| `world.load()` of that snapshot, into a new world         | 15.7      |

Change detection in the same world, with a query that watches `Position`:

| Variant | Cost |
| --- | --- |
| A change query's visit when nothing changed | 62 ns |
| One `world.set` among 100,000 entities, and the visit after it | 200 ns |
| Visiting the 1,000 entities that were written, of 100,000 | 42 µs |
| Visiting all 100,000, every one written | 22.4 ns/entity |
| `each` writing the watched component: every row noted | 14.0 ns/entity |
| The same, when every row is noted already | 11.3 ns/entity |
| `eachChunk` handed the watched component: every row noted | 5.3 ns/entity |
| The same through a query that only reads it (`Query.reads`) | 2.6 ns/entity |

The input stage, with `Input.plugin`, three buttons held and the pointer somewhere:

| Variant                                                 | Cost    |
| ------------------------------------------------------- | ------- |
| `app.input()`: the devices read, nothing changed        | 1.39 µs |
| `app.input()` and `app.tick()`: one key went down or up | 5.22 µs |

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

- Writes are noticed per row. A component that no query watches costs what it did: the lines of the first table were measured before and after and did not move. A watched one costs 2.5 ns more for an assignment in `each` to a row that is noted already, about 5 ns for the first assignment to a row since the last visit, and 2.8 ns per row that `eachChunk` hands out. Noticing per table or per column would cost nothing to write, but one `world.set` would then send every watching query through the whole table: 0.25 ms to 0.64 ms for 100,000 rows, where it now takes 0.2 µs.
- A change query is for what changes now and then. Visiting everything because everything was written costs three and a half plain passes, since each entity is looked up from the log: a system that wants every entity every tick asks for them with an ordinary query.
- The input stage runs before every tick, so its cost when nothing happens is the one that counts: one sample of the devices, compared with what the world holds, 1.4 µs for a keyboard, a pointer and a few buttons held. An app with no system in that stage reads nothing and pays nothing.
- A frame of ten systems that do nothing costs 5.8 µs, about what a tick of ten does: freezing the world is setting a flag. Checking a frame with `verifyFrames` costs a hash of the world before the stage and one after each of its systems, 1.3 ms more for one system over 100,000 entities.
- A relation costs its component and a few assignments to link and unlink: 0.13 µs more per entity that is spawned and despawned with one. A despawn that takes others with it costs what despawning each of them does, 130 ns apiece here. A world with no relation does one comparison more per despawn than before: the first line was 587 µs before relations and 561 µs after, which is the machine's noise.
- A query that requires a sparse tag 1 in 100 entities have takes about 38 µs per pass to visit its 1,000 matches.
- A tick with ten systems that do nothing costs about 5 µs, and going through `app.tick` adds nothing measurable to a 100,000-entity loop. Run conditions did not change that: 4.99 to 5.47 µs before them and 5.00 to 5.81 µs after, over four runs each. With a condition on each of the ten that holds, the tick costs 8.5 µs; with one that does not, 3.5 µs.
- A sparse tag that many entities have, mixed in with ones that do not, breaks tables into short runs and `eachChunk` loses its edge. A component like that is better off with table storage.
- A handler that loops pays one copy of the columns it visits, 0.11 ms for four float columns of 100,000 rows, and as much again to copy them back if it is refused. It pays for none it only reads: a handler that looks at all 100,000 entities takes 0.78 ms through a plain query and 0.67 ms through one made with `Query.reads()`. The copies are kept and written over by the next action; allocating them afresh each time cost 0.35 ms. A refusal itself costs about 9 µs, which is Effect building the failure.
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

- Nothing here plays sound, and nothing draws for you. There is a frame stage for what draws and a frame loop that runs it once per repaint, and the example page draws on a canvas by hand: no Foldkit or Three.js integration.
- An asset is a picture, text, JSON or bytes. A sound and a font are for whoever plays and draws them to decode, with `Assets.make`.
- A bundle is loaded or it is not: it does not say how far along it is, and a file that two bundles name is fetched for each.
- A bundle that failed stays failed until its level is entered again. Nothing tries again by itself.
- `Assets.load` waits in real time. In a script it would resume in whatever tick the file happened to arrive in, and a replay of that script would fetch the file again: a script does not load.
- The picture of the devices is one player's. Several players on one machine, or on several, bind their devices to actions that say whose they are.
- A gamepad's button is down or it is not: how far a trigger is pressed is not read. Nor are the wheel, text as it is typed, more than one finger at a time, or a pointer that is locked to the page.
- A button that is held, and let go and pressed again between two readings of the devices, is held: neither edge is seen. One that is pressed twice between two readings was pressed once.
- The pointer's place is in CSS pixels of its target. A canvas that is drawn larger or smaller than its own size has to convert.
- Bindings are fixed when the system is made. A game that lets its player choose the keys writes a system of the input stage that looks them up.
- Only a driver runs the input stage. A game that ticks when a player moves calls `app.input()` before its tick itself.
- `App.run` is for a game that ticks in real time. One that ticks when a player moves, as the duel example does, makes its app and steps it itself: in a page it would want its frames drawn at the display's rate and its ticks on demand, and no driver does that.
- The frame loop always pauses while the tab is hidden. A game that has to go on in the background, such as one peer of several, cannot say so.
- The example page is opened in a browser by hand. No test in CI runs a page: the frame loop is tested against a display turned by hand, and against stand-ins for `requestAnimationFrame` and the document.
- Neither the frame stage nor the input stage can stop a write through the raw columns of `eachChunk`. `verifyFrames` finds one afterwards, at the cost of a hash of the world per system of those stages. A draw from `world.random` there is found when the stage ends, not where it is made.
- A frame system that draws between two ticks works the place out itself, from a velocity or a previous position the simulation keeps. There is no helper for it.
- One package entry. The storage core has no Effect dependency and could be its own entry (`arcadekit/ecs`).

- Plugins cannot be added or removed while the app runs, and one plugin cannot replace or disable another's systems.
- A save does not hold scripts, so a script that keeps its progress in its own variables starts over when a game is loaded. Nor does it hold what a game's own services hold.
- A save is refused while an action or an event with no schema is waiting, which for a game that emits such an event every tick is always.
- An action enqueued with a payload its schema rejects is refused when its turn comes, as an event, and is not in the log, since it has no JSON form. A replay therefore does not repeat that one refusal.
- The log does not say when a script was started by hand with `app.spawnScript`, nor the delta and the number of ticks of the game it records. A replay is told those by its caller.
- The hash covers the world and nothing else: not the events waiting to be read, what change queries have yet to visit, the actions queued for the next tick, or how far each script has got.
- What a query only reads is the query's word. A raw column is a typed array all the same: a loop that writes one past the compiler has written it, and no change query hears of it and no refusal takes it back.
- `Query.removed` gives the ids of the entities that lost a component, not the values it held.
- A singleton cannot be watched for changes: a change query is of entities.
- An entity points at one target per relation, and a query cannot ask for what points at a given entity: `world.sources` gives those as a list.
- A run condition is given to one system at a time: a plugin cannot be given one for all its systems. A script is not stopped by a state; it asks.
- A schema checks a payload's shape. Whether an entity id in it is still alive, or belongs to the player who sent it, is for the handler to check.
- A refused action does not undo what is outside the world: an object held in a field that the handler changed in place, a call to a service of the game's own, a script it started.
- Accessors are generated with `new Function`, which a strict Content Security Policy blocks. The obvious fallback is about 40x slower than raw columns.
- `Effect.sleep`, promises and other real-time waits resume outside the tick. Scripts should wait with `Script.nextTick`, `Script.sleep` (game time) or an event's `wait`.
- Only scripts started with `app.spawnScript` or `Script.spawn` are watched. Effect has no hook that would let the app see a fiber started with `Effect.forkDetach`.
- Entity generations are 10 bits: a handle kept across 1,024 reuses of the same slot can alias a newer entity.
- Systems run in sequence on one thread. No parallelism.
