---
"arcadekit": minor
---

A connection is its session: `Transport.connect(session)` returns a `Transport.Connected` that has the session's `app`, `waitingFor`, `confirmed`, `drifted` and `stats` beside `away`, so a page reads what to show the player from what `Driver.run` hands `ready`, and catches a drift or a peer that left from `Driver.run` by its tag. A session says how far ahead of the slowest peer it is, `session.lead`, from an `at` and a `lead` that every message now carries, and a driver runs a session's ticks at half their rate while its lead is 2 or more, so a peer whose clock runs fast neither waits for the others nor makes them rewind.

The names of `arcadekit/net` are fewer. What was merged:

- `net/Peer` is gone, entry and module: `Peer.Peer` is part of `Session.Session`.
- `Transport.OverWire` is gone: `Transport.fromWire(wire)` returns an Effect that listens in the scope it runs in, `Effect<Transport.Listener, never, Scope>`, and stops listening when the scope closes.
- A session's counters are in `session.stats`: `held`, `kept`, `unheard`, `unanswered`, `rewinds` and `resimulated`.
- A session says `hz`, as `Driver.run` does for a game of one, where it said `delta`.

What breaks:

- `Session.make(game, { delta: 1 / 60, ... })` is `Session.make(game, { hz: 60, ... })`, and `session.delta` is `session.hz`. A hand-made `Driver.Paced` has `hz` for `delta`, and may have a `lead`.
- `Message.Made` has `hz` for `delta`, and `Drift.Unlike`'s `differ` names `"hz"` for `"delta"`. A message's bytes are laid out otherwise, so a peer of an earlier arcadekit refuses them.
- `import * as Peer from "arcadekit/net/Peer"` and `Peer.Peer` are `Session.Session` from `arcadekit/net/Session`.
- `session.rewinds`, `session.resimulated`, `session.kept`, `session.held`, `session.unheard` and `session.unanswered` are `session.stats.rewinds` and so on.
- `Transport.layer(Transport.fromWire(wire))` is `Layer.succeed(Transport.Transport, { listen: Transport.fromWire(wire) })`, and `transport.close()` is the scope's close. `transport.dropped` is gone.
- `Transport.connect` takes a whole `Session.Session`, and `Transport.Connected<E, HU>` takes the app's handlers as its second parameter, as a session does.
