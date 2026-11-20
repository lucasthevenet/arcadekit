---
"arcadekit": minor
"@arcadekit/three": minor
---

A query only reads its terms, unless `Query.writes` names the ones it writes: `Query.all(Position, Velocity).pipe(Query.writes(Position))`. The compiler refuses an assignment to a term the query doesn't name, through `each` or a raw column of `eachChunk`, and an assignment through `each` throws at run time. So a loop that only reads no longer counts as writing for the change queries that watch what it reads, and a handler that only looks no longer copies the columns it reads, without anyone having to remember to say so.

**Breaking**

- `Query.reads` is gone. A query reads what it doesn't name in `Query.writes`: delete `Query.reads(...)`, and add `Query.writes(...)` with the terms the loop writes.
- A system that writes through a query without `Query.writes` no longer compiles, and throws at run time when it assigns through `each`. Name what it writes.
- `Query.Reading<D, R>` is now `Query.Reading<D>`, every term marked read-only, and `Query.Writing<D, W>` unmarks the terms in `W`.
- A save keeps a change query's position under a description that includes what it reads. A change query that now reads a term it used to write is another query to a save made before this change, and starts by visiting everything.
