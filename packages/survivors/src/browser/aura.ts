import type { SpriteSheet, SpriteTag } from "@arcadekit/render-three";
import * as THREE from "three";

// Aura rings, drawn from the sheet's aura art (`aura/ring`) at any radius. A sprite scaled by a
// fraction would break the whole-pixel rule, so the shader works out each whole sprite pixel of
// the ring on the ground and takes the colour of the art pixel nearest it: the art stretches,
// its pixels stay whole. The tag's first frame is the ring at rest, its second the ring as it
// deals damage.

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

/** Up to `capacity` aura rings in one draw call, blended over the ground. */
export class AuraRings {
  readonly mesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private readonly aura: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;

  /**
   * Rings from `tag` in `sheet` (frame 0 at rest, frame 1 pulsing). `depth` is the world
   * height they draw at: above the ground, below what stands on it.
   */
  constructor(
    sheet: SpriteSheet,
    tag: SpriteTag,
    capacity: number,
    pixelsPerUnit: number,
    depth: number
  ) {
    const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute("position", quad.getAttribute("position"));
    quad.dispose();
    this.aura = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4
    );
    this.color = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3
    );
    this.aura.setUsage(THREE.DynamicDrawUsage);
    this.color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aAura", this.aura);
    geometry.setAttribute("aColor", this.color);
    geometry.instanceCount = 0;
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
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
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
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Ring `index` around (x, z), `pulse` 1 as it deals damage and fading to 0 (the pulse frame shows above 0.5), tinted `color`. */
  set(
    index: number,
    x: number,
    z: number,
    radius: number,
    pulse: number,
    color: THREE.Color
  ) {
    const aura = this.aura.array as Float32Array;
    aura[index * 4] = x;
    aura[index * 4 + 1] = z;
    aura[index * 4 + 2] = radius;
    aura[index * 4 + 3] = pulse;
    const rgb = this.color.array as Float32Array;
    rgb[index * 3] = color.r;
    rgb[index * 3 + 1] = color.g;
    rgb[index * 3 + 2] = color.b;
  }

  /** Shows the first `count` rings. */
  commit(count: number) {
    this.mesh.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    this.aura.needsUpdate = true;
    this.color.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
