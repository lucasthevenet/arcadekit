import { Context, Effect, Layer } from "effect";
import { BufferGeometry, PerspectiveCamera, Scene as ThreeScene } from "three";
import type { Camera, Material, Object3D } from "three";

/**
 * What a system of this module has created, released with the app.
 *
 * @internal
 */
export interface Kept {
  readonly dispose: () => void;
  /**
   * Called just before the scene is drawn, for things built from assets: are
   * the assets still loaded? Anything whose assets aren't is removed from the
   * scene now, so nothing is drawn with assets released since its system ran.
   */
  readonly settle?: () => void;
}

/** A geometry or a material: what this module disposes of for the game. */
type Owned = BufferGeometry | Material;

/**
 * The geometries and materials one system draws with. One that several
 * systems draw with is disposed of when the last of them lets go: when the
 * bundle it was made from is released, or the app closes. Three.js uploads a
 * disposed one again if it is drawn again.
 *
 * @internal
 */
export class Holdings {
  private readonly mine = new Set<Owned>();

  constructor(
    // How many systems hold each one: the scene's.
    private readonly counts: Map<Owned, number>
  ) {}

  hold(resource: Owned | readonly Owned[]): void {
    if (Array.isArray(resource)) {
      for (const one of resource) {
        this.hold(one);
      }
      return;
    }
    const one = resource as Owned;
    if (this.mine.has(one)) {
      return;
    }
    this.mine.add(one);
    this.counts.set(one, (this.counts.get(one) ?? 0) + 1);
    // Disposed of by the game, in a `free`: it is not held any longer.
    one.addEventListener("dispose", this.forget);
  }

  /** Holds what each mesh of an object is drawn with. */
  holdAll(object: Object3D): void {
    object.traverse((part) => {
      if ("geometry" in part && part.geometry instanceof BufferGeometry) {
        this.hold(part.geometry);
      }
      if ("material" in part && part.material !== undefined) {
        this.hold(part.material as Material | Material[]);
      }
    });
  }

  private readonly forget = (event: { readonly target: Owned }): void => {
    const one = event.target;
    one.removeEventListener("dispose", this.forget);
    if (this.mine.delete(one)) {
      this.drop(one);
    }
  };

  /** Fewer systems hold it: returns whether none does. */
  private drop(one: Owned): boolean {
    const left = (this.counts.get(one) ?? 1) - 1;
    if (left > 0) {
      this.counts.set(one, left);
      return false;
    }
    this.counts.delete(one);
    return true;
  }

  letGo(): void {
    for (const one of this.mine) {
      one.removeEventListener("dispose", this.forget);
      if (this.drop(one)) {
        one.dispose();
      }
    }
    this.mine.clear();
  }
}

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

/**
 * Provides `Three.Scene`, and disposes of what the systems made when the app
 * closes.
 *
 * @internal
 */
export const sceneLayer = Layer.effect(
  Scene,
  Effect.acquireRelease(
    Effect.sync((): SceneShape => {
      const camera = new PerspectiveCamera(50, 1, 0.1, 2000);
      camera.position.set(0, 0, 10);
      return {
        scene: new ThreeScene(),
        camera,
        _kept: new Map(),
        _owned: new Map(),
      };
    }),
    // What the systems made goes with the app, and the geometries and
    // materials they drew with once no system holds them.
    (kept) =>
      Effect.sync(() => {
        for (const one of kept._kept.values()) {
          one.dispose();
        }
        kept._kept.clear();
      })
  )
);
