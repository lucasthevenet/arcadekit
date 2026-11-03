---
status: accepted
---

# Both apps show the same save, so a shared save package is earned

#23 gave each demo app a save: the records it keeps between sessions. Each app built its own first, as [ADR-0001](0001-kit-changes-need-two-genres.md) asks. Both are done now, so the evidence is in. Most of the code is the same in both apps, and the same parts are the ones that are easy to get wrong. So a `@gamekit/save` package is earned. This ADR records that decision. The extraction is a follow-up.

## Evidence

Compared at the commits that added each save (`apps/push-puzzle-demo/src/app/save.ts`, `apps/survivor-demo/src/app/save.ts`, and their tests).

| File           | push-puzzle-demo | survivor-demo | Same in both |
| -------------- | ---------------- | ------------- | ------------ |
| `save.ts`      | 167 lines        | 157 lines     | 109 lines    |
| `save.test.ts` | 227 lines        | 208 lines     | 145 lines    |

Between them, the two `save.ts` files have 106 lines that differ. Many only rename `LevelRecords` to `HeroRecords` or `levels` to `heroes`. With those names made equal, 76 lines differ.

Same in both apps, line for line:

- The stored shape: `{ version: 1, <records> }`, a `migrate` step and a `toStored` step.
- One key per game, `gamekit/<game>/save`, and the backup key `<key>/corrupt`.
- `load`: a missing save reads as empty. A save that fails its Schema (corrupt, or an unknown version) is copied once to the backup key, removed, logged and read as empty. A store that can't be read is logged and read as empty.
- The write: re-read the stored save, merge, write, log and drop a failed write, and return the merged records either way. So neither method fails, and the app's Commands keep the error type `never`.
- `mergeRecords`: records by id, ids only one side has are kept, and ids on both sides go through a per-record merge. Ids the content no longer has stay in storage.
- `BrowserSaveStorage`: `BrowserKeyValueStore.layerLocalStorage`, falling back to `KeyValueStore.layerMemory` with a warning when the browser won't give access to localStorage.
- In the tests: a store whose writes fail, the `run` helper that seeds the store and collects the logs, and the cases for a missing, corrupt and unknown-version save, the merge with another tab, and a failed write.

Different in each app:

- The record Schema. Push-puzzle keeps `solved` and `bestMoves` per level id. Survivors keeps `bestTime`, `mostKills` and `won` per hero id.
- The per-record merge. Push-puzzle keeps the fewer moves among solved records. Survivors keeps the higher time, the more kills, and `won` if either says so.
- What a write takes: a level id and a move count, or a `RunSummary`. These turn into one record in a line or two (`withSolve`, `withRun`).
- Push-puzzle's `isNewBest`, for its Solved screen. Survivors has no such screen.
- The service's tag and the key's game name.
- The Commands, Messages, Model fields and views that use the save. These are app code either way.

## Considered Options

- **Keep a copy in each app.** Each copy is small, and the apps stay free to drift. But a fix to the shared part, such as how a corrupt save is backed up, would have to land twice, and the tests for it are copied too.
- **Wait for a third game.** ADR-0001 asks for two genres or two apps, and there are two. The parts that differ are already narrow: a Schema and a merge function.

## Consequences

- The follow-up builds `@gamekit/save` from the identical parts. It takes the key, the record Schema and the per-record merge, and gives back `load` and a write that merges. Neither fails. The record Schema, the merge, `withSolve`/`withRun`, `isNewBest` and all the UI stay in the apps.
- The package sits beside `content`: it depends on `effect` and on no other kit package, and no genre package depends on it. The save is UI state, not simulation state.
- Its root entry holds the store logic over any `KeyValueStore`, with no DOM, checked by a `tsconfig.root.json` as [ADR-0002](0002-genre-root-entries-are-dom-free.md) asks. The localStorage layer and its fallback go in a `./browser` entry, which depends on `@effect/platform-browser`.
- Neither app has migrated a save yet: both are at version 1. The package should not guess a migration API from no examples. It can take the versioned Schema and a `migrate` function from the app, as each app does today.
- Tests keep using `KeyValueStore.layerMemory`, never real localStorage. The shared failure cases move to the package's tests, and each app keeps the tests for its own merge and UI.
- #24's settings get their own key, outside the save. They may reuse the package's store logic, but they don't merge as records do: the last write wins.
- Revisit if the follow-up finds the generic version needs more code than the two copies it replaces.
