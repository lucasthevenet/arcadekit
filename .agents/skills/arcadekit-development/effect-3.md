# Effect 3 habits that do not exist in Effect 4

Checked against Effect's [rename map](https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md).

| Effect 3 | Effect 4 |
| --- | --- |
| `Context.Tag`, `Context.GenericTag`, `Effect.Tag`, `Effect.Service` | `Context.Service` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/services.md)) |
| `FiberRef` | `Context.Reference` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/fiberref.md)) |
| `Effect.catchAll`, `Effect.catchAllCause` | `Effect.catch`, `Effect.catchCause` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/error-handling.md)) |
| `Effect.fork`, `Effect.forkDaemon` | `Effect.forkChild`, `Effect.forkDetach` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/forking.md)) |
| `Effect.async` | `Effect.callback` |
| `Either`, `Effect.either` | `Result`, `Effect.result` |
| `Effect.zipRight` | `Effect.andThen` |
| `Runtime<R>`, `Effect.runtime` | `Effect.context` and `Effect.runForkWith` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/runtime.md)) |
| Yielding an `Option` or an `Either` | `Effect.fromOption`, `Effect.fromResult` ([notes](https://github.com/Effect-TS/effect/blob/main/migration/yieldable.md)) |
| `@effect/platform`, `@effect/schema` and others as separate packages | Part of `effect` |
