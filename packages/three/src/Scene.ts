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
   * such as an `OrthographicCamera`, or let `Three.camera2d` set one.
   */
  camera: Camera;
  /**
   * The size of the canvas, in CSS pixels, in the frame the scene was last
   * drawn: what `Three.toPlane` reads a pointer's position against, and
   * `Three.camera2d` fits its view to. `Three.plugin` sets it at the start of
   * each frame from `Three.Renderer`'s `size`. It is 0 by 0 until then, and
   * stays as a test sets it when its renderer has no `size`.
   */
  size: { readonly width: number; readonly height: number };
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
  "@arcadekit/three/Scene.Scene"
) {}
