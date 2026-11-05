# Changesets

A changeset says which packages a change releases, how far it bumps them, and the line that goes in their changelogs. Add one to any PR that changes a published package:

```sh
pnpm changeset
```

- The nine kit packages share one version (the `fixed` group in `config.json`), so bumping one bumps them all.
- The genre packages and the demo apps never release (`ignore`).
- While below 1.0, a minor bump may break the interface. Say how in the changeset.

On `main`, the release workflow opens a "Version packages" PR that applies the pending changesets. Merging it publishes to npm. See [ADR-0016](../docs/adr/0016-publish-the-kit-as-arcadekit.md).

`first-release.md` takes the packages from `0.0.0` to `0.1.0`. The maintainer runs `pnpm version-packages` and `pnpm release` for that one from their machine (`scripts/npm-setup.sh`).
