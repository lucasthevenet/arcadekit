/* oxlint-disable no-plusplus, no-param-reassign, max-statements, max-lines-per-function, no-magic-numbers, id-length, max-lines, complexity, class-methods-use-this, no-nested-ternary, max-classes-per-file, no-inline-comments, prefer-destructuring -- PROTOTYPE (#24 art): throwaway */
// PROTOTYPE (#24 art), variant D: smooth cartoon sprites. Everything is painted at startup on a
// canvas (variant-d-paint.ts) into one 2048px sprite sheet of 256px cells, drawn as upright
// camera-facing cards under an orthographic, mostly top-down camera.
// Draw calls: ground, shadows (instanced), aura + hero rings (a handful), sprites (one instanced
// mesh for heroes, enemies, gems, projectiles and decor, sorted back to front on the CPU).
import type { GameView } from "@gamekit/runtime/browser";
import { auraRadius } from "@gamekit/survivors";
import type { HeroDef, World } from "@gamekit/survivors";
import * as THREE from "three";

import type { ArtOptions } from "./options";
import {
  COLS,
  DECOR,
  DECOR_COUNT,
  GROUND_TILE,
  OUTLINE,
  SHEET,
  paintGroundTile,
  paintSheet,
  rng,
} from "./variant-d-paint";
import type { SheetLayout, SheetSpec } from "./variant-d-paint";

export const name = "Cartoon sprites";

const MAX_WEAPONS = 4;
const MAX_HEROES = 4;
const MAX_SPRITES = 4096;
const MAX_SHADOWS = 4096;
const MAX_RINGS = MAX_HEROES * MAX_WEAPONS + MAX_HEROES;
const PLAYER_RADIUS = 0.5;
/** Camera tilt from straight down. */
const TILT = (34 * Math.PI) / 180;
const COS_TILT = Math.cos(TILT);
const VIEW_HEIGHT = 19;
const CAM_DIST = 60;
const BACKGROUND = "#1f2b26";

/** A renderer, scene and orthographic camera filling the container (like render-three's Stage). */
class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private readonly container: HTMLElement;
  private readonly observer: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.append(canvas);
    const h = VIEW_HEIGHT / 2;
    this.camera = new THREE.OrthographicCamera(-h, h, h, -h, 0.1, 200);
    this.scene.background = new THREE.Color(BACKGROUND);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.observer.disconnect();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    // Zoom out a little on small screens so the horde stays readable.
    const h = (VIEW_HEIGHT / 2) * Math.max(1, 640 / height) ** 0.3;
    const w = h * (width / height);
    this.camera.left = -w;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
  }
}

/** Debug: &dcam=x,z pins the camera (to look at the arena edge). */
const CAM_PIN = new URLSearchParams(window.location.search)
  .get("dcam")
  ?.split(",")
  .map(Number);

const DEFAULT_SPEC: SheetSpec = {
  heroes: [
    { id: "spark", color: "#ffd23f" },
    { id: "ember", color: "#ff6b35" },
    { id: "tide", color: "#3fa7ff" },
  ],
  enemies: [
    { id: "slime", color: "#7bd389" },
    { id: "bat", color: "#a77bd3" },
    { id: "golem", color: "#9a8c7a" },
    { id: "wraith", color: "#e3e3f5" },
  ],
  weapons: [
    { id: "arc-bolt", color: "#fff176", kind: "bolt" },
    { id: "bubble-shot", color: "#8fd3ff", kind: "bolt" },
    { id: "heat-aura", color: "#ff8a50", kind: "aura" },
  ],
};
const DEFAULT_RADII = [0.45, 0.35, 0.8, 0.5];

/** Per enemy look: card size per radius, float height, animation. */
interface Look {
  readonly size: number;
  readonly lift: number;
  readonly hop: number;
  readonly freq: number;
  readonly squash: number;
  readonly rock: number;
  readonly frameRate: number;
  readonly shadow: number;
}
const LOOKS: Record<string, Look> = {
  slime: {
    size: 2.9,
    lift: 0,
    hop: 0.22,
    freq: 9,
    squash: 0.1,
    rock: 0.05,
    frameRate: 0,
    shadow: 1,
  },
  bat: {
    size: 3.9,
    lift: 0.75,
    hop: 0.12,
    freq: 6,
    squash: 0.04,
    rock: 0.12,
    frameRate: 11,
    shadow: 0.6,
  },
  golem: {
    size: 2.7,
    lift: 0,
    hop: 0.03,
    freq: 4,
    squash: 0.03,
    rock: 0.07,
    frameRate: 2.2,
    shadow: 1.05,
  },
  wraith: {
    size: 3.1,
    lift: 0.4,
    hop: 0.12,
    freq: 2.6,
    squash: 0.05,
    rock: 0.1,
    frameRate: 3,
    shadow: 0.55,
  },
};

const srgb = (hexColor: string): [number, number, number] => {
  const n = Number.parseInt(hexColor.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// ------------------------------------------------------------------ shaders

const SPRITE_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uRight;
uniform vec3 uUp;
attribute vec4 iA; // x, z, size, lift
attribute vec4 iB; // cell, flip, rotation, flash
attribute vec4 iC; // phase, freq, squash, rock
attribute vec4 iD; // tint rgb, amount (negative = grey out)
varying vec2 vUv;
varying vec4 vTint;
varying float vFlash;
void main() {
  float s = sin(uTime * iC.y + iC.x);
  vec2 p = position.xy;
  // Squash and stretch, anchored at the feet.
  p.y *= 1.0 + iC.z * s;
  p.x *= 1.0 - iC.z * s * 0.7;
  // Rock about the feet (waddle), then the base rotation about the middle.
  float rock = iC.w * sin(uTime * iC.y * 0.5 + iC.x);
  float cr = cos(rock), sr = sin(rock);
  p = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y);
  float cb = cos(iB.z), sb = sin(iB.z);
  p -= vec2(0.0, 0.5);
  p = vec2(cb * p.x - sb * p.y, sb * p.x + cb * p.y);
  p += vec2(0.0, 0.5);
  vec3 w = vec3(iA.x, 0.0, iA.y) + uUp * iA.w + (uRight * p.x + uUp * p.y) * iA.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  float u = iB.y < 0.0 ? 1.0 - uv.x : uv.x;
  float col = mod(iB.x, ${COLS}.0);
  float row = floor(iB.x / ${COLS}.0);
  vUv = vec2((col + u) / ${COLS}.0, 1.0 - (row + 1.0 - uv.y) / ${COLS}.0);
  vTint = iD;
  vFlash = iB.w;
}
`;

const SPRITE_FRAG = /* glsl */ `
uniform sampler2D uSheet;
varying vec2 vUv;
varying vec4 vTint;
varying float vFlash;
void main() {
  vec4 c = texture2D(uSheet, vUv); // premultiplied
  if (c.a < 0.004) discard;
  if (vTint.a < 0.0) {
    float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
    c.rgb = mix(c.rgb, vec3(l * 0.85, l * 0.88, l * 1.0), -vTint.a);
  } else {
    c.rgb = mix(c.rgb, vTint.rgb * c.a, vTint.a);
  }
  // Hit flash: everything goes white, the outline only lightens.
  float lum = dot(c.rgb, vec3(0.33));
  c.rgb = mix(c.rgb, vec3(c.a) * mix(0.65, 1.0, smoothstep(0.05, 0.25, lum)), vFlash);
  gl_FragColor = c;
}
`;

const SHADOW_VERT = /* glsl */ `
attribute vec4 iS; // x, z, radius, strength
varying vec2 vP;
varying float vA;
void main() {
  vP = position.xy;
  vec3 w = vec3(iS.x + position.x * iS.z, 0.02, iS.y + position.y * iS.z * 0.62);
  vA = iS.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;
const SHADOW_FRAG = /* glsl */ `
varying vec2 vP;
varying float vA;
void main() {
  float d = length(vP);
  float a = vA * (1.0 - smoothstep(0.45, 1.0, d));
  gl_FragColor = vec4(vec3(0.07, 0.12, 0.1) * a, a);
}
`;

const RING_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uPulse;
uniform float uTime;
uniform float uMarker;
varying vec2 vP;
void main() {
  float d = length(vP);
  if (d > 1.0) discard;
  vec3 outline = vec3(${srgb(OUTLINE).join(",")});
  vec3 col = uColor;
  float a;
  if (uMarker > 0.5) {
    // The hero marker: a dashed ring that turns slowly.
    float ang = atan(vP.y, vP.x);
    float dash = step(0.0, sin(ang * 8.0 + uTime * 2.0));
    float band = smoothstep(0.76, 0.8, d) * (1.0 - smoothstep(0.94, 0.98, d));
    a = band * mix(0.35, 0.85, dash);
    col = mix(uColor, vec3(1.0), 0.25);
  } else {
    float ripple = 0.5 + 0.5 * sin(d * 16.0 - uTime * 6.0);
    // Additive heat: a soft glow that brightens toward the rim, ripples outward, flares on each pulse.
    float fill = (0.04 + 0.22 * pow(d, 3.0)) * (0.65 + 0.35 * ripple) * (0.7 + 0.8 * uPulse);
    float rim = smoothstep(0.8, 0.95, d) * (1.0 - smoothstep(0.95, 1.0, d));
    col = uColor * (fill + rim * (0.35 + 0.4 * uPulse)) + vec3(1.0, 0.95, 0.8) * rim * 0.18 * (0.5 + uPulse);
    gl_FragColor = vec4(col, 0.0);
    return;
  }
  gl_FragColor = vec4(col * a, a);
}
`;

const GROUND_VERT = /* glsl */ `
varying vec2 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const GROUND_FRAG = /* glsl */ `
uniform sampler2D uTile;
uniform float uHalf;
varying vec2 vW;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec2 w = vW;
  vec3 col = texture2D(uTile, w / 9.0).rgb;
  // Big soft variation, a warmer meadow here and there.
  float n = fbm(w * 0.045);
  col *= 0.86 + 0.28 * n;
  col = mix(col, col * vec3(1.12, 1.08, 0.82), smoothstep(0.45, 0.75, fbm(w * 0.03 + 40.0)) * 0.6);
  // Dirt patches with a darker painted rim.
  float m = fbm(w * 0.11 + 17.0);
  float aa = fwidth(m) * 1.2;
  float dirt = smoothstep(0.7 - aa, 0.7 + aa, m);
  float rim = smoothstep(0.684 - aa, 0.684 + aa, m) - dirt;
  vec3 dirtCol = vec3(0.62, 0.52, 0.37) * (0.92 + 0.16 * noise(w * 1.3));
  col = mix(col, vec3(0.27, 0.34, 0.22), rim * 0.75);
  col = mix(col, dirtCol, dirt);
  // Large soft tiles, barely there.
  float chk = mod(floor(w.x / 4.0) + floor(w.y / 4.0), 2.0);
  col *= 1.0 - 0.03 * chk;
  // The arena edge: a flagstone path, outlined, then darker wilds beyond.
  float d = max(abs(w.x), abs(w.y)) - uHalf;
  vec3 outline = vec3(${srgb(OUTLINE).join(",")});
  if (d > -1.8) {
    float along = abs(w.x) > abs(w.y) ? w.y : w.x;
    float across = d + 1.8;
    vec3 stone = vec3(0.78, 0.72, 0.6) * (0.9 + 0.12 * noise(vec2(floor(along / 1.1), floor(across / 0.9)) * 7.0));
    float seam = 1.0 - smoothstep(0.0, 0.06, min(fract(along / 1.1 + (floor(across / 0.9) * 0.5)), fract(across / 0.9)));
    stone = mix(stone, stone * 0.62, seam);
    stone = mix(stone, outline, (1.0 - smoothstep(0.0, 0.12, across)) );
    if (d < 0.0) {
      col = stone;
    }
  }
  if (d >= 0.0) {
    float edge = 1.0 - smoothstep(0.0, 0.18, d);
    vec3 wild = col * vec3(0.42, 0.48, 0.52);
    wild *= 1.0 - 0.35 * smoothstep(0.0, 14.0, d);
    col = mix(wild, outline, edge);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------ the view

interface Ring {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
}

class CartoonView implements GameView<World> {
  private readonly stage: Stage;
  private readonly localHero: number;
  private readonly sheetCanvas: HTMLCanvasElement;
  private readonly sheet: THREE.CanvasTexture;
  private layout: SheetLayout;
  private paintedFor: unknown = null;
  private heroIndex = new Map<HeroDef, number>();
  private readonly spriteGeo: THREE.InstancedBufferGeometry;
  private readonly spriteMat: THREE.ShaderMaterial;
  private readonly iA: THREE.InstancedBufferAttribute;
  private readonly iB: THREE.InstancedBufferAttribute;
  private readonly iC: THREE.InstancedBufferAttribute;
  private readonly iD: THREE.InstancedBufferAttribute;
  // Staging, filled unsorted, then copied in back-to-front order.
  private readonly sA = new Float32Array(MAX_SPRITES * 4);
  private readonly sB = new Float32Array(MAX_SPRITES * 4);
  private readonly sC = new Float32Array(MAX_SPRITES * 4);
  private readonly sD = new Float32Array(MAX_SPRITES * 4);
  private readonly keys = new Float64Array(MAX_SPRITES).fill(Infinity);
  private count = 0;
  private lastCount = 0;
  private readonly shadowGeo: THREE.InstancedBufferGeometry;
  private readonly iS: THREE.InstancedBufferAttribute;
  private shadowCount = 0;
  private readonly rings: Ring[] = [];
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null =
    null;
  private groundHalf = -1;
  private readonly groundTile: THREE.CanvasTexture;
  /** Static decor: x, z, cell offset, size. */
  private decor = new Float32Array(0);
  private decorHalf = -1;
  /** Menu critters: x, z, type, phase. */
  private readonly critters: Float32Array;
  private readonly prevHero = new Float32Array(MAX_HEROES * 3);
  private readonly shotCells = new Int16Array(MAX_HEROES * MAX_WEAPONS);
  private readonly shotBubble = new Uint8Array(MAX_HEROES * MAX_WEAPONS);
  private readonly heroColors: [number, number, number][] = [];
  // View rectangle on the ground, for culling.
  private cx = 0;
  private cz = 0;
  private halfW = 20;
  private halfD = 20;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(container: HTMLElement, options: ArtOptions) {
    this.localHero = options.localHero ?? 0;
    this.stage = new Stage(container);
    const { scene, renderer } = this.stage;

    this.sheetCanvas = document.createElement("canvas");
    this.sheetCanvas.width = SHEET;
    this.sheetCanvas.height = SHEET;
    this.layout = paintSheet(this.sheetCanvas, DEFAULT_SPEC);
    this.sheet = new THREE.CanvasTexture(this.sheetCanvas);
    this.sheet.premultiplyAlpha = true;
    this.sheet.colorSpace = THREE.NoColorSpace;
    this.sheet.generateMipmaps = true;
    this.sheet.minFilter = THREE.LinearMipmapLinearFilter;
    this.sheet.magFilter = THREE.LinearFilter;
    this.sheet.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const tileCanvas = document.createElement("canvas");
    tileCanvas.width = GROUND_TILE;
    tileCanvas.height = GROUND_TILE;
    paintGroundTile(tileCanvas);
    this.groundTile = new THREE.CanvasTexture(tileCanvas);
    this.groundTile.colorSpace = THREE.NoColorSpace;
    this.groundTile.wrapS = THREE.RepeatWrapping;
    this.groundTile.wrapT = THREE.RepeatWrapping;
    this.groundTile.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // Shadows.
    const shadowQuad = new THREE.PlaneGeometry(2, 2);
    this.shadowGeo = new THREE.InstancedBufferGeometry();
    this.shadowGeo.index = shadowQuad.index;
    this.shadowGeo.setAttribute(
      "position",
      shadowQuad.getAttribute("position")
    );
    this.iS = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_SHADOWS * 4),
      4
    );
    this.iS.setUsage(THREE.DynamicDrawUsage);
    this.shadowGeo.setAttribute("iS", this.iS);
    const shadows = new THREE.Mesh(
      this.shadowGeo,
      new THREE.ShaderMaterial({
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        depthTest: false,
      })
    );
    shadows.frustumCulled = false;
    shadows.renderOrder = 1;
    scene.add(shadows);

    // Rings: auras and hero markers.
    for (let i = 0; i < MAX_RINGS; i++) {
      // Premultiplied blending: rgb adds, alpha darkens. The aura writes alpha 0, so it adds light.
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({
          vertexShader: RING_VERT,
          fragmentShader: RING_FRAG,
          uniforms: {
            uColor: { value: new THREE.Vector3(1, 1, 1) },
            uPulse: { value: 0 },
            uTime: { value: 0 },
            uMarker: { value: 0 },
          },
          transparent: true,
          premultipliedAlpha: true,
          depthWrite: false,
          depthTest: false,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.03;
      mesh.renderOrder = 2;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh });
    }

    // Sprites.
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    this.spriteGeo = new THREE.InstancedBufferGeometry();
    this.spriteGeo.index = quad.index;
    this.spriteGeo.setAttribute("position", quad.getAttribute("position"));
    this.spriteGeo.setAttribute("uv", quad.getAttribute("uv"));
    const attr = (n: string) => {
      const a = new THREE.InstancedBufferAttribute(
        new Float32Array(MAX_SPRITES * 4),
        4
      );
      a.setUsage(THREE.DynamicDrawUsage);
      this.spriteGeo.setAttribute(n, a);
      return a;
    };
    this.iA = attr("iA");
    this.iB = attr("iB");
    this.iC = attr("iC");
    this.iD = attr("iD");
    this.spriteMat = new THREE.ShaderMaterial({
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      uniforms: {
        uSheet: { value: this.sheet },
        uTime: { value: 0 },
        uRight: { value: this.right },
        uUp: { value: this.up },
      },
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
    });
    const sprites = new THREE.Mesh(this.spriteGeo, this.spriteMat);
    sprites.frustumCulled = false;
    sprites.renderOrder = 3;
    scene.add(sprites);

    // Menu critters, scattered over the default arena.
    const r = rng(99);
    this.critters = new Float32Array(220 * 4);
    for (let i = 0; i < 220; i++) {
      this.critters[i * 4] = (r() * 2 - 1) * 56;
      this.critters[i * 4 + 1] = (r() * 2 - 1) * 56;
      const roll = r();
      this.critters[i * 4 + 2] =
        roll < 0.45 ? 0 : roll < 0.75 ? 1 : roll < 0.88 ? 2 : 3;
      this.critters[i * 4 + 3] = r() * 100;
    }
  }

  render(world: World | null, timeSeconds: number): void {
    this.count = 0;
    this.shadowCount = 0;
    for (const ring of this.rings) {
      ring.mesh.visible = false;
    }
    if (world) {
      this.drawWorld(world, timeSeconds);
    } else {
      this.drawMenu(timeSeconds);
    }
    this.flush(timeSeconds);
    this.stage.render();
  }

  dispose(): void {
    this.sheet.dispose();
    this.groundTile.dispose();
    this.stage.dispose();
  }

  // ---------------------------------------------------------------- camera and ground

  private placeCamera(x: number, z: number) {
    if (CAM_PIN) {
      x = CAM_PIN[0]!;
      z = CAM_PIN[1]!;
    }
    const cam = this.stage.camera;
    cam.position.set(
      x,
      Math.cos(TILT) * CAM_DIST,
      z + Math.sin(TILT) * CAM_DIST
    );
    cam.lookAt(x, 0, z);
    cam.updateMatrixWorld();
    this.right.setFromMatrixColumn(cam.matrixWorld, 0);
    this.up.setFromMatrixColumn(cam.matrixWorld, 1);
    this.cx = x;
    this.cz = z;
    this.halfW = (cam.right - cam.left) / 2 + 3;
    this.halfD = (cam.top - cam.bottom) / 2 / COS_TILT + 3;
  }

  private visible(x: number, z: number) {
    return (
      Math.abs(x - this.cx) < this.halfW &&
      Math.abs(z - this.cz + 1) < this.halfD
    );
  }

  private ensureGround(half: number) {
    if (this.groundHalf === half) {
      return;
    }
    this.groundHalf = half;
    if (this.ground) {
      this.ground.removeFromParent();
      this.ground.geometry.dispose();
      this.ground.material.dispose();
    }
    const size = (half + 40) * 2;
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.ShaderMaterial({
        vertexShader: GROUND_VERT,
        fragmentShader: GROUND_FRAG,
        uniforms: { uTile: { value: this.groundTile }, uHalf: { value: half } },
        depthWrite: false,
      })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.renderOrder = 0;
    this.stage.scene.add(this.ground);
    this.buildDecor(half);
  }

  private buildDecor(half: number) {
    if (this.decorHalf === half) {
      return;
    }
    this.decorHalf = half;
    const r = rng(1234);
    const items: number[] = [];
    // Standing stones along the edge, just outside the flagstones.
    const step = 3.2;
    for (let s = -half; s <= half; s += step) {
      for (const [x, z] of [
        [s, -half - 0.9],
        [s, half + 0.9],
        [-half - 0.9, s],
        [half + 0.9, s],
      ] as const) {
        items.push(x + (r() - 0.5) * 0.4, z, DECOR.stone, 1.5 + r() * 0.35);
      }
    }
    // Bushes and stumps out in the wilds.
    for (let i = 0; i < 500; i++) {
      const x = (r() * 2 - 1) * (half + 22);
      const z = (r() * 2 - 1) * (half + 22);
      if (Math.max(Math.abs(x), Math.abs(z)) < half + 2.5) {
        continue;
      }
      items.push(x, z, r() < 0.7 ? DECOR.bush : DECOR.rock, 1.6 + r() * 1.4);
    }
    // Small scattered things inside, kept sparse so the fight reads.
    const inner = [
      DECOR.flowers,
      DECOR.flowers,
      DECOR.rock,
      DECOR.mushroom,
      DECOR.stump,
    ];
    for (let i = 0; i < 300; i++) {
      const x = (r() * 2 - 1) * (half - 3);
      const z = (r() * 2 - 1) * (half - 3);
      const kind = inner[Math.floor(r() * inner.length)]!;
      const size = kind === DECOR.stump ? 1.4 : 1.1 + r() * 0.35;
      items.push(x, z, kind, size);
    }
    this.decor = new Float32Array(items);
    void DECOR_COUNT;
  }

  // ---------------------------------------------------------------- staging

  private push(
    depth: number,
    x: number,
    z: number,
    size: number,
    lift: number,
    cell: number,
    flip: number,
    rot: number,
    flash: number,
    phase: number,
    freq: number,
    squash: number,
    rock: number,
    tr = 0,
    tg = 0,
    tb = 0,
    ta = 0
  ) {
    const i = this.count;
    if (i >= MAX_SPRITES) {
      return;
    }
    this.count += 1;
    const o = i * 4;
    this.sA[o] = x;
    this.sA[o + 1] = z;
    this.sA[o + 2] = size;
    this.sA[o + 3] = lift;
    this.sB[o] = cell;
    this.sB[o + 1] = flip;
    this.sB[o + 2] = rot;
    this.sB[o + 3] = flash;
    this.sC[o] = phase;
    this.sC[o + 1] = freq;
    this.sC[o + 2] = squash;
    this.sC[o + 3] = rock;
    this.sD[o] = tr;
    this.sD[o + 1] = tg;
    this.sD[o + 2] = tb;
    this.sD[o + 3] = ta;
    // Back (small z) first; index packed below so equal depths stay stable.
    this.keys[i] = Math.floor((depth + 3000) * 64) * 8192 + i;
  }

  private shadow(x: number, z: number, radius: number, strength: number) {
    if (this.shadowCount >= MAX_SHADOWS) {
      return;
    }
    const o = this.shadowCount * 4;
    this.iS.array[o] = x;
    this.iS.array[o + 1] = z;
    this.iS.array[o + 2] = radius;
    this.iS.array[o + 3] = strength;
    this.shadowCount += 1;
  }

  private flush(t: number) {
    const n = this.count;
    for (let i = n; i < this.lastCount; i++) {
      this.keys[i] = Infinity;
    }
    this.lastCount = n;
    this.keys.sort();
    const a = this.iA.array as Float32Array;
    const b = this.iB.array as Float32Array;
    const c = this.iC.array as Float32Array;
    const d = this.iD.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const src = (this.keys[k]! % 8192) * 4;
      const dst = k * 4;
      for (let j = 0; j < 4; j++) {
        a[dst + j] = this.sA[src + j]!;
        b[dst + j] = this.sB[src + j]!;
        c[dst + j] = this.sC[src + j]!;
        d[dst + j] = this.sD[src + j]!;
      }
    }
    // The keys were overwritten in sorted order: reset them to "unused" next frame.
    for (const attr of [this.iA, this.iB, this.iC, this.iD]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, n) * 4);
      attr.needsUpdate = true;
    }
    this.spriteGeo.instanceCount = n;
    this.iS.clearUpdateRanges();
    this.iS.addUpdateRange(0, Math.max(1, this.shadowCount) * 4);
    this.iS.needsUpdate = true;
    this.shadowGeo.instanceCount = this.shadowCount;
    this.spriteMat.uniforms["uTime"]!.value = t;
  }

  private drawDecor(t: number) {
    const dec = this.decor;
    for (let i = 0; i < dec.length; i += 4) {
      const x = dec[i]!;
      const z = dec[i + 1]!;
      if (!this.visible(x, z)) {
        continue;
      }
      const kind = dec[i + 2]!;
      const size = dec[i + 3]!;
      const sway = kind === DECOR.tuft || kind === DECOR.flowers ? 0.06 : 0;
      this.push(
        z,
        x,
        z,
        size,
        -0.05 * size,
        this.layout.decor + kind,
        i % 8 < 4 ? 1 : -1,
        0,
        0,
        i * 0.37,
        2.2,
        0,
        sway
      );
      if (kind !== DECOR.tuft && kind !== DECOR.flowers) {
        this.shadow(x, z, size * 0.42, 0.3);
      }
    }
    void t;
  }

  // ---------------------------------------------------------------- the menu

  private drawMenu(t: number) {
    this.ensureGround(60);
    const x = Math.sin(t * 0.031) * 34;
    const z = Math.sin(t * 0.022 + 1) * 26;
    this.placeCamera(x, z);
    this.drawDecor(t);
    const c = this.critters;
    for (let i = 0; i < c.length; i += 4) {
      const ph = c[i + 3]!;
      const cxp = c[i]! + Math.cos(t * 0.4 + ph) * 2.5;
      const czp = c[i + 1]! + Math.sin(t * 0.33 + ph) * 2;
      if (!this.visible(cxp, czp)) {
        continue;
      }
      const type = c[i + 2]!;
      const id = DEFAULT_SPEC.enemies[type]!.id;
      const flip = -Math.sin(t * 0.4 + ph) >= 0 ? 1 : -1;
      this.enemySprite(
        id,
        this.layout.enemy[type]!,
        DEFAULT_RADII[type]!,
        cxp,
        czp,
        flip,
        0,
        ph,
        t
      );
    }
  }

  // ---------------------------------------------------------------- the run

  private repaint(world: World) {
    if (this.paintedFor === world.content) {
      return;
    }
    this.paintedFor = world.content;
    const { content } = world;
    this.layout = paintSheet(this.sheetCanvas, {
      heroes: content.heroes.map((h) => ({ id: h.id, color: h.color })),
      enemies: world.enemyDefs.map((e) => ({ id: e.id, color: e.color })),
      weapons: content.weapons.map((w) => ({
        id: w.id,
        color: w.color,
        kind: w.behavior.kind,
      })),
    });
    this.sheet.needsUpdate = true;
    this.heroIndex = new Map(content.heroes.map((h, i) => [h, i]));
    this.heroColors.length = 0;
    for (const h of content.heroes) {
      this.heroColors.push(srgb(h.color));
    }
  }

  private enemySprite(
    id: string,
    cell: number,
    radius: number,
    x: number,
    z: number,
    flip: number,
    flash: number,
    phase: number,
    t: number
  ) {
    const look = LOOKS[id] ?? LOOKS["slime"]!;
    const size = radius * look.size;
    const s = Math.sin(t * look.freq * 0.5 + phase);
    const lift =
      look.lift +
      (id === "slime" ? Math.abs(s) * look.hop : (s * 0.5 + 0.5) * look.hop);
    let frame = 0;
    if (look.frameRate > 0) {
      frame = Math.floor(t * look.frameRate + phase) & 1;
    } else if ((t * 0.6 + phase * 0.31) % 4 < 0.18) {
      frame = 1; // the slime blinks
    }
    this.push(
      z,
      x,
      z,
      size,
      lift - size * 0.04,
      cell + frame,
      flip,
      0,
      flash,
      phase,
      look.freq,
      look.squash,
      look.rock
    );
    const shrink = 1 - Math.min(0.35, lift * 0.25);
    this.shadow(x, z, radius * 1.15 * look.shadow * shrink, 0.5);
  }

  private drawWorld(world: World, t: number) {
    this.repaint(world);
    const half = world.content.rules.arenaHalfSize;
    this.ensureGround(half);
    const followed = world.heroes[this.localHero] ?? world.heroes[0]!;
    this.placeCamera(followed.x, followed.z);
    this.drawDecor(t);

    const coop = world.heroes.length > 1;

    // Heroes.
    let ring = 0;
    for (const hero of world.heroes) {
      const o = hero.slot * 3;
      const moved = Math.hypot(
        hero.x - this.prevHero[o]!,
        hero.z - this.prevHero[o + 1]!
      );
      // Smooth "is walking" so the bounce doesn't flicker frame to frame.
      this.prevHero[o + 2] =
        this.prevHero[o + 2]! * 0.85 + (moved > 0.001 ? 0.15 : 0);
      this.prevHero[o] = hero.x;
      this.prevHero[o + 1] = hero.z;
      if (hero.status === "left") {
        continue;
      }
      const defIndex = this.heroIndex.get(hero.def) ?? 0;
      const cell = this.layout.hero[defIndex] ?? this.layout.hero[0]!;
      const down = coop && hero.status === "down";
      const back = !down && hero.faceZ < -0.55 && Math.abs(hero.faceX) < 0.75;
      const flip = hero.faceX < -0.05 ? -1 : 1;
      const walk = down ? 0 : this.prevHero[o + 2]!;
      const size = PLAYER_RADIUS * 4;
      const hop = Math.abs(Math.sin(t * 9 + hero.slot)) * 0.16 * walk;
      const hurt = hero.hurtTimer > 0 && !down && Math.sin(t * 40) > -0.2;
      const shake = hurt ? Math.sin(t * 70) * 0.05 : 0;
      this.push(
        hero.z + 1000,
        hero.x + shake,
        hero.z,
        size,
        down ? -size * 0.18 : hop - size * 0.03,
        cell + (back ? 1 : 0),
        flip,
        down ? (Math.PI / 2) * flip : 0,
        0,
        hero.slot * 1.7,
        down ? 0 : 9 + walk * 9,
        down ? 0 : 0.035 + walk * 0.06,
        down ? 0 : walk * 0.13,
        hurt ? 1 : 0,
        hurt ? 0.25 : 0,
        hurt ? 0.25 : 0,
        hurt ? 0.45 : down ? -0.85 : 0
      );
      this.shadow(hero.x, hero.z, 0.62 - hop * 0.6, 0.5);
      // A dashed marker ring in the hero's colour, so you can find yourself in the horde.
      if (ring < MAX_RINGS && !down) {
        const mesh = this.rings[ring]!.mesh;
        ring += 1;
        const [r, g, b] = this.heroColors[defIndex] ?? [1, 1, 1];
        mesh.visible = true;
        mesh.position.set(hero.x, 0.03, hero.z);
        mesh.scale.set(0.8, 0.8, 1);
        const u = mesh.material.uniforms;
        (u["uColor"]!.value as THREE.Vector3).set(r, g, b);
        u["uMarker"]!.value = 1;
        u["uTime"]!.value = t;
      }
      // Auras.
      if (hero.status !== "playing") {
        continue;
      }
      for (let w = 0; w < hero.weapons.length && ring < MAX_RINGS; w++) {
        const slot = hero.weapons[w]!;
        if (slot.def.behavior.kind !== "aura") {
          continue;
        }
        const mesh = this.rings[ring]!.mesh;
        ring += 1;
        const rad = auraRadius(hero, slot);
        const [r, g, b] = srgbCached(slot.def.color);
        mesh.visible = true;
        mesh.position.set(hero.x, 0.03, hero.z);
        mesh.scale.set(rad, rad, 1);
        const u = mesh.material.uniforms;
        (u["uColor"]!.value as THREE.Vector3).set(r, g, b);
        u["uMarker"]!.value = 0;
        u["uTime"]!.value = t;
        u["uPulse"]!.value = Math.max(0, 1 - slot.sinceFired * 3);
      }
    }

    // Enemies: each faces the nearest hero.
    const e = world.enemies.fields;
    for (let i = 0; i < world.enemies.count; i++) {
      const x = e.x[i]!;
      const z = e.z[i]!;
      if (!this.visible(x, z)) {
        continue;
      }
      const type = e.type[i]!;
      const def = world.enemyDefs[type]!;
      let best = Infinity;
      let dx = 1;
      for (const hero of world.heroes) {
        if (hero.status !== "playing") {
          continue;
        }
        const d = (hero.x - x) ** 2 + (hero.z - z) ** 2;
        if (d < best) {
          best = d;
          dx = hero.x - x;
        }
      }
      const flash = e.hitFlash[i]! > 0 ? 1 : 0;
      this.enemySprite(
        def.id,
        this.layout.enemy[type] ?? 0,
        def.radius,
        x,
        z,
        dx >= 0 ? 1 : -1,
        flash,
        (i * 2.399) % 6.283,
        t
      );
    }

    // Gems.
    const g = world.gems.fields;
    for (let i = 0; i < world.gems.count; i++) {
      const x = g.x[i]!;
      const z = g.z[i]!;
      if (!this.visible(x, z)) {
        continue;
      }
      const v = g.value[i]!;
      const tier = v >= 5 ? 2 : v >= 2 ? 1 : 0;
      const size = 0.55 + tier * 0.12;
      const bob = 0.12 + Math.sin(t * 4 + i) * 0.07;
      this.push(
        z - 0.2,
        x,
        z,
        size,
        bob,
        this.layout.gem + tier,
        1,
        Math.sin(t * 2 + i) * 0.15,
        0,
        i,
        0,
        0,
        0
      );
      this.shadow(x, z, size * 0.3, 0.35);
    }

    // Projectiles, always on top, turned along their flight.
    for (let s = 0; s < this.shotCells.length; s++) {
      this.shotCells[s] = -1;
    }
    for (const hero of world.heroes) {
      for (let w = 0; w < hero.weapons.length; w++) {
        const def = hero.weapons[w]!.def;
        const k = world.content.weapons.indexOf(def);
        this.shotCells[hero.slot * MAX_WEAPONS + w] = this.layout.shot[k] ?? -1;
        this.shotBubble[hero.slot * MAX_WEAPONS + w] = def.id.includes("bubble")
          ? 1
          : 0;
      }
    }
    const p = world.projectiles.fields;
    for (let i = 0; i < world.projectiles.count; i++) {
      const x = p.x[i]!;
      const z = p.z[i]!;
      if (!this.visible(x, z)) {
        continue;
      }
      const wi = p.weapon[i]!;
      const cell = this.shotCells[wi] ?? -1;
      if (cell < 0) {
        continue;
      }
      const bubble = this.shotBubble[wi] === 1;
      const size = bubble ? 0.8 : 1.35;
      const angle = Math.atan2(-p.vz[i]! * COS_TILT, p.vx[i]!);
      this.push(
        z + 2000,
        x,
        z,
        size,
        0.55 - size * 0.5,
        cell,
        1,
        bubble ? 0 : angle,
        0,
        i * 1.3,
        bubble ? 7 : 0,
        bubble ? 0.06 : 0,
        0
      );
      this.shadow(x, z, size * 0.25, 0.25);
    }
  }
}

const colorCache = new Map<string, [number, number, number]>();
const srgbCached = (c: string) => {
  let v = colorCache.get(c);
  if (!v) {
    v = srgb(c);
    colorCache.set(c, v);
  }
  return v;
};

export const makeView = (
  container: HTMLElement,
  options: ArtOptions
): GameView<World> => new CartoonView(container, options);
