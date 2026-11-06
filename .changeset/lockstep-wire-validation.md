---
"@arcadekit/net": minor
---

Lockstep sessions check what arrives on the wire, so a peer on other code, or a forged message, can no longer freeze a run.

- Every lockstep message is decoded with an Effect Schema (integer steps, at most 64 inputs, steps or hashes per message, at most 16 players). A message that doesn't decode is dropped, and the rest of what arrived is still handled.
- The host decodes each peer's input when it arrives and keeps at most 64 steps of it ahead of the last confirmed step. A peer whose input doesn't decode is removed from the run; a peer that can't decode a step from the host stops with a `badInput` error.

Breaking:

- `InputCodec.decode` returns `Result<Input, string>` (from `effect`'s `Result`) instead of returning the input or throwing. `jsonCodec` and `schemaCodec` follow; a custom codec must return `Result.succeed(input)` or `Result.fail(why)`.
- `StopReason` has a new `badInput` kind (`player`, `step`, `issue`), and the `removed` kind has a `why` (`"stalled"` or `"badInput"`, exported as `RemovedWhy`). A `switch` over `reason.kind` needs the new case.
- `hostLockstep` throws a `RangeError` for more than 16 players.
- The wire format changed: the `removed` message carries `why`, and senders send at most 64 hashes per message. Peers on this version and an older one can't play together.
