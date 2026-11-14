/**
 * Instanced sprites: copies of frames from one sprite sheet drawn in a single draw call, as quads
 * on the ground plane facing a straight-down camera. A batch of them is what a view pushes its
 * sprites into, each frame.
 *
 * Each sprite has a position, a frame, a horizontal flip, a tint, a flash toward white, an
 * alpha, a lift and a layer, written into the batch's typed arrays: once a batch has grown to a
 * frame's sprites, a frame allocates no buffer. Its functions are plain calls, made inside the
 * frame the browser shows (ADR-0024). A view makes its batches when it is made and disposes them
 * with it.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";
import * as THREE from "three";

import { pixelCameraOf } from "./internal/pixel-cameras";
import {
  FRAME,
  PLACE,
  TINT,
  attributeOf,
  spriteGeometry,
} from "./internal/sprite-buffers";
import type * as SpriteSheet from "./sprite-sheet";

const TypeId = "~arcadekit/render-three/InstancedSprites";

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
 * the pixel camera that draws it, or nothing.
 *
 * **When to use**
 *
 * As a batch's `snap` option. `"sprite"`, the default, keeps everything on one grid with the
 * ground, so the art never shimmers. `"screen"` is for what slides between two cells, since a
 * screen pixel is finer than a sprite pixel at any pixel scale above 1. `"none"` leaves
 * positions as pushed.
 *
 * **Details**
 *
 * The rounding is the shader's. A `"screen"` batch drawn by a camera that is no pixel camera's
 * rounds to sprite pixels.
 *
 * **Example** (A batch for what slides)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const snap: InstancedSprites.Snap = "screen";
 * const actors = InstancedSprites.make(TestSpriteSheet.fromTags({ box: 1 }), { snap });
 * actors.snap; // => "screen"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Snap = "sprite" | "screen" | "none";

/**
 * What a batch is made with: its room, its pixel density, its anchor, its layer, whether it
 * blends, and what it rounds positions to.
 *
 * **When to use**
 *
 * To make a batch with `make`, once per kind of thing a view draws together: the characters,
 * the soft shadows, the ground's marks.
 *
 * **Example** (Characters standing on their feet, over the ground)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const options: InstancedSprites.Options = {
 *   anchor: { x: 0.5, y: 1 },
 *   layer: 2,
 * };
 * const actors = InstancedSprites.make(TestSpriteSheet.fromTags({ hero: 1 }), options);
 * actors.capacity; // => 64
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
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
  /** What a sprite's position is rounded to. Defaults to `"sprite"`. */
  readonly snap?: Snap;
  /**
   * How far from z = 0, in world units, depth still orders sprites within a layer: beyond it,
   * sprites tie. Defaults to 256.
   */
  readonly sortRange?: number;
}

/**
 * A batch of sprites from one sheet, drawn in one draw call as quads facing a straight-down
 * camera. Within a layer, a sprite lower on screen (larger z) draws in front.
 *
 * **When to use**
 *
 * For everything a pixel-art view draws from its sheet: each frame, `begin`, then `push` every
 * sprite to draw and the setters for those that need them, then `end`.
 *
 * **Details**
 *
 * Add `mesh` to the scene. A batch filled once keeps showing its last `end`. It has room for
 * `capacity` sprites and doubles it when a frame pushes more: its mesh and material stay, and
 * its geometry is replaced. `count` is the sprites pushed since `begin`. `dispose` (or
 * `Stage.disposeObject`) frees its own geometry, material and frame table, never the sheet's
 * texture: the sheet's owner frees that.
 *
 * **Example** (A frame of enemies, one of them hit)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const enemies = InstancedSprites.make(TestSpriteSheet.fromTags({ slime: 2 }));
 * InstancedSprites.begin(enemies);
 * for (const [x, hit] of [[1, false], [2, true]] as const) {
 *   const sprite = InstancedSprites.push(enemies, x, 0, 0);
 *   InstancedSprites.setFlash(enemies, sprite, hit ? 1 : 0);
 * }
 * InstancedSprites.end(enemies);
 * [enemies.count, enemies.mesh.geometry.instanceCount]; // => [2, 2]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface InstancedSprites
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The same mesh and material for the batch's life. Its geometry is replaced when it grows. */
  readonly mesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  readonly sheet: SpriteSheet.SpriteSheet;
  /** What it rounds each sprite's position to, as it was made. */
  readonly snap: Snap;
  /** How many sprites it has room for now. A `push` past it doubles it. */
  readonly capacity: number;
  /** Sprites pushed since `begin`. */
  readonly count: number;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<InstancedSprites> & {
  readonly frameCount: number;
  readonly frameTable: THREE.DataTexture;
  place: THREE.InstancedBufferAttribute & { readonly array: Float32Array };
  frame: THREE.InstancedBufferAttribute & { readonly array: Float32Array };
  tint: THREE.InstancedBufferAttribute & { readonly array: Float32Array };
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: InstancedSprites) {
    return {
      _id: "InstancedSprites",
      sheet: this.sheet.data.image,
      snap: this.snap,
      capacity: this.capacity,
      count: this.count,
    };
  },
};

/** Room for this many sprites, when a batch is given no `capacity`. */
const DEFAULT_CAPACITY = 64;

/**
 * Checks whether a value is a batch of sprites.
 *
 * **When to use**
 *
 * Narrow an unknown value before pushing into it.
 *
 * **Example** (Recognising a batch)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ floor: 1 }));
 * InstancedSprites.isInstancedSprites(batch); // => true
 * InstancedSprites.isInstancedSprites(batch.mesh); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isInstancedSprites = (value: unknown): value is InstancedSprites =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a batch of sprites from a sheet, with none shown.
 *
 * **When to use**
 *
 * When a view is made, once for each batch it draws, with the sheet it was handed.
 *
 * **Details**
 *
 * It throws a `RangeError` for a `capacity` that is no finite number, which would make buffers
 * with no room that never grow. The mesh is never culled: sprites can be anywhere, so the
 * quad's bounds mean nothing.
 *
 * **Example** (A batch of soft shadows, blended)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const shadows = InstancedSprites.make(TestSpriteSheet.fromTags({ shadow: 1 }), {
 *   transparent: true,
 *   capacity: 100,
 * });
 * [shadows.capacity, shadows.count, shadows.mesh.material.transparent]; // => [100, 0, true]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (
  sheet: SpriteSheet.SpriteSheet,
  options: Options = {}
): InstancedSprites => {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  // NaN would make buffers with no room that never grow, and every sprite pushed would be lost.
  if (!Number.isFinite(capacity)) {
    throw new RangeError(
      `InstancedSprites.make: a capacity of ${String(capacity)} is no number of sprites: give the batch a whole number to start with, or leave it out for ${DEFAULT_CAPACITY}`
    );
  }
  const self = Object.create(Proto) as Types.Mutable<Internal>;
  self.sheet = sheet;
  // At least one, so that doubling it makes room.
  self.capacity = Math.max(1, Math.ceil(capacity));
  self.count = 0;
  self.frameCount = sheet.data.frames.length;
  const transparent = options.transparent ?? false;
  const unitsPerPixel = options.unitsPerPixel ?? 1 / 16;
  const snap = options.snap ?? "sprite";
  self.snap = snap;

  const geometry = spriteGeometry(self.capacity);
  self.place = attributeOf(geometry, PLACE);
  self.frame = attributeOf(geometry, FRAME);
  self.tint = attributeOf(geometry, TINT);

  self.frameTable = frameTable(sheet.data);
  const anchor = options.anchor ?? { x: 0.5, y: 0.5 };
  const snapUnit = { value: snap === "none" ? 0 : unitsPerPixel };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uMap: { value: sheet.texture },
      uFrames: { value: self.frameTable },
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
  self.mesh = new THREE.Mesh(geometry, material);
  // Sprites can be anywhere, so the quad's bounds mean nothing: never cull.
  self.mesh.frustumCulled = false;
  if (snap === "screen") {
    // A screen pixel's size is the camera's to say, and a batch may be drawn by more than one.
    // Three.js calls this with the camera about to draw the mesh, and uploads a
    // ShaderMaterial's uniforms for that draw when `uniformsNeedUpdate` is set.
    self.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const pixel = pixelCameraOf(camera);
      const unit =
        pixel === undefined ? unitsPerPixel : 1 / pixel.screenPixelsPerUnit;
      if (snapUnit.value !== unit) {
        snapUnit.value = unit;
        material.uniformsNeedUpdate = true;
      }
    };
  }
  return self;
};

/**
 * Starts a frame's sprites over: the next `push` is sprite 0.
 *
 * **When to use**
 *
 * First in each frame that fills the batch.
 *
 * **Details**
 *
 * The batch goes on showing as many sprites as its last `end` did until the next one, and each
 * `push` writes over one of them: render after `end`, not between the two.
 *
 * **Example** (A frame that draws nothing)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ floor: 1 }));
 * InstancedSprites.begin(batch);
 * InstancedSprites.push(batch, 0, 0, 0);
 * InstancedSprites.end(batch);
 * InstancedSprites.begin(batch);
 * InstancedSprites.end(batch);
 * batch.mesh.geometry.instanceCount; // => 0
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const begin = (self: InstancedSprites): void => {
  (self as Internal).count = 0;
};

/** Doubles a batch's room: a new geometry that holds what the old one did, which is then freed. */
const grow = (batch: Internal): void => {
  const old = batch.mesh.geometry;
  const geometry = spriteGeometry(batch.capacity * 2);
  for (const name of [PLACE, FRAME, TINT]) {
    attributeOf(geometry, name).array.set(attributeOf(old, name).array);
  }
  // As many sprites as the last `end` showed stay shown until the next one.
  geometry.instanceCount = old.instanceCount;
  batch.capacity *= 2;
  batch.place = attributeOf(geometry, PLACE);
  batch.frame = attributeOf(geometry, FRAME);
  batch.tint = attributeOf(geometry, TINT);
  // The mesh and its material stay, so the scene and the shader are untouched.
  batch.mesh.geometry = geometry;
  old.dispose();
};

/**
 * Adds a sprite with its anchor at (x, z) on the ground, showing frame `frame`, mirrored if
 * `flipX`, and returns its index for the other setters.
 *
 * **When to use**
 *
 * Between `begin` and `end`, for each sprite the frame draws, with the frame `SpriteSheet.frameAt`
 * gives.
 *
 * **Details**
 *
 * `frame` is an index into `sheet.data.frames`; one outside the sheet draws frame 0. The
 * sprite's tint, alpha, flash, lift and layer start plain, so nothing of the sprite that had
 * the index last frame is left. A push past `capacity` doubles it.
 *
 * **Example** (The player, mirrored)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ "player/idle": 2 }));
 * InstancedSprites.begin(batch);
 * InstancedSprites.push(batch, 2, 3, 1, true); // => 0
 * InstancedSprites.end(batch);
 * const [player] = DrawnSprites.read(batch);
 * [player?.x, player?.z, player?.frame, player?.flipX]; // => [2, 3, 1, true]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const push: {
  (
    x: number,
    z: number,
    frame: number,
    flipX?: boolean
  ): (self: InstancedSprites) => number;
  (
    self: InstancedSprites,
    x: number,
    z: number,
    frame: number,
    flipX?: boolean
  ): number;
} = dual(
  (args) => isInstancedSprites(args[0]),
  (
    self: InstancedSprites,
    x: number,
    z: number,
    frame: number,
    flipX = false
  ): number => {
    const batch = self as Internal;
    const index = batch.count;
    if (index === batch.capacity) {
      grow(batch);
    }
    batch.count = index + 1;
    const shown = frame >= 0 && frame < batch.frameCount ? frame : 0;
    write4(batch.place, index, x, z, 0, 0);
    write3(batch.frame, index, shown, flipX ? 1 : 0, 0);
    write4(batch.tint, index, 1, 1, 1, 1);
    return index;
  }
);

/**
 * Multiplies sprite `index`'s colours by `color`, and sets its alpha.
 *
 * **When to use**
 *
 * For white or grey art drawn in a colour of the game's (a hero's, a player slot's), or a
 * sprite dimmed behind a menu.
 *
 * **Details**
 *
 * White leaves the colours as they are. `alpha` defaults to 1; an opaque batch cuts out pixels
 * whose alpha falls below its `alphaTest`.
 *
 * **Example** (A marker in its player's colour)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 * import * as THREE from "three";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ marker: 1 }));
 * InstancedSprites.begin(batch);
 * const marker = InstancedSprites.push(batch, 0, 0, 0);
 * InstancedSprites.setTint(batch, marker, new THREE.Color(1, 0.5, 0.25), 0.75);
 * InstancedSprites.end(batch);
 * DrawnSprites.read(batch)[0]?.tint; // => [1, 0.5, 0.25, 0.75]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setTint: {
  (
    index: number,
    color: THREE.Color,
    alpha?: number
  ): (self: InstancedSprites) => void;
  (
    self: InstancedSprites,
    index: number,
    color: THREE.Color,
    alpha?: number
  ): void;
} = dual(
  (args) => isInstancedSprites(args[0]),
  (
    self: InstancedSprites,
    index: number,
    color: THREE.Color,
    alpha = 1
  ): void => {
    write4((self as Internal).tint, index, color.r, color.g, color.b, alpha);
  }
);

/**
 * Sets sprite `index`'s alpha, from 0 to 1, and keeps its tint.
 *
 * **When to use**
 *
 * To fade a sprite in a transparent batch, such as a shadow under something lifted.
 *
 * **Details**
 *
 * An opaque batch hides the sprite's pixels whose alpha falls below its `alphaTest`.
 *
 * **Example** (A shadow at half alpha)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const shadows = InstancedSprites.make(TestSpriteSheet.fromTags({ shadow: 1 }), {
 *   transparent: true,
 * });
 * InstancedSprites.begin(shadows);
 * InstancedSprites.setAlpha(shadows, InstancedSprites.push(shadows, 0, 0, 0), 0.5);
 * InstancedSprites.end(shadows);
 * DrawnSprites.read(shadows)[0]?.tint; // => [1, 1, 1, 0.5]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setAlpha: {
  (index: number, alpha: number): (self: InstancedSprites) => void;
  (self: InstancedSprites, index: number, alpha: number): void;
} = dual(3, (self: InstancedSprites, index: number, alpha: number): void => {
  (self as Internal).tint.array[index * 4 + 3] = alpha;
});

/**
 * Blends sprite `index` toward white: 0 is its own colours, 1 a white silhouette.
 *
 * **When to use**
 *
 * For a hit flash, from the time since the hit.
 *
 * **Example** (A sprite hit just now)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ slime: 1 }));
 * InstancedSprites.begin(batch);
 * batch.pipe(InstancedSprites.setFlash(InstancedSprites.push(batch, 0, 0, 0), 1));
 * InstancedSprites.end(batch);
 * DrawnSprites.read(batch)[0]?.flash; // => 1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setFlash: {
  (index: number, amount: number): (self: InstancedSprites) => void;
  (self: InstancedSprites, index: number, amount: number): void;
} = dual(3, (self: InstancedSprites, index: number, amount: number): void => {
  (self as Internal).frame.array[index * 3 + 2] = amount;
});

/**
 * Draws sprite `index` `lift` world units up the screen, as if floating: a bat.
 *
 * **When to use**
 *
 * For what flies over the ground but stands among the things near it.
 *
 * **Details**
 *
 * Its depth stays where its feet are, so it sorts with the things standing near it.
 *
 * **Example** (A bat above its shadow)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ bat: 1 }));
 * InstancedSprites.begin(batch);
 * InstancedSprites.setLift(batch, InstancedSprites.push(batch, 0, 4, 0), 0.25);
 * InstancedSprites.end(batch);
 * const [bat] = DrawnSprites.read(batch);
 * [bat?.z, bat?.lift]; // => [4, 0.25]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setLift: {
  (index: number, lift: number): (self: InstancedSprites) => void;
  (self: InstancedSprites, index: number, lift: number): void;
} = dual(3, (self: InstancedSprites, index: number, lift: number): void => {
  (self as Internal).place.array[index * 4 + 2] = lift;
});

/**
 * Puts sprite `index` in another layer, added to the batch's own.
 *
 * **When to use**
 *
 * To draw one sprite over the others of its batch whatever their positions: the hero over the
 * enemies.
 *
 * **Details**
 *
 * A higher layer draws over a lower one. Use whole numbers, as for a batch's `layer`.
 *
 * **Example** (The hero over everything else of its batch)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ hero: 1 }), { layer: 1 });
 * InstancedSprites.begin(batch);
 * InstancedSprites.setLayer(batch, InstancedSprites.push(batch, 0, 0, 0), 2);
 * InstancedSprites.end(batch);
 * DrawnSprites.read(batch)[0]?.layer; // => 3
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setLayer: {
  (index: number, layer: number): (self: InstancedSprites) => void;
  (self: InstancedSprites, index: number, layer: number): void;
} = dual(3, (self: InstancedSprites, index: number, layer: number): void => {
  (self as Internal).place.array[index * 4 + 3] = layer;
});

/**
 * Shows the sprites pushed since `begin`, and uploads them.
 *
 * **When to use**
 *
 * Last in each frame that fills the batch, before the stage renders.
 *
 * **Details**
 *
 * It marks only the pushed sprites' part of each buffer for upload, and costs the three small
 * records Three.js keeps of what to upload.
 *
 * **Example** (Showing a frame's sprites)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ gem: 1 }));
 * InstancedSprites.begin(batch);
 * InstancedSprites.push(batch, 0, 0, 0);
 * InstancedSprites.push(batch, 1, 0, 0);
 * batch.mesh.geometry.instanceCount; // => 0
 * InstancedSprites.end(batch);
 * batch.mesh.geometry.instanceCount; // => 2
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const end = (self: InstancedSprites): void => {
  const batch = self as Internal;
  const shown = batch.count;
  batch.mesh.geometry.instanceCount = shown;
  upload(batch.place, shown);
  upload(batch.frame, shown);
  upload(batch.tint, shown);
};

/**
 * Removes the batch's mesh from its parent and frees its geometry, material and frame table.
 * Never the sheet.
 *
 * **When to use**
 *
 * In the view's `dispose`, for a batch it takes out of the scene. `Stage.dispose` frees the
 * batches still in the scene with the rest of it.
 *
 * **Example** (Freeing a batch but not its sheet)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 * import * as THREE from "three";
 *
 * const sheet = TestSpriteSheet.fromTags({ floor: 1 });
 * const batch = InstancedSprites.make(sheet);
 * const scene = new THREE.Scene();
 * scene.add(batch.mesh);
 * const freed: string[] = [];
 * sheet.texture.addEventListener("dispose", () => freed.push("sheet"));
 * batch.mesh.material.addEventListener("dispose", () => freed.push("material"));
 * InstancedSprites.dispose(batch);
 * [scene.children.length, freed]; // => [0, ["material"]]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const dispose = (self: InstancedSprites): void => {
  const batch = self as Internal;
  batch.mesh.removeFromParent();
  batch.mesh.geometry.dispose();
  batch.mesh.material.dispose();
  batch.frameTable.dispose();
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
  attribute: THREE.InstancedBufferAttribute & { readonly array: Float32Array },
  index: number,
  a: number,
  b: number,
  c: number,
  d: number
) => {
  const { array } = attribute;
  const at = index * 4;
  array[at] = a;
  array[at + 1] = b;
  array[at + 2] = c;
  array[at + 3] = d;
};

const write3 = (
  attribute: THREE.InstancedBufferAttribute & { readonly array: Float32Array },
  index: number,
  a: number,
  b: number,
  c: number
) => {
  const { array } = attribute;
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
  sheet: SpriteSheet.Data
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

const frameTable = (sheet: SpriteSheet.Data): THREE.DataTexture => {
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
