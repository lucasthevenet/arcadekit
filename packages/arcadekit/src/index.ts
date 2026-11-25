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
export * as Action from "./Action.ts";
export * as App from "./App.ts";
export * as Assets from "./Assets.ts";
export * as Color from "./Color.ts";
export * as Driver from "./Driver.ts";
export {
  Component,
  type ComponentDef,
  type Entity,
  type FieldDef,
  type OnTargetDespawn,
  type RefCodec,
  type RequiredOf,
  type SingletonSpec,
} from "./ecs/component.ts";
export type { RelationDef } from "./ecs/relation.ts";
export type { JsonValue } from "./ecs/frozen.ts";
export type { Rng } from "./ecs/random.ts";
export type { Placed, Spawned, WithSpawned } from "./ecs/spawned.ts";
export {
  readSnapshot,
  type SnapshotComponent,
  type SnapshotContents,
  type SnapshotSingleton,
  type SnapshotSparse,
  type SnapshotTable,
  writeSnapshot,
} from "./ecs/contents.ts";
export { SnapshotError, type SnapshotProblem } from "./ecs/snapshot.ts";
export {
  type ChangeKind,
  type RemovedReader,
  type SavedChanges,
} from "./ecs/changes.ts";
export { CommandBuffer } from "./ecs/commands.ts";
export {
  type EntityColumn,
  type PointingView,
  type QueryView,
  type SparseColumns,
} from "./ecs/query.ts";
export { World as EcsWorld } from "./ecs/world.ts";
export * as Event from "./Event.ts";
export * as Field from "./Field.ts";
export * as Input from "./Input.ts";
export * as Journal from "./Journal.ts";
export * as Migrate from "./Migrate.ts";
export * as Plugin from "./Plugin.ts";
export * as Query from "./Query.ts";
export * as Resource from "./Resource.ts";
export * as Save from "./Save.ts";
export * as Singleton from "./Singleton.ts";
export * as Sound from "./Sound.ts";
export * as State from "./State.ts";
export { EntityId } from "./Schemas.ts";
export { Commands, Events, Frame, Random, Time, World } from "./Services.ts";
export * as System from "./System.ts";
export * as Timeline from "./Timeline.ts";
export * as Transform2d from "./Transform2d.ts";
export * as Transform3d from "./Transform3d.ts";
export * as View from "./View.ts";
