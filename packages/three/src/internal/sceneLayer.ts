import { Effect, Layer } from "effect";
import { PerspectiveCamera, Scene as ThreeScene } from "three";

import { Scene } from "../Scene";
import type { SceneShape } from "../Scene";

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
