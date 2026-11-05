# arcadekit

## Project status: alpha

arcadekit is alpha. Nothing depends on it in production yet: no players, deployments or users to protect. Breaking changes are fine when they improve the code, and a better design wins over compatibility. That covers API changes, renames, removing or reshaping exports, changing stored data formats or localStorage keys, and large refactors.

- Don't add compatibility shims, deprecation paths or data migrations. Change the code and update its callers.
- Still say what breaks: in the commit message, in the PR description, and, for a published `@arcadekit` package, in its changeset (a minor bump while below 1.0).
- Keep the replay and determinism hashes unless a change to the simulation's rules is the point.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
