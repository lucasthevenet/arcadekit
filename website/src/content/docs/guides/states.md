---
title: "States"
description: "A state is one of a few named values, such as menu, playing or paused. Systems run only in some states, and hooks run when the game enters or leaves one."
---

A **state** is one of a few named values the game is in, such as `"menu"`, `"playing"` or `"paused"`. A system runs only in some states when it is given a condition. Work that happens once, on entering or leaving a state, is a **hook**.

## Define a state

```ts
import { Action, Plugin, State, System } from "arcadekit";
import { Schema } from "effect";

const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);

const Movement = System.tick("game/Movement", function* () {
  // only while playing
}).pipe(System.runIf(State.is(Phase, "playing")));

const StartLevel = State.onEnter(
  Phase,
  "playing",
  "game/StartLevel",
  function* () {
    // once, each time the game enters "playing"
  }
);

class NotPaused extends Schema.TaggedError<NotPaused>()("NotPaused", {}) {}
const Resume = Action.define("game/Resume", {
  error: NotPaused,
});

const resume = Action.handler(Resume, function* () {
  const phase = yield* State.Setter(Phase);
  if (!phase.is("paused")) {
    return yield* NotPaused.make({});
  }
  phase.set("playing");
});

const Rules = Plugin.make("game/Rules", {
  systems: [Movement, StartLevel],
  handlers: [resume],
});
```

The game starts in the first value, or in the one passed as the third argument to `State.define`.

A state is a singleton in the world. It is saved along with any pending request, hashed, and restored when an action that set it is refused.

## Change state

`yield* State.Reader(Phase)` gives you a view of the state, with `value`, `is(...values)`, and `next`, the requested state that hasn't been entered yet. To change the state, ask for `yield* State.Setter(Phase)` and call `set`. Only the simulation can ask for `sets`: a system of the tick, an action handler or a plugin's `setup`.

`set` requests a change, and the game enters the new state at the start of the next tick:

1. The exit hooks of the old state run, still seeing the old state.
2. The entities scoped to the old state are despawned, as [Despawn a state's entities when the game leaves it](#despawn-a-states-entities-when-the-game-leaves-it) says.
3. The state changes.
4. The enter hooks of the new state run.
5. The tick's systems run, according to the new state.

There is one transition per tick, and the last request before it wins. Requesting the current state cancels an earlier request, and isn't a transition. With several states, the requested ones are entered in order of name.

## Run a hook on entering or leaving a state

`State.onEnter(Phase, "playing", name, body)` and `State.onExit(Phase, "playing", name, body)` make a system that runs at that moment instead of every tick. Hooks for the same moment run in the order they are listed, and each hook's commands are applied before the next hook runs.

On the game's first tick, the enter hooks of the initial state run, followed in the same tick by any transition requested before it. A game loaded from a save doesn't run them again, because the save already holds their effects.

A transition requested by a hook waits for the next tick.

An exit hook can tell where the game goes: `(yield* State.Reader(Phase)).next` is the value it enters. An enter hook that has to know where the game came from is a transition hook, below.

## Start a run, pause it, resume it and restart it

A run starts when the game goes from the menu to `"playing"`. A pause and a resume go from `"playing"` to `"paused"` and back, and leave the run as it was:

```ts title="run.ts"
import { Action, Commands, Component, Field, Plugin, State } from "arcadekit";
import { Schema } from "effect";

export const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);
export const Hero = Component.tag("game/Hero");
const Wall = Component.define("game/Wall", { x: Field.f32 });

const StartRun = State.onTransition(
  Phase,
  { from: "menu", to: "playing" },
  "game/StartRun",
  function* () {
    const commands = yield* Commands.spawns(Hero, Wall).pipe(
      State.scoping(Phase, "playing", "paused")
    );
    commands.spawn(Hero);
    for (const x of [0, 8, 16]) {
      commands.spawn(Wall.of({ x }));
    }
  }
);

export const Go = Action.define("game/Go", {
  payload: Schema.Struct({
    to: Schema.Literals(["menu", "playing", "paused"]),
  }),
});
const go = Action.handler(Go, function* ({ to }) {
  (yield* State.Setter(Phase)).set(to);
});

export const Rules = Plugin.make("game/Rules", {
  systems: [StartRun],
  handlers: [go],
});
```

`State.onTransition(Phase, { from, to }, name, body)` is an enter hook of `to` that runs only when the game comes from `from`, one value or a list of them. `StartRun` runs on a move from the menu, and not on a resume from `"paused"`. It never runs on the game's first tick, which comes from no value.

`State.scoping(Phase, "playing", "paused")`, piped on `Commands.spawns`, gives every entity those commands spawn the tags of `"playing"` and `"paused"`, so the run's scope is named once. The hero and the walls stay while the game is paused, and are despawned when it goes back to the menu. Going to `"playing"` from there starts a new run:

```ts title="run.test.ts"
import { expect, it } from "@effect/vitest";
import { App, Query, Test } from "arcadekit";
import { Effect } from "effect";

import { Go, Hero, Rules } from "./run.ts";

it.effect("starts a run, keeps it through a pause, and starts another", () =>
  Effect.gen(function* () {
    const game = yield* Test.make(App.define({ plugins: [Rules] }));
    const go = Effect.fnUntraced(function* (to: "menu" | "playing" | "paused") {
      yield* game.app.enqueue(Go, { to });
      yield* game.step();
      return (yield* game.app.read(
        Query.View(Query.all().pipe(Query.with(Hero)))
      )).count();
    });
    expect(yield* go("playing")).toBe(1); // a run starts
    expect(yield* go("paused")).toBe(1);
    expect(yield* go("playing")).toBe(1); // a resume spawns nothing
    expect(yield* go("menu")).toBe(0); // the run ends
    expect(yield* go("playing")).toBe(1); // and another starts
  })
);
```

## Despawn a state's entities when the game leaves it

`State.scoped(Phase, "playing")` is the tag that `State.scoping` gives. An entity that has it is despawned when the game leaves `"playing"`, unless it also has the tag of the state the game enters. A system that spawns some entities in a scope and some not gives the tag by hand, and names it in `Commands.spawns`, as any component a system spawns:

```ts
import { Commands, Component, Field, State, System } from "arcadekit";

const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);
const Wall = Component.define("game/Wall", { x: Field.f32 });
const Score = Component.define("game/Score", { points: Field.u32 });
const playing = State.scoped(Phase, "playing");

const Build = System.tick("game/Build", function* () {
  const commands = yield* Commands.spawns(Wall, Score, playing);
  commands.spawn(Wall.of({ x: 0 }), playing); // goes with the run
  commands.spawn(Score.of({ points: 0 })); // stays
});
```

`State.scoping` takes a value known only when the system runs as it takes a literal: `State.scoping(Level, (yield* State.Reader(Level)).value)` scopes what a system spawns to the level the game is in.

The entities are despawned after the exit hooks and before the enter hooks, in order of their index. An exit hook still sees them, and decides what leaves with the state: an entity it gives the tag of the next state, or takes the tag from, stays, and one it spawns with the tag of the old state is despawned with the others. Each despawn takes with it the entities that point at it with a relation, as [Relations](relations.md#choose-what-happens-when-a-target-is-despawned) says, and [`Query.Removed`](queries.md#visit-only-what-changed) reads them in the tick's systems.

An entity can have the tags of several states, and is despawned when the game leaves either. The tags are components like any other: they are saved, hashed and rewound. A save that holds the tag of a value the state no longer has fails to load with `Save.LoadRefused`, whose `problem` is `"unknown component"`: a migration renames or removes the tag, as [Migrating saves](migrating-saves.md) shows for any component.

## Run a system only in some states

`System.runIf(State.is(Phase, "playing", "paused"))` runs a system only while the game is in one of those states. `State.is` makes one condition among others. [Run a system only when a condition holds](systems.md#run-a-system-only-when-a-condition-holds) covers conditions, what a system misses while it doesn't run, and `System.otherwise`.

## Read more

- [`State`](/reference/arcadekit/State) in the API reference.
