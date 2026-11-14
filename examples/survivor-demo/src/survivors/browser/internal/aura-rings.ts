/**
 * Aura rings: the rings of the heroes' aura weapons, drawn from the sheet's aura art
 * (`aura/ring`) at any radius, in one draw call, blended over the ground.
 *
 * A sprite scaled by a fraction would break the whole-pixel rule, so the shader works out each
 * whole sprite pixel of the ring on the ground and takes the colour of the art pixel nearest it:
 * the art stretches, its pixels stay whole. The tag's first frame is the ring at rest, its second
 * the ring as it deals damage.
 *
 * Plain on purpose: a frame draws whole before the browser shows it, so `set` and `commit` are
 * plain calls. The rings' Three.js resources come from a plain `make` and go with a plain
 * `dispose`, which the arena's sprites call from their own.
 */
import { MeshInstances } from "arcadekit/render-three";
import type { SpriteSheet } from "arcadekit/render-three";
import * as THREE from "three";

const VERTEX = `
// x, z, radius, pulse
attribute vec4 aAura;
attribute vec3 aColor;
uniform float uDepth;
varying vec2 vWorld;
varying vec4 vAura;
varying vec3 vColor;
void main() {
  vAura = aAura;
  vColor = aColor;
  vec2 p = aAura.xy + position.xz * (aAura.z + 0.25);
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p.x, uDepth, p.y, 1.0);
}`;

const FRAGMENT = `
uniform sampler2D uMap;
uniform vec2 uSheetSize;
uniform float uPx;
// Per frame (rest, pulse): x, y, width, height in the image; offset x, y and width, height
// of the untrimmed frame.
uniform vec4 uRect[2];
uniform vec4 uSource[2];
varying vec2 vWorld;
varying vec4 vAura;
varying vec3 vColor;
void main() {
  vec2 px = floor(vWorld * uPx);
  vec2 rel = px + 0.5 - floor(vAura.xy * uPx);
  float r = vAura.z * uPx;
  if (length(rel) > r) discard;
  int f = vAura.w > 0.5 ? 1 : 0;
  vec4 rect = uRect[f];
  vec4 source = uSource[f];
  // The art pixel nearest this ground pixel, from the untrimmed frame's top-left.
  vec2 art = floor((rel / r * 0.5 + 0.5) * source.zw);
  vec2 local = art - source.xy;
  if (local.x < 0.0 || local.y < 0.0 || local.x >= rect.z || local.y >= rect.w) discard;
  vec4 texel = texture2D(uMap, (rect.xy + local + 0.5) / uSheetSize);
  if (texel.a < 0.01) discard;
  gl_FragColor = vec4(texel.rgb * vColor, texel.a);
  #include <colorspace_fragment>
}`;

/** What the shader reads for each ring: `aAura` is x, z, radius and pulse. */
const ATTRIBUTES = { aAura: 4, aColor: 3 } as const;

/**
 * Up to a fixed number of aura rings in one draw call: what a caller reads of them. The arena's
 * sprites add `mesh` to their root, and a test reads the sheet's frames back from `material`.
 */
export interface AuraRings {
  /** The rings' mesh, to add to the scene. */
  readonly mesh: THREE.InstancedMesh;
  /** The rings' shader: its uniforms hold the sheet's texture and the ring's two frames. */
  readonly material: THREE.ShaderMaterial;
}

/** What the module's functions keep, beyond what a caller reads. */
interface Internal extends AuraRings {
  readonly rings: MeshInstances.MeshInstances<typeof ATTRIBUTES>;
}

/**
 * Makes up to `capacity` rings from `tag` in `sheet`, frame 0 at rest and frame 1 pulsing, at
 * `pixelsPerUnit` of the sheet's pixels to a world unit. `depth` is the world height they draw
 * at: above the ground, below what stands on it. None shows until `commit`.
 */
export const make = (
  sheet: SpriteSheet.SpriteSheet,
  tag: SpriteSheet.Tag,
  capacity: number,
  pixelsPerUnit: number,
  depth: number
): AuraRings => {
  const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const frames = [tag.from, Math.min(tag.from + 1, tag.to)].map((index) => {
    const frame = sheet.data.frames[index] ?? sheet.data.frames[0]!;
    return {
      rect: new THREE.Vector4(frame.x, frame.y, frame.width, frame.height),
      source: new THREE.Vector4(
        frame.offsetX,
        frame.offsetY,
        frame.sourceWidth,
        frame.sourceHeight
      ),
    };
  });
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uMap: { value: sheet.texture },
      uSheetSize: {
        value: new THREE.Vector2(sheet.data.width, sheet.data.height),
      },
      uPx: { value: pixelsPerUnit },
      uDepth: { value: depth },
      uRect: { value: frames.map((frame) => frame.rect) },
      uSource: { value: frames.map((frame) => frame.source) },
    },
    transparent: true,
    depthWrite: false,
  });
  const rings = MeshInstances.make(quad, material, {
    capacity,
    attributes: ATTRIBUTES,
  });
  const self: Internal = { mesh: rings.mesh, material, rings };
  return self;
};

/**
 * Sets ring `index` around (x, z), of `radius`, tinted `color`. `pulse` is 1 as it deals damage
 * and fades to 0; the pulse frame shows above 0.5.
 */
export const set = (
  self: AuraRings,
  index: number,
  x: number,
  z: number,
  radius: number,
  pulse: number,
  color: THREE.Color
): void => {
  const { rings } = self as Internal;
  MeshInstances.setAttribute(rings, index, "aAura", x, z, radius, pulse);
  MeshInstances.setAttribute(rings, index, "aColor", color.r, color.g, color.b);
};

/** Shows the first `count` rings, as last set. */
export const commit = (self: AuraRings, count: number): void => {
  MeshInstances.commit((self as Internal).rings, count);
};

/** Frees the rings' geometry and their shader. Never the sheet's texture, which the app owns. */
export const dispose = (self: AuraRings): void => {
  MeshInstances.dispose((self as Internal).rings);
};
