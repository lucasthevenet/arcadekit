# Changesets

A changeset says that a change releases `arcadekit`, how far it bumps it, and the line that goes in its changelog. Add one to any PR that changes the published package (`packages/arcadekit`):

```sh
pnpm changeset
```

- `arcadekit` is the one published package; every entry (`arcadekit/core`, `arcadekit/net`, ...) releases with it.
- The genre packages and the demo apps never release (`ignore`).
- While below 1.0, a minor bump may break the interface. Say how in the changeset.

On `main`, the release workflow opens a "Version packages" PR that applies the pending changesets. Merging it publishes to npm. See [ADR-0018](../docs/adr/0018-one-package-with-entries.md).

The first `arcadekit` on npm is a `0.0.0` placeholder the maintainer publishes from their machine (`scripts/npm-setup.sh`), so the package exists and can name the release workflow as its trusted publisher. Every real version comes from the workflow.
