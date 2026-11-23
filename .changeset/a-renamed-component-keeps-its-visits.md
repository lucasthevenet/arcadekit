---
"arcadekit": minor
---

`Migrate.renameComponent` renames the component's entries under `Save.VISITS` too, with the change queries that name it. After the load, a change query on the renamed component goes on from where it was, instead of visiting every entity again, and an `added` query no longer reports every entity with the component as added.

**Breaking**

- A game that counted on a renamed component's change queries starting over after a migration now sees only what changed since the save. To visit every entity again, visit them with a query that has no `Query.changed` or `Query.added`.
