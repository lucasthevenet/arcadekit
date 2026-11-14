/**
 * Stages: a WebGL renderer, a scene and a camera that fill an element and resize with it.
 *
 * A view makes its stage when it is made and disposes it in its own `dispose`, so the stage has
 * the view's lifecycle: the engine makes the view inside an `acquireRelease` on each attach, and
 * its release disposes it (AGENTS.md, "A resource a plain handler makes"). The constructor and
 * `dispose` are plain, since the view's handler that makes the stage runs no Effect, and so is
 * `render`, which draws inside the frame the browser shows. The resize listener writes the
 * drawing buffer's size and the camera's projection while the browser dispatches it, for the
 * next frame to draw with.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import * as THREE from "three";

import { drawingBuffer } from "./internal/drawing-buffer";
import * as PixelCamera from "./pixel-camera";

const TypeId = "~arcadekit/render-three/Stage";

/**
 * Which camera a stage makes: `"perspective"` for a 3D world seen from a point,
 * `"orthographic"` for a flat board, where sizes don't shrink with distance, and `"pixel"` for
 * pixel art seen straight down.
 *
 * **When to use**
 *
 * As the `camera` a stage is made with, and as the type argument of `Stage.Stage` that says
 * which camera a view's stage has.
 *
 * **Example** (A stage for pixel art)
 *
 * ```ts
 * import type { Stage } from "arcadekit/render-three";
 *
 * const kind: Stage.CameraKind = "pixel";
 * kind; // => "pixel"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type CameraKind = "perspective" | "orthographic" | "pixel";

/**
 * The camera a stage of each kind has: a `PixelCamera.PixelCamera` for `"pixel"`, and Three.js's
 * own for the others.
 *
 * **When to use**
 *
 * To name a stage's camera in a function that takes it, for one kind or any.
 *
 * **Example** (A pixel stage's camera)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 * import type { Stage } from "arcadekit/render-three";
 *
 * const camera: Stage.CameraOf<"pixel"> = PixelCamera.make();
 * PixelCamera.isPixelCamera(camera); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CameraOf<K extends CameraKind> = K extends "pixel"
  ? PixelCamera.PixelCamera
  : K extends "orthographic"
    ? THREE.OrthographicCamera
    : THREE.PerspectiveCamera;

/**
 * What a stage is made with: its camera's kind, the ground that camera shows, and the colour
 * behind the scene.
 *
 * **When to use**
 *
 * To make a stage with `make`.
 *
 * **Details**
 *
 * `viewHeight` is an orthographic camera's view height in world units until `Camera.fit`
 * changes it (10 unless told), or the height a pixel camera aims for (20 unless told).
 * `pixelsPerUnit` is a pixel camera's sprite pixels per world unit (16 unless told).
 *
 * **Example** (A pixel stage for 16 px art)
 *
 * ```ts
 * import type { Stage } from "arcadekit/render-three";
 *
 * const options: Stage.Options<"pixel"> = {
 *   camera: "pixel",
 *   pixelsPerUnit: 16,
 *   background: "#17151f",
 * };
 * options.camera; // => "pixel"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options<K extends CameraKind = "perspective"> {
  /**
   * "perspective" (the default) for a 3D world seen from a point. "orthographic" for a flat
   * board, where sizes shouldn't shrink with distance; place it with `Camera.fit`. "pixel" for
   * pixel art seen straight down; the stage keeps it told the drawing buffer's size.
   */
  readonly camera?: K;
  /**
   * Height of an orthographic camera's view, in world units, until `Camera.fit` changes it.
   * Defaults to 10. For a pixel camera, the height it aims for (defaults to 20).
   */
  readonly viewHeight?: number;
  /** Pixel camera only: sprite pixels per world unit. Defaults to 16. */
  readonly pixelsPerUnit?: number;
  readonly background?: THREE.ColorRepresentation;
}

/**
 * A WebGL renderer, a scene and a camera that fill a container element and resize with it.
 *
 * **When to use**
 *
 * One per view that draws with Three.js: made when the view is made, rendered at the end of
 * each frame it draws, and disposed in its `dispose`.
 *
 * **Details**
 *
 * `renderer`, `scene` and `camera` are a view's to use: add to the scene, set its fog, change a
 * perspective camera's `fov`, `near` and `far` and call its `updateProjectionMatrix()`. A pixel
 * camera is moved with `PixelCamera`'s functions. On a resize, a perspective camera takes the
 * new aspect ratio, an orthographic camera keeps its view height and widens or narrows to it,
 * and a pixel camera picks its pixel scale again. The pixel ratio is read again on every
 * resize: a pixel stage sizes its drawing buffer to the canvas's exact device pixels, where the
 * others cap the ratio at 2.
 *
 * **Example** (A board's stage)
 *
 * ```ts
 * import { Stage } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const stage = Stage.make(document.createElement("div"), {
 *   camera: "orthographic",
 *   background: "#17151f",
 * });
 * stage.scene.add(new THREE.AxesHelper());
 * Stage.render(stage);
 * stage.camera instanceof THREE.OrthographicCamera; // => true
 * stage.scene.children.length; // => 1
 * Stage.dispose(stage);
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Stage<K extends CameraKind = "perspective">
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The renderer whose canvas fills the container. */
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: CameraOf<K>;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<Stage<CameraKind>> & {
  readonly kind: CameraKind;
  readonly container: HTMLElement;
  /** The Three.js camera the renderer draws with: a pixel camera's own, or the camera. */
  readonly drawsWith: THREE.Camera;
  resizeObserver: ResizeObserver;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "Stage",
      camera: this.kind,
      objects: this.scene.children.length,
    };
  },
};

/** A perspective camera's field of view, in degrees. Set `stage.camera.fov` to change it. */
const FOV = 50;
/** The near and far planes of a perspective or orthographic camera. */
const NEAR = 0.1;
const FAR = 400;
/**
 * Caps devicePixelRatio for a perspective or orthographic stage; 2 keeps phones sharp without
 * rendering 9x the pixels. A pixel stage isn't capped: see `drawingBuffer`.
 */
const MAX_PIXEL_RATIO = 2;

const BUFFER_SIZE = new THREE.Vector2();

const makeCamera = (
  options: Options<CameraKind>
): THREE.Camera | PixelCamera.PixelCamera => {
  if (options.camera === "pixel") {
    return PixelCamera.make({
      ...(options.pixelsPerUnit === undefined
        ? {}
        : { pixelsPerUnit: options.pixelsPerUnit }),
      ...(options.viewHeight === undefined
        ? {}
        : { viewHeight: options.viewHeight }),
    });
  }
  if (options.camera === "orthographic") {
    const half = (options.viewHeight ?? 10) / 2;
    return new THREE.OrthographicCamera(-half, half, half, -half, NEAR, FAR);
  }
  return new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
};

const resize = (
  stage: Internal,
  entry: ResizeObserverEntry | undefined
): void => {
  const { camera, container, renderer } = stage;
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  const target = drawingBuffer(
    stage.kind === "pixel",
    width,
    height,
    window.devicePixelRatio,
    MAX_PIXEL_RATIO,
    entry?.devicePixelContentBoxSize?.[0]
  );
  renderer.setPixelRatio(target.pixelRatio);
  renderer.setSize(target.width, target.height, false);
  const aspect = width / height;
  if (PixelCamera.isPixelCamera(camera)) {
    const buffer = renderer.getDrawingBufferSize(BUFFER_SIZE);
    PixelCamera.setBufferSize(camera, buffer.x, buffer.y);
    return;
  }
  if (camera instanceof THREE.OrthographicCamera) {
    const centerX = (camera.left + camera.right) / 2;
    const halfWidth = ((camera.top - camera.bottom) / 2) * aspect;
    camera.left = centerX - halfWidth;
    camera.right = centerX + halfWidth;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
};

/**
 * Checks whether a value is a stage.
 *
 * **When to use**
 *
 * Narrow an unknown value before rendering or disposing it.
 *
 * **Example** (Recognising a stage)
 *
 * ```ts
 * import { Stage } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const stage = Stage.make(document.createElement("div"));
 * Stage.isStage(stage); // => true
 * Stage.isStage({ scene: new THREE.Scene() }); // => false
 * Stage.dispose(stage);
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isStage = (value: unknown): value is Stage<CameraKind> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a stage whose canvas fills `container`, and starts following the container's size.
 *
 * **When to use**
 *
 * When a view is made, with the element the engine gives its `view`.
 *
 * **Details**
 *
 * The canvas is appended to the container and sized to it by CSS; the drawing buffer follows
 * the container's size and the screen's pixel ratio on every resize, including a move to a
 * screen with another ratio where the browser reports one. A pixel stage draws with no
 * multisampling, since its edges are on pixels, and its canvas is scaled pixelated.
 *
 * **Example** (A pixel stage told its drawing buffer)
 *
 * ```ts
 * import { PixelCamera, Stage } from "arcadekit/render-three";
 *
 * // An element laid out 640 by 480, on a screen of one device pixel to a CSS pixel.
 * const stage = Stage.make(document.createElement("div"), {
 *   camera: "pixel",
 *   pixelsPerUnit: 16,
 *   viewHeight: 15,
 * });
 * PixelCamera.isPixelCamera(stage.camera); // => true
 * // 15 units of 16 px is 240 sprite pixels: 480 screen pixels is 2 each.
 * stage.camera.pixelScale; // => 2
 * Stage.dispose(stage);
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <K extends CameraKind = "perspective">(
  container: HTMLElement,
  options?: Options<K>
): Stage<K> => {
  const self = Object.create(Proto) as Types.Mutable<Internal>;
  const kind: CameraKind = options?.camera ?? "perspective";
  const pixel = kind === "pixel";
  self.kind = kind;
  self.container = container;
  self.renderer = new THREE.WebGLRenderer({
    // A pixel camera's edges are already on pixels, so it needs no multisampling.
    antialias: !pixel,
    powerPreference: "high-performance",
  });
  const canvas = self.renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  if (pixel) {
    canvas.style.imageRendering = "pixelated";
  }
  container.append(canvas);
  self.scene = new THREE.Scene();
  if (options?.background !== undefined) {
    self.scene.background = new THREE.Color(options.background);
  }
  const camera = makeCamera(options ?? {});
  self.camera = camera as CameraOf<CameraKind>;
  self.drawsWith = PixelCamera.isPixelCamera(camera) ? camera.camera : camera;
  self.resizeObserver = new ResizeObserver((entries) =>
    resize(self, entries.at(-1))
  );
  try {
    // Also fires when only the pixel ratio changes (the window moved to another screen).
    self.resizeObserver.observe(container, {
      box: "device-pixel-content-box",
    });
  } catch {
    // A browser without device-pixel-content-box (Safari) refuses the option.
    self.resizeObserver.observe(container);
  }
  resize(self, undefined);
  return self as unknown as Stage<K>;
};

/**
 * Draws the scene once, with the stage's camera.
 *
 * **When to use**
 *
 * At the end of each frame a view draws, once its batches are filled and its camera placed.
 *
 * **Example** (Drawing a frame)
 *
 * ```ts
 * import { Stage } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const stage = Stage.make(document.createElement("div"));
 * stage.camera.position.set(0, 5, 5);
 * stage.camera.lookAt(0, 0, 0);
 * Stage.render(stage);
 * stage.camera.fov; // => 50
 * Stage.dispose(stage);
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const render = <K extends CameraKind>(self: Stage<K>): void => {
  const stage = self as unknown as Internal;
  stage.renderer.render(stage.scene, stage.drawsWith);
};

/**
 * Stops following the container's size, frees every GPU resource in the scene but the kept
 * textures, releases the WebGL context and removes the canvas.
 *
 * **When to use**
 *
 * In the view's `dispose`, which the engine calls when the attach that made the view ends.
 *
 * **Details**
 *
 * It frees the scene with `disposeObject`, so a sprite sheet's texture, which `keepTexture`
 * marked, is left to the app that loaded it. The context is released at once: a browser keeps
 * only so many (Chrome, 16 a page), and past that it kills the oldest, which can be a live
 * stage's.
 *
 * **Example** (Freeing a view's stage)
 *
 * ```ts
 * import { Stage } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const stage = Stage.make(document.createElement("div"));
 * const material = new THREE.MeshBasicMaterial();
 * stage.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
 * let freed = 0;
 * material.addEventListener("dispose", () => {
 *   freed += 1;
 * });
 * Stage.dispose(stage);
 * freed; // => 1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const dispose = <K extends CameraKind>(self: Stage<K>): void => {
  const stage = self as unknown as Internal;
  stage.resizeObserver.disconnect();
  disposeObject(stage.scene);
  stage.renderer.dispose();
  // `dispose` leaves the WebGL context alive until the canvas is collected. A browser keeps
  // only so many (Chrome, 16 a page): past that it kills the oldest, which can be a live
  // stage's, and a page that keeps losing them can be refused new ones. Release it now.
  stage.renderer.forceContextLoss();
  stage.renderer.domElement.remove();
};

const KEEP = "arcadekitKeep";

/**
 * Marks a texture that something outside the scene owns, such as a sprite sheet the app
 * loaded, and returns it: `disposeObject` and `Stage.dispose` leave it alone, and its owner
 * frees it.
 *
 * **When to use**
 *
 * When a view draws with a texture it didn't make. `SpriteSheet.make` marks a sheet's texture
 * already.
 *
 * **Details**
 *
 * The mark is in the texture's `userData`, so a clone of it keeps it.
 *
 * **Example** (A texture the app frees)
 *
 * ```ts
 * import { Stage } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const texture = Stage.keepTexture(new THREE.Texture());
 * Stage.isKeptTexture(texture); // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const keepTexture = <T extends THREE.Texture>(texture: T): T => {
  texture.userData[KEEP] = true;
  return texture;
};

/**
 * Whether `keepTexture` marked a texture.
 *
 * **When to use**
 *
 * In code of a game's own that frees textures, to leave the kept ones to their owners as
 * `disposeObject` does.
 *
 * **Example** (A texture no one marked)
 *
 * ```ts
 * import { Stage } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * Stage.isKeptTexture(new THREE.Texture()); // => false
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const isKeptTexture = (texture: THREE.Texture): boolean =>
  texture.userData[KEEP] === true;

/**
 * Frees the geometries, materials and textures of an object and everything under it: the
 * textures a material holds (its maps, and a shader material's texture uniforms) and, for a
 * scene, its background and environment. Textures marked with `keepTexture` are skipped.
 *
 * **When to use**
 *
 * When a view takes an object out of its scene for good: `Stage.dispose`, which frees the whole
 * scene, no longer reaches it.
 *
 * **Details**
 *
 * Each texture is freed once, however many materials hold it.
 *
 * **Example** (Freeing a mesh but not the sheet it draws)
 *
 * ```ts
 * import { Stage } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const sheet = Stage.keepTexture(new THREE.Texture());
 * const mesh = new THREE.Mesh(
 *   new THREE.PlaneGeometry(),
 *   new THREE.MeshBasicMaterial({ map: sheet })
 * );
 * const freed: string[] = [];
 * sheet.addEventListener("dispose", () => freed.push("sheet"));
 * mesh.material.addEventListener("dispose", () => freed.push("material"));
 * Stage.disposeObject(mesh);
 * freed; // => ["material"]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const disposeObject = (root: THREE.Object3D): void => {
  const textures = new Set<THREE.Texture>();
  if (root instanceof THREE.Scene) {
    addTexture(textures, root.background);
    addTexture(textures, root.environment);
  }
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Points
    ) {
      object.geometry.dispose();
      const materials: THREE.Material[] = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          addTexture(textures, value);
        }
        if (material instanceof THREE.ShaderMaterial) {
          for (const uniform of Object.values(material.uniforms)) {
            addTexture(textures, uniform.value);
          }
        }
        material.dispose();
      }
    }
  });
  for (const texture of textures) {
    texture.dispose();
  }
};

const addTexture = (textures: Set<THREE.Texture>, value: unknown) => {
  if (value instanceof THREE.Texture && !isKeptTexture(value)) {
    textures.add(value);
  }
};
