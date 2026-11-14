---
status: accepted
---

# The kit is one package with entries

> Amended on 2026-11-14: `arcadekit/audio`'s service is `AudioSystem.AudioSystem`, keyed `arcadekit/audio/AudioSystem`, since `arcadekit/audio` took Effect's module shape ([ADR-0024](0024-the-kit-is-written-as-effect-modules.md)): the key `arcadekit/audio/Audio` below is gone, and `arcadekit/audio/browser` is a folder (`src/audio/browser/index.ts`).

> Amended on 2026-11-13: every entry may import `effect`, the one required peer, `core` and `input` included. Lint no longer bans it in their files, and the entry-packages test allows it for both ([ADR-0017](0017-effect-at-the-edges-plain-code-inside.md)).

> Amended on 2026-11-13: the package has twenty entries. `render-three/testing` joined ([#84](https://github.com/lucasthevenet/arcadekit/issues/84)): what a sprite view's tests need (`testSheet`, `drawnSprites`, `pngSize`, `framesWithSoftAlpha`), which only tests import. It is in the `render-three` group, so the graph has no new arrow. It is the first entry that runs in Node and imports one of its built-ins, `node:zlib`, to inflate a PNG. A built-in is no package, so `ENTRY_PACKAGES` lists it by its `node:` name, and `test/entry-packages.test.ts` allows one only in an entry that only a test or a script imports (`NODE_ENTRIES`). `tsconfig.node.json` checks those entries and their tests with Node's types beside the DOM's, `tsconfig.json` leaves their folders out, and the build keeps a `node:` import as an import. An entry a browser or a Worker loads still imports no built-in.

> Amended by [ADR-0020](0020-a-game-is-declared.md) on 2026-11-11: the package has nineteen entries. The three `runtime` entries are gone, with the older contract they held, and `game/testing` joined (`ManualFrames`, which only tests import). What `runtime` had that survives is `game`'s: the frame loop, views, the input types and, exported from no entry, `GameLoop` (now `Kernel`). So `game` imports only `core`, `net` imports `core` and `game`, and `foldkit` imports `game`, which only its tests use. `tsconfig.root.json` compiles `core` and the root entries of `content`, `save`, `audio`, `game` (with `game/scenario`) and `net`, with `net/signalling`, without DOM types.

> Amended by [ADR-0024](0024-the-kit-is-written-as-effect-modules.md) on 2026-11-14: `arcadekit/game` is in Effect's shape, and the text above uses its names: `arcadekit/game/testing` holds the namespace `ManualFrames`, and its public file is `src/game/testing/index.ts`.

> Since [ADR-0020](0020-a-game-is-declared.md): the package has twenty-one entries. `game`, `game/browser` and `game/scenario` (a game's declarations, its engine and its scenarios) are a tenth group, which may import `core` and `runtime`, and `net` may import `game`: a lockstep session hosts a declared simulation.

> Since [ADR-0019](0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md): the package has eighteen entries. `net/worker` (the signalling worker, for Cloudflare) and `net/testing` (test helpers for a Co-op game) joined the sixteen below. Both are in the `net` group, so the graph has no new arrow. `net/worker` may import `cloudflare:workers`, with `@cloudflare/workers-types` as an optional peer for its types; `tsconfig.worker.json` checks it with Workers types and no DOM.

[ADR-0016](0016-publish-the-kit-as-arcadekit.md) published the kit as nine packages under `@arcadekit`, on one shared version. This replaces that layout with one package. ADR-0016's other decisions stand: the name, the licence, the build, the `source` condition, what users need, the checks, and releasing with Changesets and trusted publishing.

## Why

Nine packages cost more than they gave.

- They never released apart. One version covered all nine, so every release was nine publishes, nine changelogs with the same lines and nine trusted publishers.
- A user installed several of them and had to keep their versions equal by hand. A game on the kit listed up to nine dependencies that only work together.
- Each package had its own `package.json`, `tsconfig`, build config and peer ranges to keep in step.
- What the split did enforce, that `core` and `input` carry no Effect and that a lower layer doesn't import a higher one, can be enforced by lint and a test.

## Decision

**One package.** The kit publishes as the unscoped `arcadekit`, from `packages/arcadekit`. It starts at `0.3.0`, the minor after the nine packages' `0.2.3`, and its changelog keeps their entries.

**Sixteen entries, carried over.** Each entry of the nine packages is a subpath export of the same name, with the same exports: `@arcadekit/core` is `arcadekit/core`, and `@arcadekit/net/browser` is `arcadekit/net/browser`. The entries are `core`, `input`, `content`, `content/browser`, `save`, `save/browser`, `audio`, `audio/browser`, `render-three`, `runtime`, `runtime/browser`, `runtime/testing`, `net`, `net/browser`, `net/signalling` and `foldkit`. The package has no root export, so an import always names an entry. Each entry's source is `packages/arcadekit/src/<entry>/`, with its README beside it.

**No shims.** The nine `@arcadekit/*` packages stay on npm at `0.2.3` and get no further release. They are deprecated with a message naming `arcadekit` once the games that use them have moved.

**Peer dependencies.** `effect` is the one required peer: every entry but `core` and `input` imports it. `three`, `@types/three`, `foldkit` and `@effect/platform-browser` are optional peers, so a game installs only what the entries it imports need. The ranges are ADR-0016's.

**Lint and a test replace the package boundaries.**

- `oxlint.config.ts` lists which entry may import which: the graph the nine packages had. `core`, `input`, `content`, `save`, `audio` and `render-three` import no other entry; `runtime` imports `core`; `net` imports `core` and `runtime`; `foldkit` imports `runtime`, which only its tests use. The rule `entry-direction/allowed` (`tools/lint/entry-direction.ts`) fails any other import between entries. It also fails an import that reaches into another entry's files instead of its public file, and one that names the package itself (`arcadekit/core` from inside the package), since a relative import says the same thing without going through `exports`. Adding an arrow to the graph is a design decision, made in the PR that adds it.
- `core` and `input` stay free of Effect ([ADR-0017](0017-effect-at-the-edges-plain-code-inside.md)), and each optional peer stays in the entry it is for. Lint bans `effect` in the files of `core` and `input`, and `packages/arcadekit/test/entry-packages.test.ts` lists the packages each entry may import: none for `core` and `input`; `effect` for the rest, with `three` for `render-three`, `foldkit` for `foldkit` and `@effect/platform-browser` for `save/browser`. It follows every import from each entry, in `src/` and in the built `dist/` (the JavaScript and the type files), and fails if any reaches another package. The built check matters because the build shares chunks between entries. Inside the package a dynamic import names its module in a plain string, so lint and the test can read it.
- `packages/arcadekit/tsconfig.root.json` compiles `core` and the root entries of `content`, `save`, `audio`, `runtime` and `net`, with `net/signalling`, without DOM types, as each package's own config did.

**One build.** tsdown builds every entry in one pass, sharing chunks, so a module two entries use exists once: `arcadekit/runtime` and `arcadekit/net` step the same `GameLoop`.

## When to split again

Either of these would justify a second package:

- someone outside this repository needs a subset, for example `core` without the `effect` peer;
- an entry needs a dependency that can't be an optional peer, such as one with a native build or one that every install would have to download.

Until then, a new part of the kit is a new entry.

## Consequences

- Every import of the kit changes, from `@arcadekit/<entry>` to `arcadekit/<entry>`. The genre packages and the demo apps changed with it; a game outside the workspace changes its imports and replaces its `@arcadekit/*` dependencies with `arcadekit`.
- The keys of the Effect services follow the names: `@arcadekit/audio/Audio` is `arcadekit/audio/Audio`, and `@arcadekit/net/PeerConnector` is `arcadekit/net/PeerConnector`. Only a program that had both the old and the new package would notice.
- A package manager warns about nothing when an optional peer is missing. A game that imports `arcadekit/render-three` without `three` fails when it resolves the import, so each entry's README names its peers.
- The genre packages keep their names (`@arcadekit/survivors`, `@arcadekit/push-puzzle`) and stay private.
- Earlier ADRs and findings keep their wording: where they say `@arcadekit/runtime` or `packages/net/src`, read `arcadekit/runtime` and `packages/arcadekit/src/net`.
- Changesets has one package to version, so its `fixed` group is gone.
- npm needs the package to exist before it can trust the release workflow. The maintainer publishes a `0.0.0` placeholder once (`scripts/npm-setup.sh`), and the workflow publishes every real version.
