/**
 * Cameras: where a 3D stage's Three.js camera goes over the ground plane (y = 0, Y up), following
 * a point, circling one, or fitting a rectangle of ground whole.
 *
 * Each function writes a camera's position and the way it looks, and allocates nothing, so a
 * view calls it every frame. They are plain calls: a view places its camera inside the frame the
 * browser shows. A pixel camera is placed by `PixelCamera`'s own functions, which keep
 * its pixels whole; a side-view genre would need helpers of its own.
 *
 * @since 0.7.0
 */
import { Predicate } from "effect";
import { dual } from "effect/Function";
import type * as THREE from "three";

/**
 * A rectangle on the ground plane (y = 0), in world units: from `minX` to `maxX` along x, and
 * from `minZ` to `maxZ` along z.
 *
 * **When to use**
 *
 * To say what a camera shows: the board `Camera.fit` and `PixelCamera.fit` fit, and the ground
 * `PixelCamera.groundOnScreen` says is on screen, which a tile layer draws.
 *
 * **Details**
 *
 * A game writes it as a literal. Larger z is lower on screen for a camera that looks straight
 * down.
 *
 * **Example** (A board of eight by six cells)
 *
 * ```ts
 * import type { Camera } from "arcadekit/render-three";
 *
 * const board: Camera.GroundBounds = { minX: 0, maxX: 8, minZ: 0, maxZ: 6 };
 * board.maxX - board.minX; // => 8
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface GroundBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * A rectangle of ground its owner keeps, for a function to fill.
 *
 * **When to use**
 *
 * As the one object a view keeps for `PixelCamera.groundOnScreen` to write into each frame, so
 * a frame allocates no rectangle.
 *
 * **Example** (The rectangle a view keeps)
 *
 * ```ts
 * import type { Camera } from "arcadekit/render-three";
 *
 * const seen: Camera.MutableGroundBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
 * seen.maxX = 10;
 * seen.maxX; // => 10
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type MutableGroundBounds = {
  -readonly [K in keyof GroundBounds]: number;
};

/**
 * How `Camera.fit` frames its rectangle: the room left around it, and how far the camera sits
 * back from straight overhead.
 *
 * **When to use**
 *
 * As the last argument of `Camera.fit`, for a board that needs a border or a tilted look.
 *
 * **Example** (A border of one unit, seen a little from the front)
 *
 * ```ts
 * import type { Camera } from "arcadekit/render-three";
 *
 * const framing: Camera.FitOptions = { margin: 1, tilt: 0.35 };
 * framing.margin; // => 1
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface FitOptions {
  /** World units of space left around the bounds on every side. Defaults to 0. */
  readonly margin?: number;
  /**
   * How far the camera sits back (toward +z) from straight overhead, as a fraction of its
   * height. 0 looks straight down. Defaults to 0.
   */
  readonly tilt?: number;
}

/**
 * Keeps a camera at a fixed offset from a target on the ground, looking at it.
 *
 * **When to use**
 *
 * Each frame of a top-down or isometric 3D game, with the point the camera follows: a hero.
 *
 * **Details**
 *
 * The camera's height is the offset's `y`, whatever the target's. It looks at the target on the
 * ground plane.
 *
 * **Example** (Following a hero from above and behind)
 *
 * ```ts
 * import { Camera } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
 * Camera.follow(camera, { x: 3, z: -2 }, { x: 0, y: 20, z: 13 });
 * camera.position.toArray(); // => [3, 20, 11]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const follow: {
  (
    target: { readonly x: number; readonly z: number },
    offset: { readonly x: number; readonly y: number; readonly z: number }
  ): (self: THREE.Camera) => void;
  (
    self: THREE.Camera,
    target: { readonly x: number; readonly z: number },
    offset: { readonly x: number; readonly y: number; readonly z: number }
  ): void;
} = dual(
  3,
  (
    self: THREE.Camera,
    target: { readonly x: number; readonly z: number },
    offset: { readonly x: number; readonly y: number; readonly z: number }
  ): void => {
    self.position.set(target.x + offset.x, offset.y, target.z + offset.z);
    self.lookAt(target.x, 0, target.z);
  }
);

/**
 * Circles a camera around a point on the ground at a fixed height, looking at it.
 *
 * **When to use**
 *
 * For a menu's backdrop or a showcase, with an angle that grows with the time.
 *
 * **Details**
 *
 * `angle` is in radians: 0 puts the camera on the point's +z side, and a quarter turn on its +x
 * side.
 *
 * **Example** (A camera on the +z side of the point)
 *
 * ```ts
 * import { Camera } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
 * Camera.orbit(camera, { x: 1, z: 2 }, { radius: 18, height: 16, angle: 0 });
 * camera.position.toArray(); // => [1, 16, 20]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const orbit: {
  (
    center: { readonly x: number; readonly z: number },
    options: {
      readonly radius: number;
      readonly height: number;
      readonly angle: number;
    }
  ): (self: THREE.Camera) => void;
  (
    self: THREE.Camera,
    center: { readonly x: number; readonly z: number },
    options: {
      readonly radius: number;
      readonly height: number;
      readonly angle: number;
    }
  ): void;
} = dual(
  3,
  (
    self: THREE.Camera,
    center: { readonly x: number; readonly z: number },
    options: {
      readonly radius: number;
      readonly height: number;
      readonly angle: number;
    }
  ): void => {
    self.position.set(
      center.x + Math.sin(options.angle) * options.radius,
      options.height,
      center.z + Math.cos(options.angle) * options.radius
    );
    self.lookAt(center.x, 0, center.z);
  }
);

/**
 * Places a camera above a rectangle of ground, looking at its centre, so that all of it shows
 * at the camera's aspect ratio.
 *
 * **When to use**
 *
 * For a board, puzzle or arena game in 3D: every frame (it allocates nothing), or at least
 * after each resize.
 *
 * **Details**
 *
 * A perspective camera keeps its field of view and moves back far enough. An orthographic
 * camera (a stage made with `camera: "orthographic"`) changes its frustum to fit instead. With a
 * tilt, the fit is still worked out as if looking straight down: that leaves an orthographic
 * camera a little room to spare, but a small tilt (below the tangent of half its field of view)
 * can push the near edge of the bounds off a perspective camera's screen, so give it more
 * margin.
 *
 * **Example** (Fitting an orthographic camera to a board)
 *
 * ```ts
 * import { Camera } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const camera = new THREE.OrthographicCamera(-10, 10, 5, -5, 0.1, 400);
 * Camera.fit(camera, { minX: 2, maxX: 10, minZ: -1, maxZ: 5 }, { margin: 1 });
 * [camera.position.x, camera.position.z]; // => [6, 2]
 * // Twice as wide as tall: the board plus its margin is 10 by 8, and fits 8 high.
 * [camera.top, camera.right]; // => [4, 8]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const fit: {
  (
    bounds: GroundBounds,
    options?: FitOptions
  ): (self: THREE.PerspectiveCamera | THREE.OrthographicCamera) => void;
  (
    self: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    bounds: GroundBounds,
    options?: FitOptions
  ): void;
} = dual(
  (args) => Predicate.hasProperty(args[0], "isCamera"),
  (
    self: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    bounds: GroundBounds,
    options: FitOptions = {}
  ): void => {
    const margin = options.margin ?? 0;
    const tilt = options.tilt ?? 0;
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const halfWidth = (bounds.maxX - bounds.minX) / 2 + margin;
    const halfDepth = (bounds.maxZ - bounds.minZ) / 2 + margin;
    let height: number;
    if (isPerspective(self)) {
      const halfTan = Math.tan((self.fov * Math.PI) / 360);
      height = Math.max(
        halfDepth / halfTan,
        halfWidth / (halfTan * self.aspect)
      );
    } else {
      const aspect = (self.right - self.left) / (self.top - self.bottom);
      const halfHeight = Math.max(halfDepth, halfWidth / aspect);
      self.top = halfHeight;
      self.bottom = -halfHeight;
      self.left = -halfHeight * aspect;
      self.right = halfHeight * aspect;
      self.updateProjectionMatrix();
      // Any height works for an orthographic camera; this one keeps the bounds well inside
      // near and far.
      height = 4 * Math.max(halfWidth, halfDepth, 1);
    }
    self.position.set(centerX, height, centerZ + height * tilt);
    self.lookAt(centerX, 0, centerZ);
  }
);

const isPerspective = (
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
): camera is THREE.PerspectiveCamera =>
  (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
