import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { Camera } from "./index";

// No WebGL here: three's cameras and vectors are plain math, so they run in Node.

/** Where the ground point (x, 0, z) lands in the camera's normalized device coordinates. */
const project = (camera: THREE.Camera, x: number, z: number) => {
  camera.updateMatrixWorld();
  return new THREE.Vector3(x, 0, z).project(camera);
};

/** How far toward the edge of the screen a projected point is: 0 is the middle, 1 the edge. */
const reach = (point: THREE.Vector3) =>
  Math.max(Math.abs(point.x), Math.abs(point.y));

// A board 8 wide and 6 deep, centered on (6, 2).
const BOUNDS = { minX: 2, maxX: 10, minZ: -1, maxZ: 5 };
const MARGIN = 1;

/** The corners of BOUNDS grown by MARGIN, projected. */
const corners = (camera: THREE.Camera) =>
  (
    [
      [BOUNDS.minX - MARGIN, BOUNDS.minZ - MARGIN],
      [BOUNDS.maxX + MARGIN, BOUNDS.minZ - MARGIN],
      [BOUNDS.minX - MARGIN, BOUNDS.maxZ + MARGIN],
      [BOUNDS.maxX + MARGIN, BOUNDS.maxZ + MARGIN],
    ] as const
  ).map(([x, z]) => project(camera, x, z));

/**
 * Looking straight down, three's lookAt turns the camera 0.0001 radians off vertical to choose
 * which way is up. That can move a projected point by up to 0.0005.
 */
const NUDGE = 0.001;

// Cameras `aspect` times as wide as they are tall, with Stage's defaults.
const perspective = (aspect: number) =>
  new THREE.PerspectiveCamera(50, aspect, 0.1, 400);
const orthographic = (aspect: number) =>
  new THREE.OrthographicCamera(-5 * aspect, 5 * aspect, 5, -5, 0.1, 400);

describe(Camera.fit, () => {
  describe.each([
    { camera: "a perspective camera", makeCamera: perspective },
    { camera: "an orthographic camera", makeCamera: orthographic },
  ])("with $camera", ({ makeCamera }) => {
    it.each([2, 0.5])(
      "shows every corner of the bounds plus the margin, filling the view one way, at aspect %s",
      (aspect) => {
        const camera = makeCamera(aspect);
        Camera.fit(camera, BOUNDS, { margin: MARGIN });
        const points = corners(camera);
        const farthest = Math.max(...points.map(reach));
        expect(farthest).toBeLessThanOrEqual(1 + NUDGE);
        expect(farthest).toBeGreaterThanOrEqual(1 - NUDGE);
        // Between the near and far planes too.
        expect(
          Math.max(...points.map((point) => Math.abs(point.z)))
        ).toBeLessThan(1);
      }
    );

    it.each([0, 0.35])("looks at the bounds' center with tilt %s", (tilt) => {
      const camera = makeCamera(2);
      Camera.fit(camera, BOUNDS, { margin: MARGIN, tilt });
      expect(reach(project(camera, 6, 2))).toBeLessThanOrEqual(NUDGE);
    });

    it("sits back toward +z by tilt times its height", () => {
      const overhead = makeCamera(2);
      Camera.fit(overhead, BOUNDS, { margin: MARGIN });
      const tilted = makeCamera(2);
      Camera.fit(tilted, BOUNDS, { margin: MARGIN, tilt: 0.35 });
      // With no tilt, straight above the center.
      expect([overhead.position.x, overhead.position.z]).toStrictEqual([6, 2]);
      expect(tilted.position.x).toBe(6);
      expect(tilted.position.y).toBe(overhead.position.y);
      expect(tilted.position.z).toBeCloseTo(2 + 0.35 * tilted.position.y);
    });
  });

  it.each([2, 0.5])(
    "keeps an orthographic camera's aspect ratio of %s",
    (aspect) => {
      const camera = orthographic(aspect);
      Camera.fit(camera, BOUNDS, { margin: MARGIN });
      expect(
        (camera.right - camera.left) / (camera.top - camera.bottom)
      ).toBeCloseTo(aspect);
    }
  );

  // Orthographic only: a small tilt moves a perspective camera closer to the near edge of the
  // bounds, and that edge can leave the screen.
  it("leaves an orthographic camera room to spare when it tilts", () => {
    const camera = orthographic(2);
    Camera.fit(camera, BOUNDS, { margin: MARGIN, tilt: 0.35 });
    expect(Math.max(...corners(camera).map(reach))).toBeLessThan(1);
  });
});

describe(Camera.follow, () => {
  it("keeps the camera at a fixed offset from the target, looking at it", () => {
    const camera = perspective(16 / 9);
    const offset = { x: 2, y: 20, z: 13 };
    Camera.follow(camera, { x: 3, z: -2 }, offset);
    expect(camera.position.toArray()).toStrictEqual([5, 20, 11]);
    Camera.follow(camera, { x: -4, z: 6 }, offset);
    expect(camera.position.toArray()).toStrictEqual([-2, 20, 19]);
    expect(reach(project(camera, -4, 6))).toBeCloseTo(0);
  });
});

describe(Camera.orbit, () => {
  it("puts the camera on the +z side at angle 0, at the given height and radius, looking at the center", () => {
    const camera = perspective(16 / 9);
    Camera.orbit(camera, { x: 1, z: 2 }, { radius: 18, height: 16, angle: 0 });
    expect(camera.position.toArray()).toStrictEqual([1, 16, 20]);
    expect(reach(project(camera, 1, 2))).toBeCloseTo(0);
  });

  it("moves the camera to the +x side a quarter turn later", () => {
    const camera = perspective(16 / 9);
    Camera.orbit(
      camera,
      { x: 1, z: 2 },
      { radius: 18, height: 16, angle: Math.PI / 2 }
    );
    expect(camera.position.x).toBeCloseTo(19);
    expect(camera.position.y).toBe(16);
    expect(camera.position.z).toBeCloseTo(2);
    expect(reach(project(camera, 1, 2))).toBeCloseTo(0);
  });
});
