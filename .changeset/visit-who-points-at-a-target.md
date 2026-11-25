---
"arcadekit": minor
---

`view.pointingAt(Rel, target)` narrows a query's view to the entities that point at `target` with the relation `Rel`, and its `each` and `eachChunk` hand them their components as the view's own loops do: `world.view(Children).pointingAt(ChildOf, parent).each((position) => { ... })`. It walks the list the world already keeps of who points at whom, so it looks at no other entity, and visits in the order every loop visits. `Rel` is one of the query's terms, and any other doesn't compile. A change query throws. Over 1,000 children of 100 parents among 100,000 entities, it took 32 µs where `world.sources` with `get` and `set` took 102 µs, as `pnpm --filter arcadekit bench:compare` measured them.

Nothing breaks.
