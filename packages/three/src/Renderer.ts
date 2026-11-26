/**
 * What renders an app's scene each frame, and the layers that provide it from
 * a page's canvas.
 *
 *   import * as Renderer from "@arcadekit/three/Renderer"
 *
 *   Driver.run(app, { hz: 60 }).pipe(
 *     Effect.provide(Renderer.layerWebGL({ canvas }))
 *   )
 *
 * `@arcadekit/three/Three` gives the same exports. A renderer needs a canvas,
 * so it comes from outside the app, and a test provides one that draws
 * nothing.
 */
import * as Plugin from "arcadekit/Plugin";
import * as System from "arcadekit/System";
import { Context, Effect, Layer } from "effect";
import { WebGLRenderer } from "three";
import type {
  Camera,
  Scene as ThreeScene,
  WebGLRendererParameters,
} from "three";

import { fitted } from "./internal/fit.ts";
import { heldIn } from "./internal/holdings.ts";
import { sceneLayer } from "./internal/sceneLayer.ts";
import { Scene } from "./Scene.ts";

/**
 * The shape of `Three.Renderer`: a Three.js renderer, or a test's renderer that
 * draws nothing or records what it was asked to render.
 *
 * @category Services
 */
export interface RendererShape {
  /** Renders the scene as the camera sees it. `Three.Render` calls it once per frame. */
  readonly render: (scene: ThreeScene, camera: Camera) => void;
}

/**
 * What renders the scene. It needs a canvas, so it comes from outside the app,
 * such as `Three.layerWebGL({ canvas })` in a page. A game that installs
 * `Three.plugin` without providing one doesn't compile.
 *
 * **Details**
 *
 * A test provides a renderer that records what it was asked and draws
 * nothing, `Three.layer(Three.makeRecorder())`, and inspects the scene. Three.js
 * builds the scene under Node as it does in a page.
 *
 * @category Services
 */
export class Renderer extends Context.Service<Renderer, RendererShape>()(
  "@arcadekit/three/Renderer.Renderer"
) {}

/**
 * Returns a layer that provides a renderer made by hand, such as
 * `Three.makeRecorder()` in a test, as `Three.Renderer`.
 *
 *   App.make(game).pipe(Effect.provide(Three.layer(Three.makeRecorder())))
 *
 * **When to use**
 *
 * Use for a renderer that needs no canvas. For one of Three.js's own
 * renderers on a page, use `Three.layerWebGL` or `Three.layerRenderer`, which
 * fit it to its canvas and dispose of it.
 *
 * @category Layers
 */
export const layer = (renderer: RendererShape): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, renderer);

/**
 * A renderer that draws nothing and records what it was asked, from
 * `Three.makeRecorder()`.
 *
 * @category Testing
 */
export interface Recorder extends RendererShape {
  /** Every scene it was asked to render, with its camera, oldest first. */
  readonly rendered: { readonly scene: ThreeScene; readonly camera: Camera }[];
}

/**
 * Makes a renderer that draws nothing and records each scene it is asked to
 * render, for a test or a tool. Three.js builds the scene under Node as it does
 * in a page, so a test finds what was drawn in it: an instanced mesh is named
 * after its system.
 *
 *   const renderer = Three.makeRecorder()
 *   const app = yield* App.make(game).pipe(Effect.provide(Three.layer(renderer)))
 *   yield* app.frame()
 *   renderer.rendered[0]?.scene.getObjectByName("game/Rocks")
 *
 * @category Testing
 */
export const makeRecorder = (): Recorder => {
  const rendered: { scene: ThreeScene; camera: Camera }[] = [];
  return {
    rendered,
    render(scene, camera) {
      rendered.push({ scene, camera });
    },
  };
};

/**
 * The parts of a Three.js renderer that `Three.layerRenderer` uses.
 * `WebGLRenderer` and `WebGPURenderer` both have them.
 *
 * @category Models
 */
export interface RendererLike {
  /** The canvas. The image is fitted to its size on the page. */
  readonly domElement: {
    readonly clientWidth?: number;
    readonly clientHeight?: number;
  };
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: ThreeScene, camera: Camera): void;
  dispose(): void;
}

/**
 * Options for how a page's renderer follows its canvas.
 *
 * @category Options
 */
export interface FitOptions {
  /**
   * Whether the image follows the canvas's size on the page. When that size
   * changes, the renderer is resized without touching the canvas's style, and a
   * perspective camera gets the new aspect ratio. Defaults to true. Your game
   * fits any other kind of camera itself.
   */
  readonly fit?: boolean;
  /**
   * How many pixels are drawn per CSS pixel. Defaults to the page's
   * `devicePixelRatio`, capped at 2. It is set only while `fit` is on, so with
   * `fit: false` your game sets the renderer's pixel ratio itself.
   */
  readonly pixelRatio?: number;
}

/**
 * Returns a layer that provides `Three.Renderer` from a Three.js renderer you
 * create. The renderer is disposed of when the scope the layer is provided to
 * closes.
 *
 *   Three.layerRenderer(() => new WebGPURenderer({ canvas }))
 *
 * **When to use**
 *
 * Use for a renderer other than a `WebGLRenderer`, such as a `WebGPURenderer`.
 * For a `WebGLRenderer`, use `Three.layerWebGL`.
 *
 * **Gotchas**
 *
 * - Provide it to the whole program, such as `Driver.run(...)`, and not to
 *   something shorter. The renderer is disposed of when that scope closes.
 *
 * @category Layers
 */
export const layerRenderer = (
  make: () => RendererLike,
  options: FitOptions = {}
): Layer.Layer<Renderer> =>
  Layer.effect(
    Renderer,
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => make()),
        (renderer) => Effect.sync(() => renderer.dispose())
      ),
      (renderer) => fitted(renderer, options)
    )
  );

/**
 * Returns a layer that provides `Three.Renderer` as a `WebGLRenderer` on a
 * page's canvas. It takes the parameters Three.js's `WebGLRenderer` accepts,
 * and fits the image to the canvas unless `fit` is false.
 *
 *   Driver.run(app, { hz: 60 }).pipe(
 *     Effect.provide(Three.layerWebGL({ canvas, antialias: true }))
 *   )
 *
 * **Gotchas**
 *
 * - Provide it to the whole program, as above. The renderer is disposed of
 *   when that scope closes, as with `Three.layerRenderer`.
 *
 * @category Layers
 */
export const layerWebGL = (
  parameters: WebGLRendererParameters & FitOptions = {}
): Layer.Layer<Renderer> =>
  layerRenderer(() => new WebGLRenderer(parameters), parameters);

/**
 * The system that renders the scene once per frame, through `Three.Renderer`.
 * `Three.plugin` installs it.
 *
 * **Details**
 *
 * It runs in `"postFrame"`, the stage after the frame's own. Every frame-stage
 * system therefore runs before it, wherever it is listed and with no ordering:
 * `Three.instances`, `Three.objects`, and a system of your own that moves the
 * camera.
 *
 * Just before rendering, it checks that the assets of each kind built from a
 * bundle are still loaded, and removes from the scene what was built from
 * released ones. Nothing is drawn with released assets, whichever runs first
 * of the system that releases a bundle and the system that draws with it.
 *
 * @category Systems
 */
export const Render = System.frame("arcadekit/three/Render", function* () {
  const shown = yield* Scene;
  for (const one of heldIn(shown).kept.values()) {
    one.settle?.();
  }
  (yield* Renderer).render(shown.scene, shown.camera);
}).pipe(System.inStage("postFrame"));

/**
 * Gives an app a scene, `Three.Scene`, and renders it each frame with
 * `Three.Render`. The plugin that defines how the game looks lists it in its
 * `plugins`, beside its systems made with `Three.instances` and
 * `Three.objects`.
 *
 * **Details**
 *
 * The app then needs a `Three.Renderer` from outside, such as
 * `Effect.provide(Three.layerWebGL({ canvas }))`.
 *
 * Each of those systems draws from the transform it names, `Transform3d` or
 * `Transform2d`, and an instance's colour from `Color`. This package defines
 * no components of its own.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/three", {
  layer: sceneLayer,
  systems: [Render],
});
