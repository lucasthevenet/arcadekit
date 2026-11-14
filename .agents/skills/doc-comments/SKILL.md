---
name: doc-comments
description: Doc comments. Use when writing or changing a module comment or an export's doc comment in arcadekit, or an example in one.
---

Doc comments are written as Effect's are, in the kit's own voice and the glossary's words. They are the API reference of arcadekit.dev too: a module's page is its module comment, then each export's signature and doc comment, by category ([`website/README.md`](../../../website/README.md#the-api-reference)). Copy those of [`core/ring.ts`](../../../packages/arcadekit/src/core/ring.ts).

## The module comment

Every module file opens with one: what the module is, in the glossary's words, and why it is as it is, ending in `@since`. A plain module says why it is plain ("Plain on purpose: …", the effect-or-plain skill).

## An export's doc comment

1. A summary: what it is or does, in a sentence or two.
2. `**When to use**`: the moment in a game where it is the thing to reach for.
3. `**Details**`, when there is more to say: edge cases, cost, what it refuses (`It throws a RangeError for …`).
4. At least one `**Example** (Title)`: a `ts` block that imports from `arcadekit/<entry>`, as a game would, and shows results as `// =>` comments that are true. It may also import `effect`, a module of Effect's by its path (`effect/persistence`) and another entry. A result ends one line: name what spans lines first, then show it.
5. "Throws when declared", for a declaration builder whose body throws.
6. `@category`, from the list below, then `@since`: the version that added the export in this shape. No other tag.

A `dual` function's doc comment is on its export, not on each overload. A field of a data type has a one-line comment when its name doesn't say it all.

`pnpm build:packages && pnpm smoke --no-build` compiles every example alone against the packed package. Nothing runs them, so a `// =>` result is only as true as its author made it.

## Categories

One closed list: add a category here before an export uses it.

| Category | What goes in it |
| --- | --- |
| `models` | A data type's interface, a secondary type, a type a game writes, a set of constants |
| `constructors` | `make`, `empty`, `fromX`, `makeX` |
| `guards` | `isX` |
| `getters` | What reads a value, or writes only into what its caller hands it |
| `mutations` | What changes the value it is given, or draws from it (`Rng.next`) |
| `combinators` | What takes values of the module and returns a new one |
| `math` | A function of numbers |
| `utility types` | A type computed from another |
| `schemas` | A Schema, or what builds one |
| `services` | A `Context.Service` |
| `layers` | A Layer |
| `references` | A `Context.Reference` |
| `errors` | A typed error |
| `declarations` | A declaration builder |
| `testing` | What only a test imports |
