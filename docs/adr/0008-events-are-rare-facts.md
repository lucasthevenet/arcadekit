---
status: accepted
---

# An event is a rare, meaningful fact

The simulation pushes events into an `EventBuffer` during a step, and the runtime drains it after the frame's steps (and after `start` and `modify`) and passes each event to the engine's listeners, such as the UI. An event is a rare, meaningful fact, such as "level solved" or "leveled up"; events never carry per-entity data, and the HUD gets the state through samples (`CONTEXT.md`, the README's rules of thumb). Each event is a new object made during a step and then a message in the UI, so events stay cheap only while they are rare.

## Consequences

- Survivors reports `levelUp` and `runEnded`, and push-puzzle reports `levelSolved`. Hits, shots, kills and pickups are not events: with about 750 enemies they can happen hundreds of times a second.
- A frame with no events allocates nothing for them, since `EventBuffer.drain` returns a shared empty array.
- A turn-based HUD also goes through a sample, timed by a version ([ADR-0005](0005-samples-on-a-timer-or-a-version.md)).
- #24 decides how sounds are triggered against this rule. New events fit push-puzzle, whose sound-worthy moments are turns. For survivors they would break the rule, or need cue events gathered per step, which allocate in the step loop.
