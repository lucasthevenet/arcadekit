---
status: accepted
---

> Confirmed by [ADR-0012](0012-delay-based-lockstep-over-a-host-star.md) on 2026-11-04: #25 chose delay-based lockstep without rollback, and a desync stops the run instead of resyncing, so nothing needs a snapshot.

# The runtime keeps no snapshots of a run

The runtime never looks inside a run's state, and it has no way to snapshot or restore it (finding 11). Push-puzzle builds undo from a record of each turn, and a restart calls `start` again with the same config. Turn records are smaller and exact and keep the step free of allocation, while a snapshot per turn would allocate or need a pool of snapshots.

## Considered Options

- A snapshot and restore in the runtime. It would help tools, such as a solver or a rewind, and neither genre needs it to play.

## Consequences

- Push-puzzle's turn records sit in a ring of preallocated typed arrays: the player's cell, the pushed box's id and cell, and whether a hole was filled. The ring holds 2048 turns by default and drops the oldest first. (Since [ADR-0023](0023-a-step-tells-its-views-what-happened-through-a-ring-of-records.md), on 2026-11-13, the ring is made with core's `Ring.make` (named `createRing` until [ADR-0024](0024-the-kit-is-written-as-effect-modules.md)), where push-puzzle wrote its own: its rules pop it, so it is state.)
- A tool that needs a past state replays the run from its start, as the solver that checked the demo levels did.
- #23 can't save a run in progress. Its save holds records the app keeps outside the run, such as a level's best move count.
- #25's rollback netcode would reopen this, since rollback restores earlier states. Delay-based lockstep needs no snapshots. Resyncing a peer from the host's state after a desync would need the state serialized too.
