/**
 * The scene an app draws into, and the camera it is seen through.
 * `Three.plugin` provides `Scene` to an app.
 *
 *   import * as Scene from "@arcadekit/three/Scene"
 *
 *   const Lights = Layer.effectDiscard(
 *     Effect.map(Scene.Scene, ({ scene }) => {
 *       scene.add(new AmbientLight("#ffffff", 1))
 *     })
 *   )
 *
 * `@arcadekit/three/Three` gives the same exports. The scene belongs to
 * rendering, not to the game: a tick cannot require it, and none of it is
 * saved.
 */
import { Context } from "effect";
import type { Camera, Scene as ThreeScene } from "three";

import type { Kept, Owned } from "./internal/holdings";

/**
 * The scene and its camera, as a system gets them from `yield* Three.Scene`.
 *
 * @category Services
 */
export interface SceneShape {
  /** The scene everything is drawn into. Add lights and anything else to it. */
  readonly scene: ThreeScene;
  /**
   * The camera the scene is rendered through. It starts as a perspective camera
   * at (0, 0, 10), looking at the origin. Move it, or assign another camera,
   * such as an `OrthographicCamera`.
   */
  camera: Camera;
  /**
   * The meshes and objects the systems of this module keep, by the name of
   * the system that keeps them.
   * @internal
   */
  readonly _kept: Map<string, Kept>;
  /**
   * How many systems draw with each geometry and material.
   * @internal
   */
  readonly _owned: Map<Owned, number>;
}

/**
 * An app's scene and camera, which `Three.plugin` provides. A plugin that
 * depends on `Three.plugin` sets up the scene in its `layer`, and a frame-stage
 * system moves the camera.
 *
 *   const Lights = Layer.effectDiscard(
 *     Effect.map(Three.Scene, ({ scene, camera }) => {
 *       scene.add(new AmbientLight("#ffffff", 1))
 *       camera.position.set(0, 20, 40)
 *       camera.lookAt(0, 0, 0)
 *     })
 *   )
 *
 * **Details**
 *
 * It belongs to rendering, not to the game. A tick cannot require it, and none
 * of it is saved.
 *
 * @category Services
 */
export class Scene extends Context.Service<Scene, SceneShape>()(
  "arcadekit/three/Scene"
) {}
