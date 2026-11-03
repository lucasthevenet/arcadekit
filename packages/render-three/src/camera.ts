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

/** Circles the camera around a point. Menu backdrops and showcase views. */
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
