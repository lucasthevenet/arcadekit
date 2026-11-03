// Every helper here works on the ground plane (y = 0, Y up).
// A side-view genre would need its own.

import type * as THREE from "three";

/** Keeps the camera at a fixed offset from a target on the ground plane, looking at it. Top-down and isometric games. */
export const followTarget = (
  camera: THREE.Camera,
  target: { readonly x: number; readonly z: number },
  offset: { readonly x: number; readonly y: number; readonly z: number }
): void => {
  camera.position.set(target.x + offset.x, offset.y, target.z + offset.z);
  camera.lookAt(target.x, 0, target.z);
};

/**
 * Circles the camera around a point on the ground plane at a fixed height, looking at it.
 * `angle` is in radians; 0 puts the camera on the point's +z side. Menu backdrops and
 * showcase views.
 */
export const orbitAround = (
  camera: THREE.Camera,
  center: { readonly x: number; readonly z: number },
  options: {
    readonly radius: number;
    readonly height: number;
    readonly angle: number;
  }
): void => {
  camera.position.set(
    center.x + Math.sin(options.angle) * options.radius,
    options.height,
    center.z + Math.cos(options.angle) * options.radius
  );
  camera.lookAt(center.x, 0, center.z);
};

/** A rectangle on the ground plane (y = 0), in world units. */
export interface GroundBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface FitCameraOptions {
  /** World units of space left around the bounds on every side. Defaults to 0. */
  readonly margin?: number;
  /**
   * How far the camera sits back (toward +z) from straight overhead, as a fraction of its
   * height. 0 looks straight down. Defaults to 0.
   */
  readonly tilt?: number;
}

/**
 * Places a camera above a rectangle on the ground plane, looking at its center, so that all of
 * it shows at the camera's current aspect ratio. Board, puzzle and arena games. Call it every
 * frame (it allocates nothing), or at least after each resize.
 *
 * A perspective camera keeps its field of view and moves back far enough. An orthographic
 * camera (`Stage` with `camera: "orthographic"`) changes its frustum to fit instead.
 * With a tilt, the fit is still worked out as if looking straight down. That leaves an
 * orthographic camera a little extra room. It does not hold for a perspective camera: a small
 * tilt (below the tangent of half its field of view) can push the near edge of the bounds off
 * the screen, so give it more margin.
 */
export const fitCamera = (
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  bounds: GroundBounds,
  options: FitCameraOptions = {}
): void => {
  const margin = options.margin ?? 0;
  const tilt = options.tilt ?? 0;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const halfWidth = (bounds.maxX - bounds.minX) / 2 + margin;
  const halfDepth = (bounds.maxZ - bounds.minZ) / 2 + margin;
  let height: number;
  if (isPerspective(camera)) {
    const halfTan = Math.tan((camera.fov * Math.PI) / 360);
    height = Math.max(
      halfDepth / halfTan,
      halfWidth / (halfTan * camera.aspect)
    );
  } else {
    const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
    const halfHeight = Math.max(halfDepth, halfWidth / aspect);
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.updateProjectionMatrix();
    // Any height works for an orthographic camera; this one keeps the bounds well inside near/far.
    height = 4 * Math.max(halfWidth, halfDepth, 1);
  }
  camera.position.set(centerX, height, centerZ + height * tilt);
  camera.lookAt(centerX, 0, centerZ);
};

const isPerspective = (
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
): camera is THREE.PerspectiveCamera =>
  (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
