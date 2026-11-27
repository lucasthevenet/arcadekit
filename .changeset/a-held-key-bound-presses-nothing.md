---
"arcadekit": minor
---

A key that is down when a control is bound to it moves the control only from its next press. The player who presses K in a rebind menu and still holds it when the menu closes doesn't jump: the jump stays up until K is let go and pressed again. This holds for a button, an axis and a stick, and for a rebind from an input system, a frame system or `Input.settingsOf`. A key the control was already bound to the same way counts as it did, so adding a key to a held button doesn't release it.

**Breaking**

- `Input.rebind` and `Input.settingsOf(app, Controls).rebind` onto a key that is down at the next sample no longer press the control at that sample. A game that relied on the press asks the player to press the key again.
- An input system that reads a control after another input system rebinds it in the same sample reads the bindings that sample began with, as `Input.rebind` says. The new bindings count from the next sample. Before, it read the new bindings at once.
