import { describe, expect, it, vi } from "vitest";

import { PixelCamera, TileLayer } from "../../src/render-three/index";
import type { Camera } from "../../src/render-three/index";
import * as DrawnSprites from "../../src/render-three/testing/drawn-sprites";
import * as TestSpriteSheet from "../../src/render-three/testing/test-sprite-sheet";

// No WebGL here: a layer fills a batch of plain Three.js objects, read back with the testing
// entry's `DrawnSprites.read`. The helpers are imported by their files: the entry's public file also
// has the PNG checks, which need Node's types (tsconfig.node.json).

// Frames 0 to 2 are "grass", frame 3 is "wall".
const sheet = TestSpriteSheet.fromTags({ grass: 3, wall: 1 });

/** Where each tile of a layer's last fill is, and the frame it shows. */
const tiles = (layer: TileLayer.TileLayer) =>
  DrawnSprites.read(layer).map(({ x, z, frame }) => [x, z, frame]);

/** A wall in column 1, and grass everywhere else. */
const wallInColumnOne = (col: number): number => (col === 1 ? 3 : 0);

/** Columns 0 to 2 and rows -2 to 0, each partly seen: nine cells. */
const NINE_CELLS: Camera.GroundBounds = {
  minX: 0.25,
  maxX: 2.5,
  minZ: -1.5,
  maxZ: 0.5,
};

describe("a tile layer", () => {
  it("draws one tile for each cell that touches what is seen, at the cell's centre", () => {
    const layer = TileLayer.make(sheet);
    const frameOf =
      vi.fn<(col: number, row: number) => number>(wallInColumnOne);
    TileLayer.draw(layer, NINE_CELLS, frameOf);
    expect(tiles(layer)).toStrictEqual([
      [0.5, -1.5, 0],
      [1.5, -1.5, 3],
      [2.5, -1.5, 0],
      [0.5, -0.5, 0],
      [1.5, -0.5, 3],
      [2.5, -0.5, 0],
      [0.5, 0.5, 0],
      [1.5, 0.5, 3],
      [2.5, 0.5, 0],
    ]);
    expect(layer.count).toBe(9);
    // Asked once for each of those cells, row by row.
    expect(frameOf.mock.calls).toStrictEqual([
      [0, -2],
      [1, -2],
      [2, -2],
      [0, -1],
      [1, -1],
      [2, -1],
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it("leaves out a cell that only shares an edge with what is seen", () => {
    const layer = TileLayer.make(sheet);
    // Exactly cells (0, 0) and (1, 0): the cells around them touch its edges and no ground.
    TileLayer.draw(layer, { minX: 0, maxX: 2, minZ: 0, maxZ: 1 }, () => 0);
    expect(tiles(layer)).toStrictEqual([
      [0.5, 0.5, 0],
      [1.5, 0.5, 0],
    ]);
  });

  it("draws no tile for a negative frame", () => {
    const layer = TileLayer.make(sheet);
    // Nothing in row -1, and nothing in column 1.
    TileLayer.draw(layer, NINE_CELLS, (col, row) =>
      row === -1 || col === 1 ? -1 : 2
    );
    expect(tiles(layer)).toStrictEqual([
      [0.5, -1.5, 2],
      [2.5, -1.5, 2],
      [0.5, 0.5, 2],
      [2.5, 0.5, 2],
    ]);
    expect(layer.count).toBe(4);
  });

  it("does not fill again while what is seen touches the same cells", () => {
    const layer = TileLayer.make(sheet);
    TileLayer.draw(layer, NINE_CELLS, wallInColumnOne);
    const before = tiles(layer);
    const frameOf = vi.fn<(col: number, row: number) => number>(() => 1);
    // The same rectangle, then one that has moved within the same cells.
    TileLayer.draw(layer, NINE_CELLS, frameOf);
    TileLayer.draw(
      layer,
      { minX: 0.75, maxX: 2.9, minZ: -1.1, maxZ: 0.9 },
      frameOf
    );
    // One that reaches the cells' own edges, and no further.
    TileLayer.draw(layer, { minX: 0, maxX: 3, minZ: -2, maxZ: 1 }, frameOf);
    expect(frameOf).not.toHaveBeenCalled();
    expect(tiles(layer)).toStrictEqual(before);
  });

  it("fills again when what is seen touches another cell", () => {
    const layer = TileLayer.make(sheet);
    TileLayer.draw(layer, NINE_CELLS, wallInColumnOne);
    const frameOf =
      vi.fn<(col: number, row: number) => number>(wallInColumnOne);
    // Its east edge is in column 3 now: twelve cells, each asked about again.
    TileLayer.draw(layer, { ...NINE_CELLS, maxX: 3.25 }, frameOf);
    expect(frameOf).toHaveBeenCalledTimes(12);
    expect(tiles(layer).slice(0, 4)).toStrictEqual([
      [0.5, -1.5, 0],
      [1.5, -1.5, 3],
      [2.5, -1.5, 0],
      [3.5, -1.5, 0],
    ]);
    expect(layer.count).toBe(12);
  });

  it("fills again when what is seen touches a cell fewer", () => {
    const layer = TileLayer.make(sheet);
    TileLayer.draw(layer, NINE_CELLS, wallInColumnOne);
    const frameOf =
      vi.fn<(col: number, row: number) => number>(wallInColumnOne);
    // Its north edge has left row -2: six cells.
    TileLayer.draw(layer, { ...NINE_CELLS, minZ: -1 }, frameOf);
    expect(frameOf).toHaveBeenCalledTimes(6);
    expect(layer.count).toBe(6);
    expect(tiles(layer)[0]).toStrictEqual([0.5, -0.5, 0]);
  });

  it("fills again after invalidate, with what frameOf gives now", () => {
    const layer = TileLayer.make(sheet);
    let wall = 1;
    const frameOf = vi.fn<(col: number, row: number) => number>((col) =>
      col === wall ? 3 : 0
    );
    const frames = () => DrawnSprites.read(layer).map((tile) => tile.frame);
    const row: Camera.GroundBounds = { minX: 0, maxX: 3, minZ: 0, maxZ: 1 };
    TileLayer.draw(layer, row, frameOf);
    // The game's map changed: the layer is not told, and shows what it filled.
    wall = 2;
    TileLayer.draw(layer, row, frameOf);
    expect(frameOf).toHaveBeenCalledTimes(3);
    expect(frames()).toStrictEqual([0, 3, 0]);
    TileLayer.invalidate(layer);
    TileLayer.draw(layer, row, frameOf);
    expect(frameOf).toHaveBeenCalledTimes(6);
    expect(frames()).toStrictEqual([0, 0, 3]);
    // One fill for one invalidate.
    TileLayer.draw(layer, row, frameOf);
    expect(frameOf).toHaveBeenCalledTimes(6);
  });

  it("tints every tile with its tint, white when made, from the next fill on", () => {
    const layer = TileLayer.make(sheet);
    const tints = () => DrawnSprites.read(layer).map((tile) => tile.tint);
    const row: Camera.GroundBounds = { minX: 0, maxX: 3, minZ: 0, maxZ: 1 };
    TileLayer.draw(layer, row, wallInColumnOne);
    expect(tints()).toStrictEqual([
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ]);
    // Values a 32-bit float holds exactly.
    layer.tint.setRGB(0.5, 0.25, 0.125);
    // The tiles it has filled keep the tint they were filled with.
    TileLayer.draw(layer, row, wallInColumnOne);
    expect(tints()[0]).toStrictEqual([1, 1, 1, 1]);
    TileLayer.invalidate(layer);
    TileLayer.draw(layer, row, wallInColumnOne);
    expect(tints()).toStrictEqual([
      [0.5, 0.25, 0.125, 1],
      [0.5, 0.25, 0.125, 1],
      [0.5, 0.25, 0.125, 1],
    ]);
  });

  it("draws in layer 0 at 16 pixels to a cell, or in the layer and at the size it is given", () => {
    const plain = TileLayer.make(sheet);
    const given = TileLayer.make(sheet, { unitsPerPixel: 1 / 8, layer: 2 });
    const cell: Camera.GroundBounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
    TileLayer.draw(plain, cell, () => 0);
    TileLayer.draw(given, cell, () => 0);
    expect(
      [plain, given].map((layer) => [
        DrawnSprites.read(layer)[0]?.layer,
        layer.mesh.material.uniforms["uUnitsPerPixel"]?.value,
        // Rounded to sprite pixels, as everything on one grid with the ground is.
        layer.mesh.material.uniforms["uSnapUnit"]?.value,
      ])
    ).toStrictEqual([
      [0, 1 / 16, 1 / 16],
      [2, 1 / 8, 1 / 8],
    ]);
  });

  it("grows with what is seen, and keeps its mesh", () => {
    const layer = TileLayer.make(sheet);
    const { mesh } = layer;
    // 20 by 10 cells: more than a batch starts with room for.
    TileLayer.draw(layer, { minX: -10, maxX: 10, minZ: 0, maxZ: 10 }, () => 1);
    expect(layer.count).toBe(200);
    expect(tiles(layer)).toHaveLength(200);
    expect(tiles(layer).at(-1)).toStrictEqual([9.5, 9.5, 1]);
    expect(layer.mesh).toBe(mesh);
  });

  it("draws what a pixel camera says is on screen, and fills again only when that is other cells", () => {
    const camera = PixelCamera.make({ pixelsPerUnit: 16, viewHeight: 20 });
    // 2 screen pixels per sprite pixel: 20 by 15 units of ground.
    PixelCamera.setBufferSize(camera, 640, 480);
    const layer = TileLayer.make(sheet);
    const seen = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    const frameOf = vi.fn<(col: number, row: number) => number>(() => 0);
    PixelCamera.follow(camera, 0, 0);
    TileLayer.draw(layer, PixelCamera.groundOnScreen(camera, seen), frameOf);
    // Columns -10 to 9, and rows -8 to 7: the top and the bottom rows are half on screen.
    expect([layer.count, tiles(layer)[0], tiles(layer).at(-1)]).toStrictEqual([
      20 * 16,
      [-9.5, -7.5, 0],
      [9.5, 7.5, 0],
    ]);
    // A quarter of a cell down: the same cells.
    PixelCamera.follow(camera, 0, 0.25);
    TileLayer.draw(layer, PixelCamera.groundOnScreen(camera, seen), frameOf);
    expect(frameOf).toHaveBeenCalledTimes(320);
    // A quarter of a cell to the east: column 10 has come on screen.
    PixelCamera.follow(camera, 0.25, 0.25);
    TileLayer.draw(layer, PixelCamera.groundOnScreen(camera, seen), frameOf);
    expect(frameOf).toHaveBeenCalledTimes(320 + 21 * 16);
    expect(layer.count).toBe(21 * 16);
  });

  it("frees what it made on dispose, never the sheet", () => {
    const layer = TileLayer.make(sheet);
    TileLayer.draw(layer, NINE_CELLS, wallInColumnOne);
    const freed = [
      vi.spyOn(layer.mesh.geometry, "dispose"),
      vi.spyOn(layer.mesh.material, "dispose"),
    ];
    const sheetFreed = vi.spyOn(sheet.texture, "dispose");
    const removed = vi.spyOn(layer.mesh, "removeFromParent");
    TileLayer.dispose(layer);
    expect({
      freed: freed.map((spy) => spy.mock.calls.length),
      sheet: sheetFreed.mock.calls.length,
      removed: removed.mock.calls.length,
    }).toStrictEqual({ freed: [1, 1], sheet: 0, removed: 1 });
    sheetFreed.mockRestore();
  });
});
