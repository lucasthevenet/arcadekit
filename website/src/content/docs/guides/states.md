---
title: "States"
description: "A game is in the menu, playing or paused, and its systems run in only some of those. A state is one of a few named values."
---

A game is in the menu, playing or paused, and its systems run in only some of those. A state is one of a few named values. A system says when it runs with a condition, and what has to happen once, on the way into a state or out of it, is a hook.

## Defining one

```ts
import { Action, Plugin, State, System } from "arcadekit";
import { Data, Effect, Schema } from "effect";

const Phase = State.define("game/Phase", ["menu", "playing", "paused"]);

const Movement = System.make("game/Movement", function* () {
  // only while playing
}).pipe(System.runIf(State.is(Phase, "playing")));

const StartLevel = System.make("game/StartLevel", function* () {
  // once, each time the game enters "playing"
}).pipe(State.onEnter(Phase, "playing"));

const Resume = Action.define("game/Resume", Schema.Struct({}));
class NotPaused extends Data.TaggedError("NotPaused")<{}> {}

const resume = Action.handler(Resume, function* () {
  const phase = yield* Phase;
  if (!phase.is("paused")) {
    return yield* Effect.fail(new NotPaused());
  }
  phase.set("playing");
});

const Rules = Plugin.make("game/Rules", {
  components: [Phase], // a state is listed with the components
  systems: [Movement, StartLevel],
  handlers: [resume],
});
```

The game starts in the first value, or in one given as a third argument to `State.define`.

## Moving between states

`yield* Phase` gives a handle: `value`, `is(...values)`, `set(value)`, and `next`, the state asked for and not entered yet.

`set` asks. The game enters the state at the start of the next tick:

1. the hooks for leaving the old state run, seeing the old state;
2. the state changes;
3. the hooks for entering the new one run;
4. the tick's systems run, as the new state has them.

One move a tick: the last ask before it counts. Asking for the state the game is in takes an earlier ask back, and is not a move. With several states, the ones asked for are entered in order of name.

## Hooks

`State.onEnter(Phase, "playing")` and `State.onExit(Phase, "playing")` make a system a hook: it runs at that moment and no longer every tick. Hooks of one moment run in the order they were given, or as `System.after` and `System.before` say, and the commands of each are applied before the next.

On the game's first tick, the hooks for the state it starts in run, followed in the same tick by a move that was asked for before it. A game loaded from a save doesn't run them again: the save holds what they did.

What a hook asks for waits for the next tick.

## Conditions

`System.runIf(condition)` runs a system only when the condition holds. `State.is(Phase, "playing", "paused")` is one; any Effect that gives a boolean is another, and can read whatever a system can. Given several, a system runs when all hold. What a condition needs and can fail with are the system's.

A system with no condition is asked nothing. A condition costs about 0.35 µs a tick, and a system that doesn't run costs that and no more.

A system that doesn't run doesn't read. The events of the ticks it sat out are gone when it runs again, so a system that can be switched off doesn't rely on an event for what it must not miss: it watches the state of the game, with a change query or a singleton. What its change queries have yet to visit is kept, however long it was away.

`System.otherwise(effect)` gives a system something to do in place of running, each time its condition doesn't hold. A system that keeps something outside itself as it should be leaves it as it last was when it isn't run, and this is how it says what that thing should be then. Music uses it, so that music not asked for stops; a view uses it to go back to its initial value. It runs as the system, in its stage: in a tick its commands are applied, and in a frame it may change nothing.

## Saved with the game

A state is a singleton of the world: saved, with what was asked for, hashed, and put back when an action that set it is refused.

## Read more

- [`State`](/reference/arcadekit/State) in the API reference.
