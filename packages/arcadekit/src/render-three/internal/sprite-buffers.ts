// What a batch of sprites keeps in its buffers, and how it is read back. The batch writes them
// (instanced-sprites.ts) and arcadekit/render-three/testing reads them (`DrawnSprites.read`), so
// that no test knows the buffers' names or layout; no public file exports it.

import * as THREE from "three";

import type * as InstancedSprites from "../instanced-sprites";
import type * as TileLayer from "../tile-layer";

// The per-sprite attributes, by the names the vertex shader reads them under.
export const PLACE = "aPlace";
export const FRAME = "aFrame";
export const TINT = "aTint";

/** One of a sprite geometry's own attributes, which `spriteGeometry` made over a Float32Array. */
export const attributeOf = (
  geometry: THREE.InstancedBufferGeometry,
  name: string
): THREE.InstancedBufferAttribute & { readonly array: Float32Array } =>
  geometry.getAttribute(name) as THREE.InstancedBufferAttribute & {
    readonly array: Float32Array;
  };

const dynamicAttribute = (
  geometry: THREE.InstancedBufferGeometry,
  name: string,
  capacity: number,
  size: number
): void => {
  const attribute = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * size),
    size
  );
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, attribute);
};

/** A quad with room for `capacity` sprites, every one of them zero, and none shown. */
export const spriteGeometry = (
  capacity: number
): THREE.InstancedBufferGeometry => {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("uv", quad.getAttribute("uv"));
  quad.dispose();
  // x, z, lift, layer
  dynamicAttribute(geometry, PLACE, capacity, 4);
  // frame, flipX, flash
  dynamicAttribute(geometry, FRAME, capacity, 3);
  // r, g, b, alpha
  dynamicAttribute(geometry, TINT, capacity, 4);
  geometry.instanceCount = 0;
  return geometry;
};

/** One sprite as a batch's buffers hold it: what was pushed and set, in 32-bit floats. */
export interface SpriteValues {
  readonly x: number;
  readonly z: number;
  readonly frame: number;
  readonly flipX: boolean;
  readonly tint: readonly [number, number, number, number];
  readonly flash: number;
  readonly lift: number;
  /** The layer it draws in: the batch's plus its own. */
  readonly layer: number;
}

/**
 * Every sprite a batch shows since its last `end`, in the order pushed, read back from the
 * buffers its shader reads: positions as pushed, before the shader rounds them. Read it after
 * an `end` and before the next `push`, which writes over them. It allocates: not for a frame.
 */
export const readSprites = (
  batch: InstancedSprites.InstancedSprites
): SpriteValues[] => {
  const { geometry, material } = batch.mesh;
  const place = attributeOf(geometry, PLACE).array;
  const frame = attributeOf(geometry, FRAME).array;
  const tint = attributeOf(geometry, TINT).array;
  const layer = material.uniforms["uLayer"]?.value as number;
  return Array.from({ length: geometry.instanceCount }, (_, i) => ({
    x: place[i * 4]!,
    z: place[i * 4 + 1]!,
    frame: frame[i * 3]!,
    flipX: frame[i * 3 + 1]! > 0.5,
    tint: [tint[i * 4]!, tint[i * 4 + 1]!, tint[i * 4 + 2]!, tint[i * 4 + 3]!],
    flash: frame[i * 3 + 2]!,
    lift: place[i * 4 + 2]!,
    layer: layer + place[i * 4 + 3]!,
  }));
};

// The batch each tile layer fills. A layer shows its mesh and keeps its batch to itself: nothing
// else pushes into it, and only a test reads it back.
const layerBatches = new WeakMap<
  TileLayer.TileLayer,
  InstancedSprites.InstancedSprites
>();

/** Says which batch a tile layer fills, for `layerBatch`. */
export const setLayerBatch = (
  layer: TileLayer.TileLayer,
  batch: InstancedSprites.InstancedSprites
): void => {
  layerBatches.set(layer, batch);
};

/** The batch a tile layer fills. */
export const layerBatch = (
  layer: TileLayer.TileLayer
): InstancedSprites.InstancedSprites => layerBatches.get(layer)!;
