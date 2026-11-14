// arcadekit/core: the data a step keeps and the arithmetic it calls. Plain on purpose:
// a step calls all of it, so it gives the same bits on every peer and finishes in the call, and
// it is data work, as Effect's own Array and MutableRef are. Each module is a namespace.

export * as EntityPool from "./entity-pool";
export * as EventBuffer from "./event-buffer";
export * as ExactMath from "./exact-math";
export * as FixedStepClock from "./fixed-step-clock";
export * as Layout from "./layout";
export * as Point2 from "./point2";
export * as Ring from "./ring";
export * as RingReader from "./ring-reader";
export * as Rng from "./rng";
export * as SpatialGrid from "./spatial-grid";
export * as StateHash from "./state-hash";
export * as TileMap from "./tile-map";
export * as Timer from "./timer";
export * as Tween from "./tween";
