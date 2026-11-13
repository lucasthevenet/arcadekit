---
"arcadekit": minor
---

`arcadekit/core` gains exact math, 2D helpers, `hashCell`, `countDown`, `takeWhole`, `progress`, four eases and `Rng.pickDistinct`. **Breaking**: an `Rng` written by hand adds `pickDistinct`.

A step may use only exact arithmetic ([ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md)), and core gave it `clamp` alone, so each game wrote the same small functions. They are the kit's now: plain functions a step may call, with no Effect, no clock and no allocation.

- **Exact math.** `hypot2`, `sin`, `cos` and `powInt`, the replacements for `Math.hypot`, `Math.sin`, `Math.cos` and `**` that give the same bits in every engine, moved from the survivors genre as they were. `lerp(from, to, t)` is `from + (to - from) * t`.
- **2D helpers.** `clampLength(x, y, max, out)` writes (x, y), shortened to `max` if longer, and returns the length it had. `moveToward(x, y, targetX, targetY, maxStep, out)` writes the point at most `maxStep` toward a target, and the target itself once it is that near. Both write into a `Point2` the caller owns: there is no vector class.
- **`hashCell(col, row)`.** A well-spread unsigned 32-bit integer from two whole numbers, for a tile's variant: take `% count` of it, or divide it by 2^32.
- **Timers.** `countDown(value, by)` is `Math.max(0, value - by)`: a timer is a number in the state, ready at 0 and armed by writing its length. `takeWhole(amount)` is the whole units in a budget, for a rate turned into whole spawns.
- **Tweens.** `progress(now, startedAt, duration)` goes from 0 to 1, and `easeIn`, `easeOut`, `easeOutCubic` and `smoothstep` shape it. A tween is a value a view computes each frame, so no object holds one.
- **`Rng.pickDistinct(items, count)`.** Moves `count` items drawn without repeats to the front of `items`, in place, and returns how many. It draws once for each item it picks. `items` is an array or a typed array: a `readonly` list is a type error, since the pick reorders it. A `count` that is not a whole number of 0 or more is a `RangeError`.

```ts
import { clampLength, countDown, makeRng, takeWhole } from "arcadekit/core";
import type { Point2 } from "arcadekit/core";

const wish: Point2 = { x: 0, y: 0 };
const state = { x: 0, hurtTimer: 0, spawnBudget: 0 };
const dt = 1 / 60;

// Before: const length = Math.sqrt(x * x + y * y); if (length > 1) { x /= length; y /= length; }
clampLength(0.9, 0.8, 1, wish);
state.x += wish.x * 6 * dt;

// Before: state.hurtTimer = Math.max(0, state.hurtTimer - dt);
state.hurtTimer = countDown(state.hurtTimer, dt);

// Before: while (state.spawnBudget >= 1) { state.spawnBudget -= 1; spawn(); }
state.spawnBudget += 2.5 * dt;
const due = takeWhole(state.spawnBudget);
state.spawnBudget -= due;

// Before: a partial Fisher-Yates shuffle written with rng.int.
const rng = makeRng(7);
const upgrades = ["boost", "magnet", "shield", "tyres"];
const count = rng.pickDistinct(upgrades, 3);
const offer = upgrades.slice(0, count);
```

**Breaking**

- `Rng` has a new member, `pickDistinct`. An object that implements `Rng` by hand, such as a wrapper that counts draws, needs it to type-check: have it call `int` once for each item it picks, as `makeRng`'s does (`j = i + int(items.length - i)`, then a swap of `i` and `j`). An `Rng` from `makeRng` has it already. Every other export is new.
