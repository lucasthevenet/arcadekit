---
title: "Detecting drift"
description: "Peers that were not made alike, or whose worlds' hashes differ, stop with a report that names the peers and the tick. Learn what each report says and how soon it comes."
---

A session reports **drift** when its peers hold different games: `Drift.Unlike` when they were not made alike, and `Drift.Drifted` when their worlds' hashes differ. Either way, the sessions stop. [Several players](../concepts/several-players.md#peers-that-drift-apart-stop) explains why peers drift, and [determinism](../concepts/determinism.md) what keeps them in sync.

## Read why peers were not made alike

A peer's first message says what the peer was made with: a hash of what its game simulates, its `delta`, the names of every peer, and the tick its game begins at. A peer that hears of another made otherwise stops with `Drift.Unlike` before it runs a tick it is sure of, and so does every peer that hears from it. `session.tick()` throws the report, and `session.tickExit()` fails with it, on that tick and every later one. `session.drifted` keeps it.

- The report names both peers, what each was made with, and `differ`, the parts that differ: `"game"`, `"delta"`, `"peers"` or `"start"`. Its message says what to give every peer.
- What is compared of a game is what it simulates: the systems of the tick in the order they run, the hooks of its states, the actions it handles, and its version, all by name. Frame and input systems are left out, so a peer that draws the game plays with one that doesn't.
- A peer that the others leave out of their names is found too, since its own list of names differs from theirs.
- Peers that begin at different ticks, from different saves, are found, where they would otherwise wait for each other.
- The seed is not compared, nor what two systems of one name do. The worlds' hashes find a difference in either, as below.

## Read where peers drifted apart

Each peer sends the others the [checkpoints](replays.md#verify-a-replay-with-checkpoints) its log records, each the world's hash at a tick, inside the messages it sends anyway. When every peer has reported its hash for a tick and the hashes differ, every session stops with `Drift.Drifted`. `session.tick()` throws it, and the throw stops a driver. `session.tickExit()` fails with it, on that tick and every later one. `session.drifted` keeps it for a UI to show.

- The report holds the tick, every peer's hash by name, and `agreedAt`, the last tick the hashes matched. With three or more peers, the hashes show which peer is the odd one out. With a checkpoint every tick, `agreedAt` is the tick before they diverged.
- A peer that stops sends its hash first, so the others stop with the same report instead of waiting for it.
- A checkpoint adds about 30 bytes to a message. The hash is the one the app already computes for its log.

What the hash doesn't cover is detected only once it [reaches the world](../concepts/several-players.md#peers-that-drift-apart-stop).

## Choose how soon drift is caught

Drift is caught within a bounded number of ticks, however slow the network:

- A peer whose `ahead` is 0 runs at most `checkpointEvery - 1 + delay` ticks past the first tick whose world differed, where `delay` is the largest any peer uses. With a checkpoint every tick and a delay of 2, that is two ticks.
- A peer that runs ahead runs at most `2 × ahead` ticks more, since it sends a tick's hash once every peer has sent their actions for that tick.

`Session.make` takes `checkpointEvery` as `App.make` does. A smaller value catches drift sooner, at the cost of one hash of the world per checkpoint.

- The peers compare their starting state first, whatever `checkpointEvery` is, since a session records a checkpoint when it begins. Peers whose `ahead` is 0, made with a different seed or with different entities spawned at startup, never run a tick, and the report says they didn't start from the same state. A peer that runs ahead may run some ticks before the report comes, within the bound above.
- After that, peers compare what their logs record: every 60 ticks by default, and nothing more with `checkpointEvery: 0`. Peers with different intervals compare the ticks both record. A checkpoint one peer records by hand with `app.checkpoint()` isn't held against the others.

## Start again after drift

Peers that drift apart stay stopped. To go on, every peer makes its session again from one peer's save.

## Read more

- [Sessions](sessions.md), and [testing](testing.md#connect-several-peers) two peers side by side.
- [`Drift`](/reference/arcadekit/net/Drift) in the API reference.
