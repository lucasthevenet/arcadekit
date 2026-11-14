# Performance baseline

What the kit's hot paths cost before the Effect-style rework ([ADR-0024](adr/0024-the-kit-is-written-as-effect-modules.md)). The rework moves code that was plain only for speed to Effect, and defers performance: it is fixed later, against these numbers. `pnpm bench` (`scripts/bench/`) prints them.

## What it measures

The hot paths [ADR-0017](adr/0017-effect-at-the-edges-plain-code-inside.md) measured, each as a game runs it:

- **survivors step**: survivors' step at its largest test population, a horde held at the 300 enemies its world tests cap it at (`world.test.ts`), with one hero that the horde can't kill, stepped by `Game.Loop` one step per frame. The unit is one step.
- **engine frame**: a declared engine attached on `ManualFrames` (`arcadekit/game/testing`), whose every frame steps a small run once and draws it: the frame loop's fiber, its `Effect.try`, the loop and the view. The unit is one frame.
- **lockstep tick**: a host and a guest of the test game (`arcadekit/net/testing`) over the in-memory network, as scoped sessions run on `manualTicker`, on a Clock the bench moves 4 ms a tick. The unit is one tick of both peers and the network's delivery.

Each workload is the same on every run: seeded, with its time given by the bench. The wall time is the median of five rounds, after a warm-up. The heap allocated is counted over one more round, from a collected heap, with a young generation too large to collect during it and the engine's compiler on the main thread (`--single-threaded`), so it is the same on every run of one machine and Node version. It counts the spaces that hold a program's objects, not compiled code.

## Baseline

Measured at `f4c91e8`, before any of the rework, on:

- Node v22.23.4, linux x64 (kernel 6.18), Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, 15 GiB, in a shared cloud VM.

| Hot path | Wall time (three runs) | Heap allocated |
| --- | --- | --- |
| survivors step (297 enemies on average) | 131.44, 151.35, 127.13 µs/step | 662 B/step |
| engine frame (`ManualFrames`) | 0.86, 0.80, 1.37 µs/frame | 259 B/frame |
| lockstep tick (2 peers, 9,119 steps) | 11.21, 11.97, 12.33 µs/tick | 479 B/tick |

The wall time moves from run to run by up to a fifth on this machine, a VM shared with other work: compare a change against several runs, on one machine. The heap allocated did not move at all across runs.

## Comparing a change

Run `pnpm bench` on the same machine before and after it. A rework that turns plain code into Effect will cost time and allocation here, and that is expected: say how much in its PR, against this table, and leave the fix to the performance work that follows. A change to the simulation's rules changes what a step does, so its numbers are not comparable.

## Since the baseline

Each rework adds a row. Its numbers come from five runs of `pnpm bench` on its branch, interleaved with five on the baseline commit, on the same machine, so both saw the same load: the median wall time with the range, and the heap allocated, which was the same on every run.

| Commit | survivors step | engine frame | lockstep tick |
| --- | --- | --- | --- |
| The baseline, run beside the row below | 118.5 µs (110.6–122.0), 662 B | 0.94 µs (0.76–1.25), 259 B | 11.2 µs (10.6–12.9), 479 B |
| `arcadekit/core` in Effect's shape ([ADR-0024](adr/0024-the-kit-is-written-as-effect-modules.md)) | 149.9 µs (142.8–159.1), 1,187 B | 0.82 µs (0.72–1.18), 609 B | 12.1 µs (11.4–18.9), 285 B |
| The baseline, run beside the row below | 92.4 µs (90.3–103.6), 662 B | 0.62 µs (0.60–0.89), 259 B | 8.8 µs (8.4–11.2), 479 B |
| `arcadekit/input` in Effect's shape | 127.3 µs (117.8–131.7), 1,187 B | 0.61 µs (0.58–0.64), 609 B | 8.5 µs (8.1–8.6), 285 B |
| The baseline, run beside the row below | 101.4 µs (95.0–112.1), 662 B | 0.71 µs (0.71–1.00), 259 B | 9.9 µs (9.1–14.6), 479 B |
| `arcadekit/content` in Effect's shape | 130.8 µs (111.5–149.5), 1,187 B | 0.64 µs (0.59–0.73), 609 B | 9.1 µs (8.6–10.2), 285 B |
| The baseline, run beside the row below | 132.4 µs (123.1–148.6), 662 B | 0.89 µs (0.83–2.02), 259 B | 12.6 µs (12.0–18.2), 479 B |
| `arcadekit/save` in Effect's shape | 158.5 µs (150.7–166.8), 1,187 B | 0.82 µs (0.80–1.20), 609 B | 12.5 µs (12.3–14.2), 285 B |
| The baseline, run beside the row below | 93.1 µs (91.0–96.3), 662 B | 0.70 µs (0.65–0.93), 259 B | 8.8 µs (8.7–9.2), 479 B |
| `arcadekit/audio` in Effect's shape | 119.7 µs (112.0–137.6), 1,187 B | 0.64 µs (0.62–0.73), 609 B | 9.1 µs (8.7–9.2), 285 B |
| The baseline, run beside the row below | 105.0 µs (98.3–110.6), 662 B | 0.75 µs (0.70–0.77), 259 B | 10.8 µs (9.0–14.4), 479 B |
| `arcadekit/render-three` in Effect's shape | 137.9 µs (132.8–143.7), 1,187 B | 0.72 µs (0.68–0.89), 609 B | 10.7 µs (10.5–12.5), 285 B |
| The baseline, run beside the row below | 100.0 µs (92.7–103.2), 662 B | 0.73 µs (0.67–1.04), 259 B | 8.8 µs (8.6–9.1), 479 B |
| `arcadekit/game` in Effect's shape | 111.8 µs (111.7–118.5), 1,187 B | 0.74 µs (0.71–0.77), 1,124 B | 8.9 µs (8.8–9.3), 285–286 B |
| The baseline, run beside the row below | 106.7 µs (97.7–115.0), 662 B | 0.74 µs (0.65–0.83), 259 B | 10.2 µs (8.8–10.6), 479 B |
| `arcadekit/foldkit` in Effect's shape | 138.5 µs (132.8–144.2), 1,187 B | 0.86 µs (0.82–0.88), 1,124 B | 9.6 µs (8.5–10.6), 285–286 B |

Core stayed plain; what moved is its shape. A step calls core through `dual` functions and reads state from fields on a prototype, where it called closures and class methods. Survivors' step runs about a quarter slower and allocates 525 B more; an engine frame, whose loop advances a `FixedStepClock` and drains an `EventBuffer` through them, allocates 350 B more in the same time; a lockstep tick allocates 194 B less, for a reason not yet found. The performance work starts from these.

No workload makes an input controller: each reads a script in its place (survivors' hero walks a circle, the engine's run reads nothing, each lockstep peer adds a count). So input's row is core's, within the wall time's noise, and allocates the same to the byte. Core's commit, run in the same rounds, gave 122.6 µs (115.4–133.6), 0.58 µs (0.57–0.64) and 8.3 µs (8.1–12.4). The baseline ran faster on this machine than on the one beside core's row.

No workload loads a content or an asset: survivors' step is given content its Schema decoded once, before anything is timed, and the engine's run and the lockstep peers take theirs as a config. So content's row is input's, within the wall time's noise, and allocates the same to the byte. Input's commit, run in the same rounds, gave 126.4 µs (112.4–142.1), 0.58 µs (0.58–0.78) and 8.8 µs (8.7–9.5).

No workload reads or writes a save or a setting: what a game keeps between sessions is read at startup and written when a run ends, never in a step or a frame. So save's row is content's, within the wall time's noise, and allocates the same to the byte. Content's commit, run in the same rounds, gave 177.6 µs (150.8–186.1), 0.83 µs (0.80–1.16) and 14.5 µs (12.0–20.7). The baseline ran as `3df4d41`, the baseline commit with `pnpm bench` added and nothing else.

No workload plays a sound: survivors' step and the lockstep peers draw nothing, and the engine's run draws with a view that plays nothing, so no audio system is made. So audio's row is save's, within the wall time's noise, and allocates the same to the byte. Save's commit, run in the same rounds, gave 122.1 µs (111.5–127.4), 0.61 µs (0.58–0.64) and 8.8 µs (8.6–9.4). The baseline ran as `3df4d41`, on an Intel(R) Xeon(R) Processor @ 2.30GHz with the same Node.

No workload draws with Three.js: the engine's run draws with a view of its own that touches no stage, batch or camera. So render-three's row is audio's, within the wall time's noise, and allocates the same to the byte. Audio's commit, run in the same rounds, gave 129.4 µs (119.1–151.6), 0.65 µs (0.63–0.71) and 8.7 µs (8.6–10.9). The baseline ran as `3df4d41`. A view frame does change: survivors' scene drawing the survivors workload's horde of 300 into its batches, a frame, bundled and counted as these are but not kept in `pnpm bench`, took 28.8 µs (27.4–29.4) and 3,598 B on audio's commit, and 61.2 µs (57.7–63.6) and 1,673 B on render-three's, over five interleaved runs each. A sprite is drawn through `dual` functions where it was drawn through a batch's methods. `InstancedSprites.push` and `setTint`, whose last argument is optional, are `dual`s that take a predicate, which reads each call's `arguments`: one that tests its first argument instead brought the frame to about 50 µs.

Game's rework moves the frame loop's wait to Effect: each frame is an `Effect.callback` of its own, which succeeds with the frame's time and gives back its canceller, and its `Effect.try` is made around that time, where one wait and one `Effect.try` were shared by every frame. So an engine frame allocates 515 B more, and takes about a seventh of a microsecond longer than on audio's commit. The engine's methods are traced too, but the engine's workload starts and attaches before its timed rounds and sends nothing. Survivors' step and the lockstep tick run the same loop, made with `Game.makeLoop`, and are audio's row within the wall time's noise. The lockstep tick allocated 286 B in some rounds and 285 B in the others, the first heap count of the bench that moved between runs of one commit; its cause is not yet found. Audio's commit (`16c7646`), run in the same rounds, gave 118.8 µs (114.5–137.7), 0.60 µs (0.58–0.77) and 9.0 µs (8.5–10.8), with the heap of save's row.

No workload runs a Foldkit app: the engine's run is attached on `ManualFrames` by the bench itself, with no viewport, no engine entry and no key presses, and survivors' step and the lockstep peers draw nothing. So foldkit's row is game's, within the wall time's noise, and allocates the same to the byte. `main` at game's merge (`10ccf4c`), run in the same rounds, gave 138.9 µs (130.2–155.4), 0.86 µs (0.80–1.19) and 9.7 µs (8.8–12.1), with the same heap. The baseline ran as `3df4d41`.
