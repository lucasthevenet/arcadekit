# Events and actions

An event is what the simulation says happened. An action is what someone asks the game to do. This guide covers both, and how an action is checked, applied or refused.

## Events

```ts
import { Component, EntityId, Event, Field, Query, System } from "arcadekit";
import { Schema } from "effect";

const Body = Component.define("physics/Body", { y: Field.f32 });
const Bodies = Query.all(Body).pipe(Query.reads());

const Landed = Event.define(
  "physics/Landed",
  Schema.Struct({ entity: EntityId })
);

const Ground = System.make("physics/Ground", function* () {
  const landed = yield* Landed;
  (yield* Bodies).each((body, entity) => {
    if (body.y <= 0) {
      landed.emit({ entity }); // a plain call, fine inside a loop
    }
  });
});

const Dust = System.make("fx/Dust", function* () {
  for (const { entity } of (yield* Landed).read()) {
    // everything this system hasn't seen yet
  }
});
```

- Every system sees every event exactly once, whatever order systems run in. A system that runs before the one that emits sees the event on the next tick.
- An event is dropped once every system has had its chance.
- The frame stage and the input stage each hear every event once too, however many ticks ran between two frames. That is how sound and a UI follow the game.
- A script waits for one with `yield* landed.wait`, where `landed` is `yield* Landed`.

The schema is for when an event leaves the program, in a save: `Event.encode` and `Event.decode` turn a payload into JSON and back. `Event.define<Payload>("Name")` defines one with a type and no schema, for an event that never needs writing down.

## Actions

An action is how anything outside the simulation changes the game: a player's move, a button of the UI, a message from another machine.

```ts
import { Action, Commands, EntityId, World } from "arcadekit";
import { Data, Effect, Schema } from "effect";

const Strike = Action.define(
  "duel/Strike",
  Schema.Struct({ attacker: EntityId, target: EntityId })
);

class NoSuchFighter extends Data.TaggedError("NoSuchFighter")<{}> {}

const strike = Action.handler(Strike, function* ({ attacker, target }) {
  const world = yield* World;
  if (!world.isAlive(attacker) || !world.isAlive(target)) {
    return yield* Effect.fail(new NoSuchFighter());
  }
  (yield* Commands).despawn(target);
});
```

The handler is listed in a plugin's `handlers`. Then the app takes the action two ways:

- **`app.dispatch(Strike, payload)`** applies it now and returns an `Exit`: the handler's result, or why it was refused. For turn-based input.
- **`app.enqueue(Strike, payload)`** queues it for the start of the next tick. A refusal becomes an `Action.Rejected` event. For real-time input.

Dispatching an action with no handler, or with the wrong payload, doesn't compile.

## Checking and refusing

The payload is checked against the schema before the handler runs, including refinements the compiler can't see, such as a number between 1 and 10. A mismatch is an `Action.InvalidPayload`.

The handler checks the rules and refuses with a typed error. A refusal changes nothing, even after the handler has written: what it wrote, the numbers it drew, the commands it queued and the events it emitted are all taken back. So a handler can check as it goes.

A handler changes which entities exist through `Commands`. `world.spawn` and the like throw inside one.

## Who issued it

A handler is told where the action came from, beside the payload:

```ts sketch
const pass = Action.handler(Pass, function* (_, { from }) {
  const turn = yield* Turn;
  if (turn.player !== from) {
    return yield* Effect.fail(new NotYourTurn());
  }
  /* … */
});
```

In a game of several peers, `from` is the name of the peer that issued it, the same on every peer. In a game of one it is undefined. Check who may do a thing against `from`, never against a name in the payload.

## Actions the game issues itself

A system, a script or a handler issues an action with the `Actions` service, so a bot plays by the same rules as a player:

```ts sketch
(yield * Action.Actions).enqueue(Strike, { attacker, target });
```

What the simulation issues itself isn't logged: a replay's own systems issue it again.

## Actions as data

Input that arrives as JSON goes through `app.dispatchByName(name, json)` or `app.enqueueByName(name, json)`. An unknown name or a bad payload is a failure, never a crash.

`app.actionLog` holds every action that came from outside, in JSON form, with checkpoints of the world's hash among them. `Action.encodeLog` and `Action.decodeLog` turn it into text and back. See [replays](replays.md).

## Read more

- [Events](../../packages/arcadekit/README.md#events) and [actions](../../packages/arcadekit/README.md#actions-the-rules-layer) in the reference.
- [`examples/duel.ts`](../../packages/arcadekit/examples/duel.ts), a turn-based game built on actions.
