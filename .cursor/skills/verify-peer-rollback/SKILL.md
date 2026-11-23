---
name: verify-peer-rollback
description: Formally verifies arcadekit peer rollback safety — empty late messages must not rewind, and confirmed ticks must match what peers said. Use when changing Peer.ts receive/tickExit/confirmed/kept, Session rollback options, or multiplayer prediction; or when a desync/rewind bug is suspected.
---

# Verify peer rollback

## Property (plain)

A peer must not rewind because an empty late message arrived; only a late message that carried actions may mark the game wrong. Once a tick is confirmed, the actions that peer applied for it are exactly what the remote peer said.

## Harm if broken

Multiplayer sessions desync or thrash: peers rewind on noise, treat predicted ticks as final while still wrong, or show different worlds after “confirmation.”

## Tool and why

**TLA+ / TLC** (model checker), not a TypeScript verifier. The failure modes are orderings of `receive` and `tick` under prediction (`ahead`). TLC explores those interleavings on a small model of `Peer.build`. The real ECS is abstracted as “which remote actions were applied on each tick.”

Pinned toolchain: `scripts/check.sh` downloads `tla2tools.jar` from tlaplus **v1.8.0** and checks sha256 `fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713`. Needs `java` and `curl` on first run.

## Does this change need a recheck?

Recheck when any of these change in a way that affects rollback:

| Code | Role in the model |
| --- | --- |
| `packages/arcadekit/src/net/Peer.ts` — `receive` late/`wrong` assignment | `Receive`, `EmptyLateNeverSetsWrong` |
| `Peer.ts` — `tickExit` rewind / `run` / `prune` | `Tick`, moments, `ConfirmedPrefixMatchesPlan` |
| `Peer.ts` — `confirmed` / `kept` getters | `Confirmed`, `KeptWithinAhead` |
| `packages/arcadekit/src/Timeline.ts` — `rewind` / `capture` used by Peer | assumed correct; model does not expand Timeline |
| `Session` options `ahead` / `delay` (if delay leaves 0) | constants `Ahead`; delay≠0 is out of scope |

If the covered code changed after the sync commit below, update the model to match the new code, rerun the check, then move the sync commit forward only after the model still describes that code.

**Sync commit (model last confirmed against Peer.ts):** `9e5cf66e611a2db0527b185951910eae5ed185e8` — replace with the commit you just verified when you re-sync.

## How to run

From the repository root:

```sh
.cursor/skills/verify-peer-rollback/scripts/check.sh
```

Optional: `-workers N` is forwarded to TLC. Config: `model/PeerRollback.cfg` (`MaxTick = 3`, `Ahead = 2`).

Pass: TLC prints `Model checking completed. No error has been found` (about 2k distinct states, under a few seconds).

Fail: TLC names a violated invariant and a finite behavior. Read every failure with the pstack `/statechart` skill so the path is shown in plain words. Do not copy `/statechart` flags from memory; use that skill’s current commands.

## Invariants (what TLC checks)

| Invariant | Meaning |
| --- | --- |
| `EmptyLateNeverSetsWrong` | An empty delivered message never leaves `wrong` equal to that past tick |
| `WrongOnlyFromLateDrop` | `wrong` is only a late delivered Drop |
| `ConfirmedPrefixMatchesPlan` | Every tick `< confirmed` applied exactly grace’s plan |
| `KeptWithinAhead` | ` | moments | ≤ Ahead` |
| `ConfirmedRespectsWrong` | While wrong is set, confirmed does not pass it |

## Real bug vs modeling error

- **Real bug:** The counterexample steps are a possible `receive`/`tick` order; the same change in `Peer.ts` would mis-handle empty late messages or confirmed prefixes. Confirm by writing a small `Rollback.test.ts` case or replaying the path with `withPeers`.
- **Modeling error:** The path relies on something the model invented (e.g. delay>0, two remotes, Drift) or disagrees with `Peer.ts` line-by-line on `wrong` / `have` / `moments`. Fix the `.tla` to match the code; do not weaken an invariant to green the check. If the **code** is wrong, report the finding; do not change product code unless asked.

## Able to fail (proof of this skill)

Removing the `message.actions.length > 0` guard in `Peer.receive` (and the matching `acts = Drop` conjunct in `Receive`) makes TLC violate `EmptyLateNeverSetsWrong` on a short path: predict tick 0 with grace silent, then receive grace’s empty message for tick 0 → `wrong = 0`. Restoring both sides returns the check to green. Do not leave that scratch change in the tree.

## Bounds and assumptions

- One local peer (ada), one remote (grace); grace’s per-tick payload is only empty or Drop.
- `delay = 0`; ada’s own messages are always present for ticks it runs.
- `MaxTick = 3`, `Ahead = 2` in the shipped config — not a proof for arbitrary ahead or long sessions.
- No Drift, transport, resend, duplicates after accept, or frame-stage rollback (#193).
- A pass is a pass of **this model under these bounds**, not of the whole net stack.

## Layout

- `model/PeerRollback.tla` — spec
- `model/PeerRollback.cfg` — TLC config
- `scripts/check.sh` — download pinned jar + run TLC
- `.tools/` — local jar cache (gitignored)

## Maintenance

After intentional protocol changes, re-sync the model and run the check. Use `/maintain-formal-verification-skill` when the covered code moved and this skill was not rechecked.
