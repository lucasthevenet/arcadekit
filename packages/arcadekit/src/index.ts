/**
 * Every module of the package except `Browser`, each exported under its name.
 *
 *   import { App, Input, System } from "arcadekit"
 *
 * Each module is the same object as its own entry point,
 * `import * as Input from "arcadekit/Input"`. Two modules are exported as
 * their members instead: `EntityId` from `Schemas`, and the services from
 * `Services`, with the world's two types, `ReadingWorld` and `WritingWorld`.
 * Of the storage core, `arcadekit/ecs`, it gives the types a game's code
 * names, and none of its classes: a program of the storage core alone
 * imports `arcadekit/ecs`.
 */
export * as Action from "./Action.ts";
export * as App from "./App.ts";
export * as Assets from "./Assets.ts";
export * as Color from "./Color.ts";
export * as Component from "./Component.ts";
export * as Driver from "./Driver.ts";
export type {
  Entity,
  FieldDef,
  OnTargetDespawn,
  RefCodec,
  RequiredOf,
  SingletonSpec,
} from "./ecs/component.ts";
export type { JsonValue } from "./ecs/frozen.ts";
export type { Rng } from "./ecs/random.ts";
export type { Placed, Spawned, WithSpawned } from "./ecs/spawned.ts";
export type {
  SnapshotComponent,
  SnapshotContents,
  SnapshotSingleton,
  SnapshotSparse,
  SnapshotTable,
} from "./ecs/contents.ts";
export type { SnapshotProblem } from "./ecs/snapshot.ts";
export type { ChangeKind, RemovedReader, SavedChanges } from "./ecs/changes.ts";
export type {
  EntityColumn,
  PointingView,
  QueryView,
  SparseColumns,
} from "./ecs/query.ts";
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
export * from "./Services.ts";
export * as System from "./System.ts";
export * as Timeline from "./Timeline.ts";
export * as Timer from "./Timer.ts";
export * as Transform2d from "./Transform2d.ts";
export * as Transform3d from "./Transform3d.ts";
export * as View from "./View.ts";
