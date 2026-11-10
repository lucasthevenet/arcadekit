// A straight-down orthographic camera for pixel art. Every sprite pixel covers a whole number of
// screen pixels, and the camera only ever moves by whole screen pixels, so the art never shimmers.

import * as THREE from "three";

import type { GroundBounds } from "./camera";

/** How high above the ground the camera sits. Anything from y = -HEIGHT to just below it is drawn. */
const HEIGHT = 100;

/**
 * Screen pixels per sprite pixel that best shows `viewHeight` world units on a drawing buffer
 * `bufferHeight` pixels tall: the nearest whole number, at least 1.
 */
export const pixelScale = (
  bufferHeight: number,
  viewHeight: number,
  pixelsPerUnit: number
): number =>
  Math.max(1, Math.round(bufferHeight / (viewHeight * pixelsPerUnit)));

/**
 * The largest whole number of screen pixels per sprite pixel at which a `width` x `depth` world
 * unit area fits a `bufferWidth` x `bufferHeight` drawing buffer, at least 1 (a buffer too
 * small for the area at 1 crops it).
 */
export const fitPixelScale = (
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

/**
 * Rounds a world position to the nearest pixel edge, at `pixelsPerUnit` pixels per world unit:
 * sprite pixels with the sheet's density, or screen pixels with the camera's.
 */
export const snapToPixel = (value: number, pixelsPerUnit: number): number =>
  Math.round(value * pixelsPerUnit) / pixelsPerUnit;

/**
 * The frustum for a `bufferWidth` x `bufferHeight` drawing buffer at `pixelsPerWorldUnit`
 * screen pixels per world unit, around a camera at the origin. An odd size gets its spare
 * pixel on the right or bottom, so the camera's position stays on a screen pixel's corner.
 */
export const pixelFrustum = (
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
};

export interface PixelCameraOptions {
  /** Sprite pixels per world unit: 16 draws a 16 px enemy one unit wide. Defaults to 16. */
  readonly pixelsPerUnit?: number;
  /**
   * About how many world units of ground to show top to bottom. The camera picks the whole
   * number of screen pixels per sprite pixel that comes nearest. Defaults to 20.
   */
  readonly viewHeight?: number;
}

/**
 * An orthographic camera looking straight down at the ground plane (y = 0), with +x to the
 * right and +z down the screen, so a larger z is lower on screen. It keeps sprite pixels whole:
 * `pixelScale` screen pixels per sprite pixel, a whole number, and a position on whole screen
 * pixels. Give it the drawing buffer's size with `setBufferSize` (a `Stage` made with
 * `camera: "pixel"` does, on every resize), then `follow` a point or `fit` an area each frame.
 * Don't move it with `fitCamera` or `lookAt`: they undo the snapping.
 */
export class PixelCamera extends THREE.OrthographicCamera {
  readonly isPixelCamera = true;
  private pixelsPerUnitValue: number;
  private viewHeightValue: number;
  private screenScale = 1;
  private bufferWidth = 1;
  private bufferHeight = 1;
  private targetX = 0;
  private targetZ = 0;
  /** Set by `fit`, cleared by `follow`. */
  private fitted: GroundBounds | null = null;

  constructor(options: PixelCameraOptions = {}) {
    super(-1, 1, 1, -1, 1, 2 * HEIGHT);
    this.pixelsPerUnitValue = options.pixelsPerUnit ?? 16;
    this.viewHeightValue = options.viewHeight ?? 20;
    // Straight down, with up on screen toward -z. Set directly: lookAt would tilt it a hair.
    this.rotation.set(-Math.PI / 2, 0, 0);
    this.update();
  }

  /** Sprite pixels per world unit. */
  get pixelsPerUnit(): number {
    return this.pixelsPerUnitValue;
  }

  /** Screen pixels per sprite pixel: a whole number, at least 1. */
  get pixelScale(): number {
    return this.screenScale;
  }

  /** Screen (drawing buffer) pixels per world unit. */
  get screenPixelsPerUnit(): number {
    return this.pixelsPerUnitValue * this.screenScale;
  }

  /** The ground height to aim for, in world units. Takes effect at once. */
  setViewHeight(viewHeight: number): void {
    this.viewHeightValue = viewHeight;
    this.update();
  }

  /** The drawing buffer's size in pixels (`renderer.getDrawingBufferSize`), not CSS pixels. */
  setBufferSize(width: number, height: number): void {
    this.bufferWidth = Math.max(1, Math.round(width));
    this.bufferHeight = Math.max(1, Math.round(height));
    this.update();
  }

  /** Centres the view on a ground point, snapped to the nearest screen pixel. Survivors' hero. */
  follow(x: number, z: number): void {
    this.fitted = null;
    this.targetX = x;
    this.targetZ = z;
    this.update();
  }

  /**
   * Shows all of an area plus `margin` world units around it, at the largest whole pixel scale
   * that fits, centred on it. It keeps fitting on resize until the next `follow`. A puzzle board.
   */
  fit(bounds: GroundBounds, margin = 0): void {
    this.fitted = {
      minX: bounds.minX - margin,
      maxX: bounds.maxX + margin,
      minZ: bounds.minZ - margin,
      maxZ: bounds.maxZ + margin,
    };
    this.targetX = (bounds.minX + bounds.maxX) / 2;
    this.targetZ = (bounds.minZ + bounds.maxZ) / 2;
    this.update();
  }

  private update(): void {
    const perUnit = this.pixelsPerUnitValue;
    this.screenScale = this.fitted
      ? fitPixelScale(
          this.bufferWidth,
          this.bufferHeight,
          this.fitted.maxX - this.fitted.minX,
          this.fitted.maxZ - this.fitted.minZ,
          perUnit
        )
      : pixelScale(this.bufferHeight, this.viewHeightValue, perUnit);
    const screenPerUnit = perUnit * this.screenScale;
    const frustum = pixelFrustum(
      this.bufferWidth,
      this.bufferHeight,
      screenPerUnit
    );
    this.left = frustum.left;
    this.right = frustum.right;
    this.top = frustum.top;
    this.bottom = frustum.bottom;
    this.updateProjectionMatrix();
    this.position.set(
      snapToPixel(this.targetX, screenPerUnit),
      HEIGHT,
      snapToPixel(this.targetZ, screenPerUnit)
    );
    this.updateMatrixWorld();
  }
}
