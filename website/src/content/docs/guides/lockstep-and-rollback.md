---
title: "Lockstep and rollback"
description: "A session connects one app to the other peers of a game. Learn how to create lockstep and rollback sessions, drive them, and what your game must do to play online."
---

A **session** connects one app to the other peers of a game. This guide covers creating a lockstep or rollback session, driving it, and what your game must do to be played this way. [Several players](../concepts/several-players.md) explains the model.

## Lockstep sessions

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

  app.enqueue(Move, { dx: 1 }); // as in a single-player game

  const send = (message: Lockstep.Message) => {};
  session.tick(); // true if the tick ran, false if it is waiting for a peer
  for (const message of session.outgoing()) {
    send(message); // to every other peer
  }
}).pipe(Effect.scoped);
```

Messages from other peers go to `session.receive(message)`. Usually a [transport](transports-and-relays.md) handles both directions and a driver steps the session, so your game never calls these itself. If you carry messages some other way, `Lockstep.encode` and `Lockstep.decode` convert them to text and back, the latter returning an `Exit` that rejects anything that isn't a message.

- Every peer must be created identically: the same plugins, the same seed, the same `delta`, the same peer names, the same starting state. A session begins at whatever tick its app is at, so a game can start from a save every peer loaded.
- `delay` is how many ticks ahead a player's own action is sent, 2 by default. A player sees their own move that much later, and a network slower than that slows the game to its pace. Each peer can use its own value.
- Every peer sends one message per tick, usually empty: it is also how a peer says it has nothing more for that tick.
- Messages can arrive in any order and more than once. A duplicate, a message for a tick that already ran, or one from a name that isn't a peer of the game is dropped. Every message must eventually arrive.
- A session's peers are fixed when it is created. `session.waitingFor` names the peers a tick is waiting for, and a peer that stops is waited for.
- A tick reads the devices first, as an app's own tick does. A key pressed while the peer waits for another goes into its next message.

## Rollback sessions

```ts sketch
const session = Rollback.make(app, {
  peer: "ada",
  peers: ["ada", "grace"],
  delta: 1 / 60,
  ahead: 8, // how many ticks it may run past what every peer has sent
});
```

A rollback session runs each tick immediately, predicting that the peers it hasn't heard from did nothing. When a message proves a prediction wrong, it rewinds with `app.rewind` to a moment it captured, and resimulates.

- A player's own move is applied on the next tick: `delay` defaults to 0. A delay of a tick or two spares the other peers a rewind for every move, at the cost of that much input lag for the local player.
- `ahead` is how far it may run past what every peer has sent, 8 ticks by default, and also the furthest a rewind goes back. A peer that far ahead waits, and `session.waitingFor` says for whom.
- `session.confirmed` is the number of final ticks: anything after it may still be resimulated. `session.rewinds` and `session.resimulated` measure the cost.
- A message that contains nothing for a tick that already ran costs nothing: the prediction was right.
- Every peer ends on the same game. Each applies every action on the tick it is stamped with, whenever it heard of it, and its log replays into a single-player game that never rewound.
- A peer may see a move accepted that is later refused. When two players take the same coin on the same tick, each sees themselves take it until the other's message arrives. Then both agree that the player whose name sorts first takes it, and the other's take is refused, in the log and in the world.

Before each tick it isn't sure of, the session captures the game with `app.capture()`, and releases the capture once every peer has sent their actions for that tick: `session.kept` captures at a time, never more than `ahead`.

- A tick every peer has already sent actions for isn't captured, so a fast network costs nothing.
- Each capture is a snapshot of the whole world, and a rewind loads one, so for a very large world each uncertain tick pays that cost.
- When the game can't be captured, because a field holds a value no snapshot can store, the tick doesn't run and `session.tickExit()` fails with `Save.SaveRefused`.

## Driving a session

A session takes over its app: from then on, `app.tick` and `app.dispatch` throw, since either would advance one machine's game alone. Pass the session to a driver in place of the app, and the driver renders the game through it. A driver at a different rate from the session's `delta` is refused:

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

Key presses, the UI and `app.enqueue` all feed this peer's next message. Your game issues input exactly as it does with one player.

## Requirements for online play

- **Check `from`, not the payload.** A handler receives the peer that issued an action. Check permissions against `from`, never against a name in the payload. See [who issued an action](events-and-actions.md#who-issued-an-action).
- **Keep everything the simulation reads in the world.** A rewind restores the world and the app's pending work, and nothing else.
  - State held by your game's own services isn't restored, and nothing tells a service the game rewound: a counter kept in a layer continues from the discarded future. An app made with `verifyRewinds` runs each tick twice from the same moment, and names the first system that ran differently. See [testing](testing.md#rewinds).
  - A `Field.transient` field is `undefined` afterwards, as in a loaded game.
- **Expect the frame stage to show a prediction.** A rollback game is drawn and heard as predicted. The frame and input stages hear each event once across a rewind: an event a resimulated tick emits again, with the same payload, isn't heard twice, and only what the tick now does otherwise is. Their change queries visit everything after each rewind. A sound for a prediction that is rolled back has already played, and a UI may show a score that is then rolled back. `session.confirmed` tells rendering code which ticks are final.

## Capturing and rewinding

The mechanism a rollback session uses is available on the app itself, for other kinds of sessions or for tools:

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

- A moment holds what a [save](saving-and-loading.md) does: the world, the game time, the actions queued for the next tick, the events waiting to be read with every reader's position, what change queries haven't visited, and the log's length. `rewind` restores all of it in place and truncates the log. The app, its world and its services are the same objects as before.
- It lives in memory and belongs to one app in one run of the program. Pending actions and events don't need schemas, so a game with schema-less actions or events can be captured even when it can't be saved.
- A game is captured and rewound between ticks. What a rewind doesn't restore is what the requirements above keep out of the simulation's way.

## When peers drift apart

Each peer sends the others the [checkpoints](replays.md#checkpoints) its log records, the world's hash at a tick, in the messages it sends anyway. When every peer has reported its hash for a tick and they differ, every session stops with `Lockstep.Drifted`. `session.tick()` throws it, which stops a driver; `session.tickExit()` fails with it, as does every later tick; and `session.drifted` keeps it for a UI to display.

- The report includes the tick, every peer's hash by name, so that with three or more peers the odd one out stands out, and `agreedAt`, the last tick they matched. With a checkpoint every tick, that is the tick before they diverged.
- Drift is detected within a bounded number of ticks, however slow the network. No lockstep peer runs more than `checkpointEvery - 1 + delay` ticks past the first tick whose world differed, where `delay` is the largest any peer uses: with a checkpoint every tick and a delay of 2, two ticks. A rollback peer runs at most `2 × ahead` ticks more, since a tick's hash is sent once every peer has sent their actions for it.
- The peers' starting state is compared first, whatever `checkpointEvery` is: a session records a checkpoint when it begins. Lockstep peers created with a different seed, or with different entities spawned at startup, never run a tick, and the report says they didn't start from the same state.
- After that, peers compare what their logs record: every 60 ticks by default, and never with `checkpointEvery: 0`. Peers with different intervals compare the ticks both record, and a checkpoint one peer records by hand with `app.checkpoint()` isn't held against the others.
- A peer that stops sends its hash first, so the others stop with the same report instead of waiting for it.
- A checkpoint adds about 30 bytes to a message. The hash is the one the app already computes for its log.

Not every difference between peers is compared directly. A different `delta`, a system one peer lacks, or a different list of names is only detected once it has changed a world, at the next checkpoint. A list of names that leaves a peer out is never detected, since that peer isn't heard. And what the hash doesn't cover is only detected once it [reaches the world](../concepts/several-players.md#when-peers-drift-apart).

Peers that drift apart stay stopped. To continue, every peer loads one peer's save and creates its sessions again.

## Read more

- [`Lockstep`](/reference/arcadekit/Lockstep) and [`Rollback`](/reference/arcadekit/Rollback) in the API reference.
