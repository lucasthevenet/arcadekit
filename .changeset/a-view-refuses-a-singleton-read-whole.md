---
"arcadekit": minor
---

A singleton read with `yield*` is now a `Singleton.Read`, the world's own object, and `View.publish` refuses it returned whole, as the view's value or from `when`. It is the same object every frame, so the view never changed again after the first frame, with no error. A field of it and a spread of it compile as before.

**Breaking**

- A `View.publish` body or `when` that returns a singleton read whole, in a union, or inside an array or an object up to four levels deep, no longer compiles. Return its fields instead:

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

- What `yield* SomeSingleton` returns is typed `Singleton.Read<S>`, not `Readonly<ValueOf<S>>`. A plain object no longer passes for it, so a variable of that type has to be assigned a read.
- `View.publish` has one more type parameter, for the value the body returns. A call that gave its type arguments explicitly gives that one too.
