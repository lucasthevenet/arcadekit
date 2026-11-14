---
name: testing
description: Tests. Use when adding or changing tests of arcadekit or a demo, its genre included.
---

- An entry's tests are in `packages/arcadekit/test/<entry>/`, in the folder the module has in `src/`, and none is in `src/`. A demo's are in its own `test/`, its genre's in `test/<genre>/`, in the folder the module has in `src/<genre>/`.
- `pnpm test <files>` runs the files that cover a change; `pnpm test` alone runs every suite once. The kit is tested from `src/`, with no build.
- A simulation's rules are checked with scenarios (`arcadekit/game/scenario`), as in `examples/push-puzzle-demo/test/push-puzzle/world.test.ts`. The rest is tested through what a game calls.
- The kit's test helpers are entries only tests import: `ManualFrames` (`arcadekit/game/testing`) drives an engine's frames in the test's own call; `arcadekit/net/testing` has `FakeCoopRooms`, `ManualTicker`, `PageTimers` (the Clock and scheduler of a test on fake timers) and `TestGame`; `arcadekit/render-three/testing` has a sheet with no image and what a batch shows.
- A test of a declaration declares a small game of its own, written as a game would write it.
- Types are checked with `expectTypeOf`, and with `// @ts-expect-error` on the line directly above a line that must not compile.
- Every refusal's message has a test.
- A test of an Effect that can fail compares the error (`Effect.flip`) or its cause's reasons, not the whole `Exit`: a span annotates the cause with its stack, so `Exit.fail(error)` doesn't equal it. `packages/arcadekit/test/content/declarations.test.ts` has a `failures(exit)` that lists the reasons.
