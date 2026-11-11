---
status: accepted
---

# A sample runs on a timer, a version, or both

> Amended by [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md) on 2026-11-04: `GameSimulation.sample` holds these fields, and `everyMs` counts on the `nowMs` that `GameLoop`'s caller passes in: the frame time in the browser.

> Amended by [ADR-0020](0020-a-game-is-declared.md) on 2026-11-11: a game declares its sample in its `Game.Simulation` (`sample: { event, every, version, read }`), where `every` is a duration and the sample is delivered as the declared event. `GameSimulation` is the internal contract of the kernel under `Game.Loop` (`KernelSimulation`), which still counts `everyMs` on the time its caller passes in, and `GameDefinition` is gone. `modify` is gone too, so a sample by version follows a frame only. See the note on [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md).

A sample used to run only every so many milliseconds of real time, so push-puzzle's HUD lagged a turn by up to 100 ms and sent ten identical HUD events a second between turns (#16, finding 2). `GameDefinition.sample` now takes `everyMs` (real time), `version` (a cheap number the game bumps when what `read` reports may have changed), or both. The driver emits a sample when a run starts, each time `everyMs` has passed, and right after any frame or `modify` that changed the version.

## Considered Options

- A `turnTaken` event from push-puzzle. #4 ruled it out, because it would have hidden this finding inside the genre.
- Compare what `read` returns with the last sample (#16). That builds a sample every frame to compare it. PR #22 picked the version number.

## Consequences

- Survivors keeps `everyMs: 100`, since its HUD changes every step. Push-puzzle sets `version` to `puzzle.turns`.
- The driver reads the version once per frame, after all of the frame's steps, and after each `modify`. A number that changes and changes back in between hides the change, so a count that only goes up is safest. Push-puzzle counts turns, undos included, so its version never goes down.
- A sample reaches the UI as an event, through the same listeners as the run's own events ([ADR-0008](0008-events-are-rare-facts.md)).
- #24 may reuse the pattern for sound cues. Its option 3 has the simulation bump counters that the presentation side reads and clears once per frame, much as the driver reads `version`.
