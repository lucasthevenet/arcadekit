import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { InstancedSprites, PixelCamera } from "./index";
import { drawnSprites } from "./testing/drawn-sprites";
import { testSheet } from "./testing/test-sheet";

// No WebGL here: a batch is plain Three.js objects, read back with the testing entry's
// `drawnSprites`, and Three.js would call `mesh.onBeforeRender` with the camera that draws it.
// The helpers are imported by their files: the entry's public file also has the PNG checks,
// which need Node's types (tsconfig.node.json).

// Frames 0 and 1 are "slime", 2 and 3 are "bat".
const sheet = testSheet({ slime: 2, bat: 2 });

/** What each sprite shown was pushed with. */
const pushed = (batch: InstancedSprites) =>
  drawnSprites(batch).map(({ x, z, frame, flipX }) => [x, z, frame, flipX]);

/** Tells a batch that `camera` is about to draw it, as a renderer does before the draw call. */
const beforeRender = (batch: InstancedSprites, camera: THREE.Camera) => {
  const { mesh } = batch;
  mesh.onBeforeRender(
    null as unknown as THREE.WebGLRenderer,
    null as unknown as THREE.Scene,
    camera,
    mesh.geometry,
    mesh.material,
    null as unknown as THREE.Group
  );
};

/** The world units a batch's shader rounds positions to, or 0 for no rounding. */
const snapUnit = (batch: InstancedSprites) =>
  batch.mesh.material.uniforms["uSnapUnit"]?.value as number;

/** A pixel camera drawing `screenPixels` screen pixels for each of its 16 sprite pixels a unit. */
const pixelCamera = (screenPixels: number) => {
  const camera = new PixelCamera({ pixelsPerUnit: 16, viewHeight: 10 });
  camera.setBufferSize(800, 160 * screenPixels);
  return camera;
};

describe(InstancedSprites, () => {
  it("gives each pushed sprite the next index, and shows them at end", () => {
    const batch = new InstancedSprites(sheet);
    batch.begin();
    const indices = [
      batch.push(1, 2, 0),
      batch.push(3, 4, 1, true),
      batch.push(5, 6, 3),
    ];
    expect({ indices, count: batch.count }).toStrictEqual({
      indices: [0, 1, 2],
      count: 3,
    });
    // Pushed, and not shown yet.
    expect(batch.mesh.geometry.instanceCount).toBe(0);
    batch.end();
    expect(batch.mesh.geometry.instanceCount).toBe(3);
    expect(pushed(batch)).toStrictEqual([
      [1, 2, 0, false],
      [3, 4, 1, true],
      [5, 6, 3, false],
    ]);
  });

  it("starts over at begin, and keeps showing its last end until the next", () => {
    const batch = new InstancedSprites(sheet);
    batch.begin();
    batch.push(1, 1, 0);
    batch.push(2, 2, 1);
    batch.end();
    batch.begin();
    expect({ count: batch.count, shown: pushed(batch).length }).toStrictEqual({
      count: 0,
      shown: 2,
    });
    expect(batch.push(7, 8, 2)).toBe(0);
    batch.end();
    expect(pushed(batch)).toStrictEqual([[7, 8, 2, false]]);
    // A frame with no sprite shows none.
    batch.begin();
    batch.end();
    expect(pushed(batch)).toStrictEqual([]);
  });

  it("writes what the setters give a sprite, and a push starts its look plain", () => {
    const batch = new InstancedSprites(sheet, { layer: 2 });
    batch.begin();
    const sprite = batch.push(3, 4, 3, true);
    batch.setTint(sprite, new THREE.Color(0.5, 0.25, 1), 0.75);
    batch.setFlash(sprite, 0.5);
    batch.setLift(sprite, 0.25);
    batch.setLayer(sprite, 3);
    batch.end();
    expect(drawnSprites(batch)).toStrictEqual([
      {
        x: 3,
        z: 4,
        frame: 3,
        tag: "bat",
        flipX: true,
        tint: [0.5, 0.25, 1, 0.75],
        flash: 0.5,
        lift: 0.25,
        // The batch's layer plus its own.
        layer: 5,
      },
    ]);

    batch.setAlpha(sprite, 0.5);
    expect(drawnSprites(batch)[0]?.tint).toStrictEqual([0.5, 0.25, 1, 0.5]);

    // The same slot next frame: nothing of the last sprite is left. A frame outside the
    // sheet draws frame 0.
    batch.begin();
    batch.push(5, 6, 9);
    batch.end();
    expect(drawnSprites(batch)).toStrictEqual([
      {
        x: 5,
        z: 6,
        frame: 0,
        tag: "slime",
        flipX: false,
        tint: [1, 1, 1, 1],
        flash: 0,
        lift: 0,
        layer: 2,
      },
    ]);
  });

  it("has room for 64 sprites unless told, and for at least one whole sprite", () => {
    expect([
      new InstancedSprites(sheet).capacity,
      new InstancedSprites(sheet, { capacity: 300 }).capacity,
      new InstancedSprites(sheet, { capacity: 0 }).capacity,
      new InstancedSprites(sheet, { capacity: -3 }).capacity,
      new InstancedSprites(sheet, { capacity: 2.5 }).capacity,
    ]).toStrictEqual([64, 300, 1, 1, 3]);
  });

  it("refuses a capacity that is no finite number", () => {
    // Buffers with no room that never grow would lose every sprite pushed, in silence.
    expect(() => new InstancedSprites(sheet, { capacity: Number.NaN })).toThrow(
      new RangeError(
        "InstancedSprites: a capacity of NaN is no number of sprites: give the batch a whole number to start with, or leave it out for 64"
      )
    );
    expect(
      () => new InstancedSprites(sheet, { capacity: Number.POSITIVE_INFINITY })
    ).toThrow(
      new RangeError(
        "InstancedSprites: a capacity of Infinity is no number of sprites: give the batch a whole number to start with, or leave it out for 64"
      )
    );
  });

  it("doubles its room when a frame pushes past it, keeping every sprite, its mesh and its material", () => {
    const batch = new InstancedSprites(sheet, { capacity: 2 });
    const { mesh } = batch;
    const { material, geometry: first } = mesh;
    const freed = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    batch.begin();
    for (let i = 0; i < 5; i++) {
      const sprite = batch.push(i, 10 - i, i % 4, i % 2 === 1);
      batch.setLayer(sprite, i);
      batch.setFlash(sprite, i / 4);
    }
    // 2, then 4, then 8.
    expect(batch.capacity).toBe(8);
    batch.end();

    expect(
      drawnSprites(batch).map(({ x, z, frame, flipX, layer, flash }) => [
        x,
        z,
        frame,
        flipX,
        layer,
        flash,
      ])
    ).toStrictEqual([
      [0, 10, 0, false, 0, 0],
      [1, 9, 1, true, 1, 0.25],
      [2, 8, 2, false, 2, 0.5],
      [3, 7, 3, true, 3, 0.75],
      [4, 6, 0, false, 4, 1],
    ]);
    // The same mesh and material, so the scene and the shader are untouched. The two
    // geometries it outgrew are freed, and the one it draws from is not.
    const disposed = freed.mock.contexts.filter(
      (geometry) => geometry instanceof THREE.InstancedBufferGeometry
    );
    freed.mockRestore();
    expect({
      mesh: batch.mesh === mesh,
      material: mesh.material === material,
      replaced: mesh.geometry !== first,
      freedFirst: disposed[0] === first,
      freed: disposed.length,
      freedCurrent: disposed.includes(mesh.geometry),
    }).toStrictEqual({
      mesh: true,
      material: true,
      replaced: true,
      freedFirst: true,
      freed: 2,
      freedCurrent: false,
    });
  });

  it("shows as many sprites as its last end did while a frame that grows it is pushed", () => {
    const batch = new InstancedSprites(sheet, { capacity: 1 });
    batch.begin();
    batch.push(1, 1, 0);
    batch.end();
    batch.begin();
    batch.push(2, 2, 1);
    batch.push(3, 3, 2);
    expect(batch.mesh.geometry.instanceCount).toBe(1);
    batch.end();
    expect(pushed(batch)).toStrictEqual([
      [2, 2, 1, false],
      [3, 3, 2, false],
    ]);
  });

  it("dispose removes the mesh and frees what it made, not the sheet", () => {
    const batch = new InstancedSprites(sheet, { capacity: 4 });
    const scene = new THREE.Scene();
    scene.add(batch.mesh);
    const freed: unknown[] = [];
    for (const thing of [
      sheet.texture,
      batch.mesh.material,
      batch.mesh.geometry,
    ]) {
      thing.addEventListener("dispose", () => freed.push(thing));
    }
    batch.dispose();
    expect(batch.mesh.parent).toBeNull();
    expect(freed).toStrictEqual([batch.mesh.geometry, batch.mesh.material]);
  });

  describe("the unit it gives its shader to round positions to", () => {
    it('is a sprite pixel for "sprite", the default, whatever camera draws it', () => {
      const byDefault = new InstancedSprites(sheet);
      const coarse = new InstancedSprites(sheet, {
        snap: "sprite",
        unitsPerPixel: 1 / 8,
      });
      beforeRender(coarse, pixelCamera(4));
      expect([snapUnit(byDefault), snapUnit(coarse)]).toStrictEqual([
        1 / 16,
        1 / 8,
      ]);
    });

    it('is a screen pixel of the pixel camera about to draw it for "screen"', () => {
      const batch = new InstancedSprites(sheet, { snap: "screen" });
      const { material } = batch.mesh;
      // A sprite pixel until a camera draws it.
      expect(snapUnit(batch)).toBe(1 / 16);

      const camera = pixelCamera(4);
      expect(camera.screenPixelsPerUnit).toBe(64);
      beforeRender(batch, camera);
      // Three.js uploads a uniform changed here for the same draw only when told.
      expect([snapUnit(batch), material.uniformsNeedUpdate]).toStrictEqual([
        1 / 64,
        true,
      ]);

      // The same camera again: nothing to upload.
      material.uniformsNeedUpdate = false;
      beforeRender(batch, camera);
      expect([snapUnit(batch), material.uniformsNeedUpdate]).toStrictEqual([
        1 / 64,
        false,
      ]);

      // Each draw's own camera: one at another scale, then one with no screen pixels to
      // give, which gets sprite pixels.
      beforeRender(batch, pixelCamera(3));
      const other = snapUnit(batch);
      beforeRender(batch, new THREE.OrthographicCamera());
      expect([
        other,
        snapUnit(batch),
        material.uniformsNeedUpdate,
      ]).toStrictEqual([1 / 48, 1 / 16, true]);
    });

    it('is none for "none"', () => {
      const batch = new InstancedSprites(sheet, { snap: "none" });
      beforeRender(batch, pixelCamera(4));
      expect(snapUnit(batch)).toBe(0);
    });

    it("says what it was made to round to, so a view's test can hold it", () => {
      expect([
        new InstancedSprites(sheet).snap,
        new InstancedSprites(sheet, { snap: "screen" }).snap,
        new InstancedSprites(sheet, { snap: "none" }).snap,
      ]).toStrictEqual(["sprite", "screen", "none"]);
    });
  });
});
