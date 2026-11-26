---
"arcadekit": minor
---

A singleton read whole can no longer be a view's value. `yield* SomeSingleton` and `World.singleton` return a `Singleton.Read`, the world's own object, which is the same object on every read. Returned whole from `View.publish`'s `when`, or published as a view's value, it never differed from the frame before, so the view kept its first value with no error. A field of it and a spread of it compile as before.

**Breaking**

- A `View.publish` body or `when`, or a `View.Port.publish` value, that holds a singleton read whole no longer compiles. That covers the read returned directly, in a union, and inside arrays and objects up to 32 levels deep. Return its fields instead:

  ```ts
  // before
  when: function* () {
    return yield* Score;
  }
  // now
  when: function* () {
    return (yield* Score).points;
  }
  ```

- `yield* SomeSingleton` and `World.singleton(SomeSingleton)` are typed `Singleton.Read<S>`, not `Readonly<ValueOf<S>>`. A plain object does not pass for one, so a variable of that type has to be assigned a read.
- `View.publish` and `View.Port.publish` take one more type parameter, for the value they are given. A call that gives its type arguments explicitly gives that one too.
