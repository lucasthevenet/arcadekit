// The pixel camera that places each Three.js camera it holds. A batch that snaps to screen pixels
// is told only the Three.js camera about to draw it (`onBeforeRender`), and reads that camera's
// screen pixels here. No public file exports it.

import type * as THREE from "three";

import type * as PixelCamera from "../pixel-camera";

const byCamera = new WeakMap<THREE.Camera, PixelCamera.PixelCamera>();

/** Says that `pixel` places `pixel.camera`, for `pixelCameraOf`. */
export const register = (pixel: PixelCamera.PixelCamera): void => {
  byCamera.set(pixel.camera, pixel);
};

/** The pixel camera that places `camera`, or undefined for a camera no pixel camera holds. */
export const pixelCameraOf = (
  camera: THREE.Camera
): PixelCamera.PixelCamera | undefined => byCamera.get(camera);
