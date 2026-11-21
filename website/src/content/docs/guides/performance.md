---
title: "Performance"
description: "What each part of arcadekit costs, as measured by its benchmarks: loops, hashing and snapshots, change queries, idle ticks and frames, actions, and rendering crowds with Three.js."
---

This guide lists what each part of arcadekit costs, as measured by its benchmarks: the two ways to loop, hashing and snapshots, change queries, idle ticks and frames, spawning and despawning, actions, rendering crowds with Three.js, and how to run the benchmarks yourself.

## Reading the numbers

The numbers come from a cloud Linux VM running Node 22. Each variant runs in its own process, and its line is the best of three runs. The machine is shared and noisy: about one run in six is 50% slower than the rest, and a variant can measure twice as slow from one run to the next. Trust the ratios more than the absolute numbers.

Unless a table says otherwise, the world holds 100,000 entities, each with a position and a velocity of two floats. A tick at 60 per second has a budget of 16.7 ms.

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

- Start with [`each`](queries.md). In a game-like program with ten components and fields of six types, it costs 10 ns per entity, less than a loop over plain objects: a millisecond for 100,000.
- `eachChunk` is three to four times faster, a quarter of a millisecond for 100,000. Use it for the few systems that visit most of the world every tick.
- An Effect per entity costs seven times as much as `each`. That's why a system is one Effect with a plain loop inside.
- A sparse tag that few entities have costs a loop little, as a filter. One that many entities have, interleaved with ones that don't, breaks tables into short runs and erases `eachChunk`'s advantage: store such a component in a table. See [components](components.md).
- A query that requires a sparse tag held by 1 entity in 100 takes about 38 µs per pass to visit its 1,000 matches.
- `each` rebinds its accessors for each table it visits, about 75 ns per term, so a world with very many very small tables pays for it: 100,000 entities in 8,192 tables measured 19.8 ns per entity.
- Running through `app.tick` adds no measurable cost to a loop over 100,000 entities.

## Hashing, snapshots and rewinding

| Variant                                                       | ns/entity |
| ------------------------------------------------------------- | --------- |
| `world.hash()`, one table                                     | 8.3       |
| `world.hash()`, the same entities spread over 32 tables       | 8.7       |
| `world.hash()`, with a sparse one-field component on each     | 15.0      |
| `world.snapshot()`, one table (2.8 MB)                        | 6.7       |
| `world.load()` of that snapshot, into a new world             | 21.0      |
| `world.restore()` of it, into the world it came from          | 16.0      |
| `app.capture()`: a game of those entities, kept to go back to | 6.9       |
| `app.rewind()`: the game put back to that moment              | 16.2      |

- Hashing a world costs about three raw passes over it: 1.4 ns per 32-bit field per entity, with an entity's id counting as two. A sparse component's field costs about four times that, since its members are hashed individually so that their order doesn't matter. An app's hash also encodes each action queued and each event waiting through its schema, about 0.6 µs apiece for a payload of four fields: 0.15 ms for 256 events, at every checkpoint.
- A [checkpoint](replays.md) is one hash every `checkpointEvery` ticks, 60 by default: 14 µs per tick on average here.
- A [rollback session](lockstep-and-rollback.md) pays one capture per uncertain tick, 0.69 ms for 100,000 entities and 7 µs for a thousand. A misprediction costs a rewind, 1.6 ms for 100,000, plus resimulating the ticks since.

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

- Writes are tracked per row, and only for components some query watches. A component no query watches costs a loop what the first table shows.
- For a watched component, an assignment in `each` costs about 5 ns more the first time a row is written since the last visit, and about 3 ns after that, while `eachChunk` costs 2.8 ns per row it passes. A loop through a query that only reads the component, one that leaves it out of [`Query.writes`](queries.md#what-a-query-writes), pays nothing.
- Visiting everything because everything was written costs three and a half plain passes, since each entity is looked up from the change log. A system that needs every entity every tick should use an ordinary query.

## Idle ticks and frames

A tick of ten empty systems costs about 5 µs, and a frame of ten 5.8 µs. With a [condition](systems.md) on each of the ten that holds, the tick costs 8.5 µs; with one that doesn't, 3.5 µs.

The overhead of arcadekit's own plugins, each with little to do:

| Variant | Cost |
| --- | --- |
| `app.input()`: the devices read, nothing changed | 1.39 µs |
| `app.input()` and `app.tick()`: one key went down or up | 5.22 µs |
| `app.frame()`: a view, no UI is there | 0.58 µs |
| `app.frame()`: a view, a UI is there, the value is what it has | 2.90 µs |
| `app.frame()`: a view, the value is new, and one listener told | 2.57 µs |
| `app.frame()`: cues, nothing happened | 1.43 µs |
| `app.frame()`: cues, one event, and its cue is played | 1.63 µs |
| `app.frame()`: music that goes on as it was, nothing told | 1.24 µs |
| One frame of a game at rest: the devices read, the app asked, drawn, no tick | 5.3 µs |

- **Input**, with `Input.plugin`, three buttons held and the pointer somewhere. The input stage runs before every tick, so its idle cost is the one that matters: one sample of the devices, compared with the state in the world. An app with no input-stage system reads nothing and pays nothing.
- **A view** of four fields, read from a singleton. It costs the game its body and one comparison per frame, 2.3 µs, and the UI nothing until a field differs. A new value is detected at the first differing field, which is why it costs less than an unchanged one. When no UI is attached, the system checks for one and stops.
- **Sound**, with one system playing cues for two kinds of event, or one keeping a channel's music, to an output that does nothing. It costs a frame two reads of empty event queues, 0.7 µs over an empty frame, plus 0.2 µs per cue played. When sound has no output, the system checks for one and stops.
- **A game at rest** is one that [ticks only when needed](running-a-game.md), with device state, a state and a view.
- Verifying frames with `verifyFrames` costs a hash of the world before the stage and after each of its systems, 1.7 ms more for one system over 100,000 entities. Use it in [tests](testing.md#the-frame-stage).
- Checking rewinds with `Rollback.syncTest` costs a capture of the game, a rewind, a second run and a world hash per system, every tick: about 100 µs a tick for a game of 1,000 entities and two systems, against 7 to 20 µs without. Use it in [tests](testing.md#rewinds).

## Spawning and despawning

| Variant                                                    | Cost   |
| ---------------------------------------------------------- | ------ |
| Spawn 1,000 entities with two components and despawn them  | 561 µs |
| The same, each also pointing at one entity with a relation | 693 µs |
| Despawn 100 parents, each taking its 10 children with it   | 143 µs |

A relation costs its component plus a few assignments to link and unlink: 0.13 µs more per entity spawned and despawned with one. A cascading despawn costs the same as despawning each entity individually, 130 ns each here.

## Actions

One action, in the world of 100,000 entities:

| Variant                                              | Cost    |
| ---------------------------------------------------- | ------- |
| Handler reads and sets one entity, accepted          | 1.31 µs |
| The same, refused after its write                    | 10.5 µs |
| Handler loops over all 100,000 with `each`, accepted | 0.81 ms |
| The same, refused after its loop                     | 0.94 ms |

- A handler runs in a transaction, so that a [refusal leaves no trace](events-and-actions.md). A handler that loops pays one copy of the columns it visits, 0.11 ms for four float columns of 100,000 rows, and as much again to restore them on refusal.
- Columns a query only reads aren't copied: a handler that reads all 100,000 entities takes 0.78 ms through a query that names them in `Query.writes` and 0.67 ms through one that doesn't.
- A refusal itself costs about 9 µs, which is Effect constructing the failure.

## Drawing with Three.js

The work [`@arcadekit/three`](drawing-with-three.md) does before Three.js takes over: 10,000 entities, one frame, with a renderer that draws nothing. These are medians after warm-up, on the same kind of machine.

| Variant | ns/entity | Bytes allocated per frame |
| --- | --- | --- |
| `Three.instances`: a position | 9.8 | 6,700 |
| `Three.instances`: a position and a scale | 11.2 | 7,400 |
| `Three.instances`: a position and a rotation | 15.0 | 7,400 |
| `Three.instances`: all three | 18.2 | 7,100 |
| `Three.instances`, flat: a position | 8.0 | 7,300 |
| `Three.instances`, flat: a position and a scale | 8.3 | 7,100 |
| `Three.instances`, flat: a position and a rotation | 35.7 | 7,200 |
| `Three.instances`, flat: all three | 35.9 | 7,200 |
| `Three.instances`, smooth: a position | 26.9 | 7,300 |
| `Three.instances`, smooth: all three | 71.8 | 7,300 |
| `Three.instances`, smooth, flat: a position | 23.1 | 7,300 |
| `Three.instances`, smooth, flat: all three | 82.5 | 7,300 |
| `Three.instances`, a colour each: a position | 14.7 | 7,400 |
| `Three.instances`, a colour each, as the renderer has it: a position | 10.9 | 7,400 |
| `Three.instances`, a colour each, smooth: a position | 44.7 | 7,800 |
| `Three.instances`, a look made of assets: a position | 8.7 | 8,000 |
| `Three.objects`: an Object3D each, all three copied | 163.0 | 5,700 |
| `Three.objects`, flat: an Object3D each, all three copied | 167.8 | 5,700 |
| By hand: `world.get` and `setMatrixAt`, per entity | 361.6 | 2,480,000 |

- Ten thousand moving objects, drawn where the last tick left them, cost 0.08 to 0.36 ms of a frame. The seven kilobytes are per-frame overhead, the same for one entity as for ten thousand. A test holds the system to under 4 bytes per object per tick and frame, where allocating one number per object would take 12.
- An object per entity costs ten to twenty times as much as an instance, mostly Three.js keeping each object's Euler angles in sync with its quaternion. That's why crowds use instances.
- An unrotated flat entity costs slightly less than a 3D one. A rotated one costs twice as much, 36 ns: a sine and a cosine each, where a quaternion takes a few multiplications.
- With `smooth` interpolation, an entity costs about three times as much for a position, 27 ns, and four times for all three, 72 ns: each value is read, stored, and blended with the previous one. Ten thousand cost 0.27 to 0.83 ms of a frame, still with no per-entity allocation.
- A per-instance colour costs about 6 ns more per entity, mostly the colour conversion. In the renderer's space, with `colorSpace: "srgb-linear"`, it costs 2 ns. Interpolated, it costs 22 ns more, the same as interpolating the position.
- A look built from assets adds no per-entity cost: the loops are the same. Checking that the assets are still loaded happens twice per frame, allocates under a kilobyte, and takes too little time to measure.
- In headless Chromium, the example page with 10,000 lit cubes grew its heap by 7 to 58 KB per frame, including the renderer's own allocations, and by 17 KB with a hundred cubes: per-frame allocation doesn't grow with what is drawn. Headless Chromium renders in software, so this says nothing about GPU rendering speed.

## Running the benchmarks

The benchmarks live in the repository, not in the published packages. From a checkout:

```sh
pnpm --filter arcadekit bench          # every table above but the last
pnpm --filter @arcadekit/three bench   # drawing with Three.js
```

They are in [`packages/arcadekit/bench`](../../../../../packages/arcadekit/bench) and [`packages/three/bench`](../../../../../packages/three/bench). Each variant runs in its own process because V8 specialises a call site for the functions it has seen: a variant that runs after others in the same process measures slower than it is. Do the same when you benchmark your own systems.

## Read more

- [Queries](queries.md) for the two ways to loop, and [entities and systems](../concepts/entities-and-systems.md) for how the world stores what they visit.
