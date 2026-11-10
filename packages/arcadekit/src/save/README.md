# arcadekit/save

A game's save: records by id (a level's best moves, a hero's best run) under one versioned storage key. Each write re-reads the stored save and merges, so another tab's record isn't lost. A corrupt save is backed up and read as empty, and storage failures are logged rather than raised, so play goes on. `BrowserSaveStorage` in `arcadekit/save/browser` stores it in localStorage, or in memory if the browser refuses.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect @effect/platform-browser
```

Peer dependencies: `effect` (~4.1), and `@effect/platform-browser` (~4.1, an optional peer) for `arcadekit/save/browser` only.

## Example

Solved levels with their best move count (from the push-puzzle demo):

```ts
import { makeSaveStore } from "arcadekit/save";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Effect, Schema } from "effect";

const LevelRecord = Schema.Struct({
  solved: Schema.Boolean,
  bestMoves: Schema.Int,
});
type LevelRecord = typeof LevelRecord.Type;

/** The best of both: solved if either says so, with the fewer moves. */
const mergeRecord = (a: LevelRecord, b: LevelRecord): LevelRecord =>
  !a.solved
    ? b
    : !b.solved
      ? a
      : { solved: true, bestMoves: Math.min(a.bestMoves, b.bestMoves) };

export const recordSolve = (levelId: string, moves: number) =>
  Effect.gen(function* () {
    const store = yield* makeSaveStore({
      key: "my-studio/my-game/save",
      field: "levels",
      record: LevelRecord,
      mergeRecord,
    });
    // Neither call fails. `merge` returns the merged records.
    return yield* store.merge({
      [levelId]: { solved: true, bestMoves: moves },
    });
  }).pipe(Effect.provide(BrowserSaveStorage));
```

The store works over any Effect `KeyValueStore`, so tests use `KeyValueStore.layerMemory`. See [ADR-0009](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0009-a-save-package-is-earned.md).
