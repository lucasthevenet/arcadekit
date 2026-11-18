---
title: "Lockstep and rollback"
description: "A session joins one app to the other peers of a game. This guide covers making a lockstep or a rollback session, stepping it, and what a game must do to be played this way."
---

A session joins one app to the other peers of a game. This guide covers making a lockstep or a rollback session, stepping it, and what a game must do to be played this way. [Several players](../concepts/several-players.md) explains the idea.

## A lockstep session

```ts
import { Action, App, Lockstep, Plugin } from "arcadekit";
import { Effect, Schema } from "effect";

const Move = Action.define("game/Move", Schema.Struct({ dx: Schema.Int }));
const move = Action.handler(Move, function* ({ dx }, { from }) {
  // `from` is the peer that issued it: "ada" or "grace"
});
const Game = Plugin.make("game/Game", { handlers: [move] });

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game], seed: 1 });
  const session = Lockstep.make(app, {
    peer: "ada", // this machine's player
    peers: ["ada", "grace"], // everyone: the same names on every machine
    delta: 1 / 60, // the seconds a tick simulates, the same everywhere
  });

  app.enqueue(Move, { dx: 1 }); // as in a game of one

  const send = (message: Lockstep.Message) => {};
  session.tick(); // true if the tick ran, false if it waits for a peer
  for (const message of session.outgoing()) {
    send(message); // to every other peer
  }
}).pipe(Effect.scoped);
```

What arrives from another peer goes to `session.receive(message)`. Usually a [transport](transports-and-relays.md) does both halves and a driver steps it, so a game never calls these itself. One that carries its messages some other way turns each into text and back with `Lockstep.encode` and `Lockstep.decode`, the second as an `Exit` that refuses what isn't a message.

- Every peer is made alike: the same plugins, the same seed, the same `delta`, the same names, the same state to start from. A session begins at whatever tick its app is at, so a game can start from a save every peer loaded.
- `delay` is how many ticks ahead a player's own action is sent, 2 unless told. A player sees their own move that much later, and a network slower than that slows the game to its pace. Each peer may have its own.
- There is one message from every peer for every tick, empty more often than not: it is also how a peer says it has nothing more for that tick.
- Messages may arrive in any order and more than once. One that is held already, is for a tick that has run, or comes from a name that is no peer of the game is dropped. Every message has to arrive in the end.
- `session.waitingFor` names the peers a tick waits for.
- A tick hears the devices first, as an app's own does. A key pressed while the peer waits for another is in its next message.

## A rollback session

```ts sketch
const session = Rollback.make(app, {
  peer: "ada",
  peers: ["ada", "grace"],
  delta: 1 / 60,
  ahead: 8, // how many ticks it may run past what every peer has said
});
```

A rollback session runs each tick at once, guessing that the peers it hasn't heard from did nothing. When a message proves a guess wrong, it goes back with `app.rewind` to a moment it captured and runs forward again.

- A player's own move is applied on the next tick: `delay` is 0 unless told. A delay of a tick or two spares the other peers a rewind for every move, for that much lag on one's own.
- `ahead` is how far it may run past what every peer has said, 8 ticks unless told, and the furthest a rewind goes back. A peer that far ahead waits, and `session.waitingFor` says for whom.
- `session.confirmed` is how many ticks are final: what is after it may still be run another way. `session.rewinds` and `session.resimulated` count the cost.
- A message that says nothing for a tick that has run costs nothing: the guess was right.
- The peers end the same game. Every peer applies every action on the tick it is stamped with, whenever it heard of it, and its log replays into a game of one that never went back.
- A peer may see a move accepted that is then refused. Two players who take the same coin on the same tick each see themselves take it until the other's message arrives. Then both have the one whose name comes first take it, and the other's take is refused, in the log and in the world.

Before a tick it isn't sure of, the session keeps the game as it is with `app.capture()`, and lets go of it once every peer has spoken for that tick: `session.kept` of them at a time, never more than `ahead`.

- A tick every peer has spoken for isn't captured, so a fast network pays nothing.
- Each is a snapshot of the whole world, and going back loads one. For a very large world that is the cost of every such tick: nothing keeps only what changed.
- When the game can't be captured, because a field holds a value no snapshot can hold, the tick isn't run and `session.tickExit()` fails with `Save.SaveRefused`.

## Driving a session

A session takes its app over: `app.tick` and `app.dispatch` throw from then on, since either would move one machine's game alone. A driver is given the session in the app's place, and draws the game through it. One at another rate than the session's `delta` is refused:

```ts sketch
const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game], seed });
  const session = Rollback.make(app, { peer, peers, delta: 1 / 60 });
  return yield* Driver.frames(yield* Transport.connect(session), { hz: 60 });
}).pipe(
  Effect.scoped,
  Effect.provide(Transport.layerBroadcastChannel("game/room-7"))
);
```

Keys, the UI and `app.enqueue` all go into this peer's next message. A game issues its input the same way it does with one player.

## What a game must do

- **Check `from`, not the payload.** A handler is told which peer issued an action. Who may do a thing is checked against that, never against a name in the payload. See [who issued it](events-and-actions.md#who-issued-it).
- **Give every action a schema.** An action defined with a type alone can't be sent to the other peers, and enqueuing one throws.
- **Enqueue only what the schema accepts.** A payload its schema refuses has no JSON form to send. It is refused on the peer that issued it alone, as an `Action.Rejected` the others never hear of. A system that reads that event and writes what it read has the peers come apart.
- **Keep what the simulation reads in the world.** A rewind puts back the world and what waits in the app, and nothing else. With rollback, do in a system what a script would do, or keep the script's place in the world.
  - Each plugin's `scripts` start again from their beginning, and a script started by hand is stopped. One that keeps its place in its own variables plays its part twice, on the peer that went back and not on the one that didn't: the peers come apart, and the report says at which tick, not why.
  - What a service of the game's own holds isn't put back, and nothing tells it the game went back: a count kept in a layer goes on from the future that was given up.
  - A `Field.transient` field is undefined afterwards, as in a loaded game.
- **Expect the frame stage to run twice.** A game played with rollback is drawn and heard as it is predicted. The frame stage hears the events of a tick that is run again a second time, and its change queries visit everything after each rewind: a sound may play twice, and a UI is told of a score that is then taken back. Nothing tells what draws which ticks are final but `session.confirmed`.

## Going back to a moment

What a rollback session goes back with is the app's own, for a session of another kind or a tool:

```ts
import { App, Plugin } from "arcadekit";
import { Effect, Exit } from "effect";

const Game = Plugin.make("game/Game", {});

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game] });
  const moment = app.capture(); // Exit<App.Moment, Save.SaveRefused>
  app.tick(1 / 60);
  if (Exit.isSuccess(moment)) {
    app.rewind(moment.value); // the same app, as it was
  }
}).pipe(Effect.scoped);
```

- A moment holds what a [save](saving-and-loading.md) does: the world, the game's time, the actions waiting for the next tick, the events waiting to be read with everyone's place in them, what change queries had yet to visit, and how long the log was. `rewind` puts all of it back in place and cuts the log back. The app, its world and its services are the ones they were.
- It is kept in memory and is of one app in one run of the program. What is waiting needs no schema, so a game with an action or an event of a type alone can be captured where it can't be saved.
- A game is captured and put back between ticks. What a rewind doesn't put back is what the rules above keep out of the simulation's way.

## When peers come apart

Each peer tells the others the [checkpoints](replays.md#checkpoints) its log records, the world's hash at a tick, in the messages it sends anyway. When every peer has said its hash for a tick and they differ, every session stops with `Lockstep.Drifted`. `session.tick()` throws it, which stops a driver, `session.tickExit()` fails with it, as does every tick after, and `session.drifted` keeps it for a UI to show.

- The report says the tick, every peer's hash by name, so that with three or more the one that isn't as the others stands out, and `agreedAt`, the last tick they were the same. With a checkpoint every tick that is the tick before they came apart.
- It is found within a known number of ticks, however slow the network. No lockstep peer runs more than `checkpointEvery - 1 + delay` ticks past the first whose world differed, `delay` being the largest any peer has: with a checkpoint every tick and a delay of 2, two ticks. A rollback peer runs at most `2 × ahead` ticks more, since a tick's hash is sent once every peer has spoken for it.
- The state the peers start from is compared first, whatever `checkpointEvery` is: a session records a checkpoint when it begins. Lockstep peers made with another seed, or with something else spawned at the start, never run a tick, and the report says they didn't start from the same state.
- After that the peers compare what their logs record: every 60 ticks unless the app was told otherwise, and with `checkpointEvery: 0` nothing more. Peers with different schedules compare the ticks both record, and a checkpoint one peer takes by hand, `app.checkpoint()`, isn't held against the others.
- A peer that stops says its hash first, so the others stop with the same report in place of waiting for it.
- A checkpoint costs a message 30 bytes or so. The hash is the one the app takes for its log anyway.

Not everything that makes peers alike is compared. Another `delta`, a system one peer lacks, or another list of names is found only once it has changed a world, at the checkpoint after. A list of names that leaves a peer out is never found, since that peer isn't heard. And what the hash doesn't cover is found only when it [reaches the world](../concepts/several-players.md#peers-that-come-apart).

Nothing brings peers back together. A game that wants to go on has every peer load one peer's save and makes its sessions again.

## Read more

- [`Lockstep`](/reference/arcadekit/Lockstep) and [`Rollback`](/reference/arcadekit/Rollback) in the API reference.
