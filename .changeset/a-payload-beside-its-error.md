---
"arcadekit": minor
---

`Action.define` takes an action's payload beside its error, as `Rpc.make` does: `Action.define("duel/Strike", { payload: Schema.Struct({ ... }), error: NotYourTurn })`.

**Breaking**

- The payload's schema moves from the second argument into `payload`. `Action.define("duel/Strike", Strike)` is now `Action.define("duel/Strike", { payload: Strike })`.
- An action with an error and no payload leaves out `payload`, where it gave `Schema.Void`: `Action.define("duel/Pass", { error: Tired })`.
