---
title: "Events and actions"
description: "An event is what the simulation says happened. An action is what someone asks the game to do. This guide covers both, and how an action is checked, applied or refused."
---

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
- A script waits for one with `yield* landed.wait`, where `landed` is `yield* Landed`. A system never waits: it reads what there is and finishes within its tick.

An event is a fact. Name it in the past tense, with the feature it belongs to in front: `"physics/Landed"`. The name is its identity in an app: two different events with one name are refused when the second is first used.

A system that `System.runIf` switches off doesn't rely on an event for anything it must not miss. The events of the ticks it sat out are gone when it runs again. It watches the state instead, with a [change query](queries.md) or a singleton.

The payload's type comes from the schema. Emitting checks nothing, so it stays cheap inside a loop. The schema is for when an event leaves the program, in a save: `Event.encode` and `Event.decode` turn a payload into JSON and back, each as an `Exit` that fails with `Event.InvalidEvent`. `Event.define<Payload>("Name")` defines one with a type and no schema, for an event that never needs writing down. A game can't be saved while one of those waits to be read.

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

Both are for code outside the simulation: the entry point, the network, a test. Once a game has started, they are the only way such code changes it: what it writes into `app.world` directly isn't in the log, and a [replay](replays.md) can't repeat it. `dispatch` works only between ticks, and throws during a tick or a frame. In a game of several peers it is `enqueue` alone: `dispatch` would move one machine's game, and throws. See [lockstep and rollback](lockstep-and-rollback.md).

The payload's type comes from the schema, and its JSON form is what the log and a save hold and what another machine is sent. A bigint or a date in a payload is converted on the way. `Action.define<Payload>()("Name")` defines an action with a type and no schema. Only the compiler checks it, it can't be saved while it waits for a tick, and it can't be sent to another peer, so keep those for actions that never leave the program.

## Checking and refusing

The payload is checked against the schema before the handler runs, including refinements the compiler can't see, such as a number between 1 and 10. A mismatch is an `Action.InvalidPayload`.

The handler checks the rules and refuses with a typed error: a class with a tag, made with `Data.TaggedError`, that the handler fails with and returns, `return yield* Effect.fail(new NoSuchFighter())`. Without the `return`, TypeScript doesn't know the code below is unreachable. Whoever dispatched handles the refusal by its tag, and the `Exit`'s type says which there can be. Give each error a tag of its own: two classes with one tag are caught as one, and nothing warns of it.

A refusal changes nothing, even after the handler has written. So a handler can check as it goes. Taken back are:

- what it wrote to components, and the random numbers it drew;
- the commands it queued, and a spawn among them gives its id back, so the next entities get the ids they would have had;
- the events it emitted and the actions it enqueued;
- its place in the events it read and in its change queries: the next action hears what this one heard.

The same goes for a handler that dies of a bug half-way. A refused action is not in the log, so a replay never runs it, and anything it left behind would make the replay differ.

What a refusal doesn't take back is what is outside the world: an object held in a field and changed in place, a call to a service of the game's own, a script the handler started. Replace the object, and do the other two after the last check. Nor does it take back a write forced through a raw column that the query said it [only reads](queries.md).

A handler has a few rules of its own:

- It finishes at once. It doesn't wait.
- It changes which entities exist through `Commands`. `world.spawn`, `despawn`, `add` and `remove` throw inside one.
- It reads its own writes while it runs.
- It can't dispatch another action. It issues one with `Actions.enqueue`, and a refusal takes that back too.

An accepted action costs one save of what it is about to write, and no copy back: one row for a `world.set`, about 0.2 µs, and for a loop the columns of the query's terms in each table it visits, but for the terms the query only reads. The world has the same on its own, for code that isn't a handler: `world.begin()`, then `world.commit()` or `world.rollback()`.

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

In a game of several peers, `from` is the name of the peer that issued it, the same on every peer. In a game of one it is undefined, as it is for an action the simulation issues itself. Check who may do a thing against `from`, never against a name in the payload, which whoever sent it wrote.

`from` is kept in the log and in a save, with an action that waits. `Action.Rejected` has it too, beside the action's name, its payload and the error, so a UI shows a player their own refusals.

## Actions the game issues itself

A system, a script or a handler issues an action with the `Actions` service, so a bot plays by the same rules as a player:

```ts sketch
(yield * Action.Actions).enqueue(Strike, { attacker, target });
```

It is applied at the start of the next tick. `handles(action)` of the same service says whether the game has a handler for an action, which `enqueue` throws without.

What the simulation issues itself isn't logged: a replay's own systems issue it again. So a system never calls `app.enqueue`: that would put the action in the log, and a replay would apply it twice.

The frame stage and the input stage are the other way round. They are outside the simulation and a replay runs neither, so what a system of theirs issues with `Actions.enqueue` is logged, as a key or a button of the UI is.

## Actions as data

Input that arrives as JSON goes through `app.dispatchByName(name, json)` or `app.enqueueByName(name, json)`. An unknown name or a bad payload is a failure, `Action.UnknownAction` or `Action.InvalidPayload`, or an `Action.Rejected` event, never a crash.

Either takes who issued it as a third argument, for a program that brings actions in on someone else's behalf, a server for its clients: `app.enqueueByName(name, json, client)`.

`app.actionLog` holds every action that came from outside, in JSON form, with checkpoints of the world's hash among them. `Action.encodeLog` and `Action.decodeLog` turn it into text and back. See [replays](replays.md).

## Read more

- [`Event`](/reference/arcadekit/Event) and [`Action`](/reference/arcadekit/Action) in the API reference.
- [`examples/duel.ts`](../../../../../packages/arcadekit/examples/duel.ts), a turn-based game built on actions.
