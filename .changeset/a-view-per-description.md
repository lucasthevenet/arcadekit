---
"arcadekit": patch
---

`World.view` keeps one view per description, by the components it names and where, and no longer one per description object. A system that writes its query as a new object literal on every call gets the same view each time, where before the world made and kept a new one per call.

Nothing breaks. A game that kept its description in a constant sees no difference.
