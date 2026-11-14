---
"arcadekit": minor
---

`EntityPool.add` and `EntityPool.addWithId` give a slot whose fields are all 0. `arcadekit/core` gains `StateHash`, the FNV-1a both action games hash their state with, and `EntityPool.visit`. **Breaking**: a slot from `add` no longer holds the values of the entity that had it before. (The names are 0.7.0's: see the changeset that gives core Effect's module shape.)

Two things every game wrote around a pool are the pool's own. A slot came back holding what its last entity left, so each spawn wrote every field, zeros included, and a field added to a layout later was one forgotten write away from carrying a dead entity's value into a new one. And around the list of numbers its state hash covers, each game wrote the same fold and the same walk over a pool's live fields. Both are plain code in `arcadekit/core`, with no Effect and no clock: `add` runs in a step and allocates nothing, and a hash is taken by a host or a test between steps, never by the rules.

- **`EntityPool.add` and `EntityPool.addWithId`.** Every field of the slot they reserve is 0: after a `remove`, after a `clear` and on the slot's first use. It costs one write per field for each entity added, and nothing in a step that adds none. A spawn writes only the fields that start at something else.
- **`StateHash`.** FNV-1a, 32 bits, over each number's eight bytes as a float64, so a change in any bit shows. A NaN is the exception: every NaN has the same digest, since an engine may hold one in any of its bit patterns and no rule can tell them apart. `StateHash.add(hash, value)` folds one number in and allocates nothing; a game's list that takes an `add` is given a function that calls it, made once. `StateHash.digest(hash)` gives an unsigned 32-bit integer, `0x811c9dc5` with nothing folded in, and `StateHash.reset(hash)` starts again from there. `add` and `reset` return the state hash.
- **`EntityPool.visit(pool, f)`.** Calls `f` with the pool's `count`, then with each field's live values, one field at a time in the layout's order, and allocates nothing. It does not visit an identified pool's ids: they follow from the order of its adds and removes.

The game still lists its numbers, in its order: the kit never looks inside a state, and what only a view reads is left out by not being listed.

```ts
import { EntityPool, StateHash } from "arcadekit/core";

const cars = EntityPool.make(8, {
  x: Float32Array,
  speed: Float32Array,
  lap: Uint8Array,
});
const race = { time: 0, metres: 0, cars };

// Before: every field at every add, zeros included.
//   cars.fields.x[i] = 4; cars.fields.speed[i] = 0; cars.fields.lap[i] = 0;
const i = EntityPool.add(cars);
if (i !== -1) {
  cars.fields.x[i] = 4;
}

// Before: an FNV-1a of the game's own, and its loop over Object.values(pool.fields).
const hash = StateHash.make();
const add = (value: number): void => {
  StateHash.add(hash, value);
};
const hashRace = (): number => {
  StateHash.reset(hash).pipe(
    StateHash.add(race.time),
    StateHash.add(race.metres)
  );
  EntityPool.visit(race.cars, add);
  return StateHash.digest(hash);
};
```

A view that keeps something per entity keys it on an identified pool's `EntityPool.idOf`, never on the index, which moves when another entity is removed. Survivors' enemies and gems are identified pools for that: its view takes each one's animation phase from its id, where it guessed which entity was which from where each was the frame before.

**Breaking**

- A slot from `EntityPool.add` or `EntityPool.addWithId` holds 0 in every field, where it held what the slot's last entity left. Code that read a field of a new entity before writing it reads 0. No signature changes, and every export is new.
- A game that wrote every field at every `add` records the same hashes as before, as survivors does: an identified pool hashes as a pool does, since an id is in no field, and `StateHash` and `EntityPool.visit` are the fold and the walk each game wrote, moved. One thing differs: a game's own hasher folded a NaN as whichever bits the engine held it in, so two equal states could have two hashes. A hash recorded over a state that holds a NaN may move; one over a state with none does not.
