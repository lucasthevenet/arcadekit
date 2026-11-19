---
"arcadekit": minor
---

`Migrate.addField` and `Migrate.mapField` refuse a value that a field of a number type cannot hold, where they stored what its typed array made of it.

**Breaking**

- A migration that gives a number field anything but a number, a fraction to a whole-number field, or a number out of its range (300 to a `u8`) throws, and the save is refused with `"migration failed"` and the field's name. It used to store NaN, the number a string parses to, or the number cut to fit.
- The compiler refuses a value that is not a number for a field of a number type: `addField`'s value and what `mapField`'s function returns are `Migrate.ValueOfKind<K>`. A migration that returned `unknown` for one, such as `(v) => v`, names the old value's type: `(v: number) => v`.
