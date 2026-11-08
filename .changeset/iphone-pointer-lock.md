---
"@arcadekit/input": patch
---

`InputController` drags and swipes again on iPhone Safari. It has no pointer lock and leaves `document.pointerLockElement` undefined, which the check for a locked pointer read as locked, so every press was ignored.
