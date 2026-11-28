---
"arcadekit": patch
---

`Save.autosave` runs nothing after a tick or a dispatch in which the rules ask for no save. It ran an effect after every one, which found that nothing was asked. A game that ticks by itself and asks for a save once a minute no longer pays for it 60 times a second.

Nothing breaks.
