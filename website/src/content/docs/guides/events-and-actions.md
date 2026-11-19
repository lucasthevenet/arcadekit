---
title: "Events and actions"
description: "An event records something the simulation did. An action is a request to change the game. Learn how to use both, and how actions are validated, applied or refused."
---

An **event** records something that happened in the simulation. An **action** is a request to change the game. This guide covers both, and how an action is validated, applied or refused.

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
    // every event this system hasn't seen
  }
});
```

- Every system sees every event exactly once, whatever order systems run in. A system that runs before the emitter sees the event on the next tick.
- An event is dropped once every system has had a chance to read it.
- The frame and input stages also see every event once, however many ticks ran between two frames. That is how sound and UI follow the game.
- A script waits for an event with `yield* landed.wait`, where `landed` is `yield* Landed`. A system never waits: it reads what is there and finishes within its tick.

An event is a fact: name it in the past tense, prefixed with its feature, such as `"physics/Landed"`. The name identifies the event within an app, and a second, different event with the same name is refused when it is first used.

A system that `System.runIf` can switch off shouldn't rely on events for anything it must not miss: the events from the ticks it skipped are gone when it runs again. Have it watch the game's state instead, with a [change query](queries.md) or a singleton.

The payload's type comes from the schema. Emitting validates nothing, so it stays cheap inside a loop. The schema is used when an event leaves the program, in a save: `Event.encode` and `Event.decode` convert a payload to JSON and back, each returning an `Exit` that fails with `Event.InvalidEvent`. `Event.define<Payload>("Name")` defines an event with a type and no schema, for events that never need to be serialized. A game can't be saved while such an event is waiting to be read.

## Actions

An action is how anything outside the simulation changes the game: a player's move, a UI button, a message from another machine.

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
    return yield* new NoSuchFighter();
  }
  (yield* Commands).despawn(target);
});
```

List the handler in a plugin's `handlers`. The app then accepts the action in two ways:

- **`app.dispatch(Strike, payload)`** applies it immediately and returns an `Exit`: the handler's result, or why it was refused. Use it for turn-based input.
- **`app.enqueue(Strike, payload)`** queues it for the start of the next tick, where a refusal becomes an `Action.Rejected` event. Use it for real-time input.

Dispatching an action that has no handler, or with the wrong payload, is a compile error.

Both are for code outside the simulation: the entry point, the network, a test. Once a game has started, they are the only way such code should change it: anything written into `app.world` directly isn't logged, so a [replay](replays.md) can't reproduce it. `dispatch` only works between ticks, and throws during a tick or a frame. In a multiplayer game, use `enqueue` only: `dispatch` would change one machine's game, and throws. See [lockstep and rollback](lockstep-and-rollback.md).

The payload's type comes from the schema, and its JSON encoding is what the log and saves store and what other peers receive. Bigints and dates in a payload are converted along the way. `Action.define<Payload>()("Name")` defines an action with a type and no schema. Only the compiler checks it, it can't be saved while queued, and it can't be sent to other peers, so reserve it for actions that never leave the program.

## Checking and refusing

Before the handler runs, the payload is validated against the schema, including refinements the compiler can't see, such as a number between 1 and 10. A mismatch is an `Action.InvalidPayload`.

The handler checks the game's rules and refuses with a typed error: a tagged class made with `Data.TaggedError`, failed and returned with `return yield* new NoSuchFighter()`. Without the `return`, TypeScript doesn't know the code below is unreachable. The caller handles the refusal by its tag, and the `Exit`'s type lists the possible errors. Give each error its own tag: two classes with the same tag are caught as one, with no warning.

A refusal changes nothing, even after the handler has written to the world, so a handler can check as it goes. A refusal rolls back:

- its writes to components, and the random numbers it drew;
- the commands it queued, and any spawn among them returns its id, so the next entities get the ids they would have had;
- the events it emitted and the actions it enqueued;
- its position in the events it read and in its change queries, so the next action sees what this one saw.

The same applies to a handler that dies from a bug halfway through. A refused action isn't logged, so a replay never runs it, and anything it left behind would make the replay diverge.

A refusal doesn't roll back anything outside the world: an object held in a field and mutated in place, a call to one of your own services, or a script the handler started. Replace the object instead of mutating it, and make the other two calls after the last check. It also doesn't undo a write forced through a raw column the query declared [read-only](queries.md#read-only-access).

Handlers follow a few rules of their own:

- A handler finishes immediately; it doesn't wait.
- It changes which entities exist through `Commands`. `world.spawn`, `despawn`, `add` and `remove` throw inside a handler.
- It reads its own writes while it runs.
- It can't dispatch another action. It issues one with `Actions.enqueue`, and a refusal rolls that back too.

An accepted action costs one copy of what it is about to write, and no copy back: one row for a `world.set`, about 0.2 µs, and for a loop, the columns of the query's terms in each table it visits, excluding the terms it only reads. The world offers the same mechanism for code outside handlers: `world.begin()`, then `world.commit()` or `world.rollback()`.

## Who issued an action

A handler receives the action's origin alongside the payload:

```ts sketch
const pass = Action.handler(Pass, function* (_, { from }) {
  const turn = yield* Turn;
  if (turn.player !== from) {
    return yield* new NotYourTurn();
  }
  /* … */
});
```

In a multiplayer game, `from` is the name of the peer that issued the action, identical on every peer. In a single-player game it is `undefined`, as it is for actions the simulation issues itself. Check permissions against `from`, never against a name in the payload, which the sender controls.

`from` is kept in the log and in a save for queued actions. `Action.Rejected` carries it too, alongside the action's name, payload and error, so a UI can show players their own refusals.

A schema validates a payload's shape. Whether an entity id in it is still alive, or belongs to the player who sent it, is for the handler to check.

## Actions issued by the game

A system, script or handler issues actions through the `Actions` service, so bots follow the same rules as players:

```ts sketch
(yield * Action.Actions).enqueue(Strike, { attacker, target });
```

The action is applied at the start of the next tick. The service's `handles(action)` reports whether the game has a handler for an action; `enqueue` throws without one.

Actions the simulation issues itself aren't logged, because a replay's own systems issue them again. That's why a system never calls `app.enqueue`: the action would be logged, and a replay would apply it twice.

The frame and input stages work the other way round. They are outside the simulation and a replay runs neither, so what their systems issue with `Actions.enqueue` is logged, like a key press or a UI button.

## Actions as data

Input that arrives as JSON goes through `app.dispatchByName(name, json)` or `app.enqueueByName(name, json)`. An unknown name or an invalid payload is a failure, `Action.UnknownAction` or `Action.InvalidPayload`, or an `Action.Rejected` event, never a crash.

Both accept the issuer as a third argument, for a program that relays actions on someone else's behalf, such as a server for its clients: `app.enqueueByName(name, json, client)`.

`app.actionLog` holds every action from outside the simulation, in JSON form, with checkpoints of the world's hash among them. `Action.encodeLog` and `Action.decodeLog` convert it to text and back. See [replays](replays.md).

## Read more

- [`Event`](/reference/arcadekit/Event) and [`Action`](/reference/arcadekit/Action) in the API reference.
- [`examples/duel.ts`](../../../../../packages/arcadekit/examples/duel.ts), a turn-based game built on actions.
