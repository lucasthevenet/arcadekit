# Telling a view what a step did

A view needs to know what a step did: a hit and where it landed, a hole that was filled. An event is a rare fact for the app, and a cue counter is a count with no place or amount. A **ring** carries the rest: `Ring.make(capacity, layout)` makes a fixed number of records stored as one typed array per field, as a pool's entities are. The step pushes a record, and each view takes the records written since it last looked, with a `RingReader` of its own.

```ts
import { Ring, RingReader } from "arcadekit/core";

const BUMP_LAYOUT = {
  /** Where the two cars touched. */
  x: Float32Array,
  z: Float32Array,
  /** How hard, in metres a second. */
  speed: Float32Array,
};

interface Race {
  /** Bumps, for the views alone: the step pushes them and never reads them back. */
  readonly bumps: Ring.Ring<typeof BUMP_LAYOUT>;
}

const createRace = (): Race => ({ bumps: Ring.make(32, BUMP_LAYOUT) });

/** In the step: a record for the bump. Nothing is allocated. */
const bump = (race: Race, x: number, z: number, speed: number) => {
  const { bumps } = race;
  const i = Ring.push(bumps);
  bumps.fields.x[i] = x;
  bumps.fields.z[i] = z;
  bumps.fields.speed[i] = speed;
};

/** A view that draws a spark for each bump since its last frame. */
class SparkView {
  /** How far this view has read `bumps`. */
  private readonly seen = RingReader.make();
  private readonly spark: (x: number, z: number, speed: number) => void;

  constructor(spark: (x: number, z: number, speed: number) => void) {
    this.spark = spark;
  }

  render(race: Race): void {
    const { bumps } = race;
    for (let n = RingReader.take(this.seen, bumps); n < bumps.written; n++) {
      const i = Ring.slotOf(bumps, n);
      this.spark(
        bumps.fields.x[i]!,
        bumps.fields.z[i]!,
        bumps.fields.speed[i]!
      );
    }
  }
}
```

- **Record n, counted from 0, is in slot `n % capacity`**, which `Ring.slotOf(ring, n)` gives, and a new record overwrites the oldest. `Ring.push` reserves the slot of the next record and returns it with every field 0, so a step writes only the fields that start at something else. `written` counts the records pushed and not popped, and nothing is allocated after the ring is made.
- **`RingReader.take(reader, ring)` gives the number of the first record the reader has not taken**, and takes every record up to `ring.written`: a view reads the records from there to `written`. The first `take` of a ring gives `written`, so a view shows what happens from now on, not what happened before it looked. A new run is a new state and so a new ring, which the reader tells by which object it is handed; `RingReader.reset` forgets the ring, for a view that starts again on the same run. A reader follows a ring whose `written` only grows.
- **A ring only views read is lossy.** A view that looks after more than `capacity` pushes has missed the oldest: `RingReader.take` then gives `written - capacity`. Size it for what a frame's steps can push.
- **The step pushes and never reads it back**, so it cannot change what a run does, and the game's state hash leaves it out, as it leaves out its cue counters. A reader writes nothing to the ring, so two views read one ring with a reader each, and a view still never changes a run's state.
- **A ring the rules pop or read is state**, like any other field. `Ring.pop` forgets the newest record and returns its slot, or -1 when none is held, and `length` counts the records still held, `capacity` at most. `Ring.clear` forgets them all. An undo history is one: each turn pushes a record, and an undo pops it. A state hash covers such a ring, and no reader follows it. A reader is told of no `pop` or `clear`: all it can do is start again at `written` when it finds `written` below what it took, so it misses records pushed after one.
- **A capacity that is not a whole number of 1 or more is a `RangeError`.**
