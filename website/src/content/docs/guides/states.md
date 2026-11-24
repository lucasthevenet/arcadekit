---
title: "States"
description: "A state is one of a few named values, such as menu, playing or paused. Systems run only in some states, and hooks run when the game enters or leaves one."
---

A **state** is one of a few named values the game is in, such as `"menu"`, `"playing"` or `"paused"`. A system runs only in some states when it is given a condition. Work that happens once, on entering or leaving a state, is a **hook**.

## Define a state

```ts
import { Action, Plugin, State, System } from "arcadekit";
import { Data, Schema } from "effect";

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

const Resume = Action.define("game/Resume", Schema.Struct({}));
class NotPaused extends Data.TaggedError("NotPaused")<{}> {}

const resume = Action.handler(Resume, function* () {
  const phase = yield* Phase.sets;
  if (!phase.is("paused")) {
    return yield* new NotPaused();
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

`yield* Phase` gives you a view of the state, with `value`, `is(...values)`, and `next`, the requested state that hasn't been entered yet. To change the state, ask for `yield* Phase.sets` and call `set`. Only the simulation can ask for `sets`: a system of the tick, an action handler or a plugin's `setup`.

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

## Despawn a state's entities when the game leaves it

```ts
import { Commands, Component, Field, Plugin, State } from "arcadekit";

const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);
const Wall = Component.define("game/Wall", { x: Field.f32 });

const playing = State.scoped(Phase, "playing");
const paused = State.scoped(Phase, "paused");

const BuildLevel = State.onEnter(
  Phase,
  "playing",
  "game/BuildLevel",
  function* () {
    const commands = yield* Commands.spawns(Wall, playing, paused);
    commands.spawn(Wall.of({ x: 0 }), playing, paused);
  }
);

const Rules = Plugin.make("game/Rules", { systems: [BuildLevel] });
```

`State.scoped(Phase, "playing")` is a tag. An entity that has it is despawned when the game leaves `"playing"`, unless it also has the tag of the state the game enters. The wall above has the tags of `"playing"` and `"paused"`, so it stays while the game is paused, and is despawned when the game goes back to `"menu"`. Name the tags in `Commands.spawns`, as any component a system spawns.

The entities are despawned after the exit hooks and before the enter hooks, in order of their index. An exit hook still sees them, and decides what leaves with the state: an entity it gives the tag of the next state, or takes the tag from, stays, and one it spawns with the tag of the old state is despawned with the others. Each despawn takes with it the entities that point at it with a relation, as [Relations](relations.md#choose-what-happens-when-a-target-is-despawned) says, and [`Query.removed`](queries.md#visit-only-what-changed) reads them in the tick's systems.

An entity can have the tags of several states, and is despawned when the game leaves either. The tags are components like any other: they are saved, hashed and rewound. A save that holds the tag of a value the state no longer has fails to load with `Save.LoadRefused`, whose `problem` is `"unknown component"`: a migration renames or removes the tag, as [Migrating saves](migrating-saves.md) shows for any component.

## Run a system only in some states

`System.runIf(State.is(Phase, "playing", "paused"))` runs a system only while the game is in one of those states. `State.is` makes one condition among others. [Run a system only when a condition holds](systems.md#run-a-system-only-when-a-condition-holds) covers conditions, what a system misses while it doesn't run, and `System.otherwise`.

## Read more

- [`State`](/reference/arcadekit/State) in the API reference.
