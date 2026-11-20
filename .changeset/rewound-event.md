---
"arcadekit": minor
---

After `app.rewind`, the app announces `App.Rewound`, with the tick the game was at and the tick it went back to, so that what lives outside the world can follow the game back: a service of the game's own, the particles on screen, a sound that is playing. A system of the frame or input stage reads it, each once. A system of the tick or a handler that reads it throws, because only the peer that went back hears it and a tick that heard it would run differently there. A rollback session resimulates before anything hears it. Nothing else may emit it, and a moment doesn't hold it, so it never reaches a save, the hash or the log.

**Breaking**

- An event of the game's own named `App.Rewound` is refused the first time it is used, as two events with one name are.
