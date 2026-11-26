---
"arcadekit": minor
---

Two games that are the same compare as the same. `world.hash({ time: false })`, on the world `app.read(World)` gives, covers everything `world.hash()` covers but the game's time, so a test of a game paused for 120 ticks compares the game before and after in one call. `world.hash()`, which checkpoints, replays, sessions and the lobby compare, is as it was.

A save holds whether the game was at rest: an app made from a save of a game that ticks when needed, taken at rest, with `App.make(game, { save })`, or that loads it with `Save.load(app, save)`, is settled, runs no tick before its first action, and goes on tick for tick, and hash for hash, as the game it was saved from. A game's snapshot holds it in the store of the actions queued for the next tick, `Action.INTAKE`, as `rests: true`, beside `queued`. The hash doesn't cover it.

Nothing breaks. A game loaded from a save of a game at rest runs one tick fewer than it did, the tick that changed nothing but its time.
