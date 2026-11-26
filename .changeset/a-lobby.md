---
"arcadekit": minor
---

A lobby, `arcadekit/net/Lobby`: peers that know only a room meet there before the game begins, and agree on who plays, a seed and the game's settings. `Lobby.join({ me, players, settings })` listens on the program's transport, `lobby.set` and `lobby.ready()` say what this peer wants, `yield* lobby.start` succeeds with `{ me, others, seed, settings }` for `Session.make`, and `lobby.connect(session)` connects the session over the lobby's channel. Each peer gives a part of the seed, and the seed is a hash of every player's part and the settings, so peers that begin otherwise stop as `Drift.Drifted` before a tick they are sure of. A peer the players began without fails with `Lobby.Full`.

What is not the game's goes between peers as a `Message.Aside`, written by `Message.encodeAside` and read by `Message.decodeAside`. `Relay.forward` passes one on as it passes on a message, and refuses one in another peer's name. `Transport.connect` drops one.

What breaks:

- A `Transport.Listener` sends a `Message.Message` or a `Message.Aside`, and `receive` returns asides too. A listener written by hand that reads what it receives tells an aside by its `topic`.
- `Message.Invalid`'s `problem` may be `"not an aside"`.
- A relay of an earlier arcadekit refuses an aside as `"not a message"`.
