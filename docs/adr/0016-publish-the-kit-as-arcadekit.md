---
status: superseded by ADR-0018
---

# Publish the kit to npm as @arcadekit

Superseded by [ADR-0018](0018-one-package-with-entries.md): the nine packages are now one package, `arcadekit`, with the same entries. The name, the build, the peer ranges, the checks and the release process below carry over.

> Amended by [ADR-0024](0024-the-kit-is-written-as-effect-modules.md) on 2026-11-14: `arcadekit/render-three` is a set of namespaces in Effect's shape, and the text below uses its names for the camera helpers: `Camera.fit`, `Camera.follow` and `Camera.orbit`.

#26 asked how the kit becomes usable from outside this workspace. Until now every package was `"private": true` and exported its TypeScript source directly. The decisions below came from a grilling session.

## Decision

**Name.** The `@gamekit` npm scope is taken: an organisation exists with no public packages. So is the unscoped `gamekit`. The project becomes **arcadekit** everywhere: the scope (`@arcadekit/runtime`), every import, the README, the current docs, and the demo apps. The GitHub repository is renamed to match. The domain words in `CONTEXT.md` ("kit", "genre package") stay. ADRs written before this one keep their wording, so they may say "gamekit".

**What publishes.** The nine kit packages: `core`, `input`, `content`, `save`, `audio`, `render-three`, `runtime`, `net` and `foldkit`. The genre packages (`survivors`, `push-puzzle`) and the demo apps stay private examples. Publishing them would make every one of their exports public ([#30](https://github.com/lucasthevenet/arcadekit/issues/30)), and would move the kit's version whenever only a game changed.

**Licence.** MIT, "Lucas Thevenet".

**Versions.** One version for every package (lockstep), starting at `0.1.0`. While below 1.0, a minor version may break the interface, and the README says so.

**Before `0.1.0`.** The kit options nobody uses yet are removed or given a stated reason, since removing them is free now and breaking once published:

- `Stage`'s camera options;
- `InputController`'s options;
- `GameEngine.start`'s seed and `alpha`.

`Stage` lost `fov`, `near`, `far`, `maxPixelRatio`, `antialias` and `fog`: its camera, scene and renderer are public, so a game sets those itself. Its "perspective" and "orthographic" cameras stay, with `Camera.fit`, `Camera.follow` and `Camera.orbit`, though both genres use the pixel camera: they are how a game that isn't pixel art uses the stage, and dropping them would make `render-three` a pixel-art package. `InputController` lost its options, and `GameEngine.start` its seed (`alpha` was already gone).

`@arcadekit/runtime/testing` publishes, as a test helper: `manualFrames()` lets a game's own tests drive an engine frame by frame. [ADR-0010](0010-a-game-is-a-simulation-and-a-presentation.md) left this to #26.

**Build.**

- tsdown builds each package to `dist/`, as ESM only, with sourcemaps.
- Type files come from tsdown's `oxc` generator. It needs code written for isolated declarations, so the kit packages turn on TypeScript's `isolatedDeclarations` and every exported value has an explicit type.
- The other generators were weighed:
  - `tsgo` needs TypeScript 7.1, which is in beta (the repo has 7.0);
  - `tsc` needs TypeScript 5 or 6 installed beside 7.

**The workspace keeps using source.** Each package's `exports` gives a custom `source` condition pointing at `src/`, ahead of the `types` and `import` conditions pointing at `dist/`. TypeScript (`customConditions`), Vite and Vitest (`resolve.conditions`) resolve `source`, so `pnpm dev`, `pnpm test` and `pnpm typecheck` need no build. Rewriting `exports` at publish time (`publishConfig.exports`) was the alternative. It was rejected because the published shape would then differ from the one in the repository.

**Peer dependencies.** `effect`, `three`, `foldkit` and `@effect/platform-browser` are peer dependencies with narrow ranges (`effect ~4.1`, `foldkit ~0.170`, `three ^0.187`). A user installs each one once, so Effect services and Three.js `instanceof` checks never see two copies. The workspace keeps them as dev dependencies.

**What users need.**

- ESM.
- TypeScript 5.4 or later, for `NoInfer` in `gameViewport`. Effect 4.1's own type files need 5.7, so 5.4 to 5.6 work only with `skipLibCheck`.
- Node 22 or later for tooling.

**Checks.** CI runs `publint` and `@arethetypeswrong/cli` on every package, plus a pack-and-install smoke test. The smoke test packs every package and installs the tarballs into a throwaway project outside the workspace. There it type-checks with TypeScript 5.9 and 7, builds a small game with Vite, and checks that only one copy of `effect` and `three` is installed.

**Releases.**

- Changesets: a PR adds a changeset, a bot opens a "Version packages" PR, and merging that PR publishes.
- Publishing uses npm trusted publishing (OIDC from GitHub Actions) with provenance, so no npm token is stored.
- npm can only add a trusted publisher to a package that exists. So the maintainer publishes `0.1.0` once from their own machine, then adds the release workflow as each package's trusted publisher.

## Consequences

- Each published package has a README (what it is for, install with its peer libraries, a small example) and the metadata `license`, `repository`, `sideEffects`, `files` and `engines`. The root README gains an Install section.
- [#30](https://github.com/lucasthevenet/arcadekit/issues/30) is no longer urgent: the genres don't publish, so trimming their exports is just tidying.
- The release and checks workflows live in `.github/workflows/`. A maintainer adds them, since the agent sessions can't push workflow files.
- Changing a published package's interface needs a changeset that says how it breaks, while below 1.0.
