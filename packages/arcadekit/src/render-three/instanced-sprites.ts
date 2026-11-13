import * as THREE from "three";

import { PixelCamera } from "./pixel-camera";
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
// World units a position is rounded to: a sprite pixel, a screen pixel, or 0 for no rounding.
uniform float uSnapUnit;
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
  if (uSnapUnit > 0.0) {
    base = floor(base / uSnapUnit + 0.5) * uSnapUnit;
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

/**
 * What a batch rounds each sprite's position to: whole sprite pixels, whole screen pixels of
 * the `PixelCamera` that draws it, or nothing.
 */
export type SpriteSnap = "sprite" | "screen" | "none";

/** Room for this many sprites, when a batch is given no `capacity`. */
const DEFAULT_CAPACITY = 64;

export interface InstancedSpritesOptions {
  /**
   * Room for this many sprites when made. A frame that pushes more doubles it. Defaults to 64;
   * a fraction is rounded up, and less than 1 is 1.
   */
  readonly capacity?: number;
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
  /**
   * Rounds a sprite's position to whole sprite pixels (the default), to whole screen pixels, or
   * not. `"sprite"` keeps every sprite on one grid with the ground, so the art never shimmers.
   * `"screen"` is for what slides between two cells: a screen pixel is finer than a sprite pixel
   * at any pixel scale above 1, and a batch drawn by a camera that is no `PixelCamera` rounds to
   * sprite pixels. `"none"` leaves positions as pushed.
   */
  readonly snap?: SpriteSnap;
  /**
   * How far from z = 0, in world units, depth still orders sprites within a layer: beyond it,
   * sprites tie. Defaults to 256.
   */
  readonly sortRange?: number;
}

/**
 * Draws sprites from one sheet in a single draw call, as quads on the ground plane facing a
 * straight-down camera (`PixelCamera`). Each sprite has a position, a frame, a horizontal flip,
 * a tint, a flash toward white, an alpha, a lift and a layer. Within a layer a sprite lower on
 * screen (larger z) draws in front.
 *
 * Each frame, call `begin`, then `push` for every sprite to draw (it gives the sprite's index
 * and resets its look) and the other setters for those that need them, then `end`. A batch
 * filled once keeps showing its last `end`. It has room for `capacity` sprites and doubles it
 * when a frame pushes more. Once it has its size a frame allocates no buffer: `push` and the
 * setters write into the ones it has, and `end` costs the three small records Three.js keeps
 * of what to upload.
 *
 * ```ts
 * enemies.begin();
 * for (let i = 0; i < world.enemies.count; i++) {
 *   const sprite = enemies.push(x[i]!, z[i]!, frameAt(sheet.data, tags.slime, time));
 *   enemies.setFlash(sprite, hit[i]! > 0 ? 1 : 0);
 * }
 * enemies.end();
 * ```
 *
 * Add `mesh` to the scene. `dispose` (or `disposeObject`) frees its own geometry, material and
 * frame table, never the sheet's texture: the sheet's owner frees that.
 *
 * Throws a `RangeError` when made with a `capacity` that is no finite number.
 */
export class InstancedSprites {
  /** The same mesh and material for the batch's life. Its geometry is replaced when it grows. */
  readonly mesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  readonly sheet: SpriteSheet;
  /** What it rounds each sprite's position to, as it was made. */
  readonly snap: SpriteSnap;
  private readonly frameCount: number;
  private readonly frameTable: THREE.DataTexture;
  private room: number;
  private pushed = 0;
  private place: THREE.InstancedBufferAttribute;
  private frame: THREE.InstancedBufferAttribute;
  private tint: THREE.InstancedBufferAttribute;

  constructor(sheet: SpriteSheet, options: InstancedSpritesOptions = {}) {
    this.sheet = sheet;
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    // NaN would make buffers with no room that never grow, and every sprite pushed would be lost.
    if (!Number.isFinite(capacity)) {
      throw new RangeError(
        `InstancedSprites: a capacity of ${String(capacity)} is no number of sprites: give the batch a whole number to start with, or leave it out for ${DEFAULT_CAPACITY}`
      );
    }
    // At least one, so that doubling it makes room.
    this.room = Math.max(1, Math.ceil(capacity));
    this.frameCount = sheet.data.frames.length;
    const transparent = options.transparent ?? false;
    const unitsPerPixel = options.unitsPerPixel ?? 1 / 16;
    const snap = options.snap ?? "sprite";
    this.snap = snap;

    const geometry = spriteGeometry(this.room);
    this.place = attributeOf(geometry, PLACE);
    this.frame = attributeOf(geometry, FRAME);
    this.tint = attributeOf(geometry, TINT);

    this.frameTable = frameTable(sheet.data);
    const anchor = options.anchor ?? { x: 0.5, y: 0.5 };
    const snapUnit = { value: snap === "none" ? 0 : unitsPerPixel };
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
        uUnitsPerPixel: { value: unitsPerPixel },
        uSnapUnit: snapUnit,
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
    if (snap === "screen") {
      // A screen pixel's size is the camera's to say, and a batch may be drawn by more than
      // one. Three.js calls this with the camera about to draw the mesh, and uploads a
      // ShaderMaterial's uniforms for that draw when `uniformsNeedUpdate` is set.
      this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
        const unit =
          camera instanceof PixelCamera
            ? 1 / camera.screenPixelsPerUnit
            : unitsPerPixel;
        if (snapUnit.value !== unit) {
          snapUnit.value = unit;
          material.uniformsNeedUpdate = true;
        }
      };
    }
  }

  /** How many sprites it has room for now. A `push` past it doubles it. */
  get capacity(): number {
    return this.room;
  }

  /** Sprites pushed since `begin`. */
  get count(): number {
    return this.pushed;
  }

  /**
   * Starts a frame's sprites over: the next `push` is sprite 0. The batch goes on showing as
   * many sprites as its last `end` did until the next one, and each `push` writes over one of
   * them: render after `end`, not between the two.
   */
  begin(): void {
    this.pushed = 0;
  }

  /**
   * Adds a sprite with its feet (its anchor) at (x, z) on the ground, showing frame `frame`
   * (an index into `sheet.data.frames`, as `frameAt` gives), mirrored if `flipX`, and returns
   * its index for the other setters. Its tint, alpha, flash, lift and layer start plain. A
   * frame outside the sheet draws frame 0.
   */
  push(x: number, z: number, frame: number, flipX = false): number {
    const index = this.pushed;
    if (index === this.room) {
      this.grow();
    }
    this.pushed = index + 1;
    const shown = frame >= 0 && frame < this.frameCount ? frame : 0;
    write4(this.place, index, x, z, 0, 0);
    write3(this.frame, index, shown, flipX ? 1 : 0, 0);
    write4(this.tint, index, 1, 1, 1, 1);
    return index;
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

  /** Shows the sprites pushed since `begin` and uploads them. */
  end(): void {
    const shown = this.pushed;
    this.mesh.geometry.instanceCount = shown;
    upload(this.place, shown);
    upload(this.frame, shown);
    upload(this.tint, shown);
  }

  /** Removes the mesh and frees its geometry, material and frame table. Never the sheet. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.frameTable.dispose();
  }

  /**
   * Doubles the room: a new geometry that holds what the old one did, which is then freed. The
   * mesh and its material stay, so the scene and the shader are untouched.
   */
  private grow(): void {
    const old = this.mesh.geometry;
    const geometry = spriteGeometry(this.room * 2);
    for (const name of [PLACE, FRAME, TINT]) {
      attributeOf(geometry, name).array.set(attributeOf(old, name).array);
    }
    // As many sprites as the last `end` showed stay shown until the next one.
    geometry.instanceCount = old.instanceCount;
    this.room *= 2;
    this.place = attributeOf(geometry, PLACE);
    this.frame = attributeOf(geometry, FRAME);
    this.tint = attributeOf(geometry, TINT);
    this.mesh.geometry = geometry;
    old.dispose();
  }
}

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
 * an `end` and before the next `push`, which writes over them. It is for `drawnSprites` in
 * arcadekit/render-three/testing, so that no test knows the buffers' names or layout, and the
 * entry's public file doesn't export it. It allocates: not for a frame.
 */
export const readSprites = (batch: InstancedSprites): SpriteValues[] => {
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

// The per-sprite attributes, by the names the vertex shader reads them under.
const PLACE = "aPlace";
const FRAME = "aFrame";
const TINT = "aTint";

/** A quad with room for `capacity` sprites, every one of them zero, and none shown. */
const spriteGeometry = (capacity: number): THREE.InstancedBufferGeometry => {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("uv", quad.getAttribute("uv"));
  quad.dispose();
  dynamicAttribute(geometry, PLACE, capacity, 4);
  dynamicAttribute(geometry, FRAME, capacity, 3);
  dynamicAttribute(geometry, TINT, capacity, 4);
  geometry.instanceCount = 0;
  return geometry;
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

/** One of a sprite geometry's own attributes, which `spriteGeometry` made over a Float32Array. */
const attributeOf = (
  geometry: THREE.InstancedBufferGeometry,
  name: string
): THREE.InstancedBufferAttribute & { readonly array: Float32Array } =>
  geometry.getAttribute(name) as THREE.InstancedBufferAttribute & {
    readonly array: Float32Array;
  };

/** Marks the first `shown` sprites of an attribute for upload. */
const upload = (
  attribute: THREE.InstancedBufferAttribute,
  shown: number
): void => {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, Math.max(1, shown) * attribute.itemSize);
  attribute.needsUpdate = true;
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
