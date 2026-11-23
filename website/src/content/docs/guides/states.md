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
2. The state changes.
3. The enter hooks of the new state run.
4. The tick's systems run, according to the new state.

There is one transition per tick, and the last request before it wins. Requesting the current state cancels an earlier request, and isn't a transition. With several states, the requested ones are entered in order of name.

## Run a hook on entering or leaving a state

`State.onEnter(Phase, "playing", name, body)` and `State.onExit(Phase, "playing", name, body)` make a system that runs at that moment instead of every tick. Hooks for the same moment run in the order they are listed, and each hook's commands are applied before the next hook runs.

On the game's first tick, the enter hooks of the initial state run, followed in the same tick by any transition requested before it. A game loaded from a save doesn't run them again, because the save already holds their effects.

A transition requested by a hook waits for the next tick.

## Run a system only in some states

`System.runIf(State.is(Phase, "playing", "paused"))` runs a system only while the game is in one of those states. `State.is` makes one condition among others. [Run a system only when a condition holds](systems.md#run-a-system-only-when-a-condition-holds) covers conditions, what a system misses while it doesn't run, and `System.otherwise`.

## Read more

- [`State`](/reference/arcadekit/State) in the API reference.
