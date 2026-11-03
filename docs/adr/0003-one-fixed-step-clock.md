---
status: accepted
---

# Every genre runs on the runtime's fixed-step clock

The runtime has one time model: `GameDriver` advances a run in fixed steps, 1/60 s by default, using core's `FixedStepClock` in a `requestAnimationFrame` loop. Fixed steps make a run behave the same on any screen and keep it deterministic. Turn-based genres use the same clock and count steps: push-puzzle takes at most one turn per step, ignores `dt`, and times hold-to-repeat in steps, so its replays are exact (finding 10).

## Considered Options

- A turn-based time mode in the runtime, which #4 left for its own issue if the findings called for one. Finding 10 found no need. The fixed clock costs push-puzzle a call to `step` 60 times a second, and most of those steps hold no turn. The real frictions were elsewhere: `sample` ([ADR-0005](0005-samples-on-a-timer-or-a-version.md)) and the view (finding 12).

## Consequences

- A turn-based genre times things in steps. A held direction in push-puzzle moves on the press, again after 12 steps, then every 6. Repeat in the input layer would run on wall-clock time and break replays (finding 13).
- `GameView.render`'s `alpha` means little to a genre that jumps a cell per turn. Push-puzzle's view slides each move over real time.
- The clock throws time away on purpose. The driver counts at most 0.25 s per frame, and the clock drops its backlog after five catch-up steps. A hidden tab gets no frames, so its run pauses.
- #25 revisits this. Lockstep runs step N once every player's input for step N has arrived, and it can never drop a step. #25 expects a timer-driven step loop, or a Worker, with `requestAnimationFrame` only for drawing.
