/**
 * The storage core on its own: components, entities and the world that holds
 * them, as plain synchronous TypeScript.
 *
 *   import { Query } from "arcadekit"
 *   import { Component, Field, World } from "arcadekit/ecs"
 *
 *   const Position = Component.define("physics/Position", { x: Field.f32, y: Field.f32 })
 *   const Positioned = Query.all(Position).pipe(Query.writes(Position))
 *
 *   const world = new World({ seed: 7 })
 *   const rock = world.spawn(Position.of({ x: 0, y: 0 }))
 *   world.view(Positioned).each((position) => { position.x += 1 })
 *   world.get(rock, Position)                  // { x: 1, y: 0 }
 *
 * The core imports nothing: not Effect, and nothing else of this package. The
 * root entry, `arcadekit`, exports the same objects. A component defined here
 * is the same component there, and the root entry's `EcsWorld`, beside the
 * `World` service, is this `World` class. The root entry's `Field` module has
 * one more field type, `Field.schema`. `entityIndex`, `entityGeneration` and
 * `placed` are exported only here.
 */
export {
  Component,
  entityGeneration,
  entityIndex,
  Field,
} from "./component.ts";
export type { PatchOf, RelationDef, TargetField } from "./relation.ts";
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
  WritableColumn,
  RefCodec,
  RequiredOf,
  SingletonSpec,
  Storage,
  ValueOf,
} from "./component.ts";
export { Rng } from "./random.ts";
export type { Frozen, JsonValue } from "./frozen.ts";
export { placed } from "./spawned.ts";
export type { Placed, Spawned, WithSpawned } from "./spawned.ts";
export { readSnapshot, writeSnapshot } from "./contents.ts";
export type {
  SnapshotComponent,
  SnapshotContents,
  SnapshotSingleton,
  SnapshotSparse,
  SnapshotTable,
} from "./contents.ts";
export type { SnapshotStore } from "./format.ts";
export { SnapshotError } from "./snapshot.ts";
export type { SnapshotProblem } from "./snapshot.ts";
export { RemovedReader } from "./changes.ts";
export type { ChangeKind, SavedChanges } from "./changes.ts";
export { CommandBuffer } from "./commands.ts";
export { PointingView, QueryView } from "./query.ts";
export type { EntityColumn, QuerySpec, SparseColumns, Terms } from "./query.ts";
export { World } from "./world.ts";
