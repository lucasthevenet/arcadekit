---
title: "Several players"
description: "Every peer runs the same simulation. Peers exchange only the actions their players issue, each stamped with the tick it applies on."
---

A game with **several players** runs the same simulation on each player's machine, and each machine is a **peer**. Peers exchange only the actions their players issue, each stamped with the tick it applies on. Two machines play the same game when both apply the same actions on the same ticks in the same order.

A single-player game's action log already records exactly that. Each peer plays through a **session**, which shares that log with the other peers.

## Lockstep waits for every peer

A session in **lockstep** runs a tick only once it has every peer's message for that tick. Its `ahead` is 0. A player's own action goes into their message for the tick `delay` ticks ahead, 2 by default in lockstep, so the message has time to reach the other peers before they need it. Every peer applies the action on that tick, the peer that issued it included.

- A tick's actions are applied peer by peer, in the order of the peers' names, and each peer's actions in the order it issued them. The order the messages arrived in doesn't matter. When two players take the same coin on the same tick, every peer resolves it the same way: one player gets the coin, and the other is refused with the same `Action.Rejected`.
- A peer that hasn't heard from another waits. A network slower than `delay` slows the game to the network's pace.

## Rollback predicts and rewinds

A session with **rollback** doesn't wait. Its `ahead` is 8 ticks by default. It runs each tick at once, and predicts that the peers it hasn't heard from did nothing, which is true for most ticks. When a message arrives for a tick that already ran, and the message holds actions, the session rewinds to before that tick and resimulates with what it now knows.

Each player sees their own move on the next tick, whatever the network's latency. The cost is a rewind each time a prediction was wrong.

- Every peer ends on the same game. Each applies every action on the tick it is stamped with, whenever it heard of the action. Its log replays into a single-player game that never rewound.
- A peer that runs ahead may see a move accepted that is later refused. When two players take the same coin on the same tick, each sees themselves take it until the other's message arrives. Then both agree that the player whose name sorts first takes it. The other's take is refused, in the log and in the world.

Lockstep is rollback that never runs ahead. There is one session, `Session.make`, and its `ahead` says how far it predicts.

## Sessions take over the app

A session makes its app and steps it, so nothing can advance one machine's game alone. `session.app` has no `tick` and no `dispatch`. What enters the app from outside goes to the session instead: `session.app.enqueue`, a key bound to an action, and a UI button all feed this peer's next message. Your game issues input the same way with one player or several.

Actions the simulation issues itself with `Actions`, such as a bot's move, aren't sent. Every peer's simulation issues them on its own.

Every peer's log is an ordinary log, identical entry for entry across peers. [`Journal.replay`](../guides/replays.md) plays it back as a single-player game.

A session holds no socket and no timer. It receives the messages that arrived and returns the ones to send. A `Transport` carries them, between tabs with a `BroadcastChannel`, or between machines through a relay.

## Only a relay vouches for who issued an action

A handler receives the peer that issued an action, `{ from }`, beside the payload. The session stamps `from` from the message the action arrived in, so a move can't claim to be another peer's.

`from` is the sender the message names, and only a relay vouches for it, by holding each peer to the name it connected under. Through a `BroadcastChannel`, or a transport of your own, a peer can send a message in another peer's name. The peers that accepted the message and the impersonated peer then hold different games, and stop as drifted peers. Impersonation is detected, not prevented.

## Peers that drift apart stop

Each peer's first message says what the peer was made with: what its game simulates, its `hz`, the names of every peer, and the tick it begins at. The seed is not among them. Peers made otherwise stop with `Drift.Unlike` before any of them runs a tick it is sure of.

After that, peers exchange the world's hash at their checkpoints. When every peer has reported its hash for a tick and the hashes differ, every session stops with `Drift.Drifted`. The report gives the tick, each peer's hash, and the last tick they agreed on. A different seed is found this way, and so is a system that reads the clock, `Math.random` or the order of a `Set`, at the first checkpoint after it changes the world. [Determinism](determinism.md) lists what a game must do to stay in sync.

Only the world's hash is compared. It covers the actions queued and the events waiting. A difference it doesn't cover is found only once it reaches the world, and the report names that tick, not the tick the difference started on. Such differences are how far a system has read, a system's own variables, and state held in a service.

## A session needs every peer on every tick

Each tick needs a message from every peer, so a session depends on every peer for the whole game:

- The peers are fixed when the session is made. No peer joins later, and a peer that stops, or leaves for good, is waited for.
- Every message must arrive. A lost message leaves a tick that no peer can confirm, and the game stops for everyone. [Transports and relays](../guides/transports-and-relays.md) shows how a session sends again what a dropped socket lost.
- A session can't rest. The other peers wait for its message on every tick, so it ticks at its `hz` even when nothing moves. `ticks: "whenNeeded"` is for single-player games.
- Peers that were not made alike, or that drift apart, stop, since they no longer play one game.

[Make a session](../guides/sessions.md#make-a-session) shows how to see which peers a tick waits for.

## Read more

- [Sessions](../guides/sessions.md), [detecting drift](../guides/detecting-drift.md), and [transports and relays](../guides/transports-and-relays.md).
- [`arcadekit/net`](/reference/arcadekit/net): [`Session`](/reference/arcadekit/net/Session), [`Transport`](/reference/arcadekit/net/Transport) and [`Relay`](/reference/arcadekit/net/Relay) in the API reference.
