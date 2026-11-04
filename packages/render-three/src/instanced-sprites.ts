import * as THREE from "three";

import type { SpriteSheet } from "./sprite-loader";
import type { SpriteSheetData } from "./sprite-sheet";

/** Frames per row of the frame table texture; each frame takes 2 texels in a column. */
const TABLE_COLUMNS = 256;

/** How far a layer's depth band reaches either side of its middle. Bands are 1 apart. */
const BAND = 0.45;

const VERTEX = `
// x, z, lift, layer
attribute vec4 aPlace;
// frame, flipX, flash
attribute vec3 aFrame;
// r, g, b, alpha
attribute vec4 aTint;
uniform sampler2D uFrames;
uniform vec2 uSheetSize;
uniform vec2 uAnchor;
uniform float uUnitsPerPixel;
uniform float uSnap;
uniform float uLayer;
uniform float uDepthScale;
varying vec2 vUv;
varying vec4 vTint;
varying float vFlash;

ivec2 tableCell(int frame, int row) {
  return ivec2(frame % ${TABLE_COLUMNS}, (frame / ${TABLE_COLUMNS}) * 2 + row);
}

void main() {
  int frame = int(aFrame.x + 0.5);
  // x, y, width, height in the image
  vec4 rect = texelFetch(uFrames, tableCell(frame, 0), 0);
  // offset x, y in the untrimmed frame; its width, height
  vec4 source = texelFetch(uFrames, tableCell(frame, 1), 0);
  // uv.y is 1 at the top of the quad; pixel rows count down from the top.
  vec2 corner = vec2(uv.x, 1.0 - uv.y);
  vec2 pixel = source.xy + corner * rect.zw;
  if (aFrame.y > 0.5) {
    pixel.x = source.z - pixel.x;
  }
  vec2 anchor = floor(uAnchor * source.zw + 0.5);
  vec2 local = (pixel - anchor) * uUnitsPerPixel;
  // Up the screen is -z, so a lifted sprite moves toward -z; its depth stays at its feet.
  vec2 base = vec2(aPlace.x, aPlace.y - aPlace.z);
  if (uSnap > 0.5) {
    base = floor(base / uUnitsPerPixel + 0.5) * uUnitsPerPixel;
  }
  float depth = uLayer + aPlace.w + 0.5 + clamp(aPlace.y * uDepthScale, -${BAND}, ${BAND});
  vUv = (rect.xy + corner * rect.zw) / uSheetSize;
  vTint = aTint;
  vFlash = aFrame.z;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(base.x + local.x, depth, base.y + local.y, 1.0);
}`;

const FRAGMENT = `
uniform sampler2D uMap;
uniform float uAlphaTest;
uniform float uBlend;
varying vec2 vUv;
varying vec4 vTint;
varying float vFlash;

void main() {
  vec4 texel = texture2D(uMap, vUv);
  float alpha = texel.a * vTint.a;
  if (alpha < uAlphaTest) discard;
  vec3 color = mix(texel.rgb * vTint.rgb, vec3(1.0), vFlash);
  gl_FragColor = vec4(color, uBlend > 0.5 ? alpha : 1.0);
  #include <colorspace_fragment>
}`;

export interface InstancedSpritesOptions {
  /** The most sprites it can draw at once. Fixed. */
  readonly capacity: number;
  /** World units per sprite pixel: 1/16 draws a 16 px sprite one unit wide. Defaults to 1/16. */
  readonly unitsPerPixel?: number;
  /**
   * The point of a frame a sprite's position marks, as a fraction of the frame's untrimmed size
   * from its top-left corner, rounded to a whole pixel. Defaults to the middle, (0.5, 0.5); a
   * character standing on its feet wants about (0.5, 0.9).
   */
  readonly anchor?: { readonly x: number; readonly y: number };
  /**
   * Layer added to every sprite's own layer. A higher layer draws over a lower one whatever
   * their positions: ground marks below characters, characters below projectiles. Use whole
   * numbers; layer 0 and up draw above anything at y = 0, such as a ground mesh. Defaults to 0.
   */
  readonly layer?: number;
  /**
   * Blend partly transparent pixels, for soft shadows and markers. Off by default: pixel art
   * draws opaque, with pixels below `alphaTest` cut out, and sorts by depth. A transparent batch
   * doesn't write depth, so its own sprites overlap in index order.
   */
  readonly transparent?: boolean;
  /** Pixels with less alpha (after the sprite's own alpha) aren't drawn. Defaults to 0.5, or 0.01 when transparent. */
  readonly alphaTest?: number;
  /** Rounds each sprite's position to whole sprite pixels, so the art never shimmers. Defaults to true. */
  readonly snap?: boolean;
  /**
   * How far from z = 0, in world units, depth still orders sprites within a layer: beyond it,
   * sprites tie. Defaults to 256.
   */
  readonly sortRange?: number;
}

/**
 * Draws up to `capacity` sprites from one sheet in a single draw call, as quads on the ground
 * plane facing a straight-down camera (`PixelCamera`). Each sprite has a position, a frame,
 * a horizontal flip, a tint, a flash toward white, an alpha, a lift and a layer. Within a layer
 * a sprite lower on screen (larger z) draws in front.
 *
 * Each frame, call `set` for every sprite to draw (it resets that sprite's look), then the
 * other setters for those that need them, then `commit(count)`. Nothing allocates per frame.
 * Add `mesh` to the scene. `dispose` (or `disposeObject`) frees its own geometry, material and
 * frame table, never the sheet's texture: the sheet's owner frees that.
 */
export class InstancedSprites {
  readonly mesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  readonly capacity: number;
  readonly sheet: SpriteSheet;
  private readonly frameCount: number;
  private readonly place: THREE.InstancedBufferAttribute;
  private readonly frame: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  private readonly frameTable: THREE.DataTexture;

  constructor(sheet: SpriteSheet, options: InstancedSpritesOptions) {
    this.sheet = sheet;
    this.capacity = options.capacity;
    this.frameCount = sheet.data.frames.length;
    const transparent = options.transparent ?? false;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute("position", quad.getAttribute("position"));
    geometry.setAttribute("uv", quad.getAttribute("uv"));
    quad.dispose();
    this.place = dynamicAttribute(geometry, "aPlace", this.capacity, 4);
    this.frame = dynamicAttribute(geometry, "aFrame", this.capacity, 3);
    this.tint = dynamicAttribute(geometry, "aTint", this.capacity, 4);
    geometry.instanceCount = 0;

    this.frameTable = frameTable(sheet.data);
    const anchor = options.anchor ?? { x: 0.5, y: 0.5 };
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uMap: { value: sheet.texture },
        uFrames: { value: this.frameTable },
        uSheetSize: {
          value: new THREE.Vector2(sheet.data.width, sheet.data.height),
        },
        uAnchor: { value: new THREE.Vector2(anchor.x, anchor.y) },
        uUnitsPerPixel: { value: options.unitsPerPixel ?? 1 / 16 },
        uSnap: { value: (options.snap ?? true) ? 1 : 0 },
        uLayer: { value: options.layer ?? 0 },
        uDepthScale: { value: BAND / (options.sortRange ?? 256) },
        uAlphaTest: {
          value: options.alphaTest ?? (transparent ? 0.01 : 0.5),
        },
        uBlend: { value: transparent ? 1 : 0 },
      },
      transparent,
      depthWrite: !transparent,
      // A flipped sprite mirrors its quad, which turns it face down.
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    // Sprites can be anywhere, so the quad's bounds mean nothing: never cull.
    this.mesh.frustumCulled = false;
  }

  /**
   * Places sprite `index` with its feet (its anchor) at (x, z) on the ground, showing frame
   * `frame` (an index into `sheet.data.frames`, as `frameAt` gives), mirrored if `flipX`.
   * Resets its tint, alpha, flash, lift and layer. A frame outside the sheet draws frame 0.
   */
  set(index: number, x: number, z: number, frame: number, flipX = false): void {
    const shown = frame >= 0 && frame < this.frameCount ? frame : 0;
    write4(this.place, index, x, z, 0, 0);
    write3(this.frame, index, shown, flipX ? 1 : 0, 0);
    write4(this.tint, index, 1, 1, 1, 1);
  }

  /** Multiplies sprite `index`'s colors by `color` (white leaves them), and sets its alpha. */
  setTint(index: number, color: THREE.Color, alpha = 1): void {
    write4(this.tint, index, color.r, color.g, color.b, alpha);
  }

  /** Sets sprite `index`'s alpha (0 to 1) and keeps its tint. Opaque sprites hide below `alphaTest`. */
  setAlpha(index: number, alpha: number): void {
    (this.tint.array as Float32Array)[index * 4 + 3] = alpha;
  }

  /** Blends sprite `index` toward white: 0 is its own colors, 1 a white silhouette. A hit flash. */
  setFlash(index: number, amount: number): void {
    (this.frame.array as Float32Array)[index * 3 + 2] = amount;
  }

  /**
   * Draws sprite `index` `lift` world units up the screen, as if floating: a bat. Its depth
   * stays where its feet are, so it sorts with the things standing near it.
   */
  setLift(index: number, lift: number): void {
    (this.place.array as Float32Array)[index * 4 + 2] = lift;
  }

  /** Puts sprite `index` in another layer, added to the batch's own. See `InstancedSpritesOptions.layer`. */
  setLayer(index: number, layer: number): void {
    (this.place.array as Float32Array)[index * 4 + 3] = layer;
  }

  /** Shows the first `count` sprites and uploads them. */
  commit(count: number): void {
    const shown = Math.max(0, Math.min(count, this.capacity));
    this.mesh.geometry.instanceCount = shown;
    for (const attribute of [this.place, this.frame, this.tint]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, Math.max(1, shown) * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  /** Removes the mesh and frees its geometry, material and frame table. Never the sheet. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.frameTable.dispose();
  }
}

const dynamicAttribute = (
  geometry: THREE.InstancedBufferGeometry,
  name: string,
  capacity: number,
  size: number
): THREE.InstancedBufferAttribute => {
  const attribute = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, capacity) * size),
    size
  );
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, attribute);
  return attribute;
};

const write4 = (
  attribute: THREE.InstancedBufferAttribute,
  index: number,
  a: number,
  b: number,
  c: number,
  d: number
) => {
  const array = attribute.array as Float32Array;
  const at = index * 4;
  array[at] = a;
  array[at + 1] = b;
  array[at + 2] = c;
  array[at + 3] = d;
};

const write3 = (
  attribute: THREE.InstancedBufferAttribute,
  index: number,
  a: number,
  b: number,
  c: number
) => {
  const array = attribute.array as Float32Array;
  const at = index * 3;
  array[at] = a;
  array[at + 1] = b;
  array[at + 2] = c;
};

/**
 * The frame table the vertex shader reads: frame i at column i % TABLE_COLUMNS, rows
 * 2 * floor(i / TABLE_COLUMNS) (its rect in the image) and the row after (its offset in the
 * untrimmed frame, and that frame's size).
 */
const frameTableData = (
  sheet: SpriteSheetData
): {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
} => {
  const count = sheet.frames.length;
  const width = Math.min(Math.max(1, count), TABLE_COLUMNS);
  const height = 2 * Math.max(1, Math.ceil(count / TABLE_COLUMNS));
  const data = new Float32Array(width * height * 4);
  for (const [index, frame] of sheet.frames.entries()) {
    const column = index % TABLE_COLUMNS;
    const row = 2 * Math.floor(index / TABLE_COLUMNS);
    data.set(
      [frame.x, frame.y, frame.width, frame.height],
      (row * width + column) * 4
    );
    data.set(
      [frame.offsetX, frame.offsetY, frame.sourceWidth, frame.sourceHeight],
      ((row + 1) * width + column) * 4
    );
  }
  return { data, width, height };
};

const frameTable = (sheet: SpriteSheetData): THREE.DataTexture => {
  const { data, width, height } = frameTableData(sheet);
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  texture.needsUpdate = true;
  return texture;
};
