---
title: "Sessions"
description: "A session is one peer of a game played on several machines. Learn how to make a session, how far it runs ahead of the network, how to drive it, and what your game must do to play online."
---

A **session** is one peer of a game played on several machines: it makes its app, steps it, and exchanges with the other peers what their players do. This guide covers making a session, how far it runs ahead of the network, driving it, and what your game must do to be played this way. [Several players](../concepts/several-players.md) explains the model, and [detecting drift](detecting-drift.md) covers peers that end up with different games.

## Making a session

```ts
import { Action, App, Plugin } from "arcadekit";
import { Message, Session } from "arcadekit/net";
import { Effect, Schema } from "effect";

const Move = Action.define("game/Move", Schema.Struct({ dx: Schema.Int }));
const move = Action.handler(Move, function* ({ dx }, { from }) {
  // `from` is the peer that issued it: "ada" or "grace"
});
const Game = Plugin.make("game/Game", { handlers: [move] });
const Duel = App.define({ plugins: [Game] });

const program = Effect.gen(function* () {
  const session = yield* Session.make(Duel, {
    seed: 1, // or a save: how the game starts, as App.make takes it
    me: "ada", // this machine's player
    others: ["grace"], // everyone else: grace's machine has me: "grace", others: ["ada"]
    delta: 1 / 60, // the seconds a tick simulates, the same everywhere
  });

  session.app.enqueue(Move, { dx: 1 }); // as in a single-player game

  const send = (message: Message.Message) => {};
  session.tick(); // true if the tick ran, false if it is waiting for a peer
  for (const message of session.outgoing()) {
    send(message); // to every other peer
  }
}).pipe(Effect.scoped);
```

What a game played on several machines needs is in `arcadekit/net`, and none of it is in `arcadekit` itself, so a game with one player loads none of it. `Session.make` takes the game, as `App.make` does, and makes the session's app with it. `session.app` is that app without what would move this machine's game alone: it has no `tick` and no `dispatch`, so stepping it yourself doesn't compile. Its world, its `enqueue`, its saves and its recordings are an app's.

Messages from other peers go to `session.receive(message)`. Usually a [transport](transports-and-relays.md) handles both directions and a driver steps the session, so your game never calls these itself. If you carry messages some other way, `Message.encode` and `Message.decode` convert them to text and back, the latter returning an `Exit` that rejects anything that isn't a message.

- Every peer must be made identically: the same game, the same seed or save, the same `delta`, the same peer names, the same starting state. A session begins at whatever tick its app does, so a game can start from a save every peer loaded.
- Each peer is given its own name as `me`, and every other peer's in `others`, in any order. A name given twice, as `me` and among `others` or twice among `others`, doesn't compile when the compiler knows the names, and `Session.make` throws when it knows them only as strings.
- Every peer sends one message per tick, usually empty: it is also how a peer says it has nothing more for that tick.
- Messages can arrive in any order and more than once. A duplicate, a message for a tick that already ran, or one from a name that isn't a peer of the game is dropped. Every message must eventually arrive.
- A session's peers are fixed when it is made. `session.waitingFor` names the peers a tick is waiting for, and a peer that stops is waited for.
- A session's tick runs the input stage first, as a driver does before an app's tick. A key pressed while the peer waits for another goes into its next message.

## Running ahead of the network

```ts sketch
const session =
  yield *
  Session.make(Duel, {
    seed: 1,
    me: "ada",
    others: ["grace"],
    delta: 1 / 60,
    delay: 0, // how many ticks pass before a player's own action applies
    ahead: 8, // how many ticks it may run past what every peer has sent
  });
```

A session runs each tick immediately, predicting that the peers it hasn't heard from did nothing. When a message proves a prediction wrong, it rewinds to a moment it captured, and resimulates. This is rollback.

- `ahead` is how far it may run past what every peer has sent, 8 ticks by default, and also the furthest a rewind goes back. A peer that far ahead waits, and `session.waitingFor` says for whom.
- With `ahead: 0` the session predicts nothing, captures nothing and never rewinds: it runs a tick only once every peer has sent its actions for it. This is lockstep. A network slower than `delay` slows the game to its pace.
- `delay` is how many ticks ahead a player's own action is sent. It defaults to 0, so a player's own move is applied on the next tick, and to 2 for a session whose `ahead` is 0, which would otherwise wait for the network on every tick. A delay of a tick or two spares the other peers a rewind for every move, at the cost of that much input lag for the local player. Each peer can use its own value.
- `session.confirmed` is the number of final ticks: anything after it may still be resimulated. `session.rewinds` and `session.resimulated` measure the cost.
- A message that contains nothing for a tick that already ran costs nothing: the prediction was right.

Before each tick it isn't sure of, the session captures the game with [`Timeline.capture`](capturing-and-rewinding.md), and releases the capture once every peer has sent their actions for that tick: `session.kept` captures at a time, never more than `ahead`.

- A tick every peer has already sent actions for isn't captured, so a fast network costs nothing.
- Each capture is a snapshot of the whole world, and a rewind loads one, so for a very large world each uncertain tick pays that cost.
- When the game can't be captured, because a field holds a value no snapshot can store, the tick doesn't run and `session.tickExit()` fails with `Save.SaveRefused`.

## Driving a session

A session steps its app. Pass the session to a driver, and the driver renders the game through it. The driver ticks it `1 / delta` times a second, the rate every peer is made with, so it takes neither `hz` nor `ticks`, and giving it either doesn't compile:

```ts sketch
const program = Effect.gen(function* () {
  const session = yield* Session.make(Duel, {
    seed,
    me,
    others,
    delta: 1 / 60,
  });
  return yield* Driver.frames(yield* Transport.connect(session));
}).pipe(
  Effect.scoped,
  Effect.provide(Transport.layerBroadcastChannel("game/room-7"))
);
```

Key presses, the UI and `session.app.enqueue` all feed this peer's next message. Your game issues input exactly as it does with one player.

- `session.tick()` takes no delta: each tick simulates the session's `delta`.
- A session never rests: the other peers wait for its message for every tick, so `ticks: "whenNeeded"` is for a game of one.

## Requirements for online play

- **Check `from`, not the payload.** A handler receives the peer that issued an action. Check permissions against `from`, never against a name in the payload. See [who issued an action](events-and-actions.md#who-issued-an-action).
- **Keep everything the simulation reads in the world.** A rewind restores the world and the app's pending work, and nothing else.
  - State kept outside the world, in a variable of a module that a system reads, isn't restored, and nothing tells it the game rewound: a counter kept there continues from the discarded future. The tick can't require a service of your own, which would keep such state. `Session.syncTest` runs each tick twice from the same moment, and names the first system that ran differently. See [testing](testing.md#rewinds).
  - A `Field.transient` field is `undefined` afterwards, as in a loaded game.
- **Expect the frame stage to show a prediction.** A game that runs ahead is drawn and heard as predicted. The frame and input stages hear each event once however often a session runs its tick: an event a resimulated tick emits again, with the same payload, isn't heard twice, and only what the tick now does otherwise is. Their change queries visit everything after each rewind. A sound for a prediction that is rolled back has already played, and a UI may show a score that is then rolled back. `session.confirmed` tells rendering code which ticks are final.

## Read more

- [Detecting drift](detecting-drift.md), [capturing and rewinding](capturing-and-rewinding.md), and [transports and relays](transports-and-relays.md).
- [`arcadekit/net`](/reference/arcadekit/net) in the API reference: [`Session`](/reference/arcadekit/net/Session), [`Message`](/reference/arcadekit/net/Message) and [`Drift`](/reference/arcadekit/net/Drift).
