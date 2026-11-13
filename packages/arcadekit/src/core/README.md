# arcadekit/core

The DOM-free building blocks of a game's simulation: a fixed-step clock, a seeded random generator, struct-of-arrays entity pools, rings of records, a tile map, a spatial grid and an event buffer, with the exact math, the timers and the eases a step calls, and the hasher of a state hash. Nothing in it allocates per step, and nothing touches the DOM, so it runs in a browser, a Web Worker or on a server.

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

`add` gives a slot whose fields are all 0, whatever the entity that had it before left there, so a spawn writes only the fields that start at something else.

`createIdentifiedPool` gives entities stable ids too, for undo or a view that tweens each one. A view that keeps something per entity keys it on `idOf`, never on the index: removing an entity moves another into its index, and the id stays with it. An id is handed out again once its entity is removed, so it names an entity only while that entity lives.

`FixedStepClock` turns frame times into whole fixed steps; [`Game.Loop`](../game/README.md#how-a-frame-becomes-steps) uses it for you.

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

## A tile map

A level's static cells, such as wall, floor and hole, are a **tile map**: `createTileMap(cols, rows, layout)` makes a grid with one typed array per field, as a pool's entities have, and cell (col, row) is at `row * cols + col` in each. A tile is a number in a field, not an object. The map says what the level is, not where entities are: those are in pools, and a `SpatialGrid` finds them.

| Member | What it gives |
| --- | --- |
| `cols`, `rows`, `cells` | The map's size, and `cols * rows`: the length of every field |
| `fields` | One typed array per field of the layout, every cell 0 when made |
| `cellAt(col, row)` | The cell at a column and a row, or -1 off the map |
| `colOf(cell)`, `rowOf(cell)` | A cell's column and its row |
| `neighbor(cell, side)` | The cell next to `cell` on a `Side`, or -1 off the map |
| `flood(start, passes, reached)` | Marks in `reached` the cells joined to `start` through cells `passes` accepts, and returns how many |

```ts
import { Side, createTileMap } from "arcadekit/core";
import type { TileMap } from "arcadekit/core";

/** What a cell of the track is. */
const Tile = { grass: 0, road: 1, barrier: 2 } as const;

const TRACK_LAYOUT = {
  /** A `Tile`. */
  tile: Uint8Array,
  /** 1 where a coin lies. */
  coin: Uint8Array,
};

interface Race {
  readonly track: TileMap<typeof TRACK_LAYOUT>;
  /** The cell the car is on. */
  car: number;
  coins: number;
  /** How many cells of road the car can still drive to. */
  open: number;
  /** Scratch the step owns: 1 for each of those cells, and the test a flood asks of a cell. */
  readonly reached: Uint8Array;
  readonly isRoad: (cell: number) => boolean;
}

/** A track of grass, for the level to lay its road and its coins on. */
const createRace = (cols: number, rows: number): Race => {
  const track = createTileMap(cols, rows, TRACK_LAYOUT);
  const { tile } = track.fields;
  return {
    track,
    car: 0,
    coins: 0,
    open: 0,
    reached: new Uint8Array(track.cells),
    // Made once, with the mask: a flood in a step makes no closure.
    isRoad: (cell) => tile[cell] === Tile.road,
  };
};

/** In the step: drives the car one cell to `side` if that cell is road, and takes its coin. */
const drive = (race: Race, side: Side) => {
  const { track } = race;
  const { tile, coin } = track.fields;
  const target = track.neighbor(race.car, side);
  // -1 past the edge of the track.
  if (target === -1 || tile[target] !== Tile.road) {
    return;
  }
  race.car = target;
  race.coins += coin[target]!;
  coin[target] = 0;
};

/** In the step: a barrier falls on a cell, and the race counts the road the car has left. */
const dropBarrier = (race: Race, col: number, row: number) => {
  const { track, reached } = race;
  const cell = track.cellAt(col, row);
  if (cell === -1) {
    return;
  }
  track.fields.tile[cell] = Tile.barrier;
  reached.fill(0);
  race.open = track.flood(race.car, race.isRoad, reached);
};

const race = createRace(12, 8);
drive(race, Side.east);
dropBarrier(race, 5, 3);
```

- **A `Side` is `Side.west`, `Side.east`, `Side.north` or `Side.south`**, numbered 0 to 3 in that order, and north is the row above. `neighbor` gives -1 at the map's edge, and the neighbour of -1, or of any other cell off the map, is -1, so one lookup can follow another.
- **A column, a row and a cell are whole numbers.** A position on the ground is floored before `cellAt` is asked: given a fraction, it gives no cell and not -1 either.
- **`flood` marks `start` with 1, then every cell joined to it by sides through cells `passes` accepts**, and returns how many it marked. It does not enter a cell already marked, so two floods share a mask, and a flood from a marked cell marks nothing. Nor does one from a cell off the map. `start` itself is marked whatever `passes` says of it.
- **`neighbor` and `flood` allocate nothing**, so a step may call them: the map keeps the queue a flood walks, made once, and the step keeps `passes` as it keeps `reached`, which is `cells` long or longer. `passes` must not flood the same map.
- **A field the rules write is state**, as push-puzzle's tiles are: a box fills a hole, and the cell is floor from then on. A game with a state hash lists such a field. A field written once, when the level is read, changes no run, and no hash needs it.
- **A view draws one with a tile layer** ([`arcadekit/render-three`](../render-three/README.md#a-tile-layer)), which asks a function of the cell and never names the map.
- **It refuses what it can't index**, with a `RangeError`: a number of columns or of rows that is not a whole number of 1 or more, and a `reached` mask shorter than the map's `cells`, whose missing cells a flood could neither read nor mark.

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

## Telling a view what a step did

A view needs to know what a step did: a hit and where it landed, a hole that was filled. An event is a rare fact for the app, and a cue counter is a count with no place or amount. A **ring** carries the rest: `createRing(capacity, layout)` makes a fixed number of records stored as one typed array per field, as a pool's entities are. The step pushes a record, and each view takes the records written since it last looked, with a `RingReader` of its own ([ADR-0023](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0023-a-step-tells-its-views-what-happened-through-a-ring-of-records.md)).

```ts
import { RingReader, createRing } from "arcadekit/core";
import type { Ring } from "arcadekit/core";

const BUMP_LAYOUT = {
  /** Where the two cars touched. */
  x: Float32Array,
  z: Float32Array,
  /** How hard, in metres a second. */
  speed: Float32Array,
};

interface Race {
  /** Bumps, for the views alone: the step pushes them and never reads them back. */
  readonly bumps: Ring<typeof BUMP_LAYOUT>;
}

const createRace = (): Race => ({ bumps: createRing(32, BUMP_LAYOUT) });

/** In the step: a record for the bump. Nothing is allocated. */
const bump = (race: Race, x: number, z: number, speed: number) => {
  const { bumps } = race;
  const i = bumps.push();
  bumps.fields.x[i] = x;
  bumps.fields.z[i] = z;
  bumps.fields.speed[i] = speed;
};

/** A view that draws a spark for each bump since its last frame. */
class SparkView {
  /** How far this view has read `bumps`. */
  private readonly seen = new RingReader();
  private readonly spark: (x: number, z: number, speed: number) => void;

  constructor(spark: (x: number, z: number, speed: number) => void) {
    this.spark = spark;
  }

  render(race: Race): void {
    const { bumps } = race;
    for (let n = this.seen.take(bumps); n < bumps.written; n++) {
      const i = bumps.slotOf(n);
      this.spark(
        bumps.fields.x[i]!,
        bumps.fields.z[i]!,
        bumps.fields.speed[i]!
      );
    }
  }
}
```

- **Record n, counted from 0, is in slot `n % capacity`**, which `slotOf(n)` gives, and a new record overwrites the oldest. `push` reserves the slot of the next record and returns it with every field 0, so a step writes only the fields that start at something else. `written` counts the records pushed and not popped, and nothing is allocated after the ring is made.
- **`take(ring)` gives the number of the first record the reader has not taken**, and takes every record up to `ring.written`: a view reads the records from there to `written`. The first `take` of a ring gives `written`, so a view shows what happens from now on, not what happened before it looked. A new run is a new state and so a new ring, which the reader tells by which object it is handed; `reset` forgets the ring, for a view that starts again on the same run. A reader follows a ring whose `written` only grows.
- **A ring only views read is lossy.** A view that looks after more than `capacity` pushes has missed the oldest: `take` then gives `written - capacity`. Size it for what a frame's steps can push.
- **The step pushes and never reads it back**, so it cannot change what a run does, and the game's state hash leaves it out, as it leaves out its cue counters. A reader writes nothing to the ring, so two views read one ring with a reader each, and a view still never changes a run's state.
- **A ring the rules pop or read is state**, like any other field. `pop` forgets the newest record and returns its slot, or -1 when none is held, and `length` counts the records still held, `capacity` at most. `clear` forgets them all. An undo history is one: each turn pushes a record, and an undo pops it. A state hash covers such a ring, and no reader follows it. A reader is told of no `pop` or `clear`: all it can do is start again at `written` when it finds `written` below what it took, so it misses records pushed after one.
- **A capacity that is not a whole number of 1 or more is a `RangeError`.**

## The state hash

A state hash is a 32-bit digest of the numbers a game lists from a run's state, in a fixed order. Lockstep peers compare it to notice a desync, and a replay test pins one. The game writes the list, since the kit never looks inside a state ([ADR-0007](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0007-no-runtime-snapshots.md)), and the kit folds it: `StateHasher` takes one number at a time, and `visitPool` lists a pool's live entities.

```ts
import { StateHasher, visitPool } from "arcadekit/core";
import type { Pool } from "arcadekit/core";

const CAR_LAYOUT = { x: Float32Array, speed: Float32Array, lap: Uint8Array };

interface Race {
  time: number;
  metres: number;
  readonly cars: Pool<typeof CAR_LAYOUT>;
  /** Horn blasts, counted for the sound view alone. */
  horns: number;
}

const hasher = new StateHasher();

/** The race's state hash: every number its rules read, in one fixed order. */
const hashRace = (race: Race): number => {
  hasher.reset().number(race.time).number(race.metres);
  visitPool(race.cars, hasher.number);
  return hasher.digest();
};
```

- **`StateHasher` is FNV-1a, 32 bits, over each number's eight bytes as a float64**, so a change in any bit shows: 0 and -0 have different digests. A NaN is the exception: every NaN has the same digest, since an engine may hold one in any of its bit patterns and no rule can tell them apart. `number` folds one number in and allocates nothing, `digest` gives an unsigned 32-bit integer, and `reset` starts again, so one hasher serves every hash.
- **`visitPool` calls its `visit` with the pool's `count`, then with each field's live values**, one field at a time in the layout's order, and with nothing past `count`. It allocates nothing either, so a host can take a hash after every step. It does not visit an identified pool's ids: they follow from the order of its adds and removes.
- **What is not listed is not hashed.** A cue counter, a ring only views read, or anything else a view alone reads, is left out by not being listed ([ADR-0014](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md)): `horns` above. Scratch a step fills and reads back within one step is left out the same way.
- **`number` is a function of its own**, so it is passed where a function is asked for, as `visitPool`'s `visit` above. A game that folds the same list a second way, such as a trace after every step of a long run, writes the list as a function that takes `add` (`visitRace(race, add)`) and passes it `hasher.number`.
- **A host or a test takes a hash, between steps.** The rules never read one.

See [ADR-0003](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0003-one-fixed-step-clock.md) (one fixed-step clock), [ADR-0006](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0006-identified-pools-reuse-ids.md) (identified pools), [ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md) (a step uses only exact math) and [ADR-0023](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0023-a-step-tells-its-views-what-happened-through-a-ring-of-records.md) (a ring of records from a step to its views).
