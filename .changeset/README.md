# Changesets

A changeset says that a change releases a package, how far it bumps it, and the line that goes in its changelog. Add one to any PR that changes a published package (`packages/arcadekit`, `packages/three`):

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

- Two packages are published: `arcadekit`, with which every one of its entries releases, and `@arcadekit/three`. A changeset names the ones it changes, each with its own bump.
- `@arcadekit/three` has `arcadekit` as a peer. Releasing `arcadekit` releases it too, as a patch, with the new range.
- While below 1.0, a minor bump may break the interface. Say how in the changeset.
- A change that only adds is `minor` too while below 1.0. Say that nothing breaks.

On `main`, the release workflow opens a "Version packages" PR that applies the pending changesets. Merging it publishes to npm.

npm publishes through trusted publishing: it trusts the release workflow, so no npm token is stored. Each package names the workflow as its trusted publisher in its own settings on npm, so a new package has to be given one there before its first release.
