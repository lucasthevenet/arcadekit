---
status: accepted
---

# The runtime keeps no snapshots of a run

The runtime never looks inside a run's state, and it has no way to snapshot or restore it (finding 11). Push-puzzle builds undo from a record of each turn, and a restart calls `start` again with the same config. Turn records are smaller and exact and keep the step free of allocation, while a snapshot per turn would allocate or need a pool of snapshots.

## Considered Options

- A snapshot and restore in the runtime. It would help tools, such as a solver or a rewind, and neither genre needs it to play.

## Consequences

- Push-puzzle's turn records sit in a ring of preallocated typed arrays: the player's cell, the pushed box's id and cell, and whether a hole was filled. The ring holds 2048 turns by default and drops the oldest first.
- A tool that needs a past state replays the run from its start, as the solver that checked the demo levels did.
- #23 can't save a run in progress. Its save holds records the app keeps outside the run, such as a level's best move count.
- #25's rollback netcode would reopen this, since rollback restores earlier states. Delay-based lockstep needs no snapshots. Resyncing a peer from the host's state after a desync would need the state serialized too.
