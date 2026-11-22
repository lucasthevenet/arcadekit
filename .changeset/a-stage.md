---
"arcadekit": minor
---

What a game's code is given by the stage it runs in, and how the stages run, are modules of their own. `arcadekit/Stage` builds the services of the tick, of the frame stage and of the input stage. `arcadekit/Loop` runs a tick and the two stages between ticks, and holds the spans of an app that traces. `App.make` uses both as before.

This breaks one name: `App.FrameChangedWorld` is `Stage.FrameChangedWorld`. Its tag and its message are unchanged.
