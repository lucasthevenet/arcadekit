import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  PixelCamera,
  fitPixelScale,
  pixelFrustum,
  pixelScale,
  snapToPixel,
} from "./index";

// No WebGL here: three's cameras are plain math, so they run in Node.

describe(pixelScale, () => {
  it("picks the nearest whole number of screen pixels per sprite pixel", () => {
    // 20 units at 16 px each is 320 sprite pixels.
    expect(pixelScale(640, 20, 16)).toBe(2);
    expect(pixelScale(1080, 20, 16)).toBe(3);
    expect(pixelScale(2160, 20, 16)).toBe(7);
  });

  it("never goes below 1", () => {
    expect(pixelScale(100, 20, 16)).toBe(1);
  });
});

describe(fitPixelScale, () => {
  it("picks the largest whole scale at which the area fits both ways", () => {
    // 10 x 8 units at 16 px is 160 x 128 sprite pixels.
    expect(fitPixelScale(1000, 1000, 10, 8, 16)).toBe(6);
    expect(fitPixelScale(1000, 500, 10, 8, 16)).toBe(3);
    expect(fitPixelScale(100, 100, 10, 8, 16)).toBe(1);
  });
});

describe(snapToPixel, () => {
  it("rounds to the nearest pixel edge", () => {
    expect(snapToPixel(1.03, 16)).toBe(1);
    expect(snapToPixel(1.04, 16)).toBe(1.0625);
    expect(snapToPixel(-0.5, 32)).toBe(-0.5);
  });
});

describe(pixelFrustum, () => {
  it("is the buffer's size in world units, with an odd pixel on the right and bottom", () => {
    expect(pixelFrustum(640, 480, 32)).toStrictEqual({
      left: -10,
      right: 10,
      top: 7.5,
      bottom: -7.5,
    });
    const odd = pixelFrustum(641, 481, 32);
    expect(odd.left * 32).toBe(-320);
    expect(odd.right * 32).toBe(321);
    expect(odd.top * 32).toBe(240);
    expect(odd.bottom * 32).toBe(-241);
  });
});

/** The drawing buffer pixel (x right, y down, 0 at the top-left corner) a ground point lands on. */
const toBuffer = (
  camera: PixelCamera,
  width: number,
  height: number,
  x: number,
  z: number
) => {
  const ndc = new THREE.Vector3(x, 0, z).project(camera);
  return {
    x: ((ndc.x + 1) / 2) * width,
    y: ((1 - ndc.y) / 2) * height,
  };
};

const closeTo = (value: number): number => expect.closeTo(value, 6);

const isWhole = (value: number) => Math.abs(value - Math.round(value)) < 1e-6;

describe(PixelCamera, () => {
  it("looks straight down with +x right and +z down the screen", () => {
    const camera = new PixelCamera({ pixelsPerUnit: 16, viewHeight: 20 });
    camera.setBufferSize(640, 480);
    camera.follow(0, 0);
    const middle = toBuffer(camera, 640, 480, 0, 0);
    const right = toBuffer(camera, 640, 480, 1, 0);
    const below = toBuffer(camera, 640, 480, 0, 1);
    // 20 units at 16 px is 320 sprite pixels; 480 / 320 = 1.5 rounds to 2 screen pixels each.
    expect(middle).toStrictEqual({ x: closeTo(320), y: closeTo(240) });
    expect(right).toStrictEqual({ x: closeTo(352), y: closeTo(240) });
    expect(below).toStrictEqual({ x: closeTo(320), y: closeTo(272) });
  });

  it.each([
    [640, 480],
    [641, 479],
    [1366, 767],
  ])(
    "puts every sprite pixel edge on a whole buffer pixel, wherever it follows, at %s x %s",
    (width, height) => {
      const camera = new PixelCamera({ pixelsPerUnit: 16, viewHeight: 15 });
      camera.setBufferSize(width, height);
      const scale = camera.pixelScale;
      expect(Number.isInteger(scale)).toBe(true);
      for (const [x, z] of [
        [0, 0],
        [0.013, -7.77],
        [123.456, 98.7654],
        [-3.3, 2.2],
      ] as const) {
        camera.follow(x, z);
        // A sprite pixel edge near the target, and one a few pixels away.
        for (const [px, pz] of [
          [snapToPixel(x, 16), snapToPixel(z, 16)],
          [snapToPixel(x, 16) + 5 / 16, snapToPixel(z, 16) - 3 / 16],
        ] as const) {
          const at = toBuffer(camera, width, height, px, pz);
          expect(isWhole(at.x), `x ${at.x}`).toBe(true);
          expect(isWhole(at.y), `y ${at.y}`).toBe(true);
        }
        // One sprite pixel is `scale` buffer pixels.
        const a = toBuffer(camera, width, height, 0, 0);
        const b = toBuffer(camera, width, height, 1 / 16, 1 / 16);
        expect(b.x - a.x).toBeCloseTo(scale);
        expect(b.y - a.y).toBeCloseTo(scale);
      }
    }
  );

  it("moves only by whole screen pixels", () => {
    const camera = new PixelCamera({ pixelsPerUnit: 16, viewHeight: 20 });
    camera.setBufferSize(960, 640);
    expect(camera.pixelScale).toBe(2);
    camera.follow(0.01, 0);
    expect(camera.position.x).toBe(0);
    camera.follow(0.02, 0);
    expect(camera.position.x).toBe(1 / 32);
  });

  it("picks its scale again on resize and when its view height changes", () => {
    const camera = new PixelCamera({ pixelsPerUnit: 16, viewHeight: 20 });
    camera.setBufferSize(800, 320);
    expect(camera.pixelScale).toBe(1);
    camera.setBufferSize(1600, 960);
    expect(camera.pixelScale).toBe(3);
    camera.setViewHeight(10);
    expect(camera.pixelScale).toBe(6);
    expect(camera.screenPixelsPerUnit).toBe(96);
  });

  it("fits an area at the largest whole scale, centred, until it follows again", () => {
    const camera = new PixelCamera({ pixelsPerUnit: 16 });
    camera.setBufferSize(1000, 600);
    const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 6 };
    camera.fit(bounds, 1);
    // 12 x 8 units is 192 x 128 sprite pixels: 4x fits 600 high, 5x doesn't.
    expect(camera.pixelScale).toBe(4);
    expect([camera.position.x, camera.position.z]).toStrictEqual([5, 3]);
    for (const [x, z] of [
      [-1, -1],
      [11, 7],
    ] as const) {
      const at = toBuffer(camera, 1000, 600, x, z);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.x).toBeLessThanOrEqual(1000);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeLessThanOrEqual(600);
    }
    camera.setBufferSize(2000, 1200);
    expect(camera.pixelScale).toBe(9);
    camera.follow(0, 0);
    expect(camera.pixelScale).toBe(pixelScale(1200, 20, 16));
  });

  it("says which rectangle of ground is on screen after it follows, into the object it is given", () => {
    const camera = new PixelCamera({ pixelsPerUnit: 16, viewHeight: 20 });
    // 2 screen pixels per sprite pixel: 32 to a unit. An odd size has its spare pixel on the
    // right and at the bottom.
    camera.setBufferSize(641, 481);
    camera.follow(3.21, -7.77);
    const out = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    const seen = camera.groundOnScreen(out);
    // The object it was given, filled: a view keeps one, and a frame allocates nothing.
    expect(seen).toBe(out);
    expect(out).toStrictEqual({
      minX: camera.position.x + camera.left,
      maxX: camera.position.x + camera.right,
      minZ: camera.position.z - camera.top,
      maxZ: camera.position.z - camera.bottom,
    });
    // The camera is at (103 / 32, -249 / 32), with 320 pixels to its left and 240 above it.
    expect(out).toStrictEqual({
      minX: -6.78125,
      maxX: 13.25,
      minZ: -15.28125,
      maxZ: -0.25,
    });
    // Its corners are the buffer's corners.
    expect([
      toBuffer(camera, 641, 481, out.minX, out.minZ),
      toBuffer(camera, 641, 481, out.maxX, out.maxZ),
    ]).toStrictEqual([
      { x: closeTo(0), y: closeTo(0) },
      { x: closeTo(641), y: closeTo(481) },
    ]);
    // It follows the camera: the same object, filled again.
    camera.follow(4.21, -7.77);
    expect(camera.groundOnScreen(out)).toStrictEqual({
      minX: -5.78125,
      maxX: 14.25,
      minZ: -15.28125,
      maxZ: -0.25,
    });
  });

  it("says which rectangle of ground is on screen after it fits, with the room around the area", () => {
    const camera = new PixelCamera({ pixelsPerUnit: 16 });
    camera.setBufferSize(1000, 600);
    const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 6 };
    camera.fit(bounds, 1);
    const out = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    expect(camera.groundOnScreen(out)).toBe(out);
    expect(out).toStrictEqual({
      minX: camera.position.x + camera.left,
      maxX: camera.position.x + camera.right,
      minZ: camera.position.z - camera.top,
      maxZ: camera.position.z - camera.bottom,
    });
    // 4 screen pixels per sprite pixel, so 64 to a unit, around (5, 3): the 12 by 8 units it
    // fitted, and what is left of the buffer on each side.
    expect(out).toStrictEqual({
      minX: -2.8125,
      maxX: 12.8125,
      minZ: -1.6875,
      maxZ: 7.6875,
    });
    // A resize is a new rectangle: at 9 to a sprite pixel, 144 to a unit.
    camera.setBufferSize(2000, 1200);
    expect(camera.groundOnScreen(out)).toStrictEqual({
      minX: 5 - 1000 / 144,
      maxX: 5 + 1000 / 144,
      minZ: 3 - 600 / 144,
      maxZ: 3 + 600 / 144,
    });
  });
});
