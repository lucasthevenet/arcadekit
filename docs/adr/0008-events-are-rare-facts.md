---
status: accepted
---

# An event is a rare, meaningful fact

> Amended by [ADR-0020](0020-a-game-is-declared.md) on 2026-11-11: a declared simulation reports an event with `report`, and `Game.Loop` keeps the buffer. Events are delivered after `start` and after a frame's steps; `modify` is gone. See the note on [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md).

The simulation pushes events into an `EventBuffer` during a step, and the runtime drains it after the frame's steps (and after `start` and `modify`) and passes each event to the engine's listeners, such as the UI. An event is a rare, meaningful fact, such as "level solved" or "leveled up"; events never carry per-entity data, and the HUD gets the state through samples (`CONTEXT.md`, the README's rules of thumb). Each event is a new object made during a step and then a message in the UI, so events stay cheap only while they are rare.

## Consequences

- Survivors reports `levelUp` and `runEnded`, and push-puzzle reports `levelSolved`. Hits, shots, kills and pickups are not events: with about 750 enemies they can happen hundreds of times a second.
- A frame with no events allocates nothing for them, since `EventBuffer.drain` returns a shared empty array.
- A turn-based HUD also goes through a sample, timed by a version ([ADR-0005](0005-samples-on-a-timer-or-a-version.md)).
- #24 decided how sounds are triggered against this rule: not by events, but by cue counters in the state that the presentation reads ([ADR-0014](0014-sounds-come-from-cue-counters-read-by-the-presentation.md)).
