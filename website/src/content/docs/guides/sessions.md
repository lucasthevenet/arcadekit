---
title: "Sessions"
description: "A session is one peer of a game played on several machines. Learn how to make a session, how far it runs ahead of the network, how to drive it, and what your game must do to play online."
---

A **session** is one peer of a game played on several machines. It makes its app, steps it, and exchanges with the other peers what their players do. [Several players](../concepts/several-players.md) explains the model, and [detecting drift](detecting-drift.md) covers peers that end up with different games.

## Make a session

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
  const session = yield* Effect.acquireRelease(
    Session.make(Duel, {
      seed: 1, // or a save: how the game starts, as App.make takes it
      me: "ada", // this machine's player
      others: ["grace"], // everyone else: grace's machine has me: "grace", others: ["ada"]
      hz: 60, // the ticks a second, the same everywhere
    }),
    (made) => made.close // closes its app with the program's scope
  );

  yield* session.app.enqueue(Move, { dx: 1 }); // as in a single-player game

  const send = (message: Message.Message) => {};
  yield* session.tick(); // true if the tick ran, false if it is waiting for a peer
  for (const message of session.outgoing()) {
    send(message); // to every other peer
  }
}).pipe(Effect.scoped);
```

Everything a multiplayer game needs is in `arcadekit/net`, not in `arcadekit`, so a single-player game loads none of it. `Session.make` takes the game, as `App.make` does, and makes the session's app with it. `session.app` has no `tick` and no `dispatch`, since either would move this machine's game alone, so stepping it yourself doesn't compile. Its world, its `enqueue`, its saves and its recordings are an app's. It has no `close` either. `session.close` closes it, as `app.close` closes an app.

Pass each message from another peer to `session.receive(message)`. Usually a [transport](transports-and-relays.md) carries messages both ways and a driver steps the session, so your game never calls these itself. To carry messages some other way, turn them into bytes with `Message.encode` and back with `Message.decode`. Each returns an `Exit`, which fails with `Message.Invalid` for what isn't a message.

- A game begins with its peers agreeing on who plays, a seed and its settings, in a [lobby](lobbies.md): `Session.make(Duel, { ...start, hz: 60 })` with what `lobby.start` succeeds with.
- Make every peer alike: the same game, the same seed or save, the same `hz` and the same peer names. A peer made with another game, `hz`, names or starting tick stops every peer with `Drift.Unlike`. A different seed shows as `Drift.Drifted`. See [detecting drift](detecting-drift.md).
- A session begins at whatever tick its app does, so a game can start from a save that every peer loaded.
- Give each peer its own name as `me`, and every other peer's name in `others`, in any order. A name given twice, as `me` and in `others` or twice in `others`, doesn't compile when the compiler knows the names. When it knows them only as strings, `Session.make` throws.
- Every peer sends one message per tick, usually empty, which tells the others it has nothing more for that tick.
- Messages can arrive in any order and more than once. A duplicate, or a message from a name that isn't one of the other peers, is dropped. A message with actions for a tick that ran without them makes the session rewind and run that tick again, as [run ahead of the network](#run-ahead-of-the-network) shows.
- `session.waitingFor` names the peers the next tick is waiting for. The peers are fixed, and every message must arrive. [A session needs every peer on every tick](../concepts/several-players.md#a-session-needs-every-peer-on-every-tick) explains why.
- A session's tick runs the input stage first, as a driver does before an app's tick. A key pressed while the peer waits for another goes into its next message.

## Run ahead of the network

```ts sketch
const session =
  yield *
  Session.make(Duel, {
    seed: 1,
    me: "ada",
    others: ["grace"],
    hz: 60,
    delay: 0, // how many ticks pass before a player's own action applies
    ahead: 8, // how many ticks it may run past what every peer has sent
  });
```

A session runs ahead with [rollback](../concepts/several-players.md#rollback-predicts-and-rewinds) by default. Two options say how far it sends and runs ahead:

| Option | Default | What it does |
| --- | --- | --- |
| `ahead` | `8` | How many ticks the session may run past what every peer has sent. It is also the furthest a rewind goes back. With `0`, the session predicts nothing, captures nothing and never rewinds. It plays in lockstep, and runs a tick only once every peer has sent its actions for it |
| `delay` | `0`, or `2` when `ahead` is `0` | How many ticks pass between issuing an action and applying it. Each peer can use its own value |

- A peer that has run `ahead` ticks past what every peer has sent waits, and `session.waitingFor` says for whom.
- A delay of a tick or two spares the other peers a rewind for every move, at the cost of that much input lag for the local player. In lockstep, a delay of 0 would wait for the network on every tick, and a network slower than `delay` slows the game to its pace.
- `session.confirmed` is the number of final ticks. Any later tick may still be resimulated. `session.stats.rewinds` and `session.stats.resimulated` measure the cost.
- A message with no actions for a tick that already ran costs nothing, since the prediction was right.

Before each tick it isn't sure of, the session captures the game with [`Timeline.capture`](capturing-and-rewinding.md). It releases the capture once every peer has sent their actions for that tick. `session.stats.kept` is the number of captures it holds, never more than `ahead`. `session.stats` holds what a debug overlay shows beside it: the messages held, those some peer hasn't heard, the checkpoints waiting for an answer, the rewinds and the ticks resimulated.

- A tick every peer has already sent actions for isn't captured, so a fast network costs nothing.
- Each capture is a snapshot of the whole world, and a rewind loads one. A very large world pays that cost on each uncertain tick.
- When the game can't be captured, because a field holds a value no snapshot can store, the tick doesn't run, and `session.tick()` fails with `Save.Refused`.

## Drive a session

```ts
import { App, Driver, Plugin } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Relay, Session, Transport } from "arcadekit/net";
import { Effect, Schedule } from "effect";

const Duel = App.define({ plugins: [Plugin.make("game/Game", {})] });
const status = document.querySelector("#status")!;
const say = (text: string) =>
  Effect.sync(() => {
    status.textContent = text;
  });

const program = Driver.run(
  Effect.gen(function* () {
    const session = yield* Session.make(Duel, {
      seed: 1,
      me: "ada",
      others: ["grace"],
      hz: 60,
    });
    return yield* Transport.connect(session);
  }),
  {
    // Handed the connection before the first frame. What it forks lasts
    // as long as the run.
    ready: (online) =>
      Effect.forkScoped(
        Effect.repeat(
          Effect.suspend(() =>
            say(
              online.waitingFor.length === 0
                ? ""
                : `Waiting for ${online.waitingFor.join(", ")}`
            )
          ),
          Schedule.spaced("250 millis")
        )
      ),
  }
).pipe(
  Effect.catchTags({
    DriftDrifted: (drifted) =>
      say(`The game went out of sync at tick ${drifted.tick}.`),
    TransportLeft: (left) => say(`${left.peers.join(", ")} left the game.`),
  }),
  Effect.provide(
    Transport.layerWebSocket(
      Relay.address("wss://relay.example.com/rooms", {
        room: "blue",
        peer: "ada",
      })
    )
  )
);

Browser.runMain(program, { target: document.querySelector("canvas")! });
```

`Transport.connect` connects the session to a transport and returns the session connected, which a driver steps in the session's place. The driver ticks it `hz` times a second, the rate every peer is made with, and draws the game through it. A driver of a session takes neither `hz` nor `ticks`, and giving it either doesn't compile.

- The connection is the session and more: its `app`, `waitingFor`, `confirmed`, `drifted` and `stats` are the session's, and `away` lists the peers the transport said left. `Driver.run` hands it to `ready`, where a page reads what to show the player.
- What ends the game is a failure of `Driver.run`, caught by its tag: `"DriftDrifted"` and `"DriftUnlike"` for peers that are [no longer playing one game](detecting-drift.md), `"TransportLeft"` for a peer that stayed away, `"TransportClosed"` for a socket closed for good, and `"SaveRefused"` for a game that can't be captured.
- Its `close` stops listening on the transport and closes the session. `Driver.run` closes it when it ends, as it closes an app.
- Key presses, the UI and `session.app.enqueue` all feed this peer's next message, as in a single-player game.
- `session.tick()` takes no delta. Each tick simulates `1 / hz` seconds.

## Keep peers in step

Two machines' clocks never run at quite the same rate. A peer whose clock runs fast would run ahead of the others until it had to wait for them, and they would rewind for each of its moves. `session.lead` says how many ticks a peer is ahead of the peer furthest behind it, from the messages that arrived. Each peer says in its messages how far ahead it found itself, so the time a message takes cancels out.

A driver runs a session's ticks at half their rate while its `lead` is 2 or more, so the others catch up. A program that steps a session by hand reads `session.lead` and waits a tick itself.

## Prepare a game for online play

- **Check `from`, not the payload.** A handler receives the peer that issued an action. Check permissions against `from`, never against a name in the payload. See [check who issued an action](events-and-actions.md#check-who-issued-an-action).
- **Keep everything the simulation reads in the world.** A rewind restores the world and the app's pending work, and nothing else.
  - A variable of a module that a system reads isn't restored, and nothing tells it the game rewound. A counter kept there goes on from the future that the rewind gave up. A tick system can't require a service of your own, which could keep such state. `Session.syncTest` runs each tick twice from the same moment, and names the first system that ran differently. See [testing several peers](testing-peers.md#check-that-a-rewind-runs-the-same).
  - A `Field.transient` field is `undefined` afterwards where something changed its table since the moment, and keeps its value elsewhere. See [capturing and rewinding](capturing-and-rewinding.md).
- **Expect the frame stage to show a prediction.** A game that runs ahead is drawn and heard as predicted.
  - The frame and input stages hear each event once, however often a session runs its tick. An event that a resimulated tick emits again, with the same payload, isn't heard twice. Only what the tick now does differently is heard.
  - After each rewind, their change queries visit only the entities that the given-up ticks or the ticks run again changed, spawned or despawned.
  - A sound for a prediction that is rolled back has already played, and a UI may show a score that is then rolled back. `session.confirmed` tells rendering code which ticks are final.

## Read more

- [Detecting drift](detecting-drift.md), [capturing and rewinding](capturing-and-rewinding.md), and [transports and relays](transports-and-relays.md).
- [`arcadekit/net`](/reference/arcadekit/net) in the API reference: [`Session`](/reference/arcadekit/net/Session), [`Message`](/reference/arcadekit/net/Message) and [`Drift`](/reference/arcadekit/net/Drift).
