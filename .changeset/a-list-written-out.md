---
"arcadekit": minor
---

A list of systems, handlers or plugins that isn't written out as a tuple doesn't compile. The compiler can't read the names or the order of a list typed as an array, so `App.define` and `Plugin.make` let such a list skip the check for a duplicate name and the check for a watcher listed ahead of its writer. A duplicate was then refused only when the app was made, and a misordered list ran a tick late with no error. Now the list is refused with: "List systems, handlers and plugins as a literal list, [a, b], so the compiler can read their names and order." `System.Misordered` and `System.Duplicated` say the same of such a list.

**Breaking**:

- A list typed as an array, such as `const systems: readonly System.System<never, BuiltIn>[] = [Move, Draw]` or one made with `Array.from` or `.map`, no longer compiles where `App.define` or `Plugin.make` takes it. Write the list out where it is given, or keep it in a tuple:

```ts
// Before
const systems = [Move, Draw];
App.define({ systems });

// Now
App.define({ systems: [Move, Draw] });
// or
const systems = [Move, Draw] as const;
App.define({ systems });
```

- A function that takes a list and forwards it to `App.define` no longer compiles, since the compiler can't read a list it only knows as a type parameter. Take the game instead, as an `App.Game`, and call `App.define` where the list is written.
- A list that is spread from an array, `[Move, ...more]`, is not a tuple either.
