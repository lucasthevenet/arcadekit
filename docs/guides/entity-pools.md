# Entity pools

A game keeps its many entities, such as enemies, bolts and gems, in an `EntityPool`: a fixed number of entities stored as one typed array per field, so a step that spawns, moves and removes them allocates nothing. What a step reports waits in an `EventBuffer` until its loop delivers it.

Enemies in an entity pool, spawned with the run's seeded `Rng` (as the survivors demo's genre does), and an event collected in an `EventBuffer`, which is what `Game.Loop` holds for a declared simulation's `report`:

```ts
import { EntityPool, EventBuffer, Rng } from "arcadekit/core";

const rng = Rng.make(42);
const events = EventBuffer.make<{
  readonly type: "killed";
  readonly x: number;
}>();
const enemies = EntityPool.make(500, {
  x: Float32Array,
  z: Float32Array,
  hp: Float32Array,
});

const i = EntityPool.add(enemies); // -1 when the pool is full
if (i !== -1) {
  enemies.fields.x[i] = Rng.range(rng, -10, 10);
  enemies.fields.z[i] = Rng.range(rng, -10, 10);
  enemies.fields.hp[i] = 3;
}

// Remove while iterating backwards: removing moves the last entity into the hole.
for (let j = enemies.count - 1; j >= 0; j--) {
  if (enemies.fields.hp[j]! <= 0) {
    EventBuffer.push(events, { type: "killed", x: enemies.fields.x[j]! });
    EntityPool.remove(enemies, j);
  }
}
const facts = EventBuffer.drain(events);
```

`EntityPool.add` gives a slot whose fields are all 0, whatever the entity that had it before left there, so a spawn writes only the fields that start at something else.

`EntityPool.makeIdentified` gives entities stable ids too, for undo or a view that tweens each one. A view that keeps something per entity keys it on `EntityPool.idOf`, never on the index: removing an entity moves another into its index, and the id stays with it. An id is handed out again once its entity is removed, so it names an entity only while that entity lives.
