# The spatial grid

A spatial grid indexes points for the rest of a step: `SpatialGrid.build` it from a pool's position fields once everything has moved, then ask it. Given their radii too, each point is a circle, and the grid answers with the distance tested:

| Function | What it gives |
| --- | --- |
| `SpatialGrid.within(grid, x, y, radius, out)` | Writes into `out` the points whose circle overlaps the circle of `radius` at (x, y), and returns how many |
| `SpatialGrid.nearest(grid, x, y, range, skip?)` | The point whose centre is nearest (x, y) and closer than `range`, or -1 |
| `SpatialGrid.query(grid, x, y, radius, out)` | Writes the points of the cells the circle overlaps, with nothing tested: the candidates, for a step that tests each pair itself, as one that pushes overlapping bodies apart does |

```ts
import { EntityPool, SpatialGrid } from "arcadekit/core";

const MAX_CONES = 200;
const CAR_RADIUS = 0.5;
const HORN_RANGE = 6;

interface Race {
  carX: number;
  carZ: number;
  knocks: number;
  /** The cone the horn points at, or -1. */
  target: number;
}

const cones = EntityPool.make(MAX_CONES, {
  x: Float32Array,
  z: Float32Array,
  radius: Float32Array,
  /** 1 once the car has knocked it over. */
  knocked: Uint8Array,
});
const grid = SpatialGrid.make({
  halfSize: 30,
  cellSize: 2,
  capacity: MAX_CONES,
});
// Scratch the step owns: what the grid found. It is in no pool, so in no hash.
const found = new Int32Array(64);

const step = (race: Race) => {
  const { x, z, radius, knocked } = cones.fields;
  // z is the grid's y. With the radius field, each cone is a circle.
  SpatialGrid.build(grid, x, z, cones.count, radius);

  // Every cone the car overlaps. The loop over them is the response, in the grid's order.
  const count = SpatialGrid.within(
    grid,
    race.carX,
    race.carZ,
    CAR_RADIUS,
    found
  );
  for (let k = 0; k < count; k++) {
    const cone = found[k]!;
    if (knocked[cone] === 0) {
      knocked[cone] = 1;
      race.knocks += 1;
    }
  }

  // The nearest cone still standing. A mask is any array of numbers: here, the pool's field.
  race.target = SpatialGrid.nearest(
    grid,
    race.carX,
    race.carZ,
    HORN_RANGE,
    knocked
  );
};
```

- **`within` tests `ExactMath.hypot2(dx, dy) < radius + radii[i]`.** It is strict, so two circles that only touch do not overlap, and exact, so every lockstep peer finds the same points. A grid built without radii tests centres. It visits the cells of `radius` plus the build's widest radius, so a caller pads nothing. It writes the points in `query`'s order (rows, then columns, then each cell's list) and stops when `out` is full: a step that takes the first one takes the same one on every peer.
- **`nearest` measures to a centre**, whatever the point's radius. A point at exactly `range` is out, and of two points at one distance it gives the lower index. `skip` is a mask the step owns and fills: a point `i` with `skip[i]` not 0 is passed over, which leaves out the dead, or the targets a step has taken already.
- **Both measure in the plane.** A game with heights filters what `within` gives, as it filters the dead. `nearest` gives one point, so nothing is left to filter: what must not be chosen goes into `skip` before the step asks, and a choice a mask can't hold is the step's own loop over what `within` gives.
- **The grid keeps the arrays `build` was given**, and reads them when asked. A point that moved since the build is tested where it is now and found from the cell it was built in, and removing an entity from a pool moves another into its slot. A radius raised since the build is tested as it is now too, and looked for no further than the build's widest, so `within` can miss it. So a step builds once its points have moved and their radii are set, and asks before it moves or removes.
- **It refuses what it can't index**, with a `RangeError`: a `build` of more points than the grid's `capacity`, or with fewer `radii` than points, and a `skip` mask shorter than the build. A grid made with a pool's capacity and given that pool's fields meets none of them.
