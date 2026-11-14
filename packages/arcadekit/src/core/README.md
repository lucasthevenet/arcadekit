# arcadekit/core

The DOM-free building blocks of a game's simulation: a fixed-step clock, a seeded random generator, struct-of-arrays entity pools, rings of records, a tile map, a spatial grid and an event buffer, with the exact math, the timers and the tweens a step or a view calls, and the state hash. Nothing in it allocates per step, and nothing touches the DOM, so it runs in a browser, a Web Worker or on a server.

An entry of the [`arcadekit`](../../README.md) package.

## Install

```bash
pnpm add arcadekit effect
```

`effect` (~4.1) is the package's one required peer dependency. This entry imports it only for its modules' shape (`pipe`, the guards, `dual`): a game uses `arcadekit/core` without running any Effect, and a step that calls it stays plain.

## Its modules

Each module is a namespace, written as a module of Effect is: a data type named after it, its `make`, a guard, and functions that take the value first.

| Namespace | What it holds | Guide |
| --- | --- | --- |
| `EntityPool` | A fixed number of entities stored as one typed array per field, and `EntityPool.Identified`, whose entities keep stable ids | [Entity pools](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/entity-pools.md) |
| `Ring` | A fixed number of records in typed arrays, where a new one overwrites the oldest | [Telling a view what a step did](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/rings.md) |
| `RingReader` | How far one view has read one ring | [Telling a view what a step did](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/rings.md) |
| `TileMap` | A level's grid of static cells in typed arrays, with neighbours and a flood fill | [Tile maps](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/tile-maps.md) |
| `Layout` | What each record of a pool, a ring or a tile map holds: `{ x: Float32Array }` | [Entity pools](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/entity-pools.md) |
| `SpatialGrid` | A grid that finds the points near a place | [The spatial grid](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/spatial-grid.md) |
| `FixedStepClock` | Turns a frame's time into whole fixed steps | [Steps and frames](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/steps-and-frames.md) |
| `Rng` | The run's seeded random number generator | [Determinism](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/determinism.md#picking-with-the-rng) |
| `EventBuffer` | What a run reports, held until its loop delivers it | [Entity pools](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/entity-pools.md) |
| `StateHash` | The 32-bit digest peers compare to find a desync | [Determinism](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/determinism.md#the-state-hash) |
| `ExactMath` | The math a step calls, the same bits in every engine | [Determinism](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/determinism.md#exact-math) |
| `Point2` | Two numbers a function writes for its caller | [Determinism](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/determinism.md#exact-math) |
| `Timer` | Timers and rates as numbers in the state | [Timers and tweens](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/timers-and-tweens.md) |
| `Tween` | A view's values computed from when something started | [Timers and tweens](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/timers-and-tweens.md#tweens) |

## Example

A function of a value takes it first, and with one argument less gives the function a `pipe` applies:

```ts
import { Rng, StateHash } from "arcadekit/core";

const rng = Rng.make(42);
const roll = Rng.int(rng, 6);

// The same, piped: `Rng.int(6)` is the function of an Rng.
const again = Rng.make(42).pipe(Rng.int(6));

const hash = StateHash.make().pipe(StateHash.add(roll), StateHash.add(again));
const digest = StateHash.digest(hash);

// Each value says what it is, to a guard and in a log.
const known = Rng.isRng(rng) && StateHash.isStateHash(hash);
console.log(`${String(rng)} ${digest} ${known}`);
```
