---
title: "Performance"
description: "What each part of arcadekit costs, as measured by its benchmarks: loops, hashing and snapshots, change queries, idle ticks and frames, spawning, and actions."
---

arcadekit's **benchmarks** measure what each part of it costs: the two ways to loop, hashing and snapshots, change queries, idle ticks and frames, spawns and despawns, and actions. This page lists their results, and how to run them yourself. [Drawing performance](drawing-performance.md) lists what `@arcadekit/three` costs a frame.

## How the numbers were measured

Every number on this page was measured on 2026-11-27, on a shared cloud VM with four cores of an Intel Xeon at 2.1 GHz, under Node 22.23. Each variant ran in fifteen processes of its own, in turn with the others, at a load average under 1.5. Each number is the median of five, each the fastest of three processes. A cost whose five differ by more than a tenth is given as a range, from the fastest of them to the slowest. The machine is shared and noisy. About one process in 25 ran more than a tenth slower than its variant's median, and one variant's slowest process took three times as long as its fastest. Trust the ratios more than the absolute numbers.

Unless a table says otherwise, the world holds 100,000 entities, each with a position and a velocity of two floats. A tick at 60 ticks a second has a budget of 16.7 ms.

## Loops

Every variant does the same work, `pos += vel * dt`:

| Variant                                                    | ns/entity |
| ---------------------------------------------------------- | --------- |
| `eachChunk`: raw typed-array columns                       | 2.8       |
| `eachChunk`, excluding a sparse tag 1% of entities have    | 5.5       |
| `each`: accessors, only caller in the program              | 8.3       |
| `each`, excluding a sparse tag 1% have                     | 8.3       |
| `each`: accessors, in a program of ten components          | 11.0      |
| `each`: accessors, after 6 other systems used `each`       | 11.1      |
| `eachChunk`, excluding a sparse tag half the entities have | 12.3      |
| Array of plain objects (no ECS)                            | 15.7      |
| One Effect per entity                                      | 77.4      |

- Start with [`each`](queries.md). In a game-like program with ten components and fields of six types, it costs 11 ns per entity, less than a loop over plain objects. That is 1.1 ms for 100,000 entities.
- `eachChunk` is three to four times faster, 0.28 ms for 100,000 entities. Use it for the few systems that visit most of the world every tick.
- An Effect per entity costs seven times as much as `each`, so a system is one Effect with a plain loop inside.
- As a filter, a sparse tag that few entities have costs a loop little. A sparse tag that many entities have, interleaved with entities that don't, breaks tables into short runs and erases `eachChunk`'s advantage. Store such a component in a table. See [components](components.md).
- A query that requires a sparse tag held by 1 entity in 100 takes about 39 µs per pass to visit its 1,000 matches.
- `each` rebinds its accessors for each table it visits, at about 110 ns per term, so a world of many small tables pays for it. With 100,000 entities in 8,192 tables, `each` measured 26 ns per entity.
- Running a loop over 100,000 entities through `app.tick` adds 0.1 ns per entity to one over raw columns, and nothing measurable to one with `each`.

## Hashing, snapshots, and rewinds

| Variant | ns/entity |
| --- | --- |
| `world.hash()`, one table, every entity written since the last hash | 5.7 |
| `world.hash()`, the same entities spread over 32 tables | 6.1 |
| `world.hash()`, with a sparse one-field component on each | 11.9 |
| `world.hash()`, the same entities over 100 tables, one of them written | 0.13 |
| `world.snapshot()`, one table (2.8 MB) | 6.9 |
| `world.load()` of that snapshot, into a new world | 16.2 |
| `world.restore()` of it, into the world it came from | 15.9 |
| `Timeline.capture()` of a game of those entities, after a tick that moved every one | 0.85 to 0.96 |
| `Timeline.rewind()` to that moment, after another such tick | 0.57 |
| Capturing the world alone, 1 table in 100 written since the last capture | 0.13 |
| Rewinding the world alone, 1 table in 100 written since the moment | 0.23 |

- The hash, a capture and a rewind cost what changed since the last hash or capture, not the size of the world. Each component of each table counts as changed once a loop of a query that [writes](queries.md#name-what-a-query-writes) it visits the table, or `world.set` writes it, or an entity joins or leaves the table. What did not change costs one step per component of each table.
- Hashing what changed costs about 1.4 ns per 32-bit field per entity, with an entity's id counting as two fields when its table's rows changed. A sparse component's field costs about four times as much, because its members are hashed one by one so that their order doesn't matter.
- A capture copies what changed and shares the rest with the moment before. Ten moments of a game that moves every entity each tick hold 9.6 MB, where ten snapshots hold 28 MB, and 2.5 MB when one table in a hundred moves.
- A rewind copies back what changed since the moment. It also drops every query's view, which each system builds again when it next runs: about 2.7 µs per view, measured with 50 views over 100 tables.
- An app's hash also encodes each queued action and each waiting event through its schema. An event with a payload of four fields costs about 7 µs, and 256 events cost 1.8 ms at every hash check.
- A [hash check](replays.md) hashes every column, whatever changed, so that a write that went around `Query.writes` still shows up. It is one hash every `hashEvery` ticks, 60 by default: over the world of 100,000 entities, hash checks average 13 µs per tick.
- A [rollback session](sessions.md) pays one capture per uncertain tick: 0.085 to 0.096 ms for 100,000 entities when a tick moves all of them. A misprediction costs a rewind, 0.06 ms, plus running the ticks since then again.

## Change queries

With a query that watches `Position`:

| Variant | Cost |
| --- | --- |
| A change query's visit when nothing changed | 64 ns |
| One `world.set` among 100,000 entities, and the visit after it | 210 ns |
| Visiting the 1,000 entities that were written, of 100,000 | 33 µs |
| Visiting all 100,000, every one written | 24.3 ns/entity |
| `each` writing the watched component: every row noted | 19.2 ns/entity |
| The same, when every row is noted already | 15.8 ns/entity |
| `eachChunk` handed the watched component to write (`Query.writes`): every row noted | 6.4 ns/entity |
| The same through a query that only reads it | 2.9 ns/entity |

- The app tracks writes per row, and only for components that some query watches. A component that no query watches costs a loop what the [loops](#loops) table shows.
- For a watched component, an assignment in `each` costs about 11 ns more the first time a row is written since the last visit, and about 7.5 ns more after that. `eachChunk` costs 3.5 ns per row it passes. A loop through a query that only reads the component, one that leaves it out of [`Query.writes`](queries.md#name-what-a-query-writes), pays nothing.
- Visiting all entities because all were written costs three plain passes, since the query looks each entity up from the change log. A system that needs every entity every tick should use an ordinary query.

## Idle ticks and frames

A pass yields the app's method from one fiber, as a driver does, so each number of this section includes what yielding it costs.

A tick of ten empty systems costs about 9.2 µs, and a frame of ten empty systems costs 9.2 µs. With a [condition](systems.md) of `State.is` that holds on each of the ten, the tick costs about 1.7 times as much as without. With one that doesn't hold, it costs about four fifths as much as without, because a system that is skipped costs less than one that runs and does nothing.

arcadekit's own plugins cost this much when each has little to do:

| Variant | Cost |
| --- | --- |
| `app.input()`: the devices read, nothing changed | 2.81 µs |
| `app.input()` and `app.tick()`: one key went down or up | 10.1 to 12.6 µs |
| `app.input()`: three controls declared, nothing changed | 3.63 µs |
| `app.input()` and `app.tick()`: a key of a control went down or up | 11.6 to 15.1 µs |
| `app.frame()`: a view, no UI is there | 1.29 to 1.43 µs |
| `app.frame()`: a view, a UI is there, the value is what it has | 3.82 µs |
| `app.frame()`: a view, the value is new, and one listener told | 3.38 µs |
| `app.frame()`: cues, nothing happened | 4.98 µs |
| `app.frame()`: cues, one event, and its cue is played | 5.33 µs |
| `app.frame()`: music that goes on as it was, nothing told | 3.40 µs |
| One frame of a game at rest: the devices read, the app asked, drawn, no tick | 7.54 µs |

- **Input** was measured with `Input.plugin`, or with three controls declared, three buttons held, and the pointer somewhere. The input stage runs before every tick, so its idle cost is the one that matters: one sample of the devices, compared with the state in the world. An app with no input-stage system reads nothing and pays nothing.
- **A view** was measured with four fields, read from a singleton. It costs the game its body and one comparison per frame, about 2.5 µs, and costs the UI nothing until a field differs. The comparison stops at the first field that differs, so a new value costs less than an unchanged one. When no UI is attached, the system checks for one and stops.
- **Sound** was measured with one system that plays cues for two kinds of event, or one that keeps a channel's music, to an output that does nothing. The cue system costs a frame two reads of empty event queues, 3.6 µs over a frame whose one system stops at once, plus 0.35 µs per cue played. When sound goes nowhere, the system checks for an output and stops.
- **A game at rest** was measured as one that [ticks only when needed](running-a-game.md#tick-only-when-needed), with device state, a state, and a view.
- `verifyFrames` hashes the world before the frame stage and after each of its systems, and copies and compares each column that `eachChunk` hands out read-only. For one system that reads raw columns over 100,000 entities, it adds 2.8 to 3.4 ms. Use it in [tests](testing-by-hand.md#run-the-frame-stage-by-hand).
- `Session.syncTest` checks rewinds with a capture of the game, a rewind, a second run, and a world hash per system, every tick. For a game of 1,000 entities and two systems, the check costs about 360 µs a tick, against 33 µs without it. Use it in [tests](testing-peers.md#check-that-a-rewind-runs-the-same).

## Spawns and despawns

| Variant                                                    | Cost   |
| ---------------------------------------------------------- | ------ |
| Spawn 1,000 entities with two components and despawn them  | 240 µs |
| The same, each also pointing at one entity with a relation | 389 µs |
| Despawn 100 parents, each taking its 10 children with it   | 156 µs |

A relation costs its component plus a few assignments to link and unlink, 0.15 µs more per entity spawned and despawned with one. A cascading despawn costs the same as despawning each entity alone, 142 ns per entity in the last row.

## Actions

One action, in the world of 100,000 entities:

| Variant                                              | Cost            |
| ---------------------------------------------------- | --------------- |
| Handler reads and sets one entity, accepted          | 2.24 to 2.54 µs |
| The same, refused after its write                    | 9.72 µs         |
| Handler loops over all 100,000 with `each`, accepted | 0.88 ms         |
| The same, refused after its loop                     | 0.93 ms         |

- A handler runs in a transaction, so that a [refusal leaves no trace](events-and-actions.md). A handler that loops pays for one copy of the columns it visits, 0.13 ms for four float columns of 100,000 rows, and 0.05 ms more to restore them on refusal.
- Columns that a query only reads aren't copied. A handler that reads all 100,000 entities takes 0.88 ms through a query that names the component in `Query.writes`, and 0.75 ms through one that doesn't.
- A refusal itself costs about 7 µs, the time Effect takes to construct the failure.

## Run the benchmarks

The benchmarks are in the repository, not in the published packages. Run them from a checkout:

```sh
pnpm --filter arcadekit bench
```

They are in [`packages/arcadekit/bench`](../../../../../packages/arcadekit/bench). Each variant runs in its own process, because V8 specialises a call site for the functions it has seen. A variant that runs after others in the same process measures slower than it is. Run each variant in its own process when you benchmark your own systems too.

## Read more

- [Queries](queries.md) for the two ways to loop, and [entities and systems](../concepts/entities-and-systems.md) for how the world stores what they visit.
