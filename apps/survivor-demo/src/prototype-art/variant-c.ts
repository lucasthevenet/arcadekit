/* oxlint-disable no-inline-comments, no-nested-ternary, no-param-reassign, no-plusplus, prefer-destructuring, complexity, class-methods-use-this, operator-assignment, unicorn/no-array-for-each, unicorn/prefer-math-trunc, oxc/branches-sharing-code, require-unicode-regexp -- PROTOTYPE (#24 art): throwaway pixel-pushing code */
// PROTOTYPE (#24 art), variant C: crisp pixel-art sprites, straight-down orthographic camera.
// Draw calls: ground, shadows, auras, sprites (heroes + enemies + gems, one atlas), projectiles.
// Every sprite pixel is 1/16 world unit and an integer number of screen pixels.
import type { GameView } from "@gamekit/runtime/browser";
import { auraRadius } from "@gamekit/survivors";
import type { World } from "@gamekit/survivors";
import * as THREE from "three";

import type { ArtOptions } from "./options";
import { GROUND_MARGIN, PX, VOID_COLOR, paintGround } from "./variant-c-ground";
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  Atlas,
  CELL,
  ENEMY_CELLS,
  ENEMY_STRIDE,
  FEET_ROW,
  GEM_CELLS,
  HERO_CELLS,
  HERO_DOWN,
  HERO_STRIDE,
  SHOT_CELLS,
} from "./variant-c-sprites";

export const name = "Pixel-art sprites";

const MAX_WEAPONS = 4;
/** Debug: &cam=x,z pins the camera (to look at the arena wall, say). */
const CAM_OVERRIDE = new URLSearchParams(window.location.search)
  .get("cam")
  ?.split(",")
  .map(Number);
const MAX_SPRITES = 4096;
const MAX_SHOTS = 1024;
const MAX_SHADOWS = 2048;
const MAX_AURAS = 16;
/** Screen pixels of height we aim to show per sprite pixel... roughly 300 sprite px tall. */
const TARGET_SPRITE_ROWS = 300;
const DEFAULT_ENEMIES = [
  { id: "slime", color: "#7bd389", radius: 0.45 },
  { id: "bat", color: "#a77bd3", radius: 0.35 },
  { id: "golem", color: "#9a8c7a", radius: 0.8 },
  { id: "wraith", color: "#e3e3f5", radius: 0.5 },
];

// Per-type look: how high the sprite floats above its shadow (px), animation speed.
const LOOKS: Record<string, { lift: number; anim: number; shadow: number }> = {
  slime: { lift: 0, anim: 4, shadow: 7 },
  bat: { lift: 9, anim: 10, shadow: 5 },
  golem: { lift: 0, anim: 2.6, shadow: 12 },
  wraith: { lift: 5, anim: 3, shadow: 6 },
};

// ---------------------------------------------------------------- shaders

const SPRITE_VERT = /* glsl */ `
attribute vec3 aPos;
attribute float aCell;
attribute vec4 aFx;
uniform vec2 uGrid;
uniform float uPx;
varying vec2 vUv;
varying vec3 vFx;
void main() {
  vec2 uvl = uv;
  if (aFx.w > 0.5) uvl.x = 1.0 - uvl.x;
  float col = mod(aCell, uGrid.x);
  float row = floor(aCell / uGrid.x);
  vUv = vec2((col + uvl.x) / uGrid.x, 1.0 - (row + 1.0 - uvl.y) / uGrid.y);
  vFx = aFx.xyz;
  vec3 o = aPos;
  o.xz = floor(o.xz * uPx + 0.5) / uPx;
  gl_Position = projectionMatrix * viewMatrix * vec4(position + o, 1.0);
}`;

const SPRITE_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vFx;
void main() {
  vec4 c = texture2D(uMap, vUv);
  if (c.a < 0.5) discard;
  vec3 col = c.rgb;
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(g * 0.5 + 0.12, g * 0.52 + 0.13, g * 0.6 + 0.17), vFx.z);
  col = mix(col, vec3(1.0, 0.22, 0.2), vFx.y);
  col = mix(col, vec3(1.0), vFx.x);
  gl_FragColor = vec4(col, 1.0);
}`;

const SHOT_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vFx;
void main() {
  float v = texture2D(uMap, vUv).r;
  if (v < 0.05) discard;
  vec3 col = vFx * v * 1.5 + vec3(max(v - 0.8, 0.0) * 4.0);
  gl_FragColor = vec4(col, 1.0);
}`;

const SHADOW_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aShape; // rx px, ry px, ring?, unused
attribute vec4 aColor;
uniform float uPx;
varying vec2 vLocal;
varying vec4 vShape;
varying vec4 vColor;
void main() {
  vShape = aShape;
  vColor = aColor;
  vLocal = position.xz * (aShape.x + 1.0) * vec2(1.0, aShape.y / aShape.x);
  vec3 o = aPos;
  o.xz = floor(o.xz * uPx + 0.5) / uPx;
  vec3 p = vec3(vLocal.x, 0.0, vLocal.y) / uPx;
  gl_Position = projectionMatrix * viewMatrix * vec4(p + o, 1.0);
}`;

const SHADOW_FRAG = /* glsl */ `
varying vec2 vLocal;
varying vec4 vShape;
varying vec4 vColor;
void main() {
  vec2 p = floor(vLocal) + 0.5;
  float d = length(p / vShape.xy);
  if (d > 1.0) discard;
  if (vShape.z > 0.5) {
    vec2 q = p * (1.0 + 1.5 / vShape.x);
    if (length(q / vShape.xy) < 1.0) discard;
  }
  gl_FragColor = vColor;
}`;

const AURA_VERT = /* glsl */ `
attribute vec4 aAura; // x, z, radius, pulse
attribute vec3 aColor;
varying vec2 vWorld;
varying vec4 vAura;
varying vec3 vColor;
void main() {
  vAura = aAura;
  vColor = aColor;
  vec3 p = vec3(aAura.x, 0.0, aAura.y) + position * (aAura.z + 0.3);
  vWorld = p.xz;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const AURA_FRAG = /* glsl */ `
uniform float uPx;
uniform float uTime;
varying vec2 vWorld;
varying vec4 vAura;
varying vec3 vColor;
float bayer(vec2 p) {
  vec2 q = mod(p, 4.0);
  int i = int(q.y) * 4 + int(q.x);
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i]) + 0.5) / 16.0;
}
void main() {
  vec2 px = floor(vWorld * uPx);
  vec2 c = floor(vAura.xy * uPx);
  vec2 rel = px + 0.5 - c;
  float d = length(rel);
  float R = vAura.z * uPx;
  float pulse = vAura.w;
  if (d > R) discard;
  float ang = atan(rel.y, rel.x);
  float segs = floor(R * 0.35);
  float dash = fract(ang / 6.2831853 * segs + uTime * 0.6);
  vec3 col = vColor;
  float a;
  if (d > R - 2.0) {
    a = dash < 0.6 ? 0.95 : 0.55;
    col = mix(col, vec3(1.0, 0.95, 0.8), dash < 0.6 ? 0.35 : 0.0);
  } else if (d > R - 4.0 && dash < 0.25) {
    a = 0.4;
  } else {
    // dithered heat filling, denser near the rim and on each pulse
    float t = d / R;
    float wave = max(0.0, 1.0 - abs(d - (1.0 - pulse) * R) / 3.0);
    float fill = t * t * t * t * 0.18 + wave * pulse * 0.7;
    if (bayer(px) >= fill) discard;
    a = 0.55;
  }
  gl_FragColor = vec4(col, a);
}`;

const GROUND_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const GROUND_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uMap, vUv); }`;

// ---------------------------------------------------------------- batches

interface Batch {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly attrs: Record<string, THREE.InstancedBufferAttribute>;
}

const makeBatch = (
  base: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  layout: Record<string, number>
): Batch => {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute("position", base.getAttribute("position"));
  geometry.setAttribute("uv", base.getAttribute("uv"));
  const attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  for (const [key, size] of Object.entries(layout)) {
    const attr = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * size),
      size
    );
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(key, attr);
    attrs[key] = attr;
  }
  geometry.instanceCount = 0;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return { mesh, geometry, attrs };
};

const commit = (batch: Batch, count: number) => {
  batch.geometry.instanceCount = count;
  for (const attr of Object.values(batch.attrs)) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(1, count) * attr.itemSize);
    attr.needsUpdate = true;
  }
};

/** A quad lying on the ground (XZ plane), from (x0, z0) to (x1, z1); uv v=1 at z0 (screen top). */
const groundQuad = (x0: number, z0: number, x1: number, z1: number) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1],
      3
    )
  );
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2)
  );
  g.setIndex([0, 2, 1, 2, 3, 1]);
  return g;
};

const hexRgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  // keep the sRGB values as-is: the shaders output them straight to the canvas
  c.convertLinearToSRGB();
  return [c.r, c.g, c.b];
};

// ---------------------------------------------------------------- the view

class PixelView implements GameView<World> {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0.1,
    200
  );
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly localHero: number;
  private readonly atlas = new Atlas();
  private readonly texture: THREE.CanvasTexture;
  private readonly sprites: Batch;
  private readonly shots: Batch;
  private readonly shadows: Batch;
  private readonly auras: Batch;
  private readonly auraMaterial: THREE.ShaderMaterial;
  private ground: THREE.Mesh | null = null;
  private groundHalf = -1;
  private scale = 2;
  private heroColors: string[] = [];
  private enemyKey = "";
  private enemyLooks: {
    lift: number;
    anim: number;
    shadow: number;
    radius: number;
  }[] = [];
  private enemyDefsRef: unknown = null;
  private shotColors: Float32Array = new Float32Array(64 * 3);
  private shotKinds: Uint8Array = new Uint8Array(64);
  /** Distance walked per hero slot, to drive the walk cycle; and last positions. */
  private readonly walked = new Float32Array(8);
  private readonly lastX = new Float32Array(8);
  private readonly lastZ = new Float32Array(8);
  private readonly lastMoveT = new Float32Array(8);
  private readonly lastFlip = new Uint8Array(8);
  private textureVersion = -1;

  constructor(container: HTMLElement, options: ArtOptions) {
    this.container = container;
    this.localHero = options.localHero ?? 0;
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const canvas = this.renderer.domElement;
    canvas.style.cssText =
      "display:block;width:100%;height:100%;image-rendering:pixelated";
    container.append(canvas);
    this.scene.background = new THREE.Color(VOID_COLOR);
    this.camera.up.set(0, 0, -1);

    this.texture = new THREE.CanvasTexture(this.atlas.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;

    const px = PX;
    const quadW = CELL / 2 / px;
    const spriteQuad = groundQuad(
      -quadW,
      -FEET_ROW / px,
      quadW,
      (CELL - FEET_ROW) / px
    );
    const centredQuad = groundQuad(-quadW, -quadW, quadW, quadW);
    const unitQuad = groundQuad(-1, -1, 1, 1);
    const grid = new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS);

    this.sprites = makeBatch(
      spriteQuad,
      new THREE.ShaderMaterial({
        vertexShader: SPRITE_VERT,
        fragmentShader: SPRITE_FRAG,
        uniforms: {
          uMap: { value: this.texture },
          uGrid: { value: grid },
          uPx: { value: px },
        },
      }),
      MAX_SPRITES,
      { aPos: 3, aCell: 1, aFx: 4 }
    );
    this.shots = makeBatch(
      centredQuad,
      new THREE.ShaderMaterial({
        vertexShader: SPRITE_VERT,
        fragmentShader: SHOT_FRAG,
        uniforms: {
          uMap: { value: this.texture },
          uGrid: { value: grid },
          uPx: { value: px },
        },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
      MAX_SHOTS,
      { aPos: 3, aCell: 1, aFx: 4 }
    );
    this.shadows = makeBatch(
      unitQuad,
      new THREE.ShaderMaterial({
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms: { uPx: { value: px } },
        transparent: true,
        depthWrite: false,
      }),
      MAX_SHADOWS,
      { aPos: 3, aShape: 4, aColor: 4 }
    );
    this.auraMaterial = new THREE.ShaderMaterial({
      vertexShader: AURA_VERT,
      fragmentShader: AURA_FRAG,
      uniforms: { uPx: { value: px }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    this.auras = makeBatch(unitQuad, this.auraMaterial, MAX_AURAS, {
      aAura: 4,
      aColor: 3,
    });
    this.shadows.mesh.renderOrder = 1;
    this.auras.mesh.renderOrder = 2;
    this.sprites.mesh.renderOrder = 3;
    this.shots.mesh.renderOrder = 4;
    this.scene.add(
      this.shadows.mesh,
      this.auras.mesh,
      this.sprites.mesh,
      this.shots.mesh
    );

    for (let s = 0; s < 4; s++) {
      this.lastMoveT[s] = -99;
    }

    if (new URLSearchParams(window.location.search).has("sheet")) {
      const c = this.atlas.canvas;
      c.style.cssText = `position:fixed;left:8px;top:8px;width:${
        c.width * 3
      }px;image-rendering:pixelated;background:#355a36;z-index:99999`;
      document.body.append(c);
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    const bw = this.renderer.domElement.width;
    const bh = this.renderer.domElement.height;
    this.scale = Math.max(1, Math.round(bh / TARGET_SPRITE_ROWS));
    const unit = PX * this.scale; // buffer px per world unit
    this.camera.left = -bw / 2 / unit;
    this.camera.right = bw / 2 / unit;
    this.camera.top = bh / 2 / unit;
    this.camera.bottom = -bh / 2 / unit;
    this.camera.updateProjectionMatrix();
  }

  private placeCamera(x: number, z: number) {
    if (CAM_OVERRIDE) {
      x = CAM_OVERRIDE[0]!;
      z = CAM_OVERRIDE[1]!;
    }
    const unit = PX * this.scale;
    const cx = Math.round(x * unit) / unit;
    const cz = Math.round(z * unit) / unit;
    this.camera.position.set(cx, 100, cz);
    this.camera.lookAt(cx, 0, cz);
  }

  private ensureGround(halfSize: number) {
    if (this.groundHalf === halfSize) {
      return;
    }
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
      const m = this.ground.material as THREE.ShaderMaterial;
      (m.uniforms["uMap"]!.value as THREE.Texture).dispose();
      m.dispose();
    }
    this.groundHalf = halfSize;
    const tex = new THREE.CanvasTexture(paintGround(halfSize));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    const e = halfSize + GROUND_MARGIN;
    this.ground = new THREE.Mesh(
      groundQuad(-e, -e, e, e),
      new THREE.ShaderMaterial({
        vertexShader: GROUND_VERT,
        fragmentShader: GROUND_FRAG,
        uniforms: { uMap: { value: tex } },
        depthWrite: false,
      })
    );
    this.ground.renderOrder = 0;
    this.scene.add(this.ground);
  }

  private ensureEnemies(
    defs: readonly { id: string; color: string; radius: number }[]
  ) {
    if (this.enemyDefsRef === defs) {
      return;
    }
    this.enemyDefsRef = defs;
    const key = defs.map((d) => d.id + d.color).join(",");
    this.enemyLooks = defs.map((d) => ({
      ...(LOOKS[d.id] ?? LOOKS["slime"]!),
      radius: d.radius,
    }));
    if (key !== this.enemyKey) {
      this.enemyKey = key;
      defs.forEach((d, i) => this.atlas.paintEnemy(i, d.id, d.color));
    }
  }

  private ensureHero(slot: number, color: string) {
    if (this.heroColors[slot] !== color) {
      this.heroColors[slot] = color;
      this.atlas.paintHero(slot, color);
    }
  }

  private syncTexture() {
    if (this.textureVersion !== this.atlas.version) {
      this.textureVersion = this.atlas.version;
      this.texture.needsUpdate = true;
    }
  }

  render(world: World | null, timeSeconds: number): void {
    this.auraMaterial.uniforms["uTime"]!.value = timeSeconds;
    if (world) {
      this.drawWorld(world, timeSeconds);
    } else {
      this.drawMenu(timeSeconds);
    }
    this.syncTexture();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.ShaderMaterial;
        const map = m.uniforms?.["uMap"]?.value as THREE.Texture | undefined;
        map?.dispose();
        m.dispose();
      }
    });
    this.texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- writers (no allocation)

  private nSprites = 0;
  private nShadows = 0;

  private sprite(
    x: number,
    y: number,
    z: number,
    cell: number,
    flash: number,
    red: number,
    grey: number,
    flip: number
  ) {
    const i = this.nSprites;
    if (i >= MAX_SPRITES) {
      return;
    }
    this.nSprites++;
    const a = this.sprites.attrs;
    const p = a["aPos"]!.array as Float32Array;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    (a["aCell"]!.array as Float32Array)[i] = cell;
    const f = a["aFx"]!.array as Float32Array;
    f[i * 4] = flash;
    f[i * 4 + 1] = red;
    f[i * 4 + 2] = grey;
    f[i * 4 + 3] = flip;
  }

  private shadow(
    x: number,
    z: number,
    rx: number,
    ry: number,
    ring: number,
    r: number,
    g: number,
    b: number,
    alpha: number
  ) {
    const i = this.nShadows;
    if (i >= MAX_SHADOWS) {
      return;
    }
    this.nShadows++;
    const a = this.shadows.attrs;
    const p = a["aPos"]!.array as Float32Array;
    p[i * 3] = x;
    p[i * 3 + 1] = 0.05 + ring * 0.01;
    p[i * 3 + 2] = z;
    const s = a["aShape"]!.array as Float32Array;
    s[i * 4] = rx;
    s[i * 4 + 1] = ry;
    s[i * 4 + 2] = ring;
    const c = a["aColor"]!.array as Float32Array;
    c[i * 4] = r;
    c[i * 4 + 1] = g;
    c[i * 4 + 2] = b;
    c[i * 4 + 3] = alpha;
  }

  /** Depth so lower on screen (larger z) draws in front. */
  private depth(z: number, layer: number) {
    return layer + (z + 200) * 0.002;
  }

  private enemy(
    type: number,
    x: number,
    z: number,
    t: number,
    i: number,
    flash: number,
    flip: number
  ) {
    const look = this.enemyLooks[type]!;
    const phase = t * look.anim + i * 0.37;
    const frame = Math.floor(phase) & 1;
    let { lift } = look;
    if (look.lift > 0) {
      lift += Math.round(Math.sin(phase * 1.3) * 1.5);
    }
    const feet = z + look.radius * 0.75;
    this.shadow(
      x,
      feet - 1 / PX,
      look.shadow,
      Math.max(2, look.shadow * 0.45),
      0,
      0,
      0,
      0,
      0.32
    );
    this.sprite(
      x,
      this.depth(feet, 1),
      feet - lift / PX,
      ENEMY_CELLS + type * ENEMY_STRIDE + frame,
      flash,
      0,
      0,
      flip
    );
  }

  private drawMenu(t: number) {
    this.ensureGround(60);
    this.ensureEnemies(DEFAULT_ENEMIES);
    this.nSprites = 0;
    this.nShadows = 0;
    const cx = Math.sin(t * 0.04) * 22;
    const cz = Math.cos(t * 0.031) * 16;
    // a few critters roaming around wherever the camera drifts
    for (let i = 0; i < 26; i++) {
      const type = i % 7 === 0 ? 2 : i % 5 === 0 ? 3 : i % 2;
      const speed = 0.15 + (i % 4) * 0.05;
      const r = 4 + ((i * 7) % 13);
      const a = i * 2.4 + t * speed * (i % 2 ? 1 : -1);
      const x = Math.round(cx / 8) * 8 + Math.cos(a) * r + ((i * 13) % 9) - 4;
      const z =
        Math.round(cz / 8) * 8 + Math.sin(a) * r * 0.7 + ((i * 5) % 7) - 3;
      this.enemy(
        type,
        x,
        z,
        t,
        i,
        0,
        Math.sin(a) * (i % 2 ? 1 : -1) > 0 ? 1 : 0
      );
    }
    commit(this.sprites, this.nSprites);
    commit(this.shadows, this.nShadows);
    commit(this.shots, 0);
    commit(this.auras, 0);
    this.placeCamera(cx, cz);
  }

  private drawWorld(world: World, t: number) {
    this.ensureGround(world.content.rules.arenaHalfSize);
    this.ensureEnemies(world.enemyDefs);
    this.nSprites = 0;
    this.nShadows = 0;
    const coop = world.heroes.length > 1;
    const followed = world.heroes[this.localHero] ?? world.heroes[0]!;

    // weapon colours + kinds (bolt vs bubble), by projectile weapon index
    for (const hero of world.heroes) {
      for (let w = 0; w < hero.weapons.length; w++) {
        const idx = hero.slot * MAX_WEAPONS + w;
        const { def } = hero.weapons[w]!;
        if (this.shotKinds[idx] === 0) {
          const [r, g, b] = hexRgb(def.color);
          this.shotColors[idx * 3] = r;
          this.shotColors[idx * 3 + 1] = g;
          this.shotColors[idx * 3 + 2] = b;
          this.shotKinds[idx] = def.id.includes("bubble") ? 2 : 1;
        }
      }
    }

    // gems: lie on the ground, under everything that stands
    const g = world.gems.fields;
    for (let i = 0; i < world.gems.count; i++) {
      const v = g.value[i]!;
      const colour = v >= 5 ? 2 : v >= 3 ? 1 : 0;
      const sparkle = (t * 0.8 + i * 0.618) % 3 < 0.18 ? 1 : 0;
      const bob = Math.round((Math.sin(t * 4 + i) + 1) * 1.2);
      const x = g.x[i]!;
      const z = g.z[i]!;
      this.shadow(x, z + 2 / PX, 3, 1.5, 0, 0, 0, 0, 0.3);
      // gem cells are centred: shift down so the gem sits just above its shadow
      this.sprite(
        x,
        0.3,
        z + (FEET_ROW - CELL / 2 - 6 - bob) / PX,
        GEM_CELLS + colour * 2 + sparkle,
        0,
        0,
        0,
        0
      );
    }

    // heroes
    for (const hero of world.heroes) {
      const s = hero.slot;
      this.ensureHero(s, hero.def.color);
      if (hero.status === "left") {
        continue;
      }
      const dx = hero.x - this.lastX[s]!;
      const dz = hero.z - this.lastZ[s]!;
      const moved = Math.hypot(dx, dz);
      if (moved > 0.0005 && moved < 2) {
        this.walked[s] = this.walked[s]! + moved;
        this.lastMoveT[s] = t;
      }
      this.lastX[s] = hero.x;
      this.lastZ[s] = hero.z;
      if (hero.faceX < -0.05) {
        this.lastFlip[s] = 1;
      } else if (hero.faceX > 0.05) {
        this.lastFlip[s] = 0;
      }
      const walking = t - this.lastMoveT[s]! < 0.12;
      const frame = walking ? Math.floor(this.walked[s]! * 2.2) % 4 : 0;
      const down = coop && hero.status === "down";
      const feet = hero.z + 0.35;
      const [r, gg, b] = hexRgb(hero.def.color);
      this.shadow(hero.x, feet - 1 / PX, 7, 3, 0, 0, 0, 0, 0.35);
      if (!down) {
        this.shadow(hero.x, feet - 1 / PX, 10, 4.5, 1, r, gg, b, 0.75);
      }
      const hurt =
        !down && hero.hurtTimer > 0 && Math.floor(t * 14) % 2 === 0 ? 0.55 : 0;
      const base = HERO_CELLS + s * HERO_STRIDE;
      // the hero sorts in with the crowd, but nudged forward so it rarely hides
      this.sprite(
        hero.x,
        this.depth(feet + 0.4, 1),
        feet,
        down ? base + HERO_DOWN : base + frame,
        0,
        hurt,
        down ? 0.85 : 0,
        this.lastFlip[s]!
      );
    }

    // enemies: face the hero they're chasing
    const e = world.enemies.fields;
    for (let i = 0; i < world.enemies.count; i++) {
      const x = e.x[i]!;
      this.enemy(
        e.type[i]!,
        x,
        e.z[i]!,
        t,
        i,
        e.hitFlash[i]! > 0 ? 0.7 : 0,
        x > followed.x ? 1 : 0
      );
    }

    // projectiles
    const pr = world.projectiles.fields;
    const sp = this.shots.attrs;
    const sPos = sp["aPos"]!.array as Float32Array;
    const sCell = sp["aCell"]!.array as Float32Array;
    const sFx = sp["aFx"]!.array as Float32Array;
    const nShots = Math.min(world.projectiles.count, MAX_SHOTS);
    for (let i = 0; i < nShots; i++) {
      const w = pr.weapon[i]!;
      const kind = this.shotKinds[w] || 1;
      sPos[i * 3] = pr.x[i]!;
      sPos[i * 3 + 1] = 5;
      sPos[i * 3 + 2] = pr.z[i]! - 8 / PX;
      sCell[i] =
        SHOT_CELLS + (kind === 2 ? 2 : 0) + (Math.floor(t * 12 + i) & 1);
      sFx[i * 4] = this.shotColors[w * 3] ?? 1;
      sFx[i * 4 + 1] = this.shotColors[w * 3 + 1] ?? 1;
      sFx[i * 4 + 2] = this.shotColors[w * 3 + 2] ?? 1;
      sFx[i * 4 + 3] = 0;
    }
    commit(this.shots, nShots);

    // auras
    const aa = this.auras.attrs;
    const aAura = aa["aAura"]!.array as Float32Array;
    const aCol = aa["aColor"]!.array as Float32Array;
    let n = 0;
    for (const hero of world.heroes) {
      if (hero.status !== "playing") {
        continue;
      }
      for (let w = 0; w < hero.weapons.length && n < MAX_AURAS; w++) {
        const slot = hero.weapons[w]!;
        if (slot.def.behavior.kind !== "aura") {
          continue;
        }
        const idx = hero.slot * MAX_WEAPONS + w;
        aAura[n * 4] = hero.x;
        aAura[n * 4 + 1] = hero.z;
        aAura[n * 4 + 2] = auraRadius(hero, slot);
        aAura[n * 4 + 3] = Math.max(0, 1 - slot.sinceFired * 3);
        aCol[n * 3] = this.shotColors[idx * 3]!;
        aCol[n * 3 + 1] = this.shotColors[idx * 3 + 1]!;
        aCol[n * 3 + 2] = this.shotColors[idx * 3 + 2]!;
        n++;
      }
    }
    commit(this.auras, n);
    commit(this.sprites, this.nSprites);
    commit(this.shadows, this.nShadows);
    this.placeCamera(followed.x, followed.z);
  }
}

export const makeView = (
  container: HTMLElement,
  options: ArtOptions
): GameView<World> => new PixelView(container, options);
