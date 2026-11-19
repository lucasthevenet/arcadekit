---
"arcadekit": minor
"@arcadekit/three": minor
---

The kit no longer asserts a type it has not checked, but where seven files still must, which `oxlint.config.ts` names with the reason. What it was told by a cast it now checks, and refuses with a message when the check fails: a state's handle refuses a value that is not one of the state's, as a save from an older game can hold; `Gltf.model` refuses a document whose buffers, buffer views or images are not shaped as glTF has them; `Migrate.mapField` refuses an old value that is not of the schema it is given. A column of an entity field is an `EntityArray`, a `Float64Array` whose elements are `Entity`.

**Breaking**

- `Migrate.mapField` takes the schema of the old value before the function that maps it: `mapField(world, "game/Hp", "points", "f32", Schema.Number, (hp) => hp / 2)`, where it was `(hp: number) => hp / 2` alone.
- The column of a `Field.entity` is an `EntityArray`, and `EntityColumn` is `Readonly<EntityArray>`, where both were a `Float64Array`. What reads one gets an `Entity`, and only an `Entity` can be written to one.
- `Component.define`, `Component.relation` and `Component.tag` are overloaded functions, with the same signatures as before.
- `App.run` is an overloaded function, with the same signatures as before.
- `Transport.Wire`'s `listen` hands over what arrived as `unknown`, where it was a `string`: a wire of a game's own passes on whatever its socket gives, and the transport drops and counts what is not text.
- `Lockstep.make` returns a `Session` that is also `Predicting`, as `Rollback.make`'s is.
- `Assets.StoreShape`'s `hold` and `drop` are generic over the bundle's entries.
- A state's handle throws on reading a value that is not one of the state's values, where it returned it. A migration renames a state's values in a save.
- `Gltf.model` fails with `Assets.AssetFailed` for a document whose `buffers`, `bufferViews` or `images` are not lists of what glTF has there, where it went on and failed later, or not at all.
