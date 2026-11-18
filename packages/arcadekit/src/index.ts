/**
 * Everything of the package but `Browser`, each module by its name:
 *
 *   import { App, Input, System } from "arcadekit"
 *
 * A module here is the module of its own entry, the same object:
 * `import * as Input from "arcadekit/Input"`. Three modules are given by
 * the names of their exports instead: `EntityId` of `Schemas`, the
 * services of `Services`, and the two classes of `TickScheduler`. The
 * storage core, `arcadekit/ecs`, is given by the names a game uses of it,
 * with its world as `EcsWorld`, beside the service `World`.
 */
export * as Action from "./Action";
export * as App from "./App";
export * as Assets from "./Assets";
export * as Driver from "./Driver";
export {
  Component,
  type ComponentDef,
  type Entity,
  type FieldDef,
  type OnTargetDespawn,
  type RefCodec,
  type SingletonSpec,
} from "./ecs/component";
export type { Rng } from "./ecs/random";
export {
  readSnapshot,
  type SnapshotComponent,
  type SnapshotContents,
  SnapshotError,
  type SnapshotProblem,
  type SnapshotSingleton,
  type SnapshotSparse,
  type SnapshotTable,
  writeSnapshot,
} from "./ecs/snapshot";
export {
  type ChangeKind,
  CommandBuffer,
  type EntityColumn,
  type QueryView,
  type RemovedReader,
  type SavedChanges,
  type SparseColumns,
  World as EcsWorld,
} from "./ecs/world";
export * as Event from "./Event";
export * as Field from "./Field";
export * as Input from "./Input";
export * as Lockstep from "./Lockstep";
export * as Migrate from "./Migrate";
export * as Plugin from "./Plugin";
export * as Query from "./Query";
export * as Relay from "./Relay";
export * as Resource from "./Resource";
export * as Rollback from "./Rollback";
export * as Save from "./Save";
export * as Singleton from "./Singleton";
export * as Sound from "./Sound";
export * as State from "./State";
export { EntityId } from "./Schemas";
export {
  Commands,
  Events,
  Frame,
  Random,
  Script,
  Ticks,
  Time,
  World,
} from "./Services";
export * as System from "./System";
export { TickDispatcher, TickScheduler } from "./TickScheduler";
export * as Transform2d from "./Transform2d";
export * as Transform3d from "./Transform3d";
export * as Transport from "./Transport";
export * as View from "./View";
