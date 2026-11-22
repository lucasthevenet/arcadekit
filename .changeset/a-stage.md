---
"arcadekit": minor
---

What a game's code is given by the stage it runs in, and how each stage runs, are a module of their own, `arcadekit/Stage`: the services of the tick, of the frame stage and of the input stage, and the loop that gives each system its turn. `App.make` uses it as before. Nothing breaks.
