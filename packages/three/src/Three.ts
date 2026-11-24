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
 */
export { Scene } from "./three/scene";
export type { SceneShape } from "./three/scene";
export {
  layerRenderer,
  layerWebGL,
  plugin,
  Render,
  Renderer,
} from "./three/renderer";
export type { FitOptions, RendererLike, RendererShape } from "./three/renderer";
export type { Which } from "./three/which";
export { manager, texture } from "./three/assets";
export type { TextureOptions } from "./three/assets";
export type { InstancesOptions, InstancesShared, Look } from "./three/mesh";
export { instances } from "./three/instances";
export type { InstancesFromOptions } from "./three/instances";
export { objects } from "./three/objects";
export type {
  ObjectsFromOptions,
  ObjectsOptions,
  ObjectsShared,
} from "./three/objects";
