---
title: "Several players"
description: "Every peer of a game runs the same simulation. What they send each other is the actions their players issue, each stamped with the tick it applies on, and nothing else."
---

Every peer of a game runs the same simulation. What they send each other is the actions their players issue, each stamped with the tick it applies on, and nothing else. A game is the same game on two machines when both apply the same actions on the same ticks in the same order.

That is what the action log already says of a game of one. A session is little more than the log, shared.

## Lockstep

A lockstep session runs a tick once it holds every peer's message for it. A player's own action goes into their message for the tick a few ahead, `delay` ticks, 2 unless told, so it has time to reach the others before anyone needs it. Every peer applies it on that tick, the one that issued it included.

- A tick's actions are applied peer by peer in the order of the peers' names, and each peer's in the order it issued them, whatever order the messages arrived in. Two players who take the same coin on the same tick get the same answer everywhere: one has it, and the other is refused, with the same `Action.Rejected`.
- A peer that hasn't heard from another waits. A network slower than `delay` slows the game to its pace.

## Rollback

A rollback session doesn't wait. It runs the tick at once, as if the peers it hasn't heard from had nothing to say, which is true of most ticks. When a message comes for a tick that has run, and it did have something to say, the session goes back to before that tick and runs forward again with what it knows now.

A player sees their own move on the next tick, whatever the network takes. The cost is a rewind when a guess was wrong.

Lockstep is the session that runs no tick ahead: there is one implementation of the two.

## A session takes its app over

Once a game is in a session, nothing moves one machine's game alone. `app.enqueue`, a key bound to an action and a button of the UI all go into this peer's next message instead of the next tick. A game issues its input the same way with one player or several.

What the simulation issues itself with `Actions`, a bot's move, isn't sent: every peer's own simulation issues it.

Every peer's log is an ordinary log, the same entry for entry, and [`App.replay`](../guides/replays.md) plays it back into a game of one.

The session holds no socket and no timer. It is given the messages that arrived and gives the ones to send. A `Transport` carries them: between tabs with a `BroadcastChannel`, between machines through a relay.

A session is made with `app.divert(take)`, which hands over what comes in from outside and returns the one way left to queue an action and to run a tick. A session of another kind is made with the same call.

## Who did it

A handler is told which peer issued an action, `{ from }`, beside the payload. The session stamps it from the message the action came in, so a move can't claim to be someone else's.

Who issued an action is who its message says it is from, and only a relay vouches for that: it holds a peer to the name it connected under. Through a `BroadcastChannel`, or a transport of the game's own, a peer can send a message in another's name. The peers that took it and the one whose name it was then hold different games and stop as peers that have come apart. It is found, not prevented.

## Peers that come apart

The peers send each other the world's hash at their checkpoints. When every peer has said its hash for a tick and they differ, every session stops with `Lockstep.Drifted`, which says the tick, each peer's hash and when they last agreed. A system that reads the clock, `Math.random` or the order of a `Set` is found within a few ticks. [Determinism](determinism.md) says what a game must do to stay the same game.

What is compared is the world's hash. What it doesn't cover is found only when it reaches the world, and the report names that tick, not the one it began on: an event one peer alone has waiting, a system's own variables, what a service holds.

## What is not done

- The peers of a session are fixed when it is made. Nobody joins a game in progress or leaves one, and a peer that stops is waited for.
- Every message has to arrive. One that is lost stops the game for everyone: nothing asks for it again, and a socket that drops ends the game over it. Nothing says that a peer has gone quiet but `session.waitingFor`.
- Peers that have come apart stop. Nothing brings them back together.
- Who a peer is, is for a relay's host to settle. Nothing signs a message.
- A game in a session ticks all the time. `ticks: "whenNeeded"` isn't for several peers yet: a session doesn't say when it is settled.

The two guides say what else is missing, each where its reader meets it.

## Read more

- [Lockstep and rollback](../guides/lockstep-and-rollback.md) and [transports and relays](../guides/transports-and-relays.md).
- [`Lockstep`](/reference/arcadekit/Lockstep), [`Rollback`](/reference/arcadekit/Rollback), [`Transport`](/reference/arcadekit/Transport) and [`Relay`](/reference/arcadekit/Relay) in the API reference.
