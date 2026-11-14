---
name: performance
description: Benchmarks. Use when a change touches a step, a frame, a lockstep tick or a view's per-frame code, or moves code between plain and Effect.
---

`pnpm bench` times the kit's hot paths and counts the bytes each allocates ([`scripts/bench/hot-paths.ts`](../../../scripts/bench/hot-paths.ts)): survivors' step at its largest population, an engine's frames, and a lockstep run's ticks. A number means something only beside another taken on the same machine.

1. Make the tests that cover the change pass first.
2. Run `pnpm bench` on the base commit and on the change, on the same machine, one after the other. Run each twice if a time moves between runs.
3. Give both tables in the PR. A step over many entities allocates nothing per entity, so bytes that grow with the population are a regression whatever the times say.

A new hot path goes into `hot-paths.ts` in the change that adds it.
