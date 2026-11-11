# Changesets

A changeset says that a change releases `arcadekit`, how far it bumps it, and the line that goes in its changelog. Add one to any PR that changes the published package (`packages/arcadekit`):

```sh
pnpm changeset
```

The command asks its questions at a prompt. The file it writes can be written by hand instead, as `.changeset/<a-few-words>.md`: the package and the bump between two `---` lines, then the text.

```md
---
"arcadekit": minor
---

What changed, in a sentence. Then, under **Breaking**, what a game now writes instead.
```

`pnpm fix` formats a `ts` block of a changeset too. Keep a `yield*` inside a generator there, or the formatter writes it back as `yield * x`.

- `arcadekit` is the one published package; every entry (`arcadekit/core`, `arcadekit/net`, ...) releases with it.
- The genre packages and the demo apps never release (`ignore`).
- While below 1.0, a minor bump may break the interface. Say how in the changeset.
- A change that only adds is `minor` too while below 1.0. Say that nothing breaks.

On `main`, the release workflow opens a "Version packages" PR that applies the pending changesets. Merging it publishes to npm. See [ADR-0018](../docs/adr/0018-one-package-with-entries.md).

The first `arcadekit` on npm is a `0.0.0` placeholder the maintainer publishes from their machine (`scripts/npm-setup.sh`), so the package exists and can name the release workflow as its trusted publisher. Every real version comes from the workflow.
