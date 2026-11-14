---
"arcadekit": minor
---

`arcadekit/core` gains exact math (`ExactMath`), 2D helpers (`Point2`), `ExactMath.hashCell`, timers (`Timer.countDown`, `Timer.takeWhole`), tweens (`Tween.progress` and four eases) and `Rng.pickDistinct`. (The names are 0.7.0's: see the changeset that gives core Effect's module shape.)

A step may use only exact arithmetic, and core gave it `clamp` alone, so each game wrote the same small functions. They are the kit's now: plain functions a step may call, with no Effect, no clock and no allocation.

- **Exact math.** `ExactMath.hypot2`, `sin`, `cos` and `powInt`, the replacements for `Math.hypot`, `Math.sin`, `Math.cos` and `**` that give the same bits in every engine, moved from the survivors genre as they were. `ExactMath.lerp(from, to, t)` is `from + (to - from) * t`.
- **2D helpers.** `Point2.clampLength(point, x, y, max)` writes (x, y) into `point`, shortened to `max` if longer, and returns the length it had. `Point2.moveToward(point, x, y, targetX, targetY, maxStep)` writes the place at most `maxStep` toward a target, and the target itself once it is that near. Both write into a `Point2` the caller made once and owns: there is no vector class.
- **`ExactMath.hashCell(col, row)`.** A well-spread unsigned 32-bit integer from two whole numbers, for a tile's variant: take `% count` of it, or divide it by 2^32.
- **Timers.** `Timer.countDown(value, by)` is `Math.max(0, value - by)`: a timer is a number in the state, ready at 0 and armed by writing its length. `Timer.takeWhole(amount)` is the whole units in a budget, for a rate turned into whole spawns.
- **Tweens.** `Tween.progress(now, startedAt, duration)` goes from 0 to 1, and `Tween.easeIn`, `easeOut`, `easeOutCubic` and `smoothstep` shape it. A tween is a value a view computes each frame, so no object holds one.
- **`Rng.pickDistinct(rng, items, count)`.** Moves `count` items drawn without repeats to the front of `items`, in place, and returns how many. It draws once for each item it picks. `items` is an array or a typed array: a `readonly` list is a type error, since the pick reorders it. A `count` that is not a whole number of 0 or more is a `RangeError`.

```ts
import { Point2, Rng, Timer } from "arcadekit/core";

const wish = Point2.make(0, 0);
const state = { x: 0, hurtTimer: 0, spawnBudget: 0 };
const dt = 1 / 60;

// Before: const length = Math.sqrt(x * x + y * y); if (length > 1) { x /= length; y /= length; }
Point2.clampLength(wish, 0.9, 0.8, 1);
state.x += wish.x * 6 * dt;

// Before: state.hurtTimer = Math.max(0, state.hurtTimer - dt);
state.hurtTimer = Timer.countDown(state.hurtTimer, dt);

// Before: while (state.spawnBudget >= 1) { state.spawnBudget -= 1; spawn(); }
state.spawnBudget += 2.5 * dt;
const due = Timer.takeWhole(state.spawnBudget);
state.spawnBudget -= due;

// Before: a partial Fisher-Yates shuffle written with Rng.int.
const rng = Rng.make(7);
const upgrades = ["boost", "magnet", "shield", "tyres"];
const count = Rng.pickDistinct(rng, upgrades, 3);
const offer = upgrades.slice(0, count);
```

Every export is new. `Rng.pickDistinct` draws as a hand-written pick would: `j = i + Rng.int(rng, items.length - i)`, then a swap of `i` and `j`, for each item it picks.
