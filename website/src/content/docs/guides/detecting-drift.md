---
title: "Detecting drift"
description: "Peers that were not made alike, or whose worlds' hashes differ, stop with a report that names the peers and the tick. Learn what each report says and how soon it comes."
---

A session reports **drift** when its peers hold different games: `Drift.Unlike` when they were not made alike, and `Drift.Drifted` when their worlds' hashes differ. Either way, the sessions stop. [Several players](../concepts/several-players.md#when-peers-drift-apart) explains why peers drift, and [determinism](../concepts/determinism.md) what keeps them in sync.

## When peers were not made alike

Every peer is made with its own game, seed or save, `delta` and names, and they have to be alike. A peer's first message says what it was made with: a hash of what its game simulates, its `delta`, the names of every peer, and the tick its game begins at. A peer that hears another made otherwise stops with `Drift.Unlike`, before it runs a tick it is sure of, and so does every peer that hears it. `session.tick()` throws it, `session.tickExit()` fails with it, as does every later tick, and `session.drifted` keeps it.

- The report names both peers, what each was made with, and `differ`, the parts that differ: `"game"`, `"delta"`, `"peers"` or `"start"`. Its message says what to give every peer.
- What is compared of a game is what it simulates: the systems of the tick in the order they run, the hooks of its states, the actions it handles, and its version, by name. Frame and input systems are left out, so a peer that draws the game plays with one that doesn't.
- A list of names that leaves a peer out is found too: that peer is heard by the others, whose names are not the same.
- Peers that begin at different ticks, from different saves, are found, where they would otherwise wait for each other.
- Two systems with one name that do different things, or a different seed, are not in this comparison. The worlds' hashes find them, as below.

## When peers drift apart

Each peer sends the others the [checkpoints](replays.md#checkpoints) its log records, the world's hash at a tick, in the messages it sends anyway. When every peer has reported its hash for a tick and they differ, every session stops with `Drift.Drifted`. `session.tick()` throws it, which stops a driver; `session.tickExit()` fails with it, as does every later tick; and `session.drifted` keeps it for a UI to display.

- The report includes the tick, every peer's hash by name, so that with three or more peers the odd one out stands out, and `agreedAt`, the last tick they matched. With a checkpoint every tick, that is the tick before they diverged.
- Drift is detected within a bounded number of ticks, however slow the network. No peer whose `ahead` is 0 runs more than `checkpointEvery - 1 + delay` ticks past the first tick whose world differed, where `delay` is the largest any peer uses: with a checkpoint every tick and a delay of 2, two ticks. A peer that runs ahead runs at most `2 × ahead` ticks more, since a tick's hash is sent once every peer has sent their actions for it.
- The peers' starting state is compared first, whatever `checkpointEvery` is: a session records a checkpoint when it begins. Peers whose `ahead` is 0, made with a different seed or with different entities spawned at startup, never run a tick, and the report says they didn't start from the same state.
- After that, peers compare what their logs record: every 60 ticks by default, and never with `checkpointEvery: 0`. Peers with different intervals compare the ticks both record, and a checkpoint one peer records by hand with `app.checkpoint()` isn't held against the others.
- A peer that stops sends its hash first, so the others stop with the same report instead of waiting for it.
- A checkpoint adds about 30 bytes to a message. The hash is the one the app already computes for its log.

What the hash doesn't cover is only detected once it [reaches the world](../concepts/several-players.md#when-peers-drift-apart).

Peers that drift apart stay stopped. To continue, every peer makes its session again from one peer's save.

## Read more

- [Sessions](sessions.md), and [testing](testing.md#several-peers) two peers side by side.
- [`Drift`](/reference/arcadekit/net/Drift) in the API reference.
