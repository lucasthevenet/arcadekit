---
"arcadekit": minor
---

Peers compare what they were made with before anything else. A session's first message says it, as `made` (`Message.Made`): a hash of what its game simulates (the systems of the tick in the order they run, the hooks of its states, the actions it handles, its version), its `delta`, the names of every peer, and the tick it begins at. A peer that hears another made otherwise stops with `Drift.Unlike`, which names both peers, what each was made with, and `differ`, what differs, before it runs a tick it is sure of. A different `delta`, a system one peer lacks or a different list of names was found only once it had changed a world; a list that left a peer out, and peers that began at different ticks, were never found, and the peers waited.

What breaks:

- `session.drifted` and `session.tickExit`'s failure can be `Drift.Unlike` as well as `Drift.Drifted`.
- A peer whose game simulates otherwise, by the names of its systems, hooks and handlers, no longer plays with the others. One that only draws, plays sound or reads its devices otherwise still does.
