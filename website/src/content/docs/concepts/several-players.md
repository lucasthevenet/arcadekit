---
title: "Several players"
description: "Every peer runs the same simulation. Peers exchange only the actions their players issue, each stamped with the tick it applies on."
---

In a multiplayer game, every peer runs the same simulation. Peers exchange only the actions their players issue, each stamped with the tick it applies on. Two machines play the same game when both apply the same actions on the same ticks in the same order.

That is exactly what the action log already records for a single-player game. A **session** is essentially that log, shared between peers.

## Lockstep

A **lockstep** session runs a tick once it has every peer's message for that tick. A player's own action goes into their message for a tick `delay` ticks ahead, 2 by default, so it has time to reach the other peers before anyone needs it. Every peer applies it on that tick, including the one that issued it.

- A tick's actions are applied peer by peer, ordered by peer name, and each peer's actions in the order it issued them, whatever order the messages arrived in. When two players take the same coin on the same tick, every peer resolves it the same way: one gets the coin, and the other is refused with the same `Action.Rejected`.
- A peer that hasn't heard from another waits. A network slower than `delay` slows the game down to its pace.

## Rollback

A **rollback** session doesn't wait. It runs each tick immediately, predicting that peers it hasn't heard from did nothing, which is true for most ticks. When a message arrives for a tick that already ran and it contains actions, the session rewinds to before that tick and resimulates with what it now knows.

Each player sees their own move on the next tick, whatever the network latency. The cost is a rewind whenever a prediction was wrong.

Lockstep is a rollback session that never runs ahead: both share one implementation.

## Sessions take over the app

Once a game joins a session, nothing advances one machine's game alone. `app.enqueue`, a key bound to an action, and a UI button all feed this peer's next message instead of the next tick. Your game issues input the same way with one player or several.

Actions the simulation issues itself with `Actions`, such as a bot's move, aren't sent: every peer's simulation issues them on its own.

Every peer's log is an ordinary log, identical entry for entry across peers, and [`App.replay`](../guides/replays.md) plays it back into a single-player game.

A session holds no socket and no timer. It receives the messages that arrived and returns the ones to send. A `Transport` carries them: between tabs with a `BroadcastChannel`, or between machines through a relay.

A session is created with `app.divert(take)`, which takes over the app's input and returns the only remaining way to queue an action and run a tick. Custom session types use the same call.

## Who issued an action

A handler receives the peer that issued an action, `{ from }`, alongside the payload. The session stamps it from the message the action arrived in, so a move can't claim to be someone else's.

`from` is the sender the message names, and only a relay vouches for it, by holding each peer to the name it connected under. Through a `BroadcastChannel`, or a transport of your own, a peer can send a message in another peer's name. The peers that accepted it and the impersonated peer then hold different games, and stop as drifted peers. Impersonation is detected, not prevented.

## When peers drift apart

Peers exchange the world's hash at their checkpoints. When every peer has reported its hash for a tick and they differ, every session stops with `Lockstep.Drifted`, which reports the tick, each peer's hash, and when they last agreed. A system that reads the clock, `Math.random` or the order of a `Set` is caught within a few ticks. [Determinism](determinism.md) lists what a game must do to stay in sync.

Only the world's hash is compared. A difference the hash doesn't cover is found when it reaches the world, and the report names that tick, not the one it started on: an event waiting on one peer only, a system's own variables, state held in a service.

## Limits of a session

- A session's peers are fixed when it is created, and a peer that stops is waited for. `session.waitingFor` names the peers a tick is waiting for.
- Every message must eventually arrive. A lost message stops the game for everyone, and a dropped socket ends the game for that peer.
- Peers that drift apart stop.
- A session ticks continuously: `ticks: "whenNeeded"` is for single-player games.

## Read more

- [Lockstep and rollback](../guides/lockstep-and-rollback.md) and [transports and relays](../guides/transports-and-relays.md).
- [`Lockstep`](/reference/arcadekit/Lockstep), [`Rollback`](/reference/arcadekit/Rollback), [`Transport`](/reference/arcadekit/Transport) and [`Relay`](/reference/arcadekit/Relay) in the API reference.
