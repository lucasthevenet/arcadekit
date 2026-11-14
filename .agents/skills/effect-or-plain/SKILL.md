---
name: effect-or-plain
description: Effect or plain code. Use when writing code that a step, a frame, a lockstep tick or a host's listener runs, when giving plain code a lifecycle, or when moving code between Effect and plain.
---

Whether code is Effect or plain is one question: would we write it plain if performance were free? It stays plain only for one of these reasons, and a plain module's comment names which:

1. **The same bits on every peer.** A step gives the same result on every peer and every replay, so it reads no clock or random source of its own: no Effect `Clock`, `Random` or `DateTime`, nor `Date`, `Temporal`, `performance`, `crypto` or `Math.random`. Lint refuses them (the simulation skill).
2. **It finishes in the call.** A step finishes inside the frame or tick that runs it, and a frame draws whole before the browser shows it. An Effect can't promise that: one that waits throws when run synchronously, and on a fiber the scheduler can cut a long run after 2,048 operations.
3. **Pure data work**, of the kind Effect writes plain itself (its `Array`, `Number`, `MutableRef`).
4. **A framework's contract.** Foldkit's `update` and `view` are pure functions, whose side effects are Commands, Subscriptions and Mounts.

Cost is not a reason. Code plain only to save an allocation, or a fiber per frame, tick or message, becomes Effect wherever Effect buys something: a lifecycle, interruption, a typed failure in place of a throw, a service, a stream in place of listeners, or a span. Where Effect buys nothing, the code stays plain. Measure such a rework (the performance skill).

Everything with a lifecycle is Effect: loops, connections, timers, workers, resources and services. So is untrusted input, decoded with Schema where it arrives, and any failure a caller should handle, as a typed error.

## Where plain code and Effect meet

- **Waiting on a host callback**: `Effect.callback`. The engine's frame loop ([`game/frame-loop.ts`](../../../packages/arcadekit/src/game/frame-loop.ts)) waits on each frame so, then does the frame's work in one `Effect.try`. A lockstep run on a ticker is one `Effect.callback` whose ticks are plain calls.
- **Repeating host events an Effect reacts to**: `Stream.callback` with `Queue.offerUnsafe`, or for a DOM event Effect's `Stream.fromEventListener` ([`foldkit/key-presses.ts`](../../../packages/arcadekit/src/foldkit/key-presses.ts)).
- **Host events a frame or a step reads as state**: plain listeners that write it while the browser dispatches the event, as [`InputController`](../../../packages/arcadekit/src/input/input-controller.ts)'s do. On a stream the write waits for a fiber, which the browser resumes a task later, so a frame could read the state before an event that came first. Some work must also happen during the dispatch, as `setPointerCapture` in a `pointerdown`.
- **A resource a plain handler makes** (listeners, a renderer): a plain constructor and a plain `dispose`, since the handler runs no Effect. Its host makes the handler's result inside an `acquireRelease` whose release calls `dispose`: `InputController.make` and `InputController.dispose`.
- **Plain code a host calls that must run an Effect**: capture a runner once and use it on each call, with `FiberHandle.runtime` (the Co-op client forks its seats so) or `Effect.context` with `Effect.runForkWith`.
- **No other `Effect.run*` in library code** (`packages/*/src`), which lint refuses. The exception is [`net/worker/signalling-worker.ts`](../../../packages/arcadekit/src/net/worker/signalling-worker.ts), since Cloudflare owns its entry points. Apps run their Effects through Foldkit's runtime.
- **Throws**: plain code that throws on an expected failure is wrapped once, at the boundary, with `Effect.try` into a tagged error. Any other throw is a bug, which the Effect around it reports as a defect. A frame that throws ends the engine's `attach` with `GameCrashed`. Where a module of Effect's reports an expected throw as a defect, catch that cause around its Layer or Effect, as [`save/browser/browser-save-storage.ts`](../../../packages/arcadekit/src/save/browser/browser-save-storage.ts) does for a browser that refuses localStorage.
