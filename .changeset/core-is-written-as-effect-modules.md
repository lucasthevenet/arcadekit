---
"arcadekit": minor
---

`arcadekit/core` is written as Effect's modules are ([ADR-0024](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0024-the-kit-is-written-as-effect-modules.md)): each of its modules is a namespace, with a data type named after it, its `make`, an `isX` guard, `pipe`, a printed form, and functions that take the value first and, given one argument less, return the function a `pipe` applies. **Breaking**: every export of `arcadekit/core` is renamed or reshaped.

Core stays plain: a step calls it, so it gives the same bits on every peer and finishes in the call, and it runs no Effect. It imports `effect` only for its shape (`Pipeable`, `Inspectable`, `Predicate`, `dual`). The arithmetic is the same, in the same order: no state hash a game recorded moves, and survivors' replay and determinism hashes hold.

```ts
import { EntityPool, Rng, StateHash } from "arcadekit/core";

// Before: const rng = makeRng(42); const roll = rng.int(6);
const rng = Rng.make(42);
const roll = Rng.int(rng, 6);

// Before: const enemies = createPool(300, { ... }); const i = enemies.add();
const enemies = EntityPool.make(300, { x: Float32Array, hp: Float32Array });
const i = EntityPool.add(enemies);
enemies.fields.hp[i] = roll;

// Before: new StateHasher().number(roll).digest(), and visitPool(enemies, hasher.number).
const hash = StateHash.make().pipe(StateHash.add(roll));
EntityPool.visit(enemies, (value) => {
  StateHash.add(hash, value);
});
const digest = StateHash.digest(hash);
```

**Breaking**

Every export of `arcadekit/core` before, and what a game writes now:

| Before | Now |
| --- | --- |
| `createPool(capacity, layout)`, `Pool<L>` | `EntityPool.make(capacity, layout)`, `EntityPool.EntityPool<L>` |
| `pool.add()`, `pool.remove(i)`, `pool.clear()` | `EntityPool.add(pool)`, `EntityPool.remove(pool, i)`, `EntityPool.clear(pool)` |
| `createIdentifiedPool(capacity, layout)`, `IdentifiedPool<L>` | `EntityPool.makeIdentified(capacity, layout)`, `EntityPool.Identified<L>` |
| `pool.idOf(i)`, `pool.indexOf(id)`, `pool.addWithId(id)` | `EntityPool.idOf(pool, i)`, `EntityPool.indexOf(pool, id)`, `EntityPool.addWithId(pool, id)` |
| `PoolLayout`, `PoolFields<L>` | `Layout.Layout`, `Layout.Fields<L>` |
| `visitPool(pool, visit)` | `EntityPool.visit(pool, f)` |
| `createRing(capacity, layout)`, `Ring<L>` | `Ring.make(capacity, layout)`, `Ring.Ring<L>` |
| `ring.push()`, `ring.pop()`, `ring.slotOf(n)`, `ring.clear()` | `Ring.push(ring)`, `Ring.pop(ring)`, `Ring.slotOf(ring, n)`, `Ring.clear(ring)` |
| `new RingReader()`, `reader.take(ring)`, `reader.reset()` | `RingReader.make()`, `RingReader.take(reader, ring)`, `RingReader.reset(reader)` |
| `createTileMap(cols, rows, layout)`, `TileMap<L>`, `Side` | `TileMap.make(cols, rows, layout)`, `TileMap.TileMap<L>`, `TileMap.Side` |
| `map.cellAt(col, row)`, `map.colOf(cell)`, `map.rowOf(cell)`, `map.neighbor(cell, side)`, `map.flood(start, passes, reached)` | `TileMap.cellAt(map, col, row)`, `TileMap.colOf(map, cell)`, `TileMap.rowOf(map, cell)`, `TileMap.neighbor(map, cell, side)`, `TileMap.flood(map, start, passes, reached)` |
| `new SpatialGrid(options)`, `SpatialGridOptions` | `SpatialGrid.make(options)`, `SpatialGrid.Options` |
| `grid.build(xs, ys, count, radii?)`, `grid.query(…)`, `grid.within(…)`, `grid.nearest(…)` | `SpatialGrid.build(grid, xs, ys, count, radii?)`, `SpatialGrid.query(grid, …)`, `SpatialGrid.within(grid, …)`, `SpatialGrid.nearest(grid, …)` |
| `new FixedStepClock(stepSeconds?, maxStepsPerFrame?)` | `FixedStepClock.make({ stepSeconds?, maxStepsPerFrame? })` |
| `clock.advance(frameSeconds, step)`, `clock.reset()` | `FixedStepClock.advance(clock, frameSeconds, step)`, `FixedStepClock.reset(clock)` |
| `makeRng(seed)`, `Rng` | `Rng.make(seed)`, `Rng.Rng` |
| `rng.next()`, `rng.int(max)`, `rng.range(min, max)`, `rng.pickDistinct(items, count)` | `Rng.next(rng)`, `Rng.int(rng, max)`, `Rng.range(rng, min, max)`, `Rng.pickDistinct(rng, items, count)` |
| `new EventBuffer<E>()`, `events.push(event)`, `events.drain()` | `EventBuffer.make<E>()`, `EventBuffer.push(events, event)`, `EventBuffer.drain(events)` |
| `new StateHasher()`, `hasher.number(value)`, `hasher.digest()`, `hasher.reset()` | `StateHash.make()`, `StateHash.add(hash, value)`, `StateHash.digest(hash)`, `StateHash.reset(hash)` |
| `clamp`, `lerp`, `hypot2`, `sin`, `cos`, `powInt`, `hashCell` | `ExactMath.clamp`, `ExactMath.lerp`, `ExactMath.hypot2`, `ExactMath.sin`, `ExactMath.cos`, `ExactMath.powInt`, `ExactMath.hashCell` |
| `Point2`, a `{ x, y }` the caller writes | `Point2.Point2`, made with `Point2.make(x, y)` |
| `clampLength(x, y, max, out)`, `moveToward(x, y, targetX, targetY, maxStep, out)` | `Point2.clampLength(out, x, y, max)`, `Point2.moveToward(out, x, y, targetX, targetY, maxStep)`: the point first |
| `countDown`, `takeWhole` | `Timer.countDown`, `Timer.takeWhole` |
| `progress`, `easeIn`, `easeOut`, `easeOutCubic`, `smoothstep` | `Tween.progress`, `Tween.easeIn`, `Tween.easeOut`, `Tween.easeOutCubic`, `Tween.smoothstep` |

And what follows from the shape:

- **No class and no closure is left**: a pool, a ring, a reader, a tile map, a grid, a clock, an `Rng`, an event buffer and a state hash are values made by their module's `make`, with their state in fields and their behaviour in the module's functions. A function that took one as a method's receiver takes it first.
- **A value of a data type comes from its `make`.** An object written to look like one is not one: its guard says so, and its type refuses it. A `Point2` is `Point2.make(0, 0)`, where it was the literal `{ x: 0, y: 0 }`, and an `Rng` can't be written by hand.
- **A list a state hash folds takes a function made once**: `(value) => StateHash.add(hash, value)` in place of `hasher.number`.
- **Messages name the module's function**: `Ring.make needs a whole capacity of 1 or more`, `TileMap.make needs a whole number of columns and of rows`, `Rng.pickDistinct needs a whole count of 0 or more` and `ExactMath.powInt needs an integer exponent`, where they named `createRing`, `createTileMap`, `pickDistinct` and `powInt`. The other refusals are as they were.
- **New**: `Layout`, a namespace for the types of a layout and its fields; each data type's guard (`EntityPool.isEntityPool`, `EntityPool.isIdentified`, `Ring.isRing`, `RingReader.isRingReader`, `TileMap.isTileMap`, `SpatialGrid.isSpatialGrid`, `FixedStepClock.isFixedStepClock`, `Rng.isRng`, `EventBuffer.isEventBuffer`, `StateHash.isStateHash`, `Point2.isPoint2`); `pipe` and a printed form on each; `Rng.Rng`'s `state` and `EventBuffer.EventBuffer`'s `pending`, readonly fields that were hidden in a closure or a private field.

No other entry changes its exports. `RingReader.take` still takes anything with a ring's `capacity` and `written`.
