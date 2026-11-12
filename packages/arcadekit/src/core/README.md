# arcadekit/core

The DOM-free building blocks of a game's simulation: a fixed-step clock, a seeded random generator, struct-of-arrays entity pools, a spatial grid and an event buffer, with the exact math, the timers and the eases a step calls. Nothing in it allocates per step, and nothing touches the DOM, so it runs in a browser, a Web Worker or on a server.

An entry of the [`arcadekit`](../../README.md) package.

## Install

```bash
pnpm add arcadekit effect
```

`effect` (~4.1) is the package's one required peer dependency, but this entry doesn't import it: a game can use `arcadekit/core` without running any Effect.

## Example

Enemies in a pool, spawned with the run's seeded `Rng` (as `@arcadekit/survivors` does), and an event collected in an `EventBuffer`, which is what `Game.Loop` holds for a declared simulation's `report`:

```ts
import { EventBuffer, createPool, makeRng } from "arcadekit/core";

const rng = makeRng(42);
const events = new EventBuffer<{
  readonly type: "killed";
  readonly x: number;
}>();
const enemies = createPool(500, {
  x: Float32Array,
  z: Float32Array,
  hp: Float32Array,
});

const i = enemies.add(); // -1 when the pool is full
if (i !== -1) {
  enemies.fields.x[i] = rng.range(-10, 10);
  enemies.fields.z[i] = rng.range(-10, 10);
  enemies.fields.hp[i] = 3;
}

// Remove while iterating backwards: removing moves the last entity into the hole.
for (let j = enemies.count - 1; j >= 0; j--) {
  if (enemies.fields.hp[j]! <= 0) {
    events.push({ type: "killed", x: enemies.fields.x[j]! });
    enemies.remove(j);
  }
}
const facts = events.drain();
```

`createIdentifiedPool` gives entities stable ids too, for undo or a view that tweens each one. `FixedStepClock` turns frame times into whole fixed steps; [`Game.Loop`](../game/README.md#how-a-frame-becomes-steps) uses it for you.

## Exact math

A step must give the same bits in every JavaScript engine, or lockstep peers drift apart. Each engine approximates `Math.hypot`, `Math.sin`, `Math.cos` and `**` in its own way, so a step calls none of them ([ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md)). It calls these, which use only operations every engine computes exactly:

| Function | What it gives |
| --- | --- |
| `hypot2(x, y)` | The length of (x, y): `Math.sqrt(x * x + y * y)` |
| `sin(x)`, `cos(x)` | The sine and cosine of `x` radians, within 2^-52 of `Math`'s for \|x\| up to 1000 |
| `powInt(base, exponent)` | `base` raised to a whole `exponent`, by square-and-multiply. A `RangeError` for any other exponent |
| `clamp(value, min, max)` | `value`, kept between `min` and `max` |
| `lerp(from, to, t)` | `from + (to - from) * t` |
| `clampLength(x, y, max, out)` | Writes (x, y), shortened to `max` if longer, and returns the length it had |
| `moveToward(x, y, targetX, targetY, maxStep, out)` | Writes the point at most `maxStep` from (x, y) toward the target: the target itself once it is that near |
| `hashCell(col, row)` | A well-spread unsigned 32-bit integer from two whole numbers: take `% count` of it, or divide it by 2^32 |

There is no vector class: a position is two fields of a pool or of the state, and a step allocates nothing per entity. A function that gives two numbers writes them into a `Point2` its caller owns. The axes are x and y, as `SpatialGrid`'s are: a 3D game on a ground plane passes z as y. `clampLength`'s `max` and `moveToward`'s `maxStep` are 0 or more.

```ts
import { clampLength, hashCell, moveToward } from "arcadekit/core";
import type { Point2 } from "arcadekit/core";

interface Racer {
  x: number;
  z: number;
}

const SPEED = 6;
const COIN_SPEED = 18;
// Where the helpers write: one object for the whole run, read back before the next call.
const point: Point2 = { x: 0, y: 0 };

/** Moves a racer by its stick: a stick pushed into a corner is longer than 1, and no faster. */
const drive = (racer: Racer, stickX: number, stickZ: number, dt: number) => {
  clampLength(stickX, stickZ, 1, point);
  racer.x += point.x * SPEED * dt;
  racer.z += point.y * SPEED * dt;
};

/** Flies a coin to the racer that collects it, and lands on it without passing it. */
const collect = (coin: Racer, racer: Racer, dt: number) => {
  moveToward(coin.x, coin.z, racer.x, racer.z, COIN_SPEED * dt, point);
  coin.x = point.x;
  coin.z = point.y;
};

/** Which of a tile's variants a view draws at a cell: the same on every frame, from no state. */
const tileVariant = (col: number, row: number, variants: number): number =>
  hashCell(col, row) % variants;
```

A genre that needs another function, such as `atan2`, writes an exact version first.

## Asking the spatial grid

A `SpatialGrid` indexes points for the rest of a step: `build` it from a pool's position fields once everything has moved, then ask it. Given their radii too, each point is a circle, and the grid answers with the distance tested:

| Method | What it gives |
| --- | --- |
| `within(x, y, radius, out)` | Writes into `out` the points whose circle overlaps the circle of `radius` at (x, y), and returns how many |
| `nearest(x, y, range, skip?)` | The point whose centre is nearest (x, y) and closer than `range`, or -1 |
| `query(x, y, radius, out)` | Writes the points of the cells the circle overlaps, with nothing tested: the candidates, for a step that tests each pair itself, as one that pushes overlapping bodies apart does |

```ts
import { SpatialGrid, createPool } from "arcadekit/core";

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

const cones = createPool(MAX_CONES, {
  x: Float32Array,
  z: Float32Array,
  radius: Float32Array,
  /** 1 once the car has knocked it over. */
  knocked: Uint8Array,
});
const grid = new SpatialGrid({
  halfSize: 30,
  cellSize: 2,
  capacity: MAX_CONES,
});
// Scratch the step owns: what the grid found. It is in no pool, so in no hash.
const found = new Int32Array(64);

const step = (race: Race) => {
  const { x, z, radius, knocked } = cones.fields;
  // z is the grid's y. With the radius field, each cone is a circle.
  grid.build(x, z, cones.count, radius);

  // Every cone the car overlaps. The loop over them is the response, in the grid's order.
  const count = grid.within(race.carX, race.carZ, CAR_RADIUS, found);
  for (let k = 0; k < count; k++) {
    const cone = found[k]!;
    if (knocked[cone] === 0) {
      knocked[cone] = 1;
      race.knocks += 1;
    }
  }

  // The nearest cone still standing. A mask is any array of numbers: here, the pool's field.
  race.target = grid.nearest(race.carX, race.carZ, HORN_RANGE, knocked);
};
```

- **`within` tests `hypot2(dx, dy) < radius + radii[i]`.** It is strict, so two circles that only touch do not overlap, and exact, so every lockstep peer finds the same points. A grid built without radii tests centres. It visits the cells of `radius` plus the build's widest radius, so a caller pads nothing. It writes the points in `query`'s order (rows, then columns, then each cell's list) and stops when `out` is full: a step that takes the first one takes the same one on every peer.
- **`nearest` measures to a centre**, whatever the point's radius. A point at exactly `range` is out, and of two points at one distance it gives the lower index. `skip` is a mask the step owns and fills: a point `i` with `skip[i]` not 0 is passed over, which leaves out the dead, or the targets a step has taken already.
- **Both measure in the plane.** A game with heights filters what `within` gives, as it filters the dead. `nearest` gives one point, so nothing is left to filter: what must not be chosen goes into `skip` before the step asks, and a choice a mask can't hold is the step's own loop over what `within` gives.
- **The grid keeps the arrays `build` was given**, and reads them when asked. A point that moved since the build is tested where it is now and found from the cell it was built in, and removing an entity from a pool moves another into its slot. A radius raised since the build is tested as it is now too, and looked for no further than the build's widest, so `within` can miss it. So a step builds once its points have moved and their radii are set, and asks before it moves or removes.
- **It refuses what it can't index**, with a `RangeError`: a `build` of more points than the grid's `capacity`, or with fewer `radii` than points, and a `skip` mask shorter than the build. A grid made with a pool's capacity and given that pool's fields meets none of them.

## Timers are numbers in the state

A timer is a number in the state, so it pauses, replays and hashes with the run, and nothing calls back. A step lowers it with `countDown`, which stops at 0; the timer is ready at 0, and armed by writing its length. A rate is a budget the step adds to: `takeWhole` gives the whole units in it, and the step subtracts what it took, so the fraction carries to the next step.

```ts
import { countDown, takeWhole } from "arcadekit/core";

interface Race {
  /** Seconds until a racer can be bumped again. Ready at 0. */
  bumpTimer: number;
  /** Coins the track owes, with the fraction carried from step to step. */
  coinBudget: number;
  coins: number;
}

const BUMP_SECONDS = 0.5;
const COINS_PER_SECOND = 2.5;

const step = (race: Race, bumped: boolean, dt: number) => {
  race.bumpTimer = countDown(race.bumpTimer, dt);
  if (bumped && race.bumpTimer === 0) {
    race.bumpTimer = BUMP_SECONDS;
  }
  race.coinBudget += COINS_PER_SECOND * dt;
  const due = takeWhole(race.coinBudget);
  race.coinBudget -= due;
  race.coins += due;
};
```

A tween is a number too: the time it started. A view computes where the thing is on each frame, from `progress` (0 at `startedAt`, 1 from `startedAt + duration` on) through an ease, so no object holds a tween and a view writes nothing. `progress` is 1 for a `startedAt` of `-Infinity`, which is how a thing at rest is written.

```ts
import { easeOut, lerp, progress } from "arcadekit/core";

interface Slide {
  readonly fromX: number;
  readonly toX: number;
  /** The frame time the slide started at, or -Infinity for a thing at rest. */
  readonly startedAt: number;
}

const SLIDE_SECONDS = 0.09;

/** Where a racer sliding into the next lane is drawn at `now`. */
const slideX = (slide: Slide, now: number): number =>
  lerp(
    slide.fromX,
    slide.toX,
    easeOut(progress(now, slide.startedAt, SLIDE_SECONDS))
  );
```

The eases are `easeIn` (`t * t`), `easeOut` (`t * (2 - t)`), `easeOutCubic` and `smoothstep`, which clamps its `t`. Each is a polynomial, so a step may call one as well.

## Picking with the Rng

`Rng.pickDistinct(items, count)` draws `count` items without repeats: it moves them to the front of `items`, in place, and returns how many, which is `items.length` if there are fewer. It takes an array or a typed array, so a pick of pool indices allocates nothing. It reorders what it takes, so a `readonly` list is a type error: pick from a copy of a list that runs share, such as the game's content.

```ts
import { makeRng } from "arcadekit/core";

const rng = makeRng(7);
const upgrades = ["boost", "magnet", "shield", "tyres", "horn"];

// Three of the five, in the order drawn. The rest follow, so nothing is lost.
const count = rng.pickDistinct(upgrades, 3);
const offer = upgrades.slice(0, count);
```

It draws once for each item it picks, the last one included, and every later draw of the run follows from that: the number of draws is part of its contract. So `count` is a whole number of 0 or more, and any other is a `RangeError`.

See [ADR-0003](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0003-one-fixed-step-clock.md) (one fixed-step clock), [ADR-0006](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0006-identified-pools-reuse-ids.md) (identified pools) and [ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md) (a step uses only exact math).
