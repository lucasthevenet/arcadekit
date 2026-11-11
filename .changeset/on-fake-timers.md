---
"arcadekit": minor
---

`arcadekit/net/testing` has `onFakeTimers(effect)`: what a test of a Co-op client on fake timers runs its Effects on. Nothing breaks: it only adds an export.

In Node, Effect reads its time from `process.hrtime` and runs its fibers on `setImmediate`, and a test's fake timers reach neither. A run's clock would stand still while its ticker's faked timer ran on. So each such test carried about forty lines: a `Clock` on the page's timers and a scheduler on microtasks, as Foldkit's is in the browser. The kit's own client tests had them, and so had the survivors demo's and grimbonk's ([co-op-findings.md](https://github.com/lucasthevenet/arcadekit/blob/main/docs/co-op-findings.md), finding 2).

`onFakeTimers` gives an Effect both, and changes nothing else of it: what it gives, fails with and needs.

```ts
import { onFakeTimers } from "arcadekit/net/testing";
import { Effect } from "effect";

// Before: the test's own Clock and scheduler, about forty lines above this.
const before = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Clock.Clock, performanceClock),
      Effect.provideService(Scheduler.Scheduler, microtasks)
    )
  );

// After
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(onFakeTimers(effect));
```

- Wrap every Effect the test runs or forks, the one that builds the client's layer first: a client takes its Clock and its scheduler from the Effect that made it.
- It fakes nothing itself and imports no test runner. Fake `performance` and `setTimeout`, and `setInterval` with `clearInterval` for a run on the default ticker; leave `queueMicrotask` real. The entry's README has it under "On fake timers".
