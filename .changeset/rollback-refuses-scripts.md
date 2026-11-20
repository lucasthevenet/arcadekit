---
"arcadekit": minor
---

A rollback session refuses a game with scripts where the mistake is made, instead of failing on its first predicted tick: `Rollback.make` throws when a script is running, a plugin's included, and `app.spawnScript` and `Script.spawn` throw once the session has the app. `app.divert` takes `{ rewinds: true }` for a session of your own that rewinds.

**Breaking**

- `Rollback.make` throws, with what to do instead, for an app with a running script. It used to return a session whose first uncertain tick failed with `Save.SaveRefused`. Do what the script did with systems and states, or play the game with `Lockstep`.
- In a rollback game, `app.spawnScript` throws and `Script.spawn` dies, where the next uncertain tick used to fail with `Save.SaveRefused`.
