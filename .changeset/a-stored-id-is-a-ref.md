---
"arcadekit": minor
---

A `Field.entity` reads as an `Entity.Ref`, which no call of the world takes, and `world.live(ref)` returns the entity it refers to while that entity is alive, and `undefined` once it is despawned, even after another entity takes its slot. A stale id kept in a field can no longer be passed to `get`, `has`, `set`, `sources` or `Commands` as if its entity were there. `live` is on the world a system is handed, on the one `app.read(World)` hands out, and on `EcsWorld`.

**Breaking**: a value read from a `Field.entity`, in `each` or from `world.get`, is an `Entity.Ref`, not an `Entity`. Where a game passed it to the world, it now passes it through `live` first:

```ts sketch
// before
world.get(hunter.target, Health);
// now
const target = world.live(hunter.target);
if (target !== undefined) world.get(target, Health);
```

A field still takes an `Entity`, an `Entity.Ref` or a `Spawned` id as it did. `isAlive`, `entityIndex` and `entityGeneration` take an `Entity.Ref` too.
