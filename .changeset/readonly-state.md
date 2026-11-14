---
"arcadekit": minor
---

A view, a sample and a state hash are given a run's state read-only, so the compiler refuses a write there that would change one peer's run and not another's. `Game.ReadonlyState<S>` (`arcadekit/game` and `arcadekit/game/browser`) is that type: every field read-only, all the way down, each typed array a `Layout.ReadonlyTypedArray`, and each structure of `arcadekit/core` its new read-only form: `EntityPool.ReadonlyEntityPool`, `EntityPool.ReadonlyIdentified`, `Ring.ReadonlyRing`, `TileMap.ReadonlyTileMap`, `SpatialGrid.ReadonlySpatialGrid` and `Rng.ReadonlyRng`, with `Layout.TypedArray` and `Layout.ReadonlyFields`. The functions that only read take the read-only form (`EntityPool.idOf`, `indexOf`, `visit`, `Ring.slotOf`, `RingReader.take`, every function of `TileMap`, `SpatialGrid.query`, `within`, `nearest`); those that write refuse it. Nothing changes at runtime: the state given is the run's own.

**Breaking**

- `Game.View`'s `render` takes `Game.ReadonlyState<State> | null`.
- `Game.Sample`'s `read` and `version` take `Game.ReadonlyState<State>`.
- A `Coop`'s `hash` and `LockstepSession`'s `hash` option take `Game.ReadonlyState<State>`, as does `TestGame.hash` (`arcadekit/net/testing`).

A game whose view, sample or hash names the writable state now names the read-only one, and so does each of its functions that one of them calls:

```ts
// Before
export const hudSample = (self: Arena) => ({ time: self.time });

// After
export const hudSample = (self: Game.ReadonlyState<Arena>) => ({
  time: self.time,
});
```
