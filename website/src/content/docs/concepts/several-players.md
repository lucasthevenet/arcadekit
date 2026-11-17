---
title: "Several players"
description: "Every peer of a game runs the same simulation. What they send each other is the actions their players issue, each stamped with the tick it applies on, and nothing else."
---

Every peer of a game runs the same simulation. What they send each other is the actions their players issue, each stamped with the tick it applies on, and nothing else. A game is the same game on two machines when both apply the same actions on the same ticks in the same order.

That is what the action log already says of a game of one. A session is little more than the log, shared.

## Lockstep

A lockstep session runs a tick once it holds every peer's message for it. A player's own action goes into their message for the tick a few ahead, `delay` ticks, 2 unless told, so it has time to reach the others before anyone needs it. Every peer applies it on that tick, the one that issued it included.

- A tick's actions are applied peer by peer in the order of the peers' names, so two players who take the same coin on the same tick get the same answer everywhere.
- A peer that hasn't heard from another waits. A network slower than `delay` slows the game to its pace.

## Rollback

A rollback session doesn't wait. It runs the tick at once, as if the peers it hasn't heard from had nothing to say, which is true of most ticks. When a message comes for a tick that has run, and it did have something to say, the session goes back to before that tick and runs forward again with what it knows now.

A player sees their own move on the next tick, whatever the network takes. The cost is a rewind when a guess was wrong.

Lockstep is the session that runs no tick ahead: there is one implementation of the two.

## A session takes its app over

Once a game is in a session, nothing moves one machine's game alone. `app.enqueue`, a key bound to an action and a button of the UI all go into this peer's next message instead of the next tick. A game issues its input the same way with one player or several.

The session holds no socket and no timer. It is given the messages that arrived and gives the ones to send. A `Transport` carries them: between tabs with a `BroadcastChannel`, between machines through a relay.

## Who did it

A handler is told which peer issued an action, `{ from }`, beside the payload. The session stamps it from the message the action came in, so a move can't claim to be someone else's. Through a relay, the relay vouches for the name a peer connected under.

## Peers that come apart

The peers send each other the world's hash at their checkpoints. When every peer has said its hash for a tick and they differ, every session stops with `Lockstep.Drifted`, which says the tick, each peer's hash and when they last agreed. A system that reads the clock is found within a few ticks.

## What is not done

The peers of a session are fixed when it is made: nobody joins a game in progress or leaves one. Every message has to arrive: a socket that drops ends the game over it. A game in a session ticks all the time, not only when needed. The [reference](/reference/arcadekit#not-done-yet) has the rest.

## Read more

- [Lockstep and rollback](../guides/lockstep-and-rollback.md) and [transports and relays](../guides/transports-and-relays.md).
- [More than one player](/reference/arcadekit#more-than-one-player) in the reference.
