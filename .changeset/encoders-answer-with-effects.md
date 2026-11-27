---
"arcadekit": minor
---

`Migrate.migrate`, `Replay.encode`, `Message.encode` and `Message.encodeAside` return an Effect, as every method of an app does, which fails with the error their `Exit` carried: `Save.LoadRefused`, `Replay.Invalid` and `Message.Invalid`. Each does its work when the Effect runs, not when it is called. A transport writes what it sends with them.

**Breaking**

- `Migrate.migrate(save, version, migrations)` returned an `Exit`: it is `yield* Migrate.migrate(save, version, migrations)`, and `yield* Effect.exit(Migrate.migrate(save, version, migrations))` is the `Exit` it returned. `Exit.isSuccess(Migrate.migrate(...))` no longer compiles.
- `Replay.encode(recording)` is `yield* Replay.encode(recording)`.
- `Message.encode(message)` and `Message.encodeAside(aside)` are `yield* Message.encode(message)` and `yield* Message.encodeAside(aside)`.

`Replay.decode`, `Save.decode`, `Message.decode`, `Message.decodeAside`, `Message.decodeNotice`, `Event.encode`, `Event.decode`, `Relay.join` and `Relay.forward` still return an `Exit`.
