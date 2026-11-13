---
"arcadekit": minor
---

`Pool.add` and `addWithId` give a slot whose fields are all 0. `arcadekit/core` gains `StateHasher`, the FNV-1a both action games hash their state with, and `visitPool`. **Breaking**: a slot from `add` no longer holds the values of the entity that had it before.

Two things every game wrote around a pool are the pool's own. A slot came back holding what its last entity left, so each spawn wrote every field, zeros included, and a field added to a layout later was one forgotten write away from carrying a dead entity's value into a new one. And around the list of numbers its state hash covers, each game wrote the same fold and the same walk over a pool's live fields. Both are plain code in `arcadekit/core`, with no Effect and no clock: `add` runs in a step and allocates nothing, and a hash is taken by a host or a test between steps, never by the rules.

- **`add` and `addWithId`.** Every field of the slot they reserve is 0: after a `remove`, after a `clear` and on the slot's first use. It costs one write per field for each entity added, and nothing in a step that adds none. A spawn writes only the fields that start at something else.
- **`StateHasher`.** FNV-1a, 32 bits, over each number's eight bytes as a float64, so a change in any bit shows. A NaN is the exception: every NaN has the same digest, since an engine may hold one in any of its bit patterns and no rule can tell them apart. `number(value)` folds one number in and allocates nothing. It is a function of its own, so a game's list takes it as its `add`. `digest()` gives an unsigned 32-bit integer, `0x811c9dc5` with nothing folded in, and `reset()` starts again from there. `number` and `reset` return the hasher.
- **`visitPool(pool, visit)`.** Calls `visit` with the pool's `count`, then with each field's live values, one field at a time in the layout's order, and allocates nothing. It does not visit an identified pool's ids: they follow from the order of its adds and removes.

The game still lists its numbers, in its order: the kit never looks inside a state ([ADR-0007](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0007-no-runtime-snapshots.md)), and what only a view reads is left out by not being listed ([ADR-0014](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md)).

```ts
import { StateHasher, createPool, visitPool } from "arcadekit/core";

const cars = createPool(8, {
  x: Float32Array,
  speed: Float32Array,
  lap: Uint8Array,
});
const race = { time: 0, metres: 0, cars };

// Before: every field at every add, zeros included.
//   cars.fields.x[i] = 4; cars.fields.speed[i] = 0; cars.fields.lap[i] = 0;
const i = cars.add();
if (i !== -1) {
  cars.fields.x[i] = 4;
}

// Before: an FNV-1a of the game's own, and its loop over Object.values(pool.fields).
const hasher = new StateHasher();
const hashRace = (): number => {
  hasher.reset().number(race.time).number(race.metres);
  visitPool(race.cars, hasher.number);
  return hasher.digest();
};
```

A view that keeps something per entity keys it on an identified pool's `idOf`, never on the index, which moves when another entity is removed. Survivors' enemies and gems are identified pools for that: its view takes each one's animation phase from its id, where it guessed which entity was which from where each was the frame before.

**Breaking**

- A slot from `add` or `addWithId` holds 0 in every field, where it held what the slot's last entity left. Code that read a field of a new entity before writing it reads 0. No signature changes, and every export is new.
- A game that wrote every field at every `add` records the same hashes as before, as survivors does: an identified pool hashes as a pool does, since an id is in no field, and `StateHasher` and `visitPool` are the fold and the walk each game wrote, moved. One thing differs: a game's own hasher folded a NaN as whichever bits the engine held it in, so two equal states could have two hashes. A hash recorded over a state that holds a NaN may move; one over a state with none does not.
