# Steps and frames

A run changes only at a step: by the step's input, and by the commands applied at its start. A step is a fixed slice of the run's time, 1/60 s unless the simulation declares another, and a frame is whatever its host draws or ticks on, which runs as many whole steps as its time pays for. So the rules see the same steps on a fast machine and a slow one, in a replay and on every lockstep peer, and their time comes in as an argument, never from a clock of their own.

## A loop

A loop steps a run in frames: `Game.makeLoop(simulation)` makes one, a `Game.Loop`. A frame is one `loop.frame(input, budget, nowMs)` call: its caller says where each step's input comes from, how much the frame steps and what time it is, so the loop needs no DOM and reads no clock. A test, a replay, the browser engine and a lockstep session all step a game through it, in one order.

- **The budget** is a `Game.FrameBudget`: `{ seconds }` of time passed, or exactly `{ steps }`. An attached engine passes the seconds since its last animation frame. The loop turns them into whole steps on the simulation's fixed clock (`stepSeconds`, 1/60 s unless the simulation declares another) and carries the rest to the next frame. It counts at most 0.25 s of one frame, so a hidden tab or a debugger pause doesn't fast-forward the game, and it runs at most five steps a frame: a frame further behind than that drops its backlog. Tests, replays and lockstep pass `{ steps }`, which runs exactly that many, with no clamp and nothing carried.
- **Each step** is the input source's `read(step)`, then the commands sent since the last step, then `step`, then the source's `endStep`. Steps are numbered from 0 in each run. After the frame's last step comes the source's `endFrame`, once, if any step ran; then the events those steps reported; then a sample, if one is due.
- **The input source** is a `Game.StepInput`: `read(step)`, with `endStep` and `endFrame` if it needs them. A script reads by the step's number and a device ignores it. `read` runs inside the step loop, so it returns the same object each time, refilled. A source that reads presses forgets them in `endStep` ([an input controller](../guides/input.md)'s `InputController.consumePresses`), so one press reaches one step even on a slow frame that runs several; what it does once a frame, such as polling gamepads, goes in `endFrame`.
- **`frame` returns the steps it ran**: none with no run, while paused (`loop.setPaused(true)`: the frame's time is discarded, and commands wait), or while a `{ seconds }` frame is still short of a step.

`FixedStepClock` ([`arcadekit/core`](../../packages/arcadekit/src/core/README.md)) is the clock under a loop, which turns a frame's time into whole fixed steps. A loop uses it for you: a game calls it only to step something that is no declared simulation.

## Who steps a run

The same loop is under every host, so a run steps alike in each:

| Host | Its frames |
| --- | --- |
| [A scenario](../testing/scenarios.md) | `{ steps }`: the steps a test names |
| A replay, or a server | `{ steps }`, by hand, with the inputs it recorded |
| [An engine](../guides/engine.md) | `{ seconds }`: the time since its last animation frame |
| [A lockstep session](../guides/lockstep-sessions.md) | `{ steps }`: the steps the host has confirmed every player's input for |
