# Determinism

A step gives the same bits on every peer and in every replay: the same seed, config, inputs and commands give the same run. That is what lets a test pin a long run by its hash, and lockstep peers play one run while sending each other nothing but their inputs. Three rules make it so, and a step that breaks one drifts, on one machine first:

- **Its time comes in as an argument**: the step's fixed `dt` ([Steps and frames](steps-and-frames.md)). A step reads no clock.
- **Its randomness comes from the run's `Rng`**, which `create` makes from the seed the run starts with (`Rng.make(seed)`) and keeps in the state. A step calls no `Math.random`.
- **Its math is exact**: the functions below, never `Math.sin` or `**`.

The state hash says when a run went wrong anyway: peers compare it, and a replay test pins it.

## Exact math

A step must give the same bits in every JavaScript engine, or lockstep peers drift apart. Each engine approximates `Math.hypot`, `Math.sin`, `Math.cos` and `**` in its own way, so a step calls none of them. It calls these, which use only operations every engine computes exactly:

| Function | What it gives |
| --- | --- |
| `ExactMath.hypot2(x, y)` | The length of (x, y): `Math.sqrt(x * x + y * y)` |
| `ExactMath.sin(x)`, `ExactMath.cos(x)` | The sine and cosine of `x` radians, within 2^-52 of `Math`'s for \|x\| up to 1000 |
| `ExactMath.powInt(base, exponent)` | `base` raised to a whole `exponent`, by square-and-multiply. A `RangeError` for any other exponent |
| `ExactMath.clamp(value, min, max)` | `value`, kept between `min` and `max` |
| `ExactMath.lerp(from, to, t)` | `from + (to - from) * t` |
| `ExactMath.hashCell(col, row)` | A well-spread unsigned 32-bit integer from two whole numbers: take `% count` of it, or divide it by 2^32 |
| `Point2.clampLength(point, x, y, max)` | Writes (x, y) into `point`, shortened to `max` if longer, and returns the length it had |
| `Point2.moveToward(point, x, y, targetX, targetY, maxStep)` | Writes into `point` the place at most `maxStep` from (x, y) toward the target: the target itself once it is that near |

There is no vector class: a position is two fields of a pool or of the state, and a step allocates nothing per entity. A function that gives two numbers writes them into a `Point2` its caller made once and owns. The axes are x and y, as `SpatialGrid`'s are: a 3D game on a ground plane passes z as y. `clampLength`'s `max` and `moveToward`'s `maxStep` are 0 or more.

```ts
import { ExactMath, Point2 } from "arcadekit/core";

interface Racer {
  x: number;
  z: number;
}

const SPEED = 6;
const COIN_SPEED = 18;
// Where the helpers write: one point for the whole run, read back before the next call.
const point = Point2.make(0, 0);

/** Moves a racer by its stick: a stick pushed into a corner is longer than 1, and no faster. */
const drive = (racer: Racer, stickX: number, stickZ: number, dt: number) => {
  Point2.clampLength(point, stickX, stickZ, 1);
  racer.x += point.x * SPEED * dt;
  racer.z += point.y * SPEED * dt;
};

/** Flies a coin to the racer that collects it, and lands on it without passing it. */
const collect = (coin: Racer, racer: Racer, dt: number) => {
  Point2.moveToward(point, coin.x, coin.z, racer.x, racer.z, COIN_SPEED * dt);
  coin.x = point.x;
  coin.z = point.y;
};

/** Which of a tile's variants a view draws at a cell: the same on every frame, from no state. */
const tileVariant = (col: number, row: number, variants: number): number =>
  ExactMath.hashCell(col, row) % variants;
```

A genre that needs another function, such as `atan2`, writes an exact version first.

## Picking with the Rng

`Rng.int(rng, max)` gives a whole number from 0 up to `max`, and `Rng.range(rng, min, max)` a number from `min` up to `max`, each short of `max`. Each draw moves the generator on, and every later draw of the run follows from it, so a step draws the same number of times, in the same order, on every peer.

`Rng.pickDistinct(rng, items, count)` draws `count` items without repeats: it moves them to the front of `items`, in place, and returns how many, which is `items.length` if there are fewer. It takes an array or a typed array, so a pick of pool indices allocates nothing. It reorders what it takes, so a `readonly` list is a type error: pick from a copy of a list that runs share, such as the game's content.

```ts
import { Rng } from "arcadekit/core";

const rng = Rng.make(7);
const upgrades = ["boost", "magnet", "shield", "tyres", "horn"];

// Three of the five, in the order drawn. The rest follow, so nothing is lost.
const count = Rng.pickDistinct(rng, upgrades, 3);
const offer = upgrades.slice(0, count);
```

It draws once for each item it picks, the last one included, and every later draw of the run follows from that: the number of draws is part of its contract. So `count` is a whole number of 0 or more, and any other is a `RangeError`.

## The state hash

A state hash is a 32-bit digest of the numbers a game lists from a run's state, in a fixed order. Lockstep peers compare it to notice a desync, and a replay test pins one. The game writes the list, since the kit never looks inside a state, and the kit folds it: `StateHash.add` takes one number at a time, and `EntityPool.visit` lists a pool's live entities.

```ts
import { EntityPool, StateHash } from "arcadekit/core";

const CAR_LAYOUT = { x: Float32Array, speed: Float32Array, lap: Uint8Array };

interface Race {
  time: number;
  metres: number;
  readonly cars: EntityPool.EntityPool<typeof CAR_LAYOUT>;
  /** Horn blasts, counted for the sound view alone. */
  horns: number;
}

const hash = StateHash.make();
/** Folds one number in: what a list that takes `add` is given, made once. */
const add = (value: number): void => {
  StateHash.add(hash, value);
};

/** The race's state hash: every number its rules read, in one fixed order. */
const hashRace = (race: Race): number => {
  StateHash.reset(hash).pipe(
    StateHash.add(race.time),
    StateHash.add(race.metres)
  );
  EntityPool.visit(race.cars, add);
  return StateHash.digest(hash);
};
```

- **A `StateHash` is FNV-1a, 32 bits, over each number's eight bytes as a float64**, so a change in any bit shows: 0 and -0 have different digests. A NaN is the exception: every NaN has the same digest, since an engine may hold one in any of its bit patterns and no rule can tell them apart. `StateHash.add` folds one number in and allocates nothing, `StateHash.digest` gives an unsigned 32-bit integer, and `StateHash.reset` starts again, so one state hash serves every hash.
- **`EntityPool.visit` calls its function with the pool's `count`, then with each field's live values**, one field at a time in the layout's order, and with nothing past `count`. It allocates nothing either, so a host can take a hash after every step. It does not visit an identified pool's ids: they follow from the order of its adds and removes.
- **What is not listed is not hashed.** A cue counter, a ring only views read, or anything else a view alone reads, is left out by not being listed: `horns` above. Scratch a step fills and reads back within one step is left out the same way.
- **A list that takes `add` is given a function made once**, such as `add` above, which folds into one state hash: `EntityPool.visit` takes it as its function. A game that folds the same list a second way, such as a trace after every step of a long run, writes the list as a function that takes `add` (`visitRace(race, add)`) and passes it each folder in turn.
- **A host or a test takes a hash, between steps.** The rules never read one.
