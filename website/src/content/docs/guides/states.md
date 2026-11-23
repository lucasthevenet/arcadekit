---
title: "States"
description: "A state is one of a few named values, such as menu, playing or paused. Systems run only in some states, and hooks run when the game enters or leaves one."
---

A game is in a menu, playing or paused, and many of its systems should only run in some of those. A **state** is one of a few named values. A system declares when it runs with a condition, and work that happens once, on entering or leaving a state, is a **hook**.

## Defining a state

```ts
import { Action, Plugin, State, System } from "arcadekit";
import { Data, Effect, Schema } from "effect";

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

## Changing state

`yield* Phase` gives you `value`, `is(...values)`, and `next`, the requested state that hasn't been entered. Setting it is `yield* Phase.sets`, then `set`, and only a system of the tick or a handler can ask for that.

`set` requests a change, and the game enters the new state at the start of the next tick:

1. the exit hooks of the old state run, still seeing the old state;
2. the state changes;
3. the enter hooks of the new state run;
4. the tick's systems run, according to the new state.

There is one transition per tick, and the last request before it wins. Requesting the current state cancels an earlier request and isn't a transition. With several states, the requested ones are entered in order of name.

## Hooks

`State.onEnter(Phase, "playing", name, body)` and `State.onExit(Phase, "playing", name, body)` make a system that runs at that moment instead of every tick. Hooks for the same moment run in the order they are listed, and each hook's commands are applied before the next runs.

On the game's first tick, the enter hooks of the initial state run, followed in the same tick by any transition requested before it. A game loaded from a save doesn't run them again, since the save already holds their effects.

A transition requested by a hook waits for the next tick.

## Conditions

`System.runIf(condition)` runs a system only when the condition holds. `State.is(Phase, "playing", "paused")` is one condition; any Effect that returns a boolean is another, and can read anything a system can. With several conditions, the system runs when all hold. A condition's requirements and errors become the system's.

A system without conditions is never asked. A condition costs about 0.35 µs per tick, and a system that doesn't run costs that and nothing more.

A system that doesn't run doesn't read, and sees nothing of what happened while it was off: the events from the ticks it skipped are gone when it runs again, and its change queries skip what changed in them. So a system that can be switched off reads the state it needs when it runs again, with an ordinary query or a singleton, rather than counting on hearing of every change.

`System.otherwise(effect)` gives a system something to do instead of running, on each tick its condition fails. A system that keeps something outside itself up to date leaves it as it last was when it doesn't run, and `otherwise` declares what it should be instead. Music uses it so that unrequested music stops, and a view uses it to return to its initial value. It runs as the system, in its stage: in a tick its commands are applied, and in a frame it can change nothing.

## Saving

A state is a singleton in the world: saved along with any pending request, hashed, and restored when an action that set it is refused.

## Read more

- [`State`](/reference/arcadekit/State) in the API reference.
