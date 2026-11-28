---
"arcadekit": minor
---

A session is told this peer apart from the others: `Session.make(game, { seed, me: "ada", others: ["grace"], delta })`. A peer not among the peers of its own session can no longer be written, and a name given twice, as `me` and among `others` or twice among `others`, doesn't compile when the names are literals: the error says which name. Names the compiler knows only as `string` are still refused when the session is made.

**Breaking**

- `Session.Options` has `me` and `others` in place of `peer` and `peers`. Replace `{ peer: "ada", peers: ["ada", "grace"] }` with `{ me: "ada", others: ["grace"] }`: `others` is every peer but this one.
- A session's `peer` is `me`. Its `peers` is unchanged: every peer, this one too, in the order their actions are applied.
- The refusal of a peer that isn't among `peers` is gone, since it can't be written. A name given twice throws with a new message, which names `me`.
- `Session.Options` takes two more type parameters, `Me` and `Others`, after `SV`, both defaulting to any names.
