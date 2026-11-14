---
name: pull-requests
description: Finishing a change. Use when a change works and is about to be committed, pushed or opened as a pull request.
---

- **A changeset** comes with any change to what the published package (`packages/arcadekit`) does or exports; [`.changeset/README.md`](../../../.changeset/README.md) has the format. While below 1.0 it is `minor`, and says what breaks, with what a game writes instead, or that nothing does. A rename's changeset has a table of old and new names. The genre packages and the demos never release.
- **Say what breaks** in the commit message and the PR description too.
- **Before pushing**, `pnpm check`, `pnpm typecheck` and `pnpm test` pass, and `pnpm build` too when a README, the glossary or the docs site changed.
- **In the PR**, give the reason for each change a reviewer has to accept on purpose: a new import between entries, a new package in `ENTRY_PACKAGES`, a changed replay or determinism hash. Give `pnpm bench`'s numbers when the performance skill applies.
