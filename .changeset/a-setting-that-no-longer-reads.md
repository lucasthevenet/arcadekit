---
"arcadekit": minor
---

Reading a setting fails with `Setting.Invalid`, naming its key, when what the store kept isn't JSON or the setting's schema no longer takes it, where it gave the initial value and said nothing.

**Breaking**

- A `Setting<A>` is an `Effect<A, Setting.Invalid, Setting.Store>`, where its error was `never`. A system that reads one can fail with `Setting.Invalid`, and so can the app's frame and input stages and `Driver.run`, which ends with it. A game that would rather start from the initial value reads the setting with `Effect.orElseSucceed`:

```ts
Effect.gen(function* () {
  const volume = yield* Effect.orElseSucceed(Volume, () => Volume.initial);
});
```
