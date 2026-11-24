---
"arcadekit": minor
---

The parts an app is made of, and the outbox an event is told through, are files behind the module each belongs to: `App` and `Event`. They were entries of their own because they came out of a long file, and no game imports them.

What breaks:

- The entries `arcadekit/Build`, `arcadekit/Inbox`, `arcadekit/Loop`, `arcadekit/Runner`, `arcadekit/Schedule`, `arcadekit/Stage`, `arcadekit/TickScheduler` and `arcadekit/Outbox` are gone.
- `arcadekit` no longer exports `Build`, `Inbox`, `Loop`, `Runner`, `Schedule`, `Stage` or `Outbox`, and `TickScheduler` and `TickDispatcher` are no longer among its members.
- `Stage.FrameChangedWorld`, what `app.frame()` and `app.input()` die with under `verifyFrames`, is `App.FrameChangedWorld`. Its `_tag` is still `"FrameChangedWorld"`.
