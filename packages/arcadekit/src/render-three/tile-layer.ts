// A floor of tiles as a view draws one: the cells on screen, from a function that says which
// frame each shows. It knows no tile map: the game's view reads its own, or works a cell's
// frame out from the cell alone. Plain code, and nothing is allocated in a frame.

import * as THREE from "three";

import type { GroundBounds } from "./camera";
import { InstancedSprites } from "./instanced-sprites";
import type { SpriteSheet } from "./sprite-loader";

export interface TileLayerOptions {
  /** As `InstancedSprites` takes it. Defaults to 1/16: a 16 px frame fills a cell. */
  readonly unitsPerPixel?: number;
  /** As `InstancedSprites` takes it. Defaults to 0. */
  readonly layer?: number;
}

// The batch each layer fills, for `layerSprites`. A layer shows its mesh and keeps its batch to
// itself: nothing else pushes into it.
const BATCHES = new WeakMap<TileLayer, InstancedSprites>();

/**
 * A grid of cells drawn from a sheet's frames in one draw call, only the cells on screen.
 * Cell (col, row) is the square of ground from (col, row) to (col + 1, row + 1).
 *
 * Each frame a view gives `draw` the rectangle of ground its camera shows and a function of
 * the cell. The layer fills a batch of its own, which grows with the window, and fills it
 * again only when an edge of the rectangle crosses into another cell, so a camera whose edges
 * stay within the same cells costs nothing. A view keeps the function as a field: an arrow
 * written in the call is a closure each frame.
 *
 * ```ts
 * // Made once: which frame each cell of the game's tile map shows, or -1 for none.
 * private readonly frameOf = (col: number, row: number): number => {
 *   const cell = this.map.cellAt(col, row);
 *   return cell === -1 ? -1 : this.frames[this.map.fields.tile[cell]!]!;
 * };
 *
 * // Each frame, once the camera is placed:
 * camera.follow(hero.x, hero.z);
 * this.ground.draw(camera.groundOnScreen(this.seen), this.frameOf);
 * ```
 *
 * Add `mesh` to the scene. `dispose` (or `disposeObject`) frees what the layer made, never the
 * sheet's texture: the sheet's owner frees that.
 */
export class TileLayer {
  /** Add it to the scene. */
  readonly mesh: InstancedSprites["mesh"];
  /** Multiplies every tile's colours. White when made; `invalidate` after changing it. */
  readonly tint: THREE.Color = new THREE.Color(1, 1, 1);
  private readonly sprites: InstancedSprites;
  /** Whether the next `draw` fills whatever it is shown: until the first fill, and after `invalidate`. */
  private stale = true;
  // The cells of the last fill: columns `left` up to `right` and rows `top` up to `bottom`,
  // the last of each left out.
  private left = 0;
  private right = 0;
  private top = 0;
  private bottom = 0;

  constructor(sheet: SpriteSheet, options: TileLayerOptions = {}) {
    this.sprites = new InstancedSprites(sheet, {
      unitsPerPixel: options.unitsPerPixel ?? 1 / 16,
      layer: options.layer ?? 0,
    });
    this.mesh = this.sprites.mesh;
    BATCHES.set(this, this.sprites);
  }

  /** Tiles the last fill drew. */
  get count(): number {
    return this.sprites.count;
  }

  /**
   * Shows the cells that touch `seen`. A fill asks `frameOf` for each cell's frame, an index
   * as `frameAt` gives, and leaves a cell empty for a negative one. It fills only when `seen`
   * touches other cells than at the last fill, or after `invalidate`.
   *
   * A cell touches `seen` when they share ground, not an edge alone, and a tile is drawn at
   * its cell's centre. Cells are asked about row by row, each row from its lowest column.
   */
  draw(
    seen: GroundBounds,
    frameOf: (col: number, row: number) => number
  ): void {
    const left = Math.floor(seen.minX);
    const right = Math.ceil(seen.maxX);
    const top = Math.floor(seen.minZ);
    const bottom = Math.ceil(seen.maxZ);
    if (
      !this.stale &&
      left === this.left &&
      right === this.right &&
      top === this.top &&
      bottom === this.bottom
    ) {
      return;
    }
    this.stale = false;
    this.left = left;
    this.right = right;
    this.top = top;
    this.bottom = bottom;
    const { sprites, tint } = this;
    sprites.begin();
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) {
        const frame = frameOf(col, row);
        if (frame >= 0) {
          sprites.setTint(sprites.push(col + 0.5, row + 0.5, frame), tint);
        }
      }
    }
    sprites.end();
  }

  /**
   * Makes the next `draw` fill again: what `frameOf` gives has changed, or `tint` has. The
   * layer sees neither, nor that `draw` is handed another function.
   */
  invalidate(): void {
    this.stale = true;
  }

  /** Removes the mesh and frees what the layer made. Never the sheet. */
  dispose(): void {
    this.sprites.dispose();
  }
}

/**
 * The batch a layer fills. It is for `drawnSprites` in arcadekit/render-three/testing, so that
 * a test reads a layer's tiles as it reads a batch's sprites, and the entry's public file
 * doesn't export it.
 */
export const layerSprites = (layer: TileLayer): InstancedSprites =>
  BATCHES.get(layer)!;
