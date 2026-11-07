---
status: accepted
---

# Effect at the edges, plain code inside

The kit is built on Effect 4, and #52-#55 moved its coordination code to Effect: the engine's frame loop, the lockstep session's shell, the signalling client and worker, the WebRTC links and the co-op client. Some code stays plain on purpose. Without a written rule, an agent or contributor following a stricter guide (the contributor rules of effect-smol, Effect 4's beta repository, ban `try`/`catch`; Alchemy's require even `Buffer` and `TextEncoder` to be wrapped in `Effect.sync`) would wrap exactly the code where wrapping hurts, and one following no guide would drift the other way.

Effect's docs describe it as "an app-level coordination library rather than a low-level operation wrapper" ([Myths](https://effect.website/myths)), recommend plain arrays for collection transforms, and recommend `MutableHashSet` when "Performance is critical" and for "a controlled scope where mutation is safe" ([HashSet](https://effect.website/docs/v4/data-types/hash-set)). Measured in Node with Effect 4.1.2: an Effect per entity made a 2,000-entity step 7.8 times slower and allocated about 340 KB per step; one `Effect.runSync` of an `Effect.sync` allocates about 840 bytes; the engine's frame-loop fiber costs about 300 bytes per frame more than the plain loop it replaced (#52).

The Effect projects we read keep pure and hot-path code plain too. Foldkit writes it down: "Preserve deliberate non-Effect code, and do not introduce or remove Effect solely for stylistic consistency" (its `AGENTS.md`), and it moved its dispatch and render path off fibers to plain JavaScript in 0.130.0. Effect's own run loop is a plain `while (true)`, and its `Queue.offerUnsafe` is for "a performance boundary where wrapping the mutation in `Effect` is intentionally avoided". Alchemy ships a plain async form of every runtime, and TanStack AI keeps its core plain behind a thin Effect layer.

## Decision

Effect is for everything with a lifecycle (loops, connections, timers, workers, resources, services), for untrusted input (Schema where it arrives) and for failures a caller should handle (typed errors). Plain code is for:

- **the simulation:** `@arcadekit/core`, each genre's step, `GameLoop` and the `GameSimulation` contract, and the lockstep protocol's tick logic and input codecs. A step must not allocate and must give the same bits on every peer ([ADR-0011](0011-a-step-uses-only-exact-math.md)), so it runs no Effect and reads no clock or random source of its own. Its time comes in as an argument and its randomness from the run's seeded `Rng`;
- **per-frame drawing and input:** views, sound views, render-three's drawing, input reads and per-message channel code. None of it runs an Effect itself: the engine calls views and input from one `Effect.try` per frame, a lockstep run on a ticker is one `Effect.callback`, and `acquireRelease` manages their lifecycles;
- **rules behind an Effect shell:** the signalling client's and worker's room reducers, which return outputs and rejections as values, and the worker's socket bookkeeping;
- **Foldkit `update` and `view`.**

Plain code meets Effect only through a few bridges: `Effect.callback` to wait on a host callback, `Stream.callback` or a `Queue` fed with `Queue.offerUnsafe` for repeating events, a runtime or context captured once and run with on each host call, and, where a platform owns the entry points, a run at each one (the signalling Worker's `Effect.runPromise` per request, and one `ManagedRuntime` per Durable Object). Library code calls no other `Effect.run*`. `AGENTS.md` ("Effect and plain code") is the working version of this rule, with the files in each zone.

## Considered Options

- **Effect at the edges, plain code inside** (chosen). It keeps the step's no-allocation and determinism rules, costs about 300 bytes per frame in the engine, and puts untrusted input under Schema and every lifecycle, timer and connection under scopes: the edges where the audit behind #51 found most of its bugs.
- **Effect everywhere, down to each entity.** The most uniform, but 7.8 times slower with steady garbage per step, and Effect's `Random` is not the run's mulberry32, so every pinned replay hash would change.
- **Run an Effect from each host callback** (`runSync` in every `requestAnimationFrame` or message handler). Effect's docs call synchronous runs "an edge case", each callback becomes another entry point, and each run allocates a fiber.
- **Wrap every sync call in `Effect.sync`, as Alchemy's provider rules do.** Right for code that is already inside an Effect, and harmful in the step and per-frame code.
- **Hand-written lifecycles** (the frame loop, lockstep session, signalling, WebRTC links and co-op client before #52-#55). The audit behind #51 found leaks there, a frame loop that kept running after a throw, and a room that waited forever.

## Consequences

- `oxlint.config.ts` enforces the simulation's part. In `@arcadekit/core`, the genres' root entries, `GameLoop`, `GameSimulation`, the lockstep protocol and its input codecs: no `Date`, `Temporal`, `performance` or `crypto` global (nor through `globalThis`, `window` or `self`), no `Math.random`, and no `Clock`, `Random` or `DateTime` from `effect`. In `@arcadekit/core` and `@arcadekit/input`: no import from `effect` at all, so they stay installable without it.
- A new genre package must be added to those rules' `files`, as with ADR-0011.
- The rest of the rule is checked in review: `AGENTS.md` names the zones and the bridges.
- `CLAUDE.md` is a symlink to `AGENTS.md`, as in Foldkit, so every coding agent reads the same rules.
