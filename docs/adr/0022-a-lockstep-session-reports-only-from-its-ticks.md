---
status: accepted
---

# A lockstep session reports only from its ticks, and tells a host's start at the first

> Amended by [ADR-0024](0024-the-kit-is-written-as-effect-modules.md) on 2026-11-14: `arcadekit/net` is in Effect's shape, and the text below uses its names: a session is made with `LockstepSession.host` or `LockstepSession.join`, a scoped one with `ScopedLockstepSession.host` or `ScopedLockstepSession.join`, and the protocol is in `net/lockstep-session.ts`.

Grimbonk's move onto the declarations found that a co-op host never heard its run start. A host's run starts inside `LockstepSession.host` ([ADR-0012](0012-delay-based-lockstep-over-a-host-star.md)): `Game.Loop`'s `start` reports what the simulation's `create` reports, then the first sample, before the call returns, so before a caller holds a session to listen to. A guest's run starts in a tick, the one that has the host's start message, and a guest's listener heard both. So a `Coop`'s host seat heard `RunStarted` and then nothing until its first steps, where [ADR-0021](0021-co-op-is-declared-from-the-games-engine.md) has a run heard one way by every seat: a game whose `create` reports its first stage showed that stage's banner to the guests alone.

Four designs were weighed, and one of those rejected was built first and run against the session's tests.

## Decision

**A session reports from its ticks, and from nowhere else.** It owns its listeners, behind one listener of its own on its `Game.Loop`, and calls them inside a tick.

**A host's run still starts as its session is made. Only the telling waits.** The session keeps what that start reported, which is what `create` reports and one sample, and tells it at the top of its first tick, before the tick does anything else, to whoever listens then. No step has run since the start, so a listener that reads the state on hearing it reads the one `create` made.

A caller learns one rule: a listener in place before a session's first tick hears the run from its start, on a host as on a guest. That is `session.subscribe(listener)` before the first `tick`, or `yield* session.listen(onEvent)` before `session.run(...)`. The Co-op client already listened before its ticker's first tick, so a host's seat now hears the start after its `RunStarted`, as a guest's does.

**Nothing is told twice, and nothing is replayed.** A listener that comes after the first tick hears what comes after it.

## Considered Options

- **Start a host's run at its first tick, as a guest's starts** (built first, with the run's clock still counted from `LockstepSession.host`'s `nowMs`). It is the most uniform: no start to keep. Rejected, because it changes what every peer sees and what a caller gets back, for a bug that needs neither:
  - a command a host sends before its first tick would ride step 0 on every peer, where it rides the step after the run's first ones, which the start schedules before anyone can send;
  - what starting throws (more players than a run holds, a simulation that can't start, a `create` that throws) would be thrown from the first tick with the transport still listened to, where `LockstepSession.host` throws with nothing left listening and `ScopedLockstepSession.host` dies on it;
  - a host's `state` would be null and its `players` empty until its first tick, and its `status` would need a value for a host that hasn't started: `joining` misnames it, and a new one breaks every exhaustive match;
  - the Co-op client would report `RunStarted` for a run with no state to draw.

  Four of the session's tests failed on it, over the first two of these. The other two come from reading it.

- **Hand what the start reported to the first listener that subscribes.** Rejected: subscribing would change what the next listener hears, where [the code style](../code-style.md#a-host) has a listener only watch; one listener would be special; the telling would happen inside `subscribe`, outside any tick, perhaps after steps have moved the state the events describe; and what is kept has no bound unless it is capped.
- **A listener in the options** (`LockstepSession.host({ ..., onEvent })`). Rejected: it is a second way to listen beside `subscribe` and `listen`, and it would be called inside `LockstepSession.host`, before the caller holds the session. The Co-op client would then have to report `RunStarted` before it knows the session was made, or keep the events and replay them itself.

## Consequences

- **A host's listener hears more than it did**, at its session's first tick. A test that lists everything a host's session or seat reported gains the start's events and its first sample, and a workaround that gave a host the start's news another way gives it twice.
- **A host's seat gets its first sample at its first tick**, where it waited for the first one due after it: about 100 ms sooner for survivors' HUD.
- **A listener that comes after a host's first tick gets no replay of the start**, and a host's session that is never ticked never tells it.
- **The protocol is as it was**: what peers exchange, the step a command rides and when steps run. No test of it changed, and the replay and determinism hashes hold.
- **What is kept is small and short-lived**: one start's events and one sample, from `LockstepSession.host` to the first tick. `startAsHost` in [`net/lockstep-session.ts`](../../packages/arcadekit/src/net/lockstep-session.ts) says at the code why the run does not start at that tick.
