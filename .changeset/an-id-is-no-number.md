---
"arcadekit": minor
"@arcadekit/three": patch
---

An `Entity`, an `Entity.Ref` and a `Spawned` id are no longer numbers to the compiler. A `Uint32Array`, a number field such as `Field.u32`, and arithmetic or a bitwise operator kept only an id's low 32 bits, and lost the generation of a slot reused more than 1,023 times with no error. None of them takes an id now. An id is still a number when the game runs, so JSON, saves, snapshots and the hash are unchanged. An `Entity` is still an `Entity.Ref`, and an `Entity.Ref` still not an `Entity`.

**Breaking**:

- An id compares with `===` and keys a `Map` or a `Set`. Code that added to an id, sorted ids with `a - b`, or took its bits with `&` or `>>>` reads its parts with `entityIndex` and `entityGeneration` instead:

  ```ts sketch
  // before
  ids.sort((a, b) => a - b);
  const slot = entity & 0x3f_ff_ff;
  // now
  ids.sort((a, b) => entityIndex(a) - entityIndex(b));
  const slot = entityIndex(entity);
  ```

- The `entities` column that `eachChunk` hands out is an `EntityColumn`, a `ReadonlyColumn<Entity>`, and no longer a `Float64Array`. A `Field.entity` of a term the query writes is a `WritableColumn<Entity.Ref>`. Both are indexed as before, and neither has the methods of a typed array.
- `SparseColumns.indexOf` takes an `Entity`.
- An id written into a template string reads as a number at run time, as before, but a type-aware lint that refuses an object there now refuses an id. Write its parts instead.
- `@arcadekit/three` names the entity of a colour that is no colour by its slot and generation.
