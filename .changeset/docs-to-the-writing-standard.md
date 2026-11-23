---
"arcadekit": patch
"@arcadekit/three": patch
---

The doc comments of every export are edited to one thought per sentence, with caveats under **Gotchas**, and corrected where they were wrong about the code. Among the corrections: a message for a tick that already ran makes a session go back rather than being dropped, `yield*` on a state returns a `StateView`, a tick never runs the input stage itself, and requiring `Sound.Player` in the simulation doesn't compile rather than throwing. `System.spanLevel` is now `@internal` and leaves the reference. Nothing breaks.
