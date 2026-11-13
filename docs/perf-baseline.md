# Performance baseline

What the kit's hot paths cost before the Effect-style rework ([ADR-0024](adr/0024-the-kit-is-written-as-effect-modules.md)). The rework moves code that was plain only for speed to Effect, and defers performance: it is fixed later, against these numbers. `pnpm bench` (`scripts/bench/`) prints them.

## What it measures

The hot paths [ADR-0017](adr/0017-effect-at-the-edges-plain-code-inside.md) measured, each as a game runs it:

- **survivors step**: survivors' step at its largest test population, a horde held at the 300 enemies its world tests cap it at (`world.test.ts`), with one hero that the horde can't kill, stepped by `Game.Loop` one step per frame. The unit is one step.
- **engine frame**: a declared engine attached on `manualFrames` (`arcadekit/game/testing`), whose every frame steps a small run once and draws it: the frame loop's fiber, its `Effect.try`, the loop and the view. The unit is one frame.
- **lockstep tick**: a host and a guest of the test game (`arcadekit/net/testing`) over the in-memory network, as scoped sessions run on `manualTicker`, on a Clock the bench moves 4 ms a tick. The unit is one tick of both peers and the network's delivery.

Each workload is the same on every run: seeded, with its time given by the bench. The wall time is the median of five rounds, after a warm-up. The heap allocated is counted over one more round, from a collected heap, with a young generation too large to collect during it and the engine's compiler on the main thread (`--single-threaded`), so it is the same on every run of one machine and Node version. It counts the spaces that hold a program's objects, not compiled code.

## Baseline

Measured at `f4c91e8`, before any of the rework, on:

- Node v22.23.4, linux x64 (kernel 6.18), Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, 15 GiB, in a shared cloud VM.

| Hot path | Wall time (three runs) | Heap allocated |
| --- | --- | --- |
| survivors step (297 enemies on average) | 131.44, 151.35, 127.13 µs/step | 662 B/step |
| engine frame (`manualFrames`) | 0.86, 0.80, 1.37 µs/frame | 259 B/frame |
| lockstep tick (2 peers, 9,119 steps) | 11.21, 11.97, 12.33 µs/tick | 479 B/tick |

The wall time moves from run to run by up to a fifth on this machine, a VM shared with other work: compare a change against several runs, on one machine. The heap allocated did not move at all across runs.

## Comparing a change

Run `pnpm bench` on the same machine before and after it. A rework that turns plain code into Effect will cost time and allocation here, and that is expected: say how much in its PR, against this table, and leave the fix to the performance work that follows. A change to the simulation's rules changes what a step does, so its numbers are not comparable.
