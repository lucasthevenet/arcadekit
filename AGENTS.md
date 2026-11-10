# arcadekit

## Project status: alpha

arcadekit is alpha. Nothing depends on it in production yet: no players, deployments or users to protect. Breaking changes are fine when they improve the code, and a better design wins over compatibility. That covers API changes, renames, removing or reshaping exports, changing stored data formats or localStorage keys, and large refactors.

- Don't add compatibility shims, deprecation paths or data migrations. Change the code and update its callers.
- Still say what breaks: in the commit message, in the PR description, and, for the published `arcadekit` package, in its changeset (a minor bump while below 1.0).
- Keep the replay and determinism hashes unless a change to the simulation's rules is the point.

## Effect and plain code

Match the style to the subsystem and to what it models; don't homogenize the repository around one abstraction. Use pure functions for deterministic data work; plain imperative code where allocation, frame timing or the order of a host API's calls matters; and Effect where interruption, resources, services, typed failure or composition justify it. Preserve deliberate non-Effect code, and don't add or remove Effect only for consistency. When styles mix, keep the boundary explicit and follow the surrounding module. This follows Foldkit's own rule; [ADR-0017](docs/adr/0017-effect-at-the-edges-plain-code-inside.md) records why.

Plain on purpose:

- **The simulation.** `arcadekit/core` (pools, grid, clock, rng, events), each genre's step (`world.ts`, and survivors' `hero.ts`, `math.ts` and `hash-world.ts`), `GameLoop` and the `GameSimulation` contract, and the lockstep protocol (`packages/arcadekit/src/net/lockstep.ts`, which decodes its messages with Schema but ticks as plain code, and the input codecs in `codec.ts`, since every peer steps on what they decode). A step must not allocate and must give the same bits on every peer. So it runs no Effect, and it reads no clock or random source of its own: its time comes in as an argument and its randomness from the run's seeded `Rng`. Never use Effect's `Clock`, `Random` or `DateTime` there, nor `Date`, `Temporal`, `performance`, `crypto` or `Math.random`. Lint enforces this, and keeps `arcadekit/core` and `arcadekit/input` free of `effect` altogether.
- **Per-frame drawing and input.** `arcadekit/render-three`'s drawing (its sprite loading is Effect), the genres' views and sound views, `InputController`'s reads, `GameView` and `combineViews`, the `FrameSource` adapter, the audio mixer's play calls, and the per-message channel code (`dataChannelText`, `linksTransport`). None of it runs an Effect itself. The engine calls views and input from one `Effect.try` per frame, built once per attach. A lockstep run on a ticker is one `Effect.callback` whose ticks are plain calls, and messages reach the session through plain listeners. Their lifecycles are Effect: the engine makes and disposes views, input and listeners with `acquireRelease`, and each peer link's connection and channels have their own.
- **Rules behind an Effect shell.** `packages/arcadekit/src/net/browser/room-state.ts` and the signalling worker's `room.ts`. They take inputs and return outputs, and a rejection is a value, not a throw. A shell does the I/O: `signalling.ts` for the client; in the worker, the Durable Object's Effects in `connections.ts`, which call the plain `sockets.ts` to carry out the room's outputs on the sockets.
- **Foldkit `update` and `view`.** Pure functions. Their side effects are Commands, Subscriptions and Mounts.

Everything with a lifecycle is Effect: loops, connections, timers, workers, resources and services. So is untrusted input (decode it with Schema where it arrives) and any failure a caller should handle (a typed error).

Where plain code and Effect meet:

- **Waiting on a host callback:** `Effect.callback`. The engine's frame loop waits on each frame this way, then does the frame's work in one `Effect.try`. A peer link waits for its channels to open the same way, and a lockstep run on a ticker is one `Effect.callback` that resumes when the run ends.
- **Repeating host events:** `Stream.callback` with `Queue.offerUnsafe` (`keyPresses`), or a `Queue` that the host's listeners feed with `Queue.offerUnsafe` (the signalling worker's sockets, the co-op lobby's links).
- **Plain code a host calls that must run an Effect:** capture a runner once, then use it on each call: `FiberHandle.runtime` (the co-op client forks its seats this way), or `Effect.context` with `Effect.runForkWith` or `Effect.runPromiseWith`.
- **A platform that owns the entry points:** run each one's Effect there. The signalling Worker runs each request with `Effect.runPromise`. Its Durable Object, whose connections outlive a request, builds one `ManagedRuntime` with the object and runs every entry point on it.
- **No other `Effect.run*` in library code** (`packages/*/src`; test helpers aside). The browser apps run their Effects through Foldkit's runtime.
- **Throws:** plain code that throws on an expected failure is wrapped once, at the boundary, with `Effect.try` into a tagged error. Any other throw is a bug, and the Effect around it reports it as a defect. A frame is the exception: one that throws ends the engine's `attach` with the typed `GameCrashed`, so the app can show it.

## One package, sixteen entries

The kit is one published package, `arcadekit` (`packages/arcadekit`), whose entries live in `src/<entry>/` ([ADR-0018](docs/adr/0018-one-package-with-entries.md)). Inside it, import another entry by relative path to its public file (`../core/index`), never as `arcadekit/core`. `ENTRY_IMPORTS` in `oxlint.config.ts` lists which entry may import which, and lint enforces it: adding an arrow is a design decision, so say why in the PR. The genre packages and the apps import `arcadekit/<entry>`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
