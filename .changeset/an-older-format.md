---
"arcadekit": minor
---

`Save.decode` refuses a save in a format an earlier version of arcadekit wrote with the problem `"older format"`, where it said `"newer format"`.

**Breaking**

- `Save.LoadRefused`'s `problem` has a new member, `"older format"`. A game that matched on `"newer format"` to tell the player a save can't be read matches on both.
