---
"arcadekit": minor
---

`SpatialGrid` answers with the test done: `build` takes radii, `within` gives the points whose circle overlaps a circle, and `nearest` the nearest point in range, past a `skip` mask. Nothing breaks.

`query` gives the points of the cells a circle overlaps, so every caller finished it by hand: the length of the offset against the two radii, a radius padded by a guess at the widest point, and for the nearest point a loop with a tie rule of its own. The test, the pad and the tie rule decide what every lockstep peer computes, so the grid does them once. They are plain code a step calls, in `arcadekit/core`: no Effect, no clock, no allocation and no callback.

- **`build(xs, ys, count, radii?)`.** With `radii`, point i is a circle of radius `radii[i]`. The grid keeps the three arrays and reads them when asked, so a step builds once its points have moved and their radii are set, and asks before it moves or removes a point.
- **`within(x, y, radius, out)`.** Writes into `out` the index of every point whose circle overlaps the circle of `radius` at (x, y), and returns how many. The test is `hypot2(dx, dy) < radius + radii[i]`: strict, so two circles that only touch do not overlap, with 0 for a grid built without radii. It visits the cells of `radius` plus the build's widest radius, so a caller pads nothing. The points come in `query`'s order, and it stops when `out` is full.
- **`nearest(x, y, range, skip?)`.** The index of the point whose centre is nearest (x, y) and closer than `range`, or -1. A point at exactly `range` is out, a tie goes to the lower index, and a point `i` with `skip[i]` not 0 is passed over: the mask is the caller's, for the dead and for the targets it has taken.
- **`query` is the broad phase**, unchanged: for a step that tests each pair itself, as one that pushes overlapping bodies apart does.

```ts
import { SpatialGrid, hypot2 } from "arcadekit/core";

const HERO_RADIUS = 0.5;
const xs = new Float32Array(200);
const zs = new Float32Array(200);
const radii = new Float32Array(200);
const dead = new Uint8Array(200);
const found = new Int32Array(64);
const grid = new SpatialGrid({ halfSize: 30, cellSize: 2, capacity: 200 });
const hero = { x: 0, z: 0, touches: 0 };
const count = 0;

// Before: a padded query, then the test, by hand.
grid.build(xs, zs, count);
const candidates = grid.query(hero.x, hero.z, HERO_RADIUS + 1, found);
for (let k = 0; k < candidates; k++) {
  const i = found[k]!;
  if (hypot2(xs[i]! - hero.x, zs[i]! - hero.z) < HERO_RADIUS + radii[i]!) {
    hero.touches += 1;
  }
}

// After: the grid has the radii, and what comes back overlaps.
grid.build(xs, zs, count, radii);
hero.touches += grid.within(hero.x, hero.z, HERO_RADIUS, found);

// The nearest living point within 14, or -1.
const target = grid.nearest(hero.x, hero.z, 14, dead);
```

Two mistakes that gave a wrong answer in silence are refused, and one accident of `query` is gone. A step that builds its grid from a pool of the grid's capacity, before it asks, meets none of them:

- `build` throws a `RangeError` for more points than the grid's `capacity`, where `query` gave indices that were never built and `within` and `nearest` would never return, and for fewer `radii` than points.
- `nearest` throws a `RangeError` for a `skip` mask shorter than the build, which would pass over every point past its end.
- A grid that was never built has no points. Before its first `build`, `query` filled `out` with index 0.
