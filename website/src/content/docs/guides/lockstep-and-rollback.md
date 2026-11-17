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

What arrives from another peer goes to `session.receive(message)`. Usually a [transport](transports-and-relays.md) does both halves and a driver steps it, so a game never calls these itself.

- Every peer is made alike: the same plugins, the same seed, the same state to start from. A session begins at whatever tick its app is at, so a game can start from a save every peer loaded.
- `delay` is how many ticks ahead a player's own action is sent, 2 unless told. A network slower than that slows the game to its pace.
- Messages may arrive in any order and more than once. Every message has to arrive in the end.
- `session.waitingFor` names the peers a tick waits for.

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

- A player's own move is applied on the next tick: `delay` is 0 unless told.
- `ahead` is how far it may run past what every peer has said, and the furthest a rewind goes back. A peer that far ahead waits.
- `session.confirmed` is how many ticks are final. `session.rewinds` and `session.resimulated` count the cost.
- A message that says nothing for a tick that has run costs nothing.

## Driving a session

A session takes its app over: `app.tick` and `app.dispatch` throw from then on, since either would move one machine's game alone. A driver is given the session in the app's place, and draws the game through it:

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

- **Check `from`, not the payload.** A handler is told which peer issued an action. Who may do a thing is checked against that, never against a name in the payload.
- **Keep what the simulation reads in the world.** A rewind puts back the world and what waits in the app, and nothing else. A script starts again from its beginning, and a service of the game's own isn't put back. With rollback, do in a system what a script would do, or keep the script's place in the world.
- **Expect the frame stage to run twice.** A tick that is run again is drawn and heard again: a sound may play twice. A UI that must show only what is final asks `session.confirmed`.

## When peers come apart

The peers compare the world's hash at their checkpoints. When they differ, every session stops with `Lockstep.Drifted`, which `session.tick()` throws and `session.drifted` keeps for a UI to show. It says the tick, every peer's hash by name, and `agreedAt`, the last tick they were the same. Peers that didn't start from the same state never run a tick.

Nothing brings peers back together. A game that wants to go on has every peer load one peer's save and makes its sessions again.

## Read more

- [More than one player](/reference/arcadekit#more-than-one-player), [rollback](/reference/arcadekit#without-waiting-rollback) and [peers that come apart](/reference/arcadekit#peers-that-come-apart) in the reference.
