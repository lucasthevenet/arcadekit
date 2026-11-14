/**
 * Tile layers: a grid of cells drawn from a sprite sheet's frames in one draw call, only the
 * cells on screen.
 *
 * A layer belongs to the view: each frame the view gives it the rectangle of ground its camera
 * shows and a function that says which frame a cell shows. It knows no tile map: a game's view
 * reads its own, or works a cell's frame out from the cell alone. Its functions are plain calls,
 * made inside the frame the browser shows, and once its batch has grown to the
 * window, a frame allocates nothing.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";
import * as THREE from "three";

import type { GroundBounds } from "./camera";
import * as InstancedSprites from "./instanced-sprites";
import { setLayerBatch } from "./internal/sprite-buffers";
import type * as SpriteSheet from "./sprite-sheet";

const TypeId = "~arcadekit/render-three/TileLayer";

/**
 * What a tile layer is made with: a batch's pixel density and layer.
 *
 * **When to use**
 *
 * To make a tile layer with `make`, for a sheet whose tiles are not 16 px to a cell, or a
 * layer of tiles over another.
 *
 * **Details**
 *
 * `unitsPerPixel` is 1/16 unless told, so a 16 px frame fills a cell; `layer` is 0 unless
 * told. A layer rounds to sprite pixels, as the ground of every other batch does.
 *
 * **Example** (Tiles of 32 px, one to a cell)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const options: TileLayer.Options = { unitsPerPixel: 1 / 32, layer: 0 };
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ grass: 1 }), options);
 * ground.count; // => 0
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
  /** As a batch of sprites takes it. Defaults to 1/16: a 16 px frame fills a cell. */
  readonly unitsPerPixel?: number;
  /** As a batch of sprites takes it. Defaults to 0. */
  readonly layer?: number;
}

/**
 * A grid of cells drawn from a sheet's frames in one draw call, only the cells on screen. Cell
 * (col, row) is the square of ground from (col, row) to (col + 1, row + 1), and its tile is
 * drawn at its centre.
 *
 * **When to use**
 *
 * For a floor of tiles under a pixel camera: a level's walls and floor, or an arena's grass.
 * What is no cell, such as a patch three cells wide, goes in a batch of sprites of its own.
 *
 * **Details**
 *
 * Add `mesh` to the scene. `tint` multiplies every tile's colours (white when made), and shows
 * from the next fill. `count` is the tiles the last fill drew. `dispose` (or
 * `Stage.disposeObject`) frees what the layer made, never the sheet's texture: the sheet's
 * owner frees that.
 *
 * **Example** (A wall and a floor in a row)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * // Frame 0 is the wall and frame 1 the floor.
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ wall: 1, floor: 1 }));
 * const frameOf = (col: number): number => (col === 0 ? 0 : 1);
 * TileLayer.draw(ground, { minX: 0, maxX: 3, minZ: 0, maxZ: 1 }, frameOf);
 * ground.count; // => 3
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface TileLayer extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** Add it to the scene. */
  readonly mesh: InstancedSprites.InstancedSprites["mesh"];
  /** Multiplies every tile's colours. White when made; invalidate after changing it. */
  readonly tint: THREE.Color;
  /** Tiles the last fill drew. */
  readonly count: number;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<TileLayer> & {
  readonly sprites: InstancedSprites.InstancedSprites;
  /** Whether the next `draw` fills whatever it is shown: until the first fill, and after `invalidate`. */
  stale: boolean;
  // The cells of the last fill: columns `left` up to `right` and rows `top` up to `bottom`,
  // the last of each left out.
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "TileLayer",
      sheet: this.sprites.sheet.data.image,
      count: this.count,
      cells: [this.left, this.right, this.top, this.bottom],
    };
  },
};

/**
 * Checks whether a value is a tile layer.
 *
 * **When to use**
 *
 * Narrow an unknown value before drawing it.
 *
 * **Example** (Recognising a tile layer)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ grass: 1 }));
 * TileLayer.isTileLayer(ground); // => true
 * TileLayer.isTileLayer(ground.mesh); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isTileLayer = (value: unknown): value is TileLayer =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a tile layer that draws from a sheet, with no tile yet.
 *
 * **When to use**
 *
 * When a view is made, once for each grid of tiles it draws.
 *
 * **Details**
 *
 * Its batch starts with room for 64 tiles and grows with the window.
 *
 * **Example** (A floor under everything else)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 * import * as THREE from "three";
 *
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ floor: 3 }));
 * const scene = new THREE.Scene();
 * scene.add(ground.mesh);
 * [scene.children.length, ground.tint.getHexString()]; // => [1, "ffffff"]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (
  sheet: SpriteSheet.SpriteSheet,
  options: Options = {}
): TileLayer => {
  const self = Object.create(Proto) as Types.Mutable<Internal>;
  self.sprites = InstancedSprites.make(sheet, {
    unitsPerPixel: options.unitsPerPixel ?? 1 / 16,
    layer: options.layer ?? 0,
  });
  self.mesh = self.sprites.mesh;
  self.tint = new THREE.Color(1, 1, 1);
  self.count = 0;
  self.stale = true;
  self.left = 0;
  self.right = 0;
  self.top = 0;
  self.bottom = 0;
  setLayerBatch(self, self.sprites);
  return self;
};

/**
 * Shows the cells that touch `seen`, the rectangle of ground the camera shows, each with the
 * frame `frameOf` gives it.
 *
 * **When to use**
 *
 * Each frame, after the camera is placed, with `PixelCamera.groundOnScreen`'s rectangle and a
 * function the view keeps as a field: an arrow written in the call is a closure each frame.
 *
 * **Details**
 *
 * A fill asks `frameOf` for each cell's frame, an index as `SpriteSheet.frameAt` gives, and
 * leaves a cell empty for a negative one. It fills only when `seen` touches other cells than at
 * the last fill, or after `invalidate`, so a camera whose edges stay within the same cells costs
 * nothing. A cell touches `seen` when they share ground, not an edge alone. Cells are asked
 * about row by row, each row from its lowest column.
 *
 * **Example** (A camera that moves within the same cells)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ grass: 1 }));
 * let asked = 0;
 * const frameOf = (): number => {
 *   asked += 1;
 *   return 0;
 * };
 * TileLayer.draw(ground, { minX: 0.5, maxX: 2.5, minZ: 0, maxZ: 1 }, frameOf);
 * ground.pipe(TileLayer.draw({ minX: 0.75, maxX: 2.75, minZ: 0, maxZ: 1 }, frameOf));
 * // Columns 0 to 2 both times: one fill, of three cells.
 * [asked, ground.count]; // => [3, 3]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const draw: {
  (
    seen: GroundBounds,
    frameOf: (col: number, row: number) => number
  ): (self: TileLayer) => void;
  (
    self: TileLayer,
    seen: GroundBounds,
    frameOf: (col: number, row: number) => number
  ): void;
} = dual(
  3,
  (
    self: TileLayer,
    seen: GroundBounds,
    frameOf: (col: number, row: number) => number
  ): void => {
    const layer = self as Internal;
    const left = Math.floor(seen.minX);
    const right = Math.ceil(seen.maxX);
    const top = Math.floor(seen.minZ);
    const bottom = Math.ceil(seen.maxZ);
    if (
      !layer.stale &&
      left === layer.left &&
      right === layer.right &&
      top === layer.top &&
      bottom === layer.bottom
    ) {
      return;
    }
    layer.stale = false;
    layer.left = left;
    layer.right = right;
    layer.top = top;
    layer.bottom = bottom;
    const { sprites, tint } = layer;
    InstancedSprites.begin(sprites);
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) {
        const frame = frameOf(col, row);
        if (frame >= 0) {
          InstancedSprites.setTint(
            sprites,
            InstancedSprites.push(sprites, col + 0.5, row + 0.5, frame),
            tint
          );
        }
      }
    }
    InstancedSprites.end(sprites);
    layer.count = sprites.count;
  }
);

/**
 * Makes the next `draw` fill again, whatever it is shown.
 *
 * **When to use**
 *
 * When what `frameOf` gives has changed, or `tint` has: another level, a tile the rules
 * changed, an animated tile's next frame, or another function handed to `draw`. The layer sees
 * none of them. A board small enough to fill on every frame invalidates before each `draw`.
 *
 * **Example** (Another level on the same cells)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ floor: 1 }));
 * const seen = { minX: 0, maxX: 2, minZ: 0, maxZ: 1 };
 * TileLayer.draw(ground, seen, () => 0);
 * // Without the invalidate, the same cells would keep their last fill.
 * TileLayer.invalidate(ground);
 * TileLayer.draw(ground, seen, (col) => (col === 0 ? 0 : -1));
 * ground.count; // => 1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const invalidate = (self: TileLayer): void => {
  (self as Internal).stale = true;
};

/**
 * Removes the layer's mesh from its parent and frees what the layer made. Never the sheet.
 *
 * **When to use**
 *
 * In the view's `dispose`, for a layer it takes out of the scene. `Stage.dispose` frees the
 * layers still in the scene with the rest of it.
 *
 * **Example** (Freeing a layer)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ floor: 1 }));
 * let freed = 0;
 * ground.mesh.material.addEventListener("dispose", () => {
 *   freed += 1;
 * });
 * TileLayer.dispose(ground);
 * freed; // => 1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const dispose = (self: TileLayer): void => {
  InstancedSprites.dispose((self as Internal).sprites);
};
