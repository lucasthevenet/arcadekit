/**
 * The `arcadekit/ecs` entry point: the storage core on its own.
 *
 *   import { Component, Field, World } from "arcadekit/ecs"
 *
 *   const Position = Component.define("physics/Position", { x: Field.f32, y: Field.f32 })
 *   const world = new World({ seed: 7 })
 *   world.spawn(Position.of({ x: 0, y: 0 }))
 *   world
 *     .view({ terms: [Position], withDefs: [], withoutDefs: [] })
 *     .each((pos) => { pos.x += 1 })
 *
 * The core is plain synchronous TypeScript with no imports: no Effect, and
 * nothing else from this package. The root entry exports the same objects, so a
 * world created here is one `arcadekit` accepts and a component is the same
 * component. The root entry exports the world class as `EcsWorld`, next to the
 * `World` service, and leaves out `entityIndex` and `entityGeneration`, which
 * are only available here.
 */
export { Component, entityGeneration, entityIndex, Field } from "./component";
export type {
  ComponentDef,
  ComponentInput,
  ComponentValue,
  Entity,
  FieldDef,
  FieldKind,
  InputOf,
  OnTargetDespawn,
  ReadonlyColumn,
  RefCodec,
  SingletonSpec,
  Storage,
  ValueOf,
} from "./component";
export { Rng } from "./random";
export { placed } from "./spawned";
export type { Placed, Spawned, WithSpawned } from "./spawned";
export { readSnapshot, writeSnapshot } from "./contents";
export type {
  SnapshotComponent,
  SnapshotContents,
  SnapshotSingleton,
  SnapshotSparse,
  SnapshotTable,
} from "./contents";
export type { SnapshotStore } from "./format";
export { SnapshotError } from "./snapshot";
export type { SnapshotProblem } from "./snapshot";
export { RemovedReader } from "./changes";
export type { ChangeKind, SavedChanges } from "./changes";
export { CommandBuffer } from "./commands";
export { QueryView } from "./query";
export type { EntityColumn, QuerySpec, SparseColumns, Terms } from "./query";
export { World } from "./world";
