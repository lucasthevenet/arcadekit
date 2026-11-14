---
name: simulation
description: Simulation rules and determinism. Use when changing a step, a simulation's rules, `arcadekit/core`, the lockstep protocol, or anything every peer computes or hashes.
---

A step must give the same bits on every peer and every replay, or lockstep peers drift apart and replays stop matching. Lint holds the first two rules: the first on the genres' rules, `arcadekit/core`, `arcadekit/game` and the lockstep files of `arcadekit/net`, the second on the genres' rules and `arcadekit/core`. `oxlint.config.ts` lists those files: add a new file a step runs there.

- **No clock or random source of its own.** Time comes in as an argument (`dt`, `nowMs`), and randomness from the run's seeded `Rng`.
- **Exact math only.** Engines approximate `Math.hypot`, `sin`, `cos` and `**` differently, so a step calls `ExactMath` (`hypot2`, `sin`, `cos`, `powInt`). Only `+ - * /`, `Math.sqrt`, `round`, `floor`, `min`, `max`, `imul` and bit operations are exact in every engine.
- **No allocation per entity.** Keep large collections in an `EntityPool`. A function that gives two numbers writes them into a point it is handed (`Point2`).
- **Events are rare facts** for the app, reported with `report`; an event is a class instance, so reporting one allocates. What a view needs of each step goes through a `Ring` only views read, and sounds come from cue counters.
- **A run changes only at a step.** The loop applies a command at the start of the next step, and its `apply` takes it or returns one of the rejections the command declares.
- **The state hash folds what the game lists** (`StateHash`), in a fixed order: the kit never looks inside a state. What only a view reads, such as a cue counter or a ring, stays out by not being listed.

## Checking it

- A simulation's rules are checked with scenarios (`arcadekit/game/scenario`), which run a script of steps and commands in one call: `packages/push-puzzle/test/world.test.ts`.
- `packages/survivors/test/determinism.test.ts` and `replay.test.ts` pin hashes of whole runs. Keep them unless changing the rules is the point: then update them in the same change and say so in the changeset.
- `pnpm test:browsers` runs survivors' long run (`packages/survivors/src/internal/long-run.ts`) in Chromium, Firefox and WebKit, which must give the same hashes.
