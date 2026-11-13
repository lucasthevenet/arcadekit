---
status: accepted
---

# A step tells its views what happened through a ring of records

A view needs to know what a step did: a hit and where it landed, a hole that was filled, an undo. The kit gave it two channels, and neither fits. An event is a rare, meaningful fact and never per-entity data ([ADR-0008](0008-events-are-rare-facts.md)), and a cue counter is a count with no place or amount ([ADR-0014](0014-sounds-come-from-cue-counters-read-by-the-presentation.md)). So each game found its own way, and each way has a cost:

- Grimbonk wrote the channel: three rings of typed arrays, each with a count of the records written that only grows, the functions its rules push with, and the reader each of its views keeps. Its hash leaves them out.
- Push-puzzle's view compared the state with last frame. It kept every tile it last saw and which boxes were on the board, searched a box's four neighbours for the hole it fell in, and read a sound's counter to learn of an undo ([finding 12](../push-puzzle-findings.md)).
- Survivors keeps the view's timers in the rules' state: `hitFlash` on every enemy and `hurtTimer` on every hero. The rules lower them each step and never read them, and the state hash covers them.
- Push-puzzle's undo history was the same storage with another use: a ring of turn records in typed arrays, written by hand ([ADR-0007](0007-no-runtime-snapshots.md)).

All three games show the need, and two wrote a ring ([ADR-0001](0001-kit-changes-need-two-genres.md)).

## Decision

**A ring of records is a primitive of `arcadekit/core`.** `createRing(capacity, layout)` makes a fixed number of records stored as one typed array per field, as a pool's entities are. Record n, counted from 0, is in slot `n % capacity`, so a new record overwrites the oldest. `push` reserves the next slot with every field 0, `pop` forgets the newest record, `written` counts the records pushed and not popped, and `length` those still held. Nothing is allocated after the ring is made, so a step that pushes a record allocates nothing. No game supplies a ring as a part under a name of its own, so it is no declaration ([ADR-0020](0020-a-game-is-declared.md)).

**A ring is one of two things**, and the game says which by where it keeps it and what its rules do with it:

- **A ring only views read** carries what a step did. The step pushes and never reads it back, so it cannot change what a run does, and its `written` only grows. The game's state hash leaves it out, as it leaves out its cue counters. It is lossy: a view that looks after more than `capacity` pushes has missed the oldest. This carries ADR-0014's rule from a count to a record: a moment that needs a place or an amount is a record, under the same rule.
- **A ring the rules pop or read** is state, like any other field: push-puzzle's undo history. A state hash covers it, and no reader follows it.

**Each view takes what is new with a reader of its own.** A `RingReader` is how far one view has read one ring. `take(ring)` gives the number of the first record the reader has not taken, and takes every record up to `ring.written`:

```ts
const { changes } = puzzle;
for (let n = this.seen.take(changes); n < changes.written; n++) {
  const i = changes.slotOf(n);
  this.sinkBox(changes.fields.box[i]!, changes.fields.cell[i]!, t);
}
```

- The first `take` of a ring gives `ring.written`: a view shows what happens from now on, not what happened before it looked. A new run is a new state and so a new ring, which the reader sees by identity.
- After that it gives where it stopped, or `ring.written - ring.capacity` if the ring has lapped it.
- If it finds `written` below what it took, the ring was popped or cleared, and it starts again at `written`. That is all it can see of either, so a reader follows a ring whose `written` only grows: a ring the rules pop or clear is not followed.

A view keeps one reader for each ring it reads, and two views read one ring with a reader each. A reader writes nothing to the ring, so a view still never changes a run's state.

## Considered options

- **An event for each hit.** ADR-0008 keeps events rare: an event is a new object made during a step and then a message in the UI, and survivors' hits can happen hundreds of times a second. Events also go to the app's listeners, and no view is handed them.
- **A timer in the state for each entity**, as survivors' `hitFlash` and `hurtTimer` are. It sits in the hash and costs a field on every entity, which the rules lower each step and never read. It says how long ago, and not where or how much.
- **A view that compares the state with last frame**, as push-puzzle's did. Each genre writes its own comparison, a frame of several steps loses moments, and "some moments (a kill) leave nothing behind to compare", as ADR-0014 says of sound. A box that fills a hole is gone in the same step, so the view had to search for the hole it fell in.

## Consequences

- Push-puzzle's undo history is made with `createRing`, and its own ring is deleted (`History`, `createHistory`, `pushRecord`, `popRecord`). The slots are the ones it had. `length` is a count of its own, as the history's was: a record that was overwritten is not popped, though `written` is still above 0. Its `historyCapacity` is a ring's capacity now, a whole number of 1 or more, and `createPuzzle` refuses any other: 0 used to give a run with no undo.
- Push-puzzle's rules push to `Puzzle.changes`, a ring of eight records only its view reads, what a turn did that the state no longer shows after it: the id of a box that filled a hole with the hole's cell, and an undo. The view reads it in place of comparing with last frame, which answers finding 12. The engine's frame runs at most five steps and a step holds at most one turn, so eight records lose nothing. Where a thing is drawn between two cells is still the view's own: its slides stay.
- Survivors keeps `hitFlash` and `hurtTimer` in its state. Its recorded hashes cover both, and moving a view's timer is no change to the rules. They move to a ring with the next change that re-records survivors on purpose.
- No recorded hash moved. Push-puzzle has no state hash, and its replay test compares the board, the boxes' ids and the counts, which no ring changes.
- A game sizes a ring only views read for what its steps push between two frames. A view that looks later than that, such as one in a tab that was hidden while its co-op run stepped, has missed the oldest records, as a sound view plays one sound for a counter's whole jump.
- Nothing walks a ring for a state hash yet: no game hashes one. Push-puzzle, whose rules pop a ring, has no hash.
