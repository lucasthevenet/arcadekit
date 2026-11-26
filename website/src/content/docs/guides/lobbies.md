---
title: "Lobbies"
description: "A lobby is where the peers of a game meet before it begins. Learn how peers that know only a room agree on who plays, a seed and the game's settings, and start the same game."
---

A **lobby** is where the peers of a game meet before it begins. Peers that know only the room agree there on who plays, a seed and the game's settings, and each makes its [session](sessions.md) from what they agreed, so every peer begins the same game.

## Meet in a lobby

```ts
import { App, Driver, Plugin } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Lobby, Relay, Session, Transport } from "arcadekit/net";
import { Effect, Schema } from "effect";

const Duel = App.define({ plugins: [Plugin.make("game/Game", {})] });
const Settings = Schema.Struct({ map: Schema.String });

// Only the room is the page's: the peer names itself, and gives no seed.
const room = new URLSearchParams(location.search).get("room") ?? "lobby";
const me = crypto.randomUUID().slice(0, 8);

const program = Driver.run(
  Effect.gen(function* () {
    const lobby = yield* Lobby.join({ me, players: 2, settings: Settings });
    yield* lobby.set({ map: "dunes" }); // any peer may, and the last set wins
    yield* lobby.ready(); // ready for these settings, with whoever is here
    const start = yield* lobby.start; // { me, others, seed, settings }
    const session = yield* Session.make(Duel, { ...start, hz: 60 });
    return yield* lobby.connect(session);
  })
).pipe(
  Effect.provide(
    Transport.layerWebSocket(
      Relay.address("wss://relay.example.com/rooms", { room, peer: me })
    )
  )
);

Browser.runMain(program, { target: document.querySelector("canvas")! });
```

`Lobby.join` listens on the program's transport, and the lobby says what it has to say to the others as a `Message.Aside`, which a relay passes on as it passes on a message. `lobby.start` waits until the lobby holds `players` peers and each is ready for the settings set last, and succeeds with what they agreed, in the words `Session.make` takes.

| Option | Default | What it does |
| --- | --- | --- |
| `me` |  | This peer's name, as its transport gives it to the others |
| `players` |  | How many peers play. The game begins with that many |
| `settings` | none | The schema of the game's settings. With one, the game begins only once a peer has set them. Without one, `start.settings` is `undefined` |

- A peer may set the settings at any time before the game begins, and the settings set last win, the same on every peer. A change of the settings takes back every peer's word that it is ready, so `lobby.ready()` is called again for the new ones.
- `lobby.members` lists who is in the lobby, and `lobby.waitingFor` who isn't ready for the settings set last. A peer that leaves is out of the lobby, and one that comes later takes the seat.
- Every peer gives a part of the seed, and the seed is a hash of every player's part and the settings, so no one peer chooses it.
- A peer that joins a room whose game has begun without it fails with `Lobby.Full`, caught by its tag, `"LobbyFull"`.

## Connect the session through the lobby

`lobby.connect(session)` connects the session as `Transport.connect` does, over the lobby's own channel. It hands the session what the other players' sessions sent while this peer was still in the lobby, since a peer that hears the last word begins a moment before the others. A second `Transport.connect` on the program's transport would open a second socket under the same name, which a relay refuses with `Transport.Closed`. `lobby.connect` dies for a session made from anything but the lobby's start.

## What every peer agrees on

The game begins on every peer with the same names, seed and settings, before its first tick, and the sessions check it as they check any game: peers with other names stop with `Drift.Unlike`, and peers with another seed or other settings with `Drift.Drifted` on the state they begin from. See [detecting drift](detecting-drift.md).

- A peer that joins or leaves in the moment the last player says it is ready can see the lobby otherwise than the others. A peer that hears a player began takes that player's word for whom it began with.
- The lobby is outside the game. Nothing of it is in the world, a save or a replay: a game that uses its settings builds them into the world as it begins, from `start.settings`.

## Read more

- [Sessions](sessions.md) and [transports and relays](transports-and-relays.md).
- [`Lobby`](/reference/arcadekit/net/Lobby) and [`Message`](/reference/arcadekit/net/Message) in the API reference.
