---
title: "Events and actions"
description: "An event records something the simulation did. An action is a request to change the game. Learn how to use both, and how actions are validated, applied or refused."
---

An **event** records something that happened in the simulation. An **action** is a request to change the game, which its handler validates and then applies or refuses.

## Emit and read an event

```ts
import { Component, EntityId, Event, Field, Query, System } from "arcadekit";
import { Schema } from "effect";

const Body = Component.define("physics/Body", { y: Field.f32 });
const Bodies = Query.all(Body);

const Landed = Event.define(
  "physics/Landed",
  Schema.Struct({ entity: EntityId })
);

const Ground = System.tick("physics/Ground", function* () {
  const landed = yield* Landed.emits;
  (yield* Bodies).each((body, entity) => {
    if (body.y <= 0) {
      landed.emit({ entity }); // a plain call, fine inside a loop
    }
  });
});

const Dust = System.tick("fx/Dust", function* () {
  for (const { entity } of (yield* Landed).read()) {
    // every event this system hasn't seen
  }
});
```

- Every system sees every event exactly once, whatever order systems run in. A system that a condition [switched off](systems.md#run-a-system-only-when-a-condition-holds) hears no event from the ticks it skipped.
- A system reads only what was emitted before it began to run. A system that runs before the emitter therefore sees the event on the next tick, and so does the emitter itself, so the entities its own events name are spawned by the time it reads them.
- An event is dropped once every system has had a chance to read it.
- The frame and input stages also see every event once, however many ticks ran between two frames. Sound and a UI follow the game by reading events there.
- A system never waits for an event. It reads what is there and finishes within its tick.
- Only the simulation emits: a system of the tick, an action handler or a plugin's `setup`. An event is in no log, so emitting from anywhere else throws. Code outside the simulation issues an [action](#define-and-issue-an-action) whose handler emits the event.

An event is a fact, so name it in the past tense, prefixed with its feature, such as `"physics/Landed"`. The name identifies the event within an app. A second, different event with the same name is refused when it is first used.

The payload's type comes from the schema. Emitting validates nothing, so it stays cheap inside a loop. A save uses the schema to store the events waiting to be read. `Event.encode` and `Event.decode` use it to convert a payload to JSON and back, and each returns an `Exit` that fails with `Event.InvalidEvent`. An event with no payload takes only its name, `Event.define("Started")`.

## Define and issue an action

An action is how anything outside the simulation changes the game, such as a player's move, a UI button or a message from another machine.

```ts
import { Action, Commands, EntityId, World } from "arcadekit";
import { Effect, Schema } from "effect";

class NoSuchFighter extends Schema.TaggedError<NoSuchFighter>()(
  "NoSuchFighter",
  {}
) {}

const Strike = Action.define(
  "duel/Strike",
  Schema.Struct({ attacker: EntityId, target: EntityId }),
  { error: NoSuchFighter }
);

const strike = Action.handler(Strike, function* ({ attacker, target }) {
  const world = yield* World;
  if (!world.isAlive(attacker) || !world.isAlive(target)) {
    return yield* NoSuchFighter.make({});
  }
  (yield* Commands).despawn(target);
});
```

List the handler in a plugin's `handlers`. The app then accepts the action in two ways:

- **`app.dispatch(Strike, payload)`** applies it immediately and returns an `Exit`, with the handler's result or why it was refused. Use it for turn-based input.
- **`app.enqueue(Strike, payload)`** queues it for the start of the next tick, where a refusal becomes an `Action.Rejected` event. Use it for real-time input. A payload the schema refuses is refused at once. `enqueue` then returns an `Exit` that fails with `Action.InvalidPayload`, and nothing is queued or logged.

Dispatching an action that has no handler, or with the wrong payload, is a compile error.

Both are for code outside the simulation, such as the entry point, the network or a test. They are the only way such code changes the game, because an app has no world to write and `app.read` takes nothing that writes. Everything that changes a game from outside is therefore logged, and a [replay](replays.md) reproduces it.

- `dispatch` works only between ticks. It throws during a tick, during the frame or input stage, and from a handler.
- In a multiplayer game, use `enqueue` only. On an app a session has taken over, `dispatch` throws, because it would change this machine's game alone. See [sessions](sessions.md).

The payload's type comes from the schema. Its JSON encoding is what the log and saves store, and what other peers receive. Bigints and dates in a payload are converted along the way. An action with no payload takes only its name, `Action.define("Pass")`, is issued with `undefined`, and is logged as `null`.

## Check and refuse an action

Before the handler runs, the app validates the payload against the schema, including refinements the compiler can't see, such as a number between 1 and 10. A mismatch fails with `Action.InvalidPayload`.

The handler checks the game's rules and refuses with a typed error, a tagged class made with `Schema.TaggedError`. Fail with it and return, as in `return yield* NoSuchFighter.make({})`. Without the `return`, TypeScript doesn't know that the code below is unreachable. The caller handles the refusal by its tag, and the `Exit`'s type lists the possible errors. Give each error its own tag, because two classes with the same tag are caught as one, with no warning.

The action declares the schema of its error in `Action.define`, as `{ error: NoSuchFighter }`, or `{ error: Schema.Union([NoSuchFighter, NotYourTurn]) }` for several. An action without one can't be refused. A handler that fails with an error outside the schema doesn't compile, and the compiler names the error. The schema gives a refusal its JSON form, so every peer and a save hold the same refusal. Each error has a `_tag`, as a `Schema.TaggedError` or a `Schema.TaggedStruct` has, and a schema without one doesn't compile. An action with no payload and an error takes `Schema.Void` as its payload.

A refusal changes nothing, even after the handler has written to the world, so a handler can check as it goes. A refusal rolls back:

- its writes to components, and the random numbers it drew
- the commands it queued, and the ids of the entities they would have spawned, so the next entities get the ids they would have had
- the events it emitted and the actions it enqueued
- its position in the events it read and in its change queries, so the next action sees what this one saw

The same applies to a handler that dies from a bug halfway through. A refused action isn't logged, so a replay never runs it. Anything it left behind would therefore make the replay diverge. A bug isn't a refusal, though: a queued action whose handler dies fails the tick, as a system that dies does, and `app.tick` throws once the tick's other actions and systems have run.

A refusal doesn't roll back anything outside the world, such as a module variable the handler changed. A field's value is read-only, so a handler replaces it, and a refusal puts the old value back. A fiber the handler forks ends with the handler. A fiber that would outlive it makes `dispatch` throw, with the handler's changes undone. A refusal also doesn't undo a write forced through a raw column of a component the query [only reads](queries.md#name-what-a-query-writes), which only an app made with `verifyFrames` refuses.

A handler follows a few rules of its own:

- It finishes at once, and doesn't wait.
- It changes which entities exist through `Commands`, and sets a component of one entity through `World.writes`. See [create and change entities](components.md#create-and-change-entities).
- It reads its own writes while it runs.
- It can't dispatch another action. It issues one with `Actions.enqueue`, and a refusal rolls that back too.

An accepted action costs one copy of what it is about to write, and no copy back. A `world.set` copies one row, in about 0.2 µs. A loop copies the columns of the query's terms in each table it visits, except the terms it only reads. With the storage core alone, code uses the same mechanism: `world.begin()`, then `world.commit()` or `world.rollback()`.

## Check who issued an action

A handler receives the action's origin alongside the payload:

```ts sketch
const pass = Action.handler(Pass, function* (_, { from }) {
  const turn = yield* Turn;
  if (turn.player !== from) {
    return yield* NotYourTurn.make({});
  }
  /* … */
});
```

In a multiplayer game, `from` is the name of the peer that issued the action, the same on every peer. In a single-player game it is `undefined`, as it is for actions the simulation issues itself. Check permissions against `from`, never against a name in the payload, which the sender controls.

The log and a save keep `from` for queued actions, and so does a refusal of one, so a UI can show players their own refusals.

## Read the refusals of an action

A queued action that is refused becomes an event. `Action.rejected(action)` is the event of one action's refusals, with its payload and its error typed:

```ts sketch
const Refusals = System.frame("ui/Refusals", function* () {
  for (const { error, from } of (yield* Action.rejected(Strike)).read()) {
    if (error._tag === "NoSuchFighter") {
      /* … */
    }
  }
});
```

Each refusal is `{ payload, error, from }`: the payload the handler received, an error the action's schema takes, and who issued it. A payload that the action's schema doesn't take never reaches the handler, and isn't among them.

`Action.Rejected` is the event of every refusal, whatever the action. It carries the action's name, its payload in JSON form, the error in JSON form with its `_tag`, and `from`. Its error is a refusal the action declares, `Action.InvalidPayload` for a payload the schema doesn't take, or `Action.UnknownAction` for an action the game has no handler for.

A schema validates only a payload's shape. Have the handler check whether an entity id in the payload is still alive, and whether it belongs to the player who sent it.

## Issue an action from the game

A system or a handler issues actions through the `Actions` service, so bots follow the same rules as players:

```ts sketch
const Bot = System.tick("game/Bot", function* () {
  (yield* Action.Actions).enqueue(Strike, { attacker, target });
});
```

The action is applied at the start of the next tick. The service's `handles(action)` reports whether the game has a handler for an action, and `enqueue` throws without one.

`Actions.enqueue` and `app.enqueue` are the same, and where they are called decides whether the action is logged. From a tick, a handler or a plugin's `setup`, the action is the simulation's own. It isn't logged, because a replay's own systems issue it again. Between ticks, the action is input, like a key press or a UI button, and is logged. The frame and input stages count as between ticks, because they are outside the simulation and a replay runs neither.

## Issue an action from JSON

Input that arrives as JSON goes through `app.dispatchByName(name, json)` or `app.enqueueByName(name, json)`. With `dispatchByName`, an unknown name or an invalid payload fails with `Action.UnknownAction` or `Action.InvalidPayload`. With `enqueueByName`, it becomes an `Action.Rejected` event. Neither crashes the game.

Both accept the issuer as a third argument, for a program that relays actions on someone else's behalf, such as a server for its clients: `app.enqueueByName(name, json, client)`. Don't pass it on an app in a session, where each peer's actions carry that peer's own name.

`app.actionLog` holds every action from outside the simulation, in JSON form, with checkpoints of the world's hash among them. `app.record()` returns the log with how long each tick was. `Journal.encode` and `Journal.decode` convert that recording to bytes and back. See [replays](replays.md).

## Read more

- [`Event`](/reference/arcadekit/Event) and [`Action`](/reference/arcadekit/Action) in the API reference.
- [`examples/duel.ts`](../../../../../packages/arcadekit/examples/duel.ts), a turn-based game built on actions.
