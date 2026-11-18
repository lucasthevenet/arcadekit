---
title: "Performance"
description: "What each part of arcadekit costs, as its benchmarks measure it: the two ways to loop, the hash and snapshots, change queries, a tick with nothing to do, actions, and a crowd drawn with Three.js."
---

What each part of arcadekit costs, as its benchmarks measure it. This guide covers the two ways to loop, the hash and snapshots, change queries, a tick and a frame with nothing to do, entities coming and going, actions, a crowd drawn with Three.js, and how to run the benchmarks.

## Reading the numbers

The numbers are from a cloud Linux VM, on Node 22. Each variant runs in a process of its own, and its line is the best of three runs. The machine is shared and noisy: about one run in six is half as slow again as the rest, and a variant can come out twice as slow from one run to the next. Trust the ratios more than the numbers.

Unless a table says otherwise, the world holds 100,000 entities with a position and a velocity of two floats each. A tick at 60 a second has 16.7 ms.

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

- [`each`](queries.md) is the one to write first. In a program like a game, of ten components with fields of six kinds, it costs 10 ns an entity, less than a loop over plain objects: a millisecond for 100,000.
- `eachChunk` is three to four times faster, a quarter of a millisecond for 100,000. It is for the few systems that visit most of the world every tick.
- An Effect per entity costs seven times what `each` does. A system is one Effect, with a plain loop inside.
- A sparse tag that few entities have costs a loop little, as a filter. One that many have, mixed in with ones that do not, breaks tables into short runs and `eachChunk` loses its edge: such a component is better in a table. See [components](components.md).
- A query that requires a sparse tag 1 entity in 100 has takes about 38 µs a pass to visit its 1,000 matches.
- `each` points its accessors at each table it visits, about 75 ns a term, so a world of very many very small tables pays for it: 100,000 entities in 8,192 tables measured 19.8 ns an entity.
- Going through `app.tick` adds nothing measurable to a loop over 100,000 entities.

## The hash, snapshots and going back

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

- Hashing a world costs about three raw passes over it: 1.4 ns per 32-bit field per entity, an entity's id being two of them. A field of a sparse component costs about four times that, since its members are hashed one by one so that their order does not matter.
- A [checkpoint](replays.md) is one hash every `checkpointEvery` ticks, 60 unless told: 14 µs a tick on average here.
- A [rollback session](lockstep-and-rollback.md) pays a capture for each tick it is not sure of, 0.69 ms for 100,000 entities and 7 µs for a thousand. Being wrong costs a rewind, 1.6 ms for 100,000, and the ticks since, run again.

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
| `eachChunk` handed the watched component: every row noted | 6.3 ns/entity |
| The same through a query that only reads it (`Query.reads`) | 2.6 ns/entity |

- Writes are noticed per row, and only for a component some query watches. One that no query watches costs a loop what the first table says.
- A watched one costs an assignment in `each` about 5 ns more the first time a row is written since the last visit and about 3 ns after that, and `eachChunk` 2.8 ns per row it hands out. A loop that says it only reads the component, with [`Query.reads`](queries.md), pays nothing.
- Visiting everything because everything was written costs three and a half plain passes, since each entity is looked up from the log. A system that wants every entity every tick asks with an ordinary query.

## A tick and a frame with nothing to do

A tick of ten systems that do nothing costs about 5 µs, and a frame of ten 5.8 µs. With a [condition](systems.md) on each of the ten that holds, the tick costs 8.5 µs; with one that does not, 3.5 µs.

What the package's own plugins add, each with little to do:

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

- **Input**, with `Input.plugin`, three buttons held and the pointer somewhere. The input stage runs before every tick, so its cost when nothing happens is the one that counts: one sample of the devices, compared with what the world holds. An app with no system in that stage reads nothing and pays nothing.
- **A view** of four fields, read from a singleton. It costs the game its body and one comparison a frame, 2.3 µs, and the UI nothing until a field differs. A new value is found to be new at the first field that differs, which is why it costs less than one that is not. Where no UI is there, the system asks whether one is and stops.
- **Sound**, with one system that plays cues for two kinds of event, or one that keeps a channel's music, to an output that does nothing. It costs a frame two reads of events that are not there, 0.7 µs over a frame that does nothing, and 0.2 µs more for a cue that is played. Where sound goes nowhere, the system asks whether it does and stops.
- **A game at rest** is one that [ticks when it is needed](running-a-game.md), with the picture of the devices, a state and a view.
- Checking a frame with `verifyFrames` costs a hash of the world before the stage and one after each of its systems, 1.7 ms more for one system over 100,000 entities. It is for [tests](testing.md#the-frame-stage).

## Entities coming and going

| Variant                                                    | Cost   |
| ---------------------------------------------------------- | ------ |
| Spawn 1,000 entities with two components and despawn them  | 561 µs |
| The same, each also pointing at one entity with a relation | 693 µs |
| Despawn 100 parents, each taking its 10 children with it   | 143 µs |

A relation costs its component and a few assignments to link and unlink: 0.13 µs more per entity that is spawned and despawned with one. A despawn that takes others with it costs what despawning each of them does, 130 ns apiece here.

## Actions

One action, in the world of 100,000 entities:

| Variant                                              | Cost    |
| ---------------------------------------------------- | ------- |
| Handler reads and sets one entity, accepted          | 1.31 µs |
| The same, refused after its write                    | 10.5 µs |
| Handler loops over all 100,000 with `each`, accepted | 0.81 ms |
| The same, refused after its loop                     | 0.94 ms |

- A handler runs in a transaction, so that a [refusal leaves nothing behind](events-and-actions.md). One that loops pays one copy of the columns it visits, 0.11 ms for four float columns of 100,000 rows, and as much again to copy them back if it is refused.
- It pays for none it only reads: a handler that looks at all 100,000 entities takes 0.78 ms through a plain query and 0.67 ms through one made with `Query.reads()`.
- A refusal itself costs about 9 µs, which is Effect building the failure.

## Drawing with Three.js

What [`@arcadekit/three`](drawing-with-three.md) does before Three.js takes over: 10,000 entities, one frame, with a renderer that draws nothing. These are medians after warm-up, on the same kind of machine.

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

- Ten thousand moving objects, drawn where the last tick left them, cost 0.08 to 0.36 ms of a frame. The seven kilobytes are the frame itself, the same for one entity as for ten thousand. A test of the package holds the system to under 4 bytes an object per tick and frame, where one number allocated per object would be 12.
- An object each costs ten to twenty times an instance, most of it Three.js keeping an object's Euler angles in step with its quaternion. That is why a crowd is instances.
- A flat entity that is not turned costs a little less than one in three dimensions. One that is turned costs twice as much, 36 ns: a sine and a cosine each, where a quaternion is a few multiplications.
- Drawn between two ticks, with `smooth`, an entity costs about three times as much for a place, 27 ns, and four times for all three, 72 ns: each value is read, kept, and blended with the one before. Ten thousand of them cost 0.27 to 0.83 ms of a frame, and still nothing is allocated per entity.
- A colour each costs about 6 ns more per entity, most of it converting the colour. Given as the renderer has it, with `colorSpace: "srgb-linear"`, it costs 2 ns. Blended between two ticks it costs 22 ns more, as much as blending the place does.
- A look made of assets costs an entity nothing: the loops are the same. Whether the assets are still there is asked twice a frame, which is under a kilobyte and too little time to measure.
- The example page, with 10,000 lit cubes in headless Chromium, grew its heap by 7 to 58 KB a frame, the renderer's own allocations included, and by 17 KB with a hundred cubes: what a frame allocates does not grow with what it draws. That browser draws in software, so it says nothing of how fast a graphics card draws them.

## Running the benchmarks

The benchmarks are in the repository, not in the packages. From a checkout of it:

```sh
pnpm --filter arcadekit bench          # every table above but the last
pnpm --filter @arcadekit/three bench   # drawing with Three.js
```

[`packages/arcadekit/bench`](../../../../../packages/arcadekit/bench) and [`packages/three/bench`](../../../../../packages/three/bench) hold them. Each variant runs in a process of its own because V8 optimises a call for the functions it has seen there: a variant that runs after others in one process looks slower than it is. A game that measures its own systems does the same.

## Not done yet

Systems run in sequence on one thread, and a rollback session keeps the whole world for each tick it is not sure of. [Not done yet](../not-done-yet.md#performance) says what was measured of both.

## Read more

- [Queries](queries.md) for the two ways to loop, and [entities and systems](../concepts/entities-and-systems.md) for how the world stores what they visit.
