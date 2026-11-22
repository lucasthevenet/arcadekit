---
"arcadekit": minor
---

Systems run in the order they are listed, and nothing moves one. `System.before` and `System.after` pulled a system ahead of everything listed between it and the one it named, so it could run before a system it read from, with no error. Now the only order within a stage is the list: a plugin's dependencies' systems, then its own, then the app's.

**Breaking**: `System.before` and `System.after` are removed, and a system no longer has `before` or `after`. List a system after the ones it reads from. To run a system ahead of one from a plugin you depend on, place it in an earlier stage:

```ts
// Before
const CallHits = System.make("CallHits", function* () {
  /* … */
}).pipe(System.before(Casualties));

// Now
const CallHits = System.make("CallHits", function* () {
  /* … */
}).pipe(System.inStage("preUpdate"));
```
