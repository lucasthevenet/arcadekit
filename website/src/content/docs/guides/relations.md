---
title: "Linking entities with relations"
description: "A relation is a component that points at another entity and stays consistent when that entity is despawned: a parent and its children, a target, an owner."
---

A **relation** is a component that points at another entity, its `target`, and stays consistent when that entity is despawned: a parent and its children, a target, an owner. Use a relation rather than a bare `Field.entity` for any reference that must never dangle. [Components](components.md) covers components in general.

## Linking entities

```ts
import {
  Action,
  Commands,
  Component,
  EntityId,
  Field,
  Plugin,
  World,
} from "arcadekit";
import { Effect, Schema } from "effect";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const ChildOf = Component.relation("scene/ChildOf", {
  onTargetDespawn: "despawn", // a child is despawned with its parent
});
const Targets = Component.relation("ai/Targets", {
  onTargetDespawn: "remove", // whoever aimed at it now aims at nothing
  storage: "sparse",
  fields: { since: Field.f32 }, // fields of its own, beside the target
});

// A tank with a turret on it.
const setup = Effect.gen(function* () {
  const commands = yield* Commands.spawns(Position, ChildOf);
  const tank = commands.spawn(Position.of({ x: 0, y: 0 }));
  commands.spawn(Position.of({ x: 0, y: 1 }), ChildOf.of({ target: tank }));
});

// Moves the turret onto the truck, then scraps the truck.
const Swap = Action.define(
  "game/Swap",
  Schema.Struct({ turret: EntityId, truck: EntityId })
);
const swap = Action.handler(Swap, function* ({ turret, truck }) {
  const world = yield* World;
  const commands = yield* Commands.spawns(ChildOf);
  const tank = world.get(turret, ChildOf)?.target; // its parent
  if (tank !== undefined) {
    world.sources(tank, ChildOf); // the tank's children
  }
  commands.add(turret, ChildOf.of({ target: truck })); // a new parent
  commands.despawn(truck); // despawns the turret too, and everything attached to it
});

export const Rules = Plugin.make("game/Rules", { handlers: [swap], setup });
```

- `world.sources(target, ChildOf)` returns the entities pointing at a target, ordered by index. The world tracks these links, so neither this call nor a despawn scans other entities. It takes a relation, and any other component doesn't compile.
- To change a target, add the relation again. `target` is read-only in `each`, in `world.set` and in its raw column, so assigning to it doesn't compile. A relation's own fields are written like any others.
- A relation requires a live target. Given bare, as `ChildOf` and not `ChildOf.of({ target })`, it doesn't compile, on `Commands` or on the world. With a target that is already despawned, the despawn behaviour applies immediately: the child doesn't survive the call, or the relation isn't added.
- An entity has one target per relation. A different kind of link is a different relation.
- In a system or an action handler, add, remove and retarget relations through `Commands`, like any other structural change.

## When a target is despawned

- `onTargetDespawn` controls what happens to the entities pointing at a target when it is despawned. `"despawn"` despawns them too, along with whatever points at them, at any depth. `"remove"` removes the relation from them and leaves them otherwise untouched.
- Either way, nothing is left pointing at a despawned entity, so a dangling reference can never be read as a live one. A plain `Field.entity` gets no such guarantee: it holds whatever id was written, and readers check `world.isAlive` themselves.
- A despawn follows relations ordered by name and the pointing entities ordered by index, so the same world always loses the same entities in the same order.

## A relation is a component

In every other way, a relation is a component: stored in tables or a sparse set, read in queries, watched with `Query.added` and `Query.removed`, saved in snapshots and included in the hash. The links between entities are derived from it, and rebuilt when a world loads a snapshot, which refuses a relation pointing at no entity.

## Read more

- [`Component`](/reference/arcadekit/ecs#component) in the API reference.
