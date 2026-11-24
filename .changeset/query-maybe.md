---
"arcadekit": minor
"@arcadekit/three": patch
---

`Query.maybe` makes a term of `Query.all` that an entity may lack: `Query.all(Position, Query.maybe(Rotation), Query.maybe(Scale))` visits every entity with a `Position`, and hands its loop the rotation and the scale where the entity's table has them, and `undefined` where it doesn't. `each` passes an accessor or `undefined`, and `eachChunk` the columns or `undefined` for a whole run, so a loop tests once per run in place of one query for each combination. It takes only a component stored in tables, and `Query.changed` and `Query.added` don't take it.

`Three.instances` and `Three.objects` each draw a kind with one such query, where they used up to eight and three. Instances of a kind may now be filled in another order, which nothing promised.

Nothing breaks.
