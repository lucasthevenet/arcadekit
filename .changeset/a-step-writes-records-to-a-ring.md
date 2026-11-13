---
"arcadekit": minor
---

`arcadekit/core` gains `createRing`, a fixed ring of records in typed arrays that a step pushes to, and `RingReader`, with which a view takes the records written since it last looked. Nothing breaks.

A view needs to know what a step did: a hit and where it landed, a hole that was filled, an undo. An event is a rare fact for the app, and a cue counter is a count with no place or amount, so each game found its own way: a ring written by hand, a view that compared the state with last frame, a timer in the rules' state that only the view reads. The ring is the kit's now ([ADR-0023](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0023-a-step-tells-its-views-what-happened-through-a-ring-of-records.md)). Both exports are plain code, with no Effect, no clock and no allocation after they are made.

- **`createRing(capacity, layout)`.** A fixed number of records stored as one typed array per field, as a pool's entities are. Record n, counted from 0, is in slot `n % capacity`, which `slotOf(n)` gives: a new record overwrites the oldest. `push` reserves the next record's slot and returns it with every field 0. `pop` forgets the newest record and returns its slot, or -1 when none is held, and `clear` forgets them all. `written` counts the records pushed and not popped, and `length` those still held, `capacity` at most. A capacity that is not a whole number of 1 or more is a `RangeError`.
- **`RingReader`.** How far one view has read one ring. `take(ring)` gives the number of the first record the reader has not taken, and takes every record up to `ring.written`. The first `take` of a ring gives `written`: a view shows what happens from now on. After that it gives where it stopped, or `written - capacity` if the ring has lapped it, and it starts again at `written` for another ring, after `reset`, and when it finds `written` below what it took. It follows a ring whose `written` only grows: it is told of no `pop` or `clear`, so a ring the rules pop or clear is not followed. It writes nothing to the ring, so two views read one ring with a reader each.

A ring is one of two things, and the game says which by what its rules do with it:

- **A ring only views read** carries what a step did. The step pushes and never reads it back, so it cannot change what a run does, and the game's state hash leaves it out, as it leaves out its cue counters ([ADR-0014](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md)). It is lossy: a view that looks after more than `capacity` pushes has missed the oldest.
- **A ring the rules pop or read** is state, like any other field, such as an undo history. A state hash covers it, and no reader follows it.

```ts
import { RingReader, createRing } from "arcadekit/core";

const hits = createRing(64, {
  x: Float32Array,
  z: Float32Array,
  amount: Uint16Array,
});

// In the step: one record for the hit.
const hit = (x: number, z: number, amount: number) => {
  const i = hits.push();
  hits.fields.x[i] = x;
  hits.fields.z[i] = z;
  hits.fields.amount[i] = amount;
};

// In a view, on each frame: the hits since its last one.
const seen = new RingReader();
const render = (show: (x: number, z: number, amount: number) => void) => {
  for (let n = seen.take(hits); n < hits.written; n++) {
    const i = hits.slotOf(n);
    show(hits.fields.x[i]!, hits.fields.z[i]!, hits.fields.amount[i]!);
  }
};
```

Push-puzzle uses both kinds. Its undo history is a ring its rules pop, in place of one it wrote by hand, and its rules push what a turn did that the board no longer shows to a ring its view reads: a box that filled a hole, and an undo. The view no longer compares the board with last frame.

Every export is new, and no recorded hash moved.
