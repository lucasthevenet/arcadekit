/**
 * The storage core on its own: the package's `arcadekit/ecs` entry.
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
 * It is plain synchronous TypeScript and imports nothing: no Effect, and
 * nothing else of this package. Everything here is the same object when it
 * is reached through `arcadekit`, where the world is called `EcsWorld`.
 */
export { Component, entityGeneration, entityIndex, Field } from "./component";
export type {
  ComponentDef,
  ComponentInput,
  ComponentValue,
  Entity,
  FieldDef,
  FieldKind,
  OnTargetDespawn,
  ReadonlyColumn,
  RefCodec,
  SingletonSpec,
  Storage,
  ValueOf,
} from "./component";
export { Rng } from "./random";
export { readSnapshot, SnapshotError, writeSnapshot } from "./snapshot";
export type {
  SnapshotComponent,
  SnapshotContents,
  SnapshotProblem,
  SnapshotSingleton,
  SnapshotSparse,
  SnapshotTable,
} from "./snapshot";
export { CommandBuffer, QueryView, RemovedReader, World } from "./world";
export type {
  ChangeKind,
  EntityColumn,
  QuerySpec,
  SavedChanges,
  SparseColumns,
  Terms,
} from "./world";
