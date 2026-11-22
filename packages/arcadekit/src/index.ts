/**
 * Every module of the package except `Browser`, each exported under its name:
 *
 *   import { App, Input, System } from "arcadekit"
 *
 * Each module is the same object as its own entry point: `import * as Input
 * from "arcadekit/Input"`. Three modules are exported as their members instead:
 * `EntityId` from `Schemas`, the services from `Services`, and the two classes
 * from `TickScheduler`. The storage core, `arcadekit/ecs`, is exported as the
 * members a game uses, with its world class as `EcsWorld`, alongside the
 * `World` service.
 */
export * as Action from "./Action";
export * as App from "./App";
export * as Assets from "./Assets";
export * as Build from "./Build";
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
export * as Inbox from "./Inbox";
export * as Input from "./Input";
export * as Journal from "./Journal";
export * as Loop from "./Loop";
export * as Migrate from "./Migrate";
export * as Netcode from "./Netcode";
export * as Outbox from "./Outbox";
export * as Plugin from "./Plugin";
export * as Query from "./Query";
export * as Relay from "./Relay";
export * as Resource from "./Resource";
export * as Runner from "./Runner";
export * as Save from "./Save";
export * as Schedule from "./Schedule";
export * as Session from "./Session";
export * as Singleton from "./Singleton";
export * as Sound from "./Sound";
export * as Stage from "./Stage";
export * as State from "./State";
export { EntityId } from "./Schemas";
export {
  Commands,
  Events,
  Frame,
  Random,
  Ticks,
  Time,
  World,
} from "./Services";
export * as System from "./System";
export { TickDispatcher, TickScheduler } from "./TickScheduler";
export * as Timeline from "./Timeline";
export * as Transform2d from "./Transform2d";
export * as Transform3d from "./Transform3d";
export * as Transport from "./Transport";
export * as View from "./View";
