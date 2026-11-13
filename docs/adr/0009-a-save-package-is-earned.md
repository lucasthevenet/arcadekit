---
status: accepted
---

# Both apps show the same save, so a shared save package is earned

> Amended by [ADR-0020](0020-a-game-is-declared.md) on 2026-11-11: a save is declared. `makeSaveStore(definition)` is the `Save` declaration, whose class is the key of the service each app wrote by hand; its definition's `key` is `storageKey`, its `load` is `read` and its `merge(records)` is `write(records)`, which still merges; `mergeRecords(mergeRecord)` is the class's `merge`. The stored shape, the keys and the backup are as [The shape picked](#the-shape-picked) has them. The settings this decision left to #24 "may reuse the package's store logic", and now do: one value under its own key is the `Setting` declaration, in the same entry, over the module the save reads and writes with.

> Amended by [ADR-0024](0024-the-kit-is-written-as-effect-modules.md) on 2026-11-13, when `arcadekit/save` took Effect's module shape: a save's definition has no `field`, and the stored save is `{ version: 1, records }`. The field kept each app's stored format as it was, so that saves already stored still loaded ([The shape picked](#the-shape-picked)); the kit is alpha and keeps no stored format for its own sake, so a save stored the old way reads as corrupt and is backed up. What a save's and a setting's service give is `Stored.Stored`, and a declaration's writes run one at a time. `BrowserSaveStorage` is `BrowserSaveStorage.layer`, as the text below names it.

#23 gave each demo app a save: the records it keeps between sessions. Each app built its own first, as [ADR-0001](0001-kit-changes-need-two-genres.md) asks. Both are done now, so the evidence is in. Most of the code is the same in both apps, and the same parts are the ones that are easy to get wrong. So a `@gamekit/save` package is earned. This ADR records that decision. The extraction is done: see [The shape picked](#the-shape-picked).

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
- `BrowserSaveStorage.layer`: `BrowserKeyValueStore.layerLocalStorage`, falling back to `KeyValueStore.layerMemory` with a warning when the browser won't give access to localStorage.
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

- The follow-up builds `@gamekit/save` from the identical parts. (It was done in #23 itself. See [The shape picked](#the-shape-picked).) It takes the key, the record Schema and the per-record merge, and gives back `load` and a write that merges. Neither fails. The record Schema, the merge, `withSolve`/`withRun`, `isNewBest` and all the UI stay in the apps.
- The package sits beside `content`: it depends on `effect` and on no other kit package, and no genre package depends on it. The save is UI state, not simulation state.
- Its root entry holds the store logic over any `KeyValueStore`, with no DOM, checked by a `tsconfig.root.json` as [ADR-0002](0002-genre-root-entries-are-dom-free.md) asks. The localStorage layer and its fallback go in a `./browser` entry, which depends on `@effect/platform-browser`.
- Neither app has migrated a save yet: both are at version 1. The package should not guess a migration API from no examples. It can take the versioned Schema and a `migrate` function from the app, as each app does today. (Superseded: the package took neither. See [The shape picked](#the-shape-picked).)
- Tests keep using `KeyValueStore.layerMemory`, never real localStorage. The shared failure cases move to the package's tests, and each app keeps the tests for its own merge and UI.
- #24's settings get their own key, outside the save. They may reuse the package's store logic, but they don't merge as records do: the last write wins.
- Revisit if the follow-up finds the generic version needs more code than the two copies it replaces.

## The shape picked

Done in #23, right after this decision, rather than as a later follow-up.

- The root entry exports `makeSaveStore(definition)`, which needs a `KeyValueStore` and gives a `SaveStore` with `load` and `merge(records)`. Neither fails. `merge` re-reads the stored save, merges, writes, logs and drops a failed write, and returns the merged records. It also exports `mergeRecords(mergeRecord)`. The backup key is `<key>/corrupt`, kept inside the package.
- A game's `SaveDefinition` is its `key`, the `field` the records sit under in the stored save (`levels`, `heroes`), its record Schema and its `mergeRecord`. The field keeps each app's stored format as it was, so existing saves still load.
- The package owns the stored shape `{ version: 1, <field>: records }`. It takes no versioned Schema or `migrate` from the app: with every save at version 1 there is nothing to migrate, and an app-supplied Schema would have meant two copies of the same three lines. When a game first changes its record shape, the package grows a migration then, from that example.
- `./browser` exports `BrowserSaveStorage.layer`. Only it imports `@effect/platform-browser`.
- Each app keeps its Save service (tag, `recordSolve` or `recordRun`), its record Schema and merge, `withSolve`/`withRun` and `isNewBest`, and turns a solve or a run into one record before calling `merge`. The shared failure cases are tested once, in the package, against `KeyValueStore.layerMemory`. Each app tests only its merge, its key and stored format, and its Story wiring.
- The total is a little more code than the two copies (about 350 lines against 324), from the package's interface and docs. So the revisit condition above is met, and the tests grew too (465 lines against 435). The extraction is kept anyway: the shared part, and the tests for its failure cases, now exist once, so a fix to them lands in one place.
