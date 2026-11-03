---
status: accepted
---

# Identified pools give stable ids and reuse them

Removing an entity from a pool moves the last entity into its index, so an index can't name an entity across a removal. Push-puzzle must name a box across turns for undo and for its view, so core's `createIdentifiedPool` gives each entity a stable id, reused after removal, with O(1) `idOf`, `indexOf` and `addWithId` that allocate nothing (#17, finding 3).

## Considered Options

- Generational handles (an index plus a generation), the usual answer in entity-component systems. They catch an id used after its entity is gone. Neither genre needs that, so they were left out (PR #22).

## Consequences

- A removed entity's id becomes free, and a later `add` may hand it out again. An id names its entity only while that entity is in the pool.
- `addWithId` brings a removed entity back under its old id. Push-puzzle's undo uses it for a box that filled a hole. Push-puzzle adds no box after a level starts, so that id is still free.
- `createPool` is unchanged. Survivors' entities stay anonymous, and its replay hash didn't move.
- Push-puzzle's turn records and its view name boxes by id ([ADR-0007](0007-no-runtime-snapshots.md), finding 12).
- Revisit if a genre must keep an id after its entity is removed while other entities are still added, such as a unit that targets an enemy that dies. A reused id would then name a different entity, and generational handles would catch it.
