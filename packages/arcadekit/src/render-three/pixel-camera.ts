/**
 * Pixel cameras: an orthographic camera looking straight down at the ground plane that keeps
 * sprite pixels whole, with the arithmetic of its pixel scale.
 *
 * Every sprite pixel covers a whole number of screen pixels, and the camera moves only by whole
 * screen pixels, so pixel art never shimmers. A pixel camera holds the Three.js camera it places
 * and is moved only by this module's functions: a Three.js `lookAt`, or `Camera.fit`, would undo
 * the snapping, and a pixel camera is no Three.js camera to hand them. Its functions are plain
 * calls, made inside the frame the browser shows (ADR-0024).
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";
import * as THREE from "three";

import type { GroundBounds, MutableGroundBounds } from "./camera";
import { register } from "./internal/pixel-cameras";

const TypeId = "~arcadekit/render-three/PixelCamera";

/** How high above the ground the camera sits. Anything from y = -HEIGHT to just below it is drawn. */
const HEIGHT = 100;

/**
 * A camera looking straight down at the ground plane (y = 0), with +x to the right and +z down
 * the screen, so a larger z is lower on screen. It keeps sprite pixels whole: `pixelScale`
 * screen pixels per sprite pixel, a whole number, and a position on whole screen pixels.
 *
 * **When to use**
 *
 * For pixel art seen from above: a stage made with `camera: "pixel"` has one, and keeps it told
 * the drawing buffer's size. Each frame, `follow` a point or `fit` an area, then
 * `groundOnScreen` says which rectangle of ground it shows, for a view that draws only that.
 *
 * **Details**
 *
 * `camera` is the Three.js camera it places, which a stage draws with: read it, and move it
 * only with this module's functions. The other fields are what the last change worked out.
 *
 * **Example** (A camera's pixel scale for its drawing buffer)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make({ pixelsPerUnit: 16, viewHeight: 20 });
 * PixelCamera.setBufferSize(camera, 960, 640);
 * // 20 units at 16 px is 320 sprite pixels: 640 screen pixels is 2 each.
 * [camera.pixelScale, camera.screenPixelsPerUnit]; // => [2, 32]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface PixelCamera
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The Three.js camera it places, which a stage draws with. */
  readonly camera: THREE.OrthographicCamera;
  /** Sprite pixels per world unit. */
  readonly pixelsPerUnit: number;
  /** About how many world units of ground it shows top to bottom, when it follows. */
  readonly viewHeight: number;
  /** Screen pixels per sprite pixel: a whole number, at least 1. */
  readonly pixelScale: number;
  /** Screen (drawing buffer) pixels per world unit. */
  readonly screenPixelsPerUnit: number;
}

/**
 * What a pixel camera is made with: its sprite pixels per world unit, and the ground it aims to
 * show.
 *
 * **When to use**
 *
 * To make a pixel camera with `make`. A stage passes its own `pixelsPerUnit` and `viewHeight`.
 *
 * **Example** (A camera for 16 px art that shows about 12 units)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const options: PixelCamera.Options = { pixelsPerUnit: 16, viewHeight: 12 };
 * PixelCamera.make(options).viewHeight; // => 12
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
  /** Sprite pixels per world unit: 16 draws a 16 px enemy one unit wide. Defaults to 16. */
  readonly pixelsPerUnit?: number;
  /**
   * About how many world units of ground to show top to bottom. The camera picks the whole
   * number of screen pixels per sprite pixel that comes nearest. Defaults to 20.
   */
  readonly viewHeight?: number;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<PixelCamera> & {
  bufferWidth: number;
  bufferHeight: number;
  targetX: number;
  targetZ: number;
  /** Set by `fit`, cleared by `follow`. */
  fitted: GroundBounds | null;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "PixelCamera",
      pixelsPerUnit: this.pixelsPerUnit,
      viewHeight: this.viewHeight,
      pixelScale: this.pixelScale,
      buffer: [this.bufferWidth, this.bufferHeight],
      at: [this.camera.position.x, this.camera.position.z],
      fitted: this.fitted !== null,
    };
  },
};

const scaleToShow = (
  bufferHeight: number,
  viewHeight: number,
  pixelsPerUnit: number
): number =>
  Math.max(1, Math.round(bufferHeight / (viewHeight * pixelsPerUnit)));

const scaleToFit = (
  bufferWidth: number,
  bufferHeight: number,
  width: number,
  depth: number,
  pixelsPerUnit: number
): number =>
  Math.max(
    1,
    Math.floor(
      Math.min(
        bufferWidth / (width * pixelsPerUnit),
        bufferHeight / (depth * pixelsPerUnit)
      )
    )
  );

const snap = (value: number, pixelsPerUnit: number): number =>
  Math.round(value * pixelsPerUnit) / pixelsPerUnit;

/** Works out the scale, the frustum and the snapped position from what the camera was told. */
const place = (self: Internal): void => {
  const perUnit = self.pixelsPerUnit;
  const { bufferWidth, bufferHeight, camera, fitted } = self;
  self.pixelScale = fitted
    ? scaleToFit(
        bufferWidth,
        bufferHeight,
        fitted.maxX - fitted.minX,
        fitted.maxZ - fitted.minZ,
        perUnit
      )
    : scaleToShow(bufferHeight, self.viewHeight, perUnit);
  const screenPerUnit = perUnit * self.pixelScale;
  self.screenPixelsPerUnit = screenPerUnit;
  // An odd size gets its spare pixel on the right or bottom, so the camera's position stays on
  // a screen pixel's corner: as `pixelFrustum` gives it.
  const halfWidth = Math.floor(bufferWidth / 2);
  const halfHeight = Math.floor(bufferHeight / 2);
  camera.left = -halfWidth / screenPerUnit;
  camera.right = (bufferWidth - halfWidth) / screenPerUnit;
  camera.top = halfHeight / screenPerUnit;
  camera.bottom = -(bufferHeight - halfHeight) / screenPerUnit;
  camera.updateProjectionMatrix();
  camera.position.set(
    snap(self.targetX, screenPerUnit),
    HEIGHT,
    snap(self.targetZ, screenPerUnit)
  );
  camera.updateMatrixWorld();
};

/**
 * Checks whether a value is a pixel camera.
 *
 * **When to use**
 *
 * Narrow a stage's camera, or an unknown value, before moving it with this module.
 *
 * **Details**
 *
 * The Three.js camera a pixel camera holds is no pixel camera.
 *
 * **Example** (Recognising a pixel camera)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make();
 * PixelCamera.isPixelCamera(camera); // => true
 * PixelCamera.isPixelCamera(camera.camera); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isPixelCamera = (value: unknown): value is PixelCamera =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a pixel camera over the origin, for a drawing buffer of one pixel until it is told
 * another.
 *
 * **When to use**
 *
 * A stage made with `camera: "pixel"` makes one and keeps it told its drawing buffer's size. A
 * view's test makes one of its own, with `setBufferSize`, to draw with no stage.
 *
 * **Details**
 *
 * `pixelsPerUnit` defaults to 16 and `viewHeight` to 20. Its Three.js camera looks straight
 * down, with up on screen toward -z, and draws from 100 units above the ground to 100 below.
 *
 * **Example** (A test's camera, with no stage)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make({ pixelsPerUnit: 16 });
 * PixelCamera.setBufferSize(camera, 800, 600);
 * [camera.pixelsPerUnit, camera.viewHeight, camera.pixelScale]; // => [16, 20, 2]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (options?: Options): PixelCamera => {
  const self = Object.create(Proto) as Internal;
  self.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2 * HEIGHT);
  // Straight down, with up on screen toward -z. Set directly: lookAt would tilt it a hair.
  self.camera.rotation.set(-Math.PI / 2, 0, 0);
  self.pixelsPerUnit = options?.pixelsPerUnit ?? 16;
  self.viewHeight = options?.viewHeight ?? 20;
  self.pixelScale = 1;
  self.screenPixelsPerUnit = self.pixelsPerUnit;
  self.bufferWidth = 1;
  self.bufferHeight = 1;
  self.targetX = 0;
  self.targetZ = 0;
  self.fitted = null;
  place(self);
  register(self);
  return self;
};

/**
 * Sets the ground height the camera aims to show, in world units. It takes effect at once.
 *
 * **When to use**
 *
 * When a view shows more or less of the ground than it did: a menu's backdrop seen closer.
 *
 * **Details**
 *
 * It picks the whole pixel scale nearest the height, as a resize does. A camera that fits an
 * area keeps fitting it until it follows again.
 *
 * **Example** (Seeing half as much ground)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make({ pixelsPerUnit: 16, viewHeight: 20 });
 * PixelCamera.setBufferSize(camera, 1600, 960);
 * camera.pixelScale; // => 3
 * PixelCamera.setViewHeight(camera, 10);
 * [camera.pixelScale, camera.screenPixelsPerUnit]; // => [6, 96]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setViewHeight: {
  (viewHeight: number): (self: PixelCamera) => void;
  (self: PixelCamera, viewHeight: number): void;
} = dual(2, (self: PixelCamera, viewHeight: number): void => {
  const camera = self as Internal;
  camera.viewHeight = viewHeight;
  place(camera);
});

/**
 * Tells the camera the drawing buffer's size, in pixels: what `renderer.getDrawingBufferSize`
 * gives, not CSS pixels.
 *
 * **When to use**
 *
 * A stage calls it on every resize, so a view never does; a test calls it once.
 *
 * **Details**
 *
 * Each size is rounded to a whole pixel, at least 1. The camera picks its pixel scale again.
 *
 * **Example** (A larger window, a larger scale)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make({ pixelsPerUnit: 16, viewHeight: 20 });
 * PixelCamera.setBufferSize(camera, 800, 320);
 * camera.pixelScale; // => 1
 * camera.pipe(PixelCamera.setBufferSize(1600, 960));
 * camera.pixelScale; // => 3
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setBufferSize: {
  (width: number, height: number): (self: PixelCamera) => void;
  (self: PixelCamera, width: number, height: number): void;
} = dual(3, (self: PixelCamera, width: number, height: number): void => {
  const camera = self as Internal;
  camera.bufferWidth = Math.max(1, Math.round(width));
  camera.bufferHeight = Math.max(1, Math.round(height));
  place(camera);
});

/**
 * Centres the view on a point of the ground, snapped to the nearest screen pixel.
 *
 * **When to use**
 *
 * Each frame, with the point the view follows: survivors' hero.
 *
 * **Details**
 *
 * It ends a `fit`: the camera shows `viewHeight` again.
 *
 * **Example** (Moving by whole screen pixels)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make({ pixelsPerUnit: 16, viewHeight: 20 });
 * PixelCamera.setBufferSize(camera, 960, 640);
 * // 32 screen pixels to a unit: 0.01 is nearer 0 than a pixel, and 0.02 nearer one.
 * PixelCamera.follow(camera, 0.01, 0);
 * camera.camera.position.x; // => 0
 * PixelCamera.follow(camera, 0.02, 0);
 * camera.camera.position.x; // => 1 / 32
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const follow: {
  (x: number, z: number): (self: PixelCamera) => void;
  (self: PixelCamera, x: number, z: number): void;
} = dual(3, (self: PixelCamera, x: number, z: number): void => {
  const camera = self as Internal;
  camera.fitted = null;
  camera.targetX = x;
  camera.targetZ = z;
  place(camera);
});

/**
 * Shows all of an area plus `margin` world units around it, at the largest whole pixel scale
 * that fits, centred on it.
 *
 * **When to use**
 *
 * For a board that must show whole, such as a puzzle's: once when its level starts.
 *
 * **Details**
 *
 * It keeps fitting the area on a resize until the next `follow`. `margin` defaults to 0.
 *
 * **Example** (Fitting a board with a border of one unit)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make({ pixelsPerUnit: 16 });
 * PixelCamera.setBufferSize(camera, 1000, 600);
 * PixelCamera.fit(camera, { minX: 0, maxX: 10, minZ: 0, maxZ: 6 }, 1);
 * // 12 by 8 units is 192 by 128 sprite pixels: 4 screen pixels each fit 600 high, 5 don't.
 * camera.pixelScale; // => 4
 * [camera.camera.position.x, camera.camera.position.z]; // => [5, 3]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const fit: {
  (bounds: GroundBounds, margin?: number): (self: PixelCamera) => void;
  (self: PixelCamera, bounds: GroundBounds, margin?: number): void;
} = dual(
  (args) => isPixelCamera(args[0]),
  (self: PixelCamera, bounds: GroundBounds, margin = 0): void => {
    const camera = self as Internal;
    camera.fitted = {
      minX: bounds.minX - margin,
      maxX: bounds.maxX + margin,
      minZ: bounds.minZ - margin,
      maxZ: bounds.maxZ + margin,
    };
    camera.targetX = (bounds.minX + bounds.maxX) / 2;
    camera.targetZ = (bounds.minZ + bounds.maxZ) / 2;
    place(camera);
  }
);

/**
 * Writes the rectangle of ground on screen to `out`, and returns it.
 *
 * **When to use**
 *
 * Each frame after `follow` or `fit`, with an object the view keeps, to give a tile layer the
 * cells to draw.
 *
 * **Details**
 *
 * It allocates nothing: `out` is filled and returned. Its corners are the drawing buffer's.
 *
 * **Example** (The ground a 640 by 480 buffer shows)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 * import type { Camera } from "arcadekit/render-three";
 *
 * const camera = PixelCamera.make({ pixelsPerUnit: 16, viewHeight: 20 });
 * PixelCamera.setBufferSize(camera, 640, 480);
 * PixelCamera.follow(camera, 0, 0);
 * const seen: Camera.MutableGroundBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
 * PixelCamera.groundOnScreen(camera, seen) === seen; // => true
 * // 32 screen pixels to a unit: 320 to either side, and 240 above and below.
 * seen; // => { minX: -10, maxX: 10, minZ: -7.5, maxZ: 7.5 }
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const groundOnScreen: {
  (out: MutableGroundBounds): (self: PixelCamera) => GroundBounds;
  (self: PixelCamera, out: MutableGroundBounds): GroundBounds;
} = dual(2, (self: PixelCamera, out: MutableGroundBounds): GroundBounds => {
  const { camera } = self;
  out.minX = camera.position.x + camera.left;
  out.maxX = camera.position.x + camera.right;
  out.minZ = camera.position.z - camera.top;
  out.maxZ = camera.position.z - camera.bottom;
  return out;
});

/**
 * The screen pixels per sprite pixel that best show `viewHeight` world units on a drawing
 * buffer `bufferHeight` pixels tall: the nearest whole number, at least 1.
 *
 * **When to use**
 *
 * To know the scale a following camera will pick, as a test of a view's layout does.
 *
 * **Example** (The scale of a 20-unit view of 16 px art)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * // 20 units at 16 px is 320 sprite pixels.
 * PixelCamera.pixelScale(640, 20, 16); // => 2
 * PixelCamera.pixelScale(1080, 20, 16); // => 3
 * PixelCamera.pixelScale(100, 20, 16); // => 1
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const pixelScale: {
  (viewHeight: number, pixelsPerUnit: number): (bufferHeight: number) => number;
  (bufferHeight: number, viewHeight: number, pixelsPerUnit: number): number;
} = dual(3, scaleToShow);

/**
 * The largest whole number of screen pixels per sprite pixel at which a `width` by `depth` area
 * of world units fits a `bufferWidth` by `bufferHeight` drawing buffer, at least 1.
 *
 * **When to use**
 *
 * To know the scale a fitting camera will pick for an area.
 *
 * **Details**
 *
 * A buffer too small for the area at a scale of 1 crops it.
 *
 * **Example** (A 10 by 8 area of 16 px art)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * // 160 by 128 sprite pixels.
 * PixelCamera.fitPixelScale(1000, 1000, 10, 8, 16); // => 6
 * PixelCamera.fitPixelScale(1000, 500, 10, 8, 16); // => 3
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const fitPixelScale: {
  (
    bufferHeight: number,
    width: number,
    depth: number,
    pixelsPerUnit: number
  ): (bufferWidth: number) => number;
  (
    bufferWidth: number,
    bufferHeight: number,
    width: number,
    depth: number,
    pixelsPerUnit: number
  ): number;
} = dual(5, scaleToFit);

/**
 * Rounds a world position to the nearest pixel edge, at `pixelsPerUnit` pixels per world unit:
 * sprite pixels with the sheet's density, or screen pixels with the camera's.
 *
 * **When to use**
 *
 * To put what a view computes on the grid its sprites are drawn on, such as the point a camera
 * follows, so the camera moves in the same steps as the sprite.
 *
 * **Example** (Snapping to 16 px)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * PixelCamera.snapToPixel(1.03, 16); // => 1
 * PixelCamera.snapToPixel(1.04, 16); // => 1.0625
 * PixelCamera.snapToPixel(-0.5, 32); // => -0.5
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const snapToPixel: {
  (pixelsPerUnit: number): (value: number) => number;
  (value: number, pixelsPerUnit: number): number;
} = dual(2, snap);

/**
 * The frustum of a `bufferWidth` by `bufferHeight` drawing buffer at `pixelsPerWorldUnit`
 * screen pixels per world unit, around a camera at the origin.
 *
 * **When to use**
 *
 * To know what a pixel camera shows around its position, as `groundOnScreen` adds to it.
 *
 * **Details**
 *
 * An odd size gets its spare pixel on the right or at the bottom, so the camera's position
 * stays on a screen pixel's corner.
 *
 * **Example** (A buffer at 32 pixels to a unit)
 *
 * ```ts
 * import { PixelCamera } from "arcadekit/render-three";
 *
 * PixelCamera.pixelFrustum(640, 480, 32); // => { left: -10, right: 10, top: 7.5, bottom: -7.5 }
 * PixelCamera.pixelFrustum(641, 481, 32).right * 32; // => 321
 * ```
 *
 * @category math
 * @since 0.7.0
 */
export const pixelFrustum: {
  (
    bufferHeight: number,
    pixelsPerWorldUnit: number
  ): (bufferWidth: number) => {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  (
    bufferWidth: number,
    bufferHeight: number,
    pixelsPerWorldUnit: number
  ): {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
} = dual(
  3,
  (
    bufferWidth: number,
    bufferHeight: number,
    pixelsPerWorldUnit: number
  ): {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  } => {
    const halfWidth = Math.floor(bufferWidth / 2);
    const halfHeight = Math.floor(bufferHeight / 2);
    return {
      left: -halfWidth / pixelsPerWorldUnit,
      right: (bufferWidth - halfWidth) / pixelsPerWorldUnit,
      top: halfHeight / pixelsPerWorldUnit,
      bottom: -(bufferHeight - halfHeight) / pixelsPerWorldUnit,
    };
  }
);
