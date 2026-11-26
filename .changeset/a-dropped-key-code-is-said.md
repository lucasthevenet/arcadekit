---
"arcadekit": minor
---

The page's keyboard warns, through Effect's logger, the first time a key comes whose `KeyboardEvent.code` is none of `Input.KeyCode`, once for each code. Such a key is still not heard, but a code a newer browser sends that the list does not have yet is no longer dropped with nothing said. The empty code and `"Unidentified"` are no key, and are not warned of. Nothing breaks.
