---
"@arcadekit/net": patch
---

The host no longer ends a lockstep run on a peer's word. Before, any peer could stop the run for everyone by sending a desync message with any step and hashes. Now a peer's desync claim counts only as that peer's own hash for the step: the run stops only when the host's own hash for that step differs. A claim about the host's hash, or one with no hash for the sender, is ignored. The host also ignores a peer's hash for a step that isn't a hash step or that no peer can have reached yet, so those don't pile up.
