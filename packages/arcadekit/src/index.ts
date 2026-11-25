/**
 * Every module of the package except `Browser`, each exported under its name.
 *
 *   import { App, Input, System } from "arcadekit"
 *
 * Each module is the same object as its own entry point,
 * `import * as Input from "arcadekit/Input"`. Two modules are exported as
 * their members instead: `EntityId` from `Schemas`, and the services from
 * `Services`. The storage core, `arcadekit/ecs`, is exported as the members
 * a game uses, with its world class as `EcsWorld`, beside the `World`
 * service.
 */
export * as Action from "./Action";
export * as App from "./App";
export * as Assets from "./Assets";
export * as Color from "./Color";
export * as Driver from "./Driver";
export {
  Component,
  type ComponentDef,
  type Entity,
  type FieldDef,
  type OnTargetDespawn,
  type RefCodec,
  type RequiredOf,
  type SingletonSpec,
} from "./ecs/component";
export type { RelationDef } from "./ecs/relation";
export type { JsonValue } from "./ecs/frozen";
export type { Rng } from "./ecs/random";
export type { Placed, Spawned, WithSpawned } from "./ecs/spawned";
export {
  readSnapshot,
  type SnapshotComponent,
  type SnapshotContents,
  type SnapshotSingleton,
  type SnapshotSparse,
  type SnapshotTable,
  writeSnapshot,
} from "./ecs/contents";
export { SnapshotError, type SnapshotProblem } from "./ecs/snapshot";
export {
  type ChangeKind,
  type RemovedReader,
  type SavedChanges,
} from "./ecs/changes";
export { CommandBuffer } from "./ecs/commands";
export {
  type EntityColumn,
  type QueryView,
  type SparseColumns,
} from "./ecs/query";
export { World as EcsWorld } from "./ecs/world";
export * as Event from "./Event";
export * as Field from "./Field";
export * as Input from "./Input";
export * as Journal from "./Journal";
export * as Migrate from "./Migrate";
export * as Plugin from "./Plugin";
export * as Query from "./Query";
export * as Resource from "./Resource";
export * as Save from "./Save";
export * as Singleton from "./Singleton";
export * as Sound from "./Sound";
export * as State from "./State";
export { EntityId } from "./Schemas";
export { Commands, Events, Frame, Random, Time, World } from "./Services";
export * as System from "./System";
export * as Timeline from "./Timeline";
export * as Transform2d from "./Transform2d";
export * as Transform3d from "./Transform3d";
export * as View from "./View";
