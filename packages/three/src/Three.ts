/**
 * The `@arcadekit/three/Three` entry point, which draws a game with Three.js.
 *
 *   import * as Transform3d from "arcadekit/Transform3d"
 *   import * as Three from "@arcadekit/three/Three"
 *
 *   // The rules: a rock has a position. They know nothing about how it looks.
 *   commands.spawn(Rock, Transform3d.Position.of({ x: 0, y: 4, z: 0 }))
 *
 *   // The page: every rock is one instance of one mesh, where its Transform3d puts it.
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     geometry: new IcosahedronGeometry(1),
 *     material: new MeshStandardMaterial({ color: "#8a8f98" }),
 *   })
 *   const Look = Plugin.make("game/Look", {
 *     plugins: [Three.plugin],
 *     systems: [Rocks],
 *   })
 *
 *   Browser.runMain(
 *     Driver.run(App.define({ plugins: [Rules, Look] }), { hz: 60 }).pipe(
 *       Effect.provide(Three.layerWebGL({ canvas }))
 *     )
 *   )
 *
 * Its systems run in the frame stage, between ticks, and only read the world. A
 * game that is drawn is the same game as one that isn't, and a server or a
 * replay installs none of this.
 *
 * An entity's components decide what is drawn. The transform its kind names
 * decides where: arcadekit's own `Transform3d`, or a flat game's `Transform2d`,
 * drawn the same way in the x-y plane. An entity is drawn at that module's
 * `Position`, turned and sized by its `Rotation` and `Scale` when it has them.
 *
 * Each kind of entity is drawn by one of two systems:
 *
 * - `Three.instances` draws every entity of a kind as an instance of one mesh,
 *   for crowds. It reads the columns directly and writes one matrix per entity
 *   into the mesh's buffer. It creates no object per entity, and allocates
 *   nothing per entity per frame.
 * - `Three.objects` keeps one `Object3D` per entity, for the few entities that
 *   are more than a copy of one mesh. The object exists from the frame the
 *   entity first matches to the frame it stops matching, and receives the
 *   entity's transform each frame.
 *
 * Either system takes a look that exists from the start, or builds one `from` a
 * bundle's assets while the bundle is loaded. `Three.texture` makes a texture
 * asset for such a bundle. After every frame-stage system has run,
 * `Three.Render` renders the scene through `Three.Renderer`.
 *
 * Each part is also a module of its own, which gives the same exports:
 * `@arcadekit/three/Scene`, `Renderer`, `Assets`, `Instances` and `Objects`.
 */
import type { ComponentDef } from "arcadekit/ecs";
import type * as Transform2d from "arcadekit/Transform2d";
import type * as Transform3d from "arcadekit/Transform3d";

export { Scene } from "./Scene";
export type { SceneShape } from "./Scene";
export {
  layerRenderer,
  layerWebGL,
  plugin,
  Render,
  Renderer,
} from "./Renderer";
export type { FitOptions, RendererLike, RendererShape } from "./Renderer";
export { manager, texture } from "./Assets";
export type { TextureOptions } from "./Assets";
export { instances } from "./Instances";
export type {
  InstancesFromOptions,
  InstancesOptions,
  InstancesShared,
  Look,
} from "./Instances";
export { objects } from "./Objects";
export type {
  ObjectsFromOptions,
  ObjectsOptions,
  ObjectsShared,
} from "./Objects";

/**
 * Which entities a drawing system draws, and the transform it draws them from.
 * `Three.instances` and `Three.objects` both take these options.
 *
 * @category Options
 */
export interface Which {
  /**
   * The component that marks an entity as one of the kind, or several
   * components, all of which it must have. An entity is drawn while it has
   * them, none of `without`, and the `Position` of the kind's `transform`.
   */
  readonly of: ComponentDef | readonly ComponentDef[];
  /**
   * The module whose components place the entities: `Transform3d`, or
   * `Transform2d` for a flat game, whose entities are drawn in the x-y plane at
   * z = 0. An entity is drawn at that module's `Position`, turned and sized by
   * its `Rotation` and `Scale` when it has them. A kind reads nothing of the
   * other module, so a kind of `Transform2d` draws an entity that has both
   * positions from its `Transform2d` components alone.
   *
   *   Three.instances("game/Cards", { of: Card, transform: Transform2d, geometry, material })
   */
  readonly transform: typeof Transform3d | typeof Transform2d;
  /** Components that keep an entity from being drawn, such as one that hides it. */
  readonly without?: readonly ComponentDef[];
  /**
   * Whether each entity is drawn between its last two positions, at
   * `Frame.alpha` of the way from where it was a tick ago to where it is now,
   * instead of where the last tick left it. Defaults to false. With it, a game
   * whose ticks and frames don't line up moves smoothly, up to a tick behind.
   * `Three.instances` says what is interpolated.
   */
  readonly smooth?: boolean;
  /**
   * With `smooth`, the farthest an entity may move in one tick and still be
   * interpolated, in scene units. An entity that moves farther, such as one
   * that wraps from one edge to the other, is drawn where it is. Defaults to no
   * limit.
   */
  readonly snap?: number;
}
