---
title: "Performance"
description: "What each part of arcadekit costs, as measured by its benchmarks: loops, hashing and snapshots, change queries, idle ticks and frames, spawning, and actions."
---

arcadekit's **benchmarks** measure what each part of it costs: the two ways to loop, hashing and snapshots, change queries, idle ticks and frames, spawns and despawns, and actions. This page lists their results, and how to run them yourself. [Drawing performance](drawing-performance.md) lists what `@arcadekit/three` costs a frame.

## How the numbers were measured

The numbers come from a cloud Linux VM that runs Node 22. Each variant runs in its own process, and its line is the best of three runs. The machine is shared and noisy. About one run in six is 50% slower than the rest, and a variant can measure twice as slow from one run to the next. Trust the ratios more than the absolute numbers.

Unless a table says otherwise, the world holds 100,000 entities, each with a position and a velocity of two floats. A tick at 60 ticks a second has a budget of 16.7 ms.

## Loops

Every variant does the same work, `pos += vel * dt`:

| Variant                                                    | ns/entity |
| ---------------------------------------------------------- | --------- |
| `eachChunk`: raw typed-array columns                       | 2.6       |
| `eachChunk`, excluding a sparse tag 1% of entities have    | 4.8       |
| `each`: accessors, only caller in the program              | 8.0       |
| `each`, excluding a sparse tag 1% have                     | 8.8       |
| `each`: accessors, in a program of ten components          | 10.2      |
| `each`: accessors, after 6 other systems used `each`       | 10.7      |
| `eachChunk`, excluding a sparse tag half the entities have | 11.4      |
| Array of plain objects (no ECS)                            | 16.0      |
| One Effect per entity                                      | 69.3      |

- Start with [`each`](queries.md). In a game-like program with ten components and fields of six types, it costs 10 ns per entity, less than a loop over plain objects. That is a millisecond for 100,000 entities.
- `eachChunk` is three to four times faster, a quarter of a millisecond for 100,000 entities. Use it for the few systems that visit most of the world every tick.
- An Effect per entity costs seven times as much as `each`, so a system is one Effect with a plain loop inside.
- As a filter, a sparse tag that few entities have costs a loop little. A sparse tag that many entities have, interleaved with entities that don't, breaks tables into short runs and erases `eachChunk`'s advantage. Store such a component in a table. See [components](components.md).
- A query that requires a sparse tag held by 1 entity in 100 takes about 38 µs per pass to visit its 1,000 matches.
- `each` rebinds its accessors for each table it visits, at about 75 ns per term, so a world of many small tables pays for it. With 100,000 entities in 8,192 tables, `each` measured 19.8 ns per entity.
- Running through `app.tick` adds no measurable cost to a loop over 100,000 entities.

## Hashing, snapshots, and rewinds

| Variant | ns/entity |
| --- | --- |
| `world.hash()`, one table, every entity written since the last hash | 4.3 |
| `world.hash()`, the same entities spread over 32 tables | 4.2 |
| `world.hash()`, with a sparse one-field component on each | 8.6 |
| `world.hash()`, the same entities over 100 tables, one of them written | 0.09 |
| `world.snapshot()`, one table (2.8 MB) | 6.7 |
| `world.load()` of that snapshot, into a new world | 21.0 |
| `world.restore()` of it, into the world it came from | 16.0 |
| `Timeline.capture()` of a game of those entities, after a tick that moved every one | 0.8 |
| `Timeline.rewind()` to that moment, after another such tick | 0.4 |
| Capturing the world alone, 1 table in 100 written since the last capture | 0.09 |
| Rewinding the world alone, 1 table in 100 written since the moment | 0.14 |

- The hash, a capture and a rewind cost what changed since the last hash or capture, not the size of the world. Each component of each table counts as changed once a loop of a query that [writes](queries.md#name-what-a-query-writes) it visits the table, or `world.set` writes it, or an entity joins or leaves the table. What did not change costs one step per component of each table.
- Hashing what changed costs about 1.4 ns per 32-bit field per entity, with an entity's id counting as two fields when its table's rows changed. A sparse component's field costs about four times as much, because its members are hashed one by one so that their order doesn't matter.
- A capture copies what changed and shares the rest with the moment before. Ten moments of a game that moves every entity each tick hold 10.5 MB, where ten snapshots hold 28 MB, and 2.7 MB when one table in a hundred moves.
- A rewind copies back what changed since the moment. It also drops every query's view, which each system builds again when it next runs: about 6 µs per view, measured with 50 views over 100 tables.
- An app's hash also encodes each queued action and each waiting event through its schema. Each costs about 0.6 µs for a payload of four fields, and 256 events cost 0.15 ms at every hash check.
- A [hash check](replays.md) hashes every column, whatever changed, so that a write that went around `Query.writes` still shows up. It is one hash every `hashEvery` ticks, 60 by default: over the world of 100,000 entities, hash checks average 14 µs per tick.
- A [rollback session](sessions.md) pays one capture per uncertain tick: 0.08 ms for 100,000 entities when a tick moves all of them. A misprediction costs a rewind, 0.04 ms, plus running the ticks since then again.

## Change queries

With a query that watches `Position`:

| Variant | Cost |
| --- | --- |
| A change query's visit when nothing changed | 62 ns |
| One `world.set` among 100,000 entities, and the visit after it | 200 ns |
| Visiting the 1,000 entities that were written, of 100,000 | 42 µs |
| Visiting all 100,000, every one written | 22.4 ns/entity |
| `each` writing the watched component: every row noted | 17.2 ns/entity |
| The same, when every row is noted already | 13.8 ns/entity |
| `eachChunk` handed the watched component to write (`Query.writes`): every row noted | 6.3 ns/entity |
| The same through a query that only reads it | 2.6 ns/entity |

- The app tracks writes per row, and only for components that some query watches. A component that no query watches costs a loop what the [loops](#loops) table shows.
- For a watched component, an assignment in `each` costs about 5 ns more the first time a row is written since the last visit, and about 3 ns more after that. `eachChunk` costs 2.8 ns per row it passes. A loop through a query that only reads the component, one that leaves it out of [`Query.writes`](queries.md#name-what-a-query-writes), pays nothing.
- Visiting all entities because all were written costs three and a half plain passes, since the query looks each entity up from the change log. A system that needs every entity every tick should use an ordinary query.

## Idle ticks and frames

This section is what a cloud Linux VM measured on 2026-11-26, with four cores of an Intel Xeon at 2.1 GHz and Node 22.23, at a load average of 1.1 to 1.5 from the benchmark itself. Each variant ran in fifteen processes of its own, in turn with the others, and each number is the median of five, each the fastest of three. A pass yields the app's method from one fiber, as a driver does, so each number includes what yielding it costs, about 0.3 µs a method. On the same day the machine measured the `eachChunk` row of the [loops](#loops) table at 2.6 ns per entity, as the table has it, and its other rows from 25% faster to 10% slower.

A tick of ten empty systems costs about 7.6 µs, and a frame of ten empty systems costs 7.3 µs. With a [condition](systems.md) of `State.is` that holds on each of the ten, the tick costs about 1.7 times as much as without. With one that doesn't hold, it costs about three quarters as much as without, because a system that is skipped costs less than one that runs and does nothing.

arcadekit's own plugins cost this much when each has little to do:

| Variant | Cost |
| --- | --- |
| `app.input()`: the devices read, nothing changed | 2.37 µs |
| `app.input()` and `app.tick()`: one key went down or up | 8.16 µs |
| `app.input()`: three controls declared, nothing changed | 3.06 µs |
| `app.input()` and `app.tick()`: a key of a control went down or up | 9.08 µs |
| `app.frame()`: a view, no UI is there | 1.06 µs |
| `app.frame()`: a view, a UI is there, the value is what it has | 3.25 µs |
| `app.frame()`: a view, the value is new, and one listener told | 2.76 µs |
| `app.frame()`: cues, nothing happened | 4.23 µs |
| `app.frame()`: cues, one event, and its cue is played | 4.54 µs |
| `app.frame()`: music that goes on as it was, nothing told | 3.44 µs |
| One frame of a game at rest: the devices read, the app asked, drawn, no tick | 6.87 µs |

- **Input** was measured with `Input.plugin`, or with three controls declared, three buttons held, and the pointer somewhere. The input stage runs before every tick, so its idle cost is the one that matters: one sample of the devices, compared with the state in the world. An app with no input-stage system reads nothing and pays nothing.
- **A view** was measured with four fields, read from a singleton. It costs the game its body and one comparison per frame, 2.2 µs, and costs the UI nothing until a field differs. The comparison stops at the first field that differs, so a new value costs less than an unchanged one. When no UI is attached, the system checks for one and stops.
- **Sound** was measured with one system that plays cues for two kinds of event, or one that keeps a channel's music, to an output that does nothing. The cue system costs a frame two reads of empty event queues, 3.2 µs over a frame whose one system stops at once, plus 0.3 µs per cue played. When sound goes nowhere, the system checks for an output and stops.
- **A game at rest** was measured as one that [ticks only when needed](running-a-game.md#tick-only-when-needed), with device state, a state, and a view.
- `verifyFrames` hashes the world before the frame stage and after each of its systems, and copies and compares each column that `eachChunk` hands out read-only. For one system that reads raw columns over 100,000 entities, it adds 3.2 ms. Use it in [tests](testing.md#run-the-frame-stage-by-hand).
- `Session.syncTest` checks rewinds with a capture of the game, a rewind, a second run, and a world hash per system, every tick. For a game of 1,000 entities and two systems, the check costs about 100 µs a tick, against 7 to 20 µs without it. Use it in [tests](testing-peers.md#check-that-a-rewind-runs-the-same).

## Spawns and despawns

| Variant                                                    | Cost   |
| ---------------------------------------------------------- | ------ |
| Spawn 1,000 entities with two components and despawn them  | 156 µs |
| The same, each also pointing at one entity with a relation | 251 µs |
| Despawn 100 parents, each taking its 10 children with it   | 106 µs |

A relation costs its component plus a few assignments to link and unlink, 0.1 µs more per entity spawned and despawned with one. A cascading despawn costs the same as despawning each entity alone, 96 ns per entity in the last row.

## Actions

One action, in the world of 100,000 entities:

| Variant                                              | Cost    |
| ---------------------------------------------------- | ------- |
| Handler reads and sets one entity, accepted          | 1.31 µs |
| The same, refused after its write                    | 10.5 µs |
| Handler loops over all 100,000 with `each`, accepted | 0.81 ms |
| The same, refused after its loop                     | 0.94 ms |

- A handler runs in a transaction, so that a [refusal leaves no trace](events-and-actions.md). A handler that loops pays for one copy of the columns it visits, 0.11 ms for four float columns of 100,000 rows, and as much again to restore them on refusal.
- Columns that a query only reads aren't copied. A handler that reads all 100,000 entities takes 0.78 ms through a query that names the component in `Query.writes`, and 0.67 ms through one that doesn't.
- A refusal itself costs about 9 µs, the time Effect takes to construct the failure.

## Run the benchmarks

The benchmarks are in the repository, not in the published packages. Run them from a checkout:

```sh
pnpm --filter arcadekit bench
```

They are in [`packages/arcadekit/bench`](../../../../../packages/arcadekit/bench). Each variant runs in its own process, because V8 specialises a call site for the functions it has seen. A variant that runs after others in the same process measures slower than it is. Run each variant in its own process when you benchmark your own systems too.

## Read more

- [Queries](queries.md) for the two ways to loop, and [entities and systems](../concepts/entities-and-systems.md) for how the world stores what they visit.
