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

export * as Driver from "./Driver";

export {
  Component,
  type ComponentDef,
  type Entity,
  type FieldDef,
  type OnTargetDespawn,
  type RefCodec,
  type SingletonSpec,
} from "./ecs/Component";

export type { Rng } from "./ecs/Random";

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
} from "./ecs/Snapshot";

export {
  type ChangeKind,
  CommandBuffer,
  type EntityColumn,
  type QueryView,
  type RemovedReader,
  type SavedChanges,
  type SparseColumns,
  World as EcsWorld,
} from "./ecs/World";

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
