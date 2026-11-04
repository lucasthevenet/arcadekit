// PROTOTYPE (#24 art), variant B: low-poly 3D. Chunky faceted models built in code, flat shading,
// a warm sun with a cool sky fill, fake drop shadows as instanced soft discs, and glowing decals.
// Every numerous thing is one InstancedMesh: one per enemy type, gems, projectiles (core + halo),
// shadows, ground glows and each kind of scenery prop. Heroes (at most 4) are small groups.
import type { GameView } from "@gamekit/runtime/browser";
import { auraRadius } from "@gamekit/survivors";
import type { Hero, World, WeaponDef } from "@gamekit/survivors";
import * as THREE from "three";

import type { ArtOptions } from "./options";
import {
  batGeometry,
  flowerGeometry,
  gemGeometry,
  golemGeometry,
  heroGeometry,
  pineGeometry,
  rng,
  rockGeometry,
  slimeGeometry,
  tuftGeometry,
  wraithGeometry,
} from "./variant-b-models";

export const name = "Low-poly 3D";

export const makeView = (
  container: HTMLElement,
  options: ArtOptions
): GameView<World> => new LowPolyView(container, options);

const MAX_WEAPONS = 4;
const MAX_AURAS = 16;
const CAMERA = { x: 0, y: 17, z: 12.5 };
const SKY = "#7fa7c4";
const DOWN_TINT = 1;

// ---------------------------------------------------------------- shaders

interface Uniform<T> {
  value: T;
}

/**
 * Lit, flat-shaded, vertex-coloured material. Reads the model attributes (aGlow, aWing, aSway)
 * and, on instanced enemies, per-instance aPhase and aFlash. Heroes use uHurt and uGrey instead.
 */
const modelMaterial = (
  time: Uniform<number>,
  extra: {
    side?: THREE.Side;
    hurt?: Uniform<number>;
    grey?: Uniform<number>;
  } = {}
) => {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: extra.side ?? THREE.FrontSide,
  });
  const hurt = extra.hurt ?? { value: 0 };
  const grey = extra.grey ?? { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms["uTime"] = time;
    shader.uniforms["uHurt"] = hurt;
    shader.uniforms["uGrey"] = grey;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime;
        attribute float aGlow; attribute float aWing; attribute float aSway;
        attribute float aPhase; attribute float aFlash;
        varying float vGlow; varying float vFlash;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vGlow = aGlow; vFlash = aFlash;
        float ph = uTime + aPhase;
        if (aWing > 0.0) {
          float a = (sin(ph * 15.0) * 0.8 + 0.1) * sign(transformed.x) * aWing;
          float c = cos(a); float s = sin(a);
          transformed.xy = vec2(c * transformed.x - s * transformed.y, s * transformed.x + c * transformed.y);
        }
        transformed.x += sin(ph * 4.0 + transformed.y * 3.5) * 0.14 * aSway;
        transformed.z += cos(ph * 3.0 + transformed.y * 3.0) * 0.1 * aSway;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uHurt; uniform float uGrey;
        varying float vGlow; varying float vFlash;`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum * 0.75 + 0.05), uGrey);
        totalEmissiveRadiance += diffuseColor.rgb * vGlow * (1.0 - uGrey);
        float flash = max(vFlash, 0.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), flash * 0.8);
        totalEmissiveRadiance += vec3(1.0, 0.96, 0.9) * flash * 0.7;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.3, 0.25), uHurt * 0.3);
        totalEmissiveRadiance += vec3(0.8, 0.1, 0.06) * uHurt * 0.45;`
      );
  };
  return material;
};

/** A flat-shaded material that also glows in its own (instance) colour: gems. */
const crystalMaterial = () => {
  const material = new THREE.MeshStandardMaterial({
    flatShading: true,
    roughness: 0.25,
    metalness: 0.1,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      totalEmissiveRadiance += diffuseColor.rgb * 0.55;`
    );
  };
  return material;
};

// ---------------------------------------------------------------- textures (painted at startup)

const canvasTexture = (
  size: number,
  paint: (g: CanvasRenderingContext2D, s: number) => void
) => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  paint(canvas.getContext("2d")!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const radial = (stops: [number, string][]) =>
  canvasTexture(128, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [at, color] of stops) {
      grad.addColorStop(at, color);
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

const auraTexture = () =>
  canvasTexture(512, (g, s) => {
    const c = s / 2;
    const fill = g.createRadialGradient(c, c, 0, c, c, c);
    fill.addColorStop(0, "rgba(255,255,255,0.05)");
    fill.addColorStop(0.7, "rgba(255,255,255,0.18)");
    fill.addColorStop(0.9, "rgba(255,255,255,0.42)");
    fill.addColorStop(0.95, "rgba(255,255,255,0.95)");
    fill.addColorStop(0.985, "rgba(255,255,255,0.3)");
    fill.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = fill;
    g.fillRect(0, 0, s, s);
    // A ring of runes: little diamonds and dashes.
    g.strokeStyle = "rgba(255,255,255,0.55)";
    g.lineWidth = s * 0.006;
    g.beginPath();
    g.arc(c, c, c * 0.8, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "rgba(255,255,255,0.75)";
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      g.save();
      g.translate(c + Math.cos(a) * c * 0.865, c + Math.sin(a) * c * 0.865);
      g.rotate(a);
      if (i % 3 === 0) {
        g.beginPath();
        g.moveTo(-s * 0.018, 0);
        g.lineTo(0, -s * 0.012);
        g.lineTo(s * 0.018, 0);
        g.lineTo(0, s * 0.012);
        g.fill();
      } else {
        g.fillRect(-s * 0.004, -s * 0.014, s * 0.008, s * 0.028);
      }
      g.restore();
    }
  });

// ---------------------------------------------------------------- instancing helpers

const flatPlane = (size: number) => {
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  return g;
};

const instanced = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  colors = false
) => {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (colors) {
    mesh.setColorAt(0, new THREE.Color("#ffffff"));
  }
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
};

/** Writes a flat decal transform (uniform xz scale, optional yaw) without a Matrix4. */
const setFlat = (
  mesh: THREE.InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sz = sx,
  yaw = 0
) => {
  const a = mesh.instanceMatrix.array as Float32Array;
  const o = index * 16;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  a[o] = c * sx;
  a[o + 1] = 0;
  a[o + 2] = -s * sx;
  a[o + 3] = 0;
  a[o + 4] = 0;
  a[o + 5] = 1;
  a[o + 6] = 0;
  a[o + 7] = 0;
  a[o + 8] = s * sz;
  a[o + 9] = 0;
  a[o + 10] = c * sz;
  a[o + 11] = 0;
  a[o + 12] = x;
  a[o + 13] = y;
  a[o + 14] = z;
  a[o + 15] = 1;
};

const setColor = (
  mesh: THREE.InstancedMesh,
  index: number,
  c: THREE.Color,
  k = 1
) => {
  const a = mesh.instanceColor!.array as Float32Array;
  a[index * 3] = c.r * k;
  a[index * 3 + 1] = c.g * k;
  a[index * 3 + 2] = c.b * k;
};

const commit = (mesh: THREE.InstancedMesh, count: number) => {
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
};

// ---------------------------------------------------------------- enemies

type EnemyKind = "slime" | "bat" | "golem" | "wraith";

interface EnemyType {
  kind: EnemyKind;
  radius: number;
  mesh: THREE.InstancedMesh;
  phase: THREE.InstancedBufferAttribute;
  flash: THREE.InstancedBufferAttribute;
}

const enemyKind = (id: string): EnemyKind =>
  id === "bat" || id === "golem" || id === "wraith" ? id : "slime";

const DECALS = 2048;

/** Per-instance motion, written by `animate` (reused, so the frame allocates nothing). */
const MOTION = { y: 0, sx: 1, sy: 1, pitch: 0, roll: 0 };

/** Cheap motion per kind: hop and squash, hover, waddle, float. Returns the shadow size. */
const animate = (
  kind: EnemyKind,
  r: number,
  t: number,
  phase: number,
  m: typeof MOTION
): number => {
  m.sx = 1;
  m.sy = 1;
  switch (kind) {
    case "slime": {
      const p = (t * 1.7 + phase) % 1;
      const hop = Math.sin(p * Math.PI);
      m.y = hop * hop * 0.35 * r;
      m.sy = 1 + Math.cos(p * Math.PI * 2) * -0.16 + hop * 0.06;
      m.sx = 1 / Math.sqrt(m.sy);
      m.pitch = hop * 0.12;
      m.roll = 0;
      return r * (1.3 - hop * 0.25);
    }
    case "bat": {
      m.y = r * 2.2 + Math.sin(t * 7.5 + phase) * 0.12;
      m.pitch = 0.3;
      m.roll = Math.sin(t * 2.3 + phase) * 0.18;
      return r * 1.2;
    }
    case "golem": {
      const w = Math.sin(t * 4.2 + phase);
      m.roll = w * 0.09;
      m.y = Math.abs(w) * 0.05;
      m.pitch = 0.06;
      return r * 1.45;
    }
    default: {
      m.y = r * 0.45 + Math.sin(t * 2.2 + phase) * 0.12;
      m.pitch = 0.32;
      m.roll = Math.sin(t * 1.7 + phase) * 0.08;
      return r * 0.9;
    }
  }
};

const ENEMY_GEOMETRY: Record<
  EnemyKind,
  (color: string) => THREE.BufferGeometry
> = {
  slime: slimeGeometry,
  bat: batGeometry,
  golem: golemGeometry,
  wraith: wraithGeometry,
};

// ---------------------------------------------------------------- heroes

interface HeroFigure {
  id: string;
  root: THREE.Group;
  pose: THREE.Group;
  legs: THREE.Object3D[];
  cape: THREE.Object3D;
  hand: THREE.Object3D;
  hurt: Uniform<number>;
  grey: Uniform<number>;
  ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  lastX: number;
  lastZ: number;
  walk: number;
  speed: number;
  yaw: number;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, "YXZ");
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const WHITE = new THREE.Color("#ffffff");
const GEM_COLORS = [
  new THREE.Color("#4fd8ff"),
  new THREE.Color("#6dff8e"),
  new THREE.Color("#ff6fd8"),
];

class LowPolyView implements GameView<World> {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly localHero: number;
  private readonly time: Uniform<number> = { value: 0 };
  private lastT = 0;

  private readonly shadowTex = radial([
    [0, "rgba(0,0,0,0.75)"],
    [0.5, "rgba(0,0,0,0.5)"],
    [1, "rgba(0,0,0,0)"],
  ]);
  private readonly glowTex = radial([
    [0, "rgba(255,255,255,1)"],
    [0.25, "rgba(255,255,255,0.5)"],
    [1, "rgba(255,255,255,0)"],
  ]);
  private readonly shadows: THREE.InstancedMesh;
  private readonly glows: THREE.InstancedMesh;
  private readonly gems: THREE.InstancedMesh;
  private readonly bolts: THREE.InstancedMesh;
  private readonly orbs: THREE.InstancedMesh;
  private readonly halos: THREE.InstancedMesh;
  private readonly auras: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >[] = [];
  private readonly heroes: HeroFigure[] = [];
  private enemyTypes: EnemyType[] = [];
  private enemyWorld: World | null = null;
  private enemyCounts = new Int32Array(0);
  private ground: THREE.Group | null = null;
  private groundSize = -1;
  private weaponColors: (THREE.Color | undefined)[] = [];
  private weaponDefs: (WeaponDef | undefined)[] = [];
  private paletteWorld: World | null = null;
  private shadowCount = 0;
  private glowCount = 0;
  private readonly heroX = new Float32Array(4);
  private readonly heroZ = new Float32Array(4);

  constructor(container: HTMLElement, options: ArtOptions) {
    this.container = container;
    this.localHero = options.localHero ?? 0;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "display:block;width:100%;height:100%";
    container.append(canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const { scene } = this;
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 26, 62);
    // Warm sun, cool sky: the pair that sells the low-poly look.
    scene.add(new THREE.HemisphereLight("#bcd6ff", "#4a3a28", 1.25));
    const sun = new THREE.DirectionalLight("#ffd49a", 2.3);
    sun.position.set(-7, 14, 9);
    scene.add(sun);
    const rim = new THREE.DirectionalLight("#86b4ff", 1.4);
    rim.position.set(8, 6, -10);
    scene.add(rim);

    this.shadows = instanced(
      flatPlane(2),
      new THREE.MeshBasicMaterial({
        map: this.shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.8,
      }),
      2048
    );
    this.shadows.renderOrder = 1;
    this.glows = instanced(
      flatPlane(2),
      new THREE.MeshBasicMaterial({
        map: this.glowTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.4,
        fog: false,
      }),
      2048,
      true
    );
    this.glows.renderOrder = 2;
    this.gems = instanced(gemGeometry(), crystalMaterial(), 1024, true);

    const bolt = new THREE.OctahedronGeometry(0.16, 0);
    bolt.scale(0.7, 0.7, 2.6);
    this.bolts = instanced(
      bolt,
      new THREE.MeshBasicMaterial({ fog: false }),
      512,
      true
    );
    this.orbs = instanced(
      new THREE.IcosahedronGeometry(0.2, 1),
      new THREE.MeshBasicMaterial({ fog: false }),
      512,
      true
    );
    this.halos = instanced(
      new THREE.IcosahedronGeometry(0.42, 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
      512,
      true
    );
    this.halos.renderOrder = 3;
    scene.add(
      this.shadows,
      this.glows,
      this.gems,
      this.bolts,
      this.orbs,
      this.halos
    );

    const auraTex = auraTexture();
    const auraGeo = flatPlane(2);
    for (let i = 0; i < MAX_AURAS; i++) {
      const aura = new THREE.Mesh(
        auraGeo,
        new THREE.MeshBasicMaterial({
          map: auraTex,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      aura.renderOrder = 2;
      aura.visible = false;
      this.auras.push(aura);
      scene.add(aura);
    }
  }

  render(world: World | null, timeSeconds: number): void {
    const dt = Math.min(0.1, Math.max(0, timeSeconds - this.lastT));
    this.lastT = timeSeconds;
    this.time.value = timeSeconds;
    if (world) {
      this.drawWorld(world, timeSeconds, dt);
    } else {
      this.drawMenu(timeSeconds);
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const materials: THREE.Material[] = Array.isArray(o.material)
          ? o.material
          : [o.material];
        for (const m of materials) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        }
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ menu

  private drawMenu(t: number) {
    this.ensureGround(60);
    for (const h of this.heroes) {
      h.root.visible = false;
    }
    for (const e of this.enemyTypes) {
      e.mesh.count = 0;
    }
    for (const m of [
      this.shadows,
      this.glows,
      this.gems,
      this.bolts,
      this.orbs,
      this.halos,
    ]) {
      m.count = 0;
    }
    for (const a of this.auras) {
      a.visible = false;
    }
    // A slow pan along the north wall: boulders, the pine forest and the hills behind.
    const half = this.groundSize;
    const x = Math.sin(t * 0.03) * (half - 15);
    this.camera.position.set(x, 9, -half + 16);
    this.camera.lookAt(x + 3, 0.5, -half - 3);
  }

  // ------------------------------------------------------------ the run

  private drawWorld(world: World, t: number, dt: number) {
    this.ensureGround(world.content.rules.arenaHalfSize);
    this.updatePalette(world);
    this.shadowCount = 0;
    this.glowCount = 0;
    const targets = this.drawHeroes(world, t, dt);
    this.drawEnemies(world, t, targets);
    this.drawGems(world, t);
    this.drawProjectiles(world, t);
    this.drawAuras(world, t);
    commit(this.shadows, this.shadowCount);
    commit(this.glows, this.glowCount);

    const followed = world.heroes[this.localHero] ?? world.heroes[0]!;
    this.camera.position.set(
      followed.x + CAMERA.x,
      CAMERA.y,
      followed.z + CAMERA.z
    );
    this.camera.lookAt(followed.x, 0, followed.z + 0.8);
  }

  private addShadow(x: number, z: number, size: number) {
    if (this.shadowCount < DECALS) {
      setFlat(this.shadows, this.shadowCount, x, 0.07, z, size);
      this.shadowCount += 1;
    }
  }

  private addGlow(
    x: number,
    z: number,
    size: number,
    color: THREE.Color,
    k: number
  ) {
    if (this.glowCount < DECALS) {
      setFlat(this.glows, this.glowCount, x, 0.09, z, size);
      setColor(this.glows, this.glowCount, color, k);
      this.glowCount += 1;
    }
  }

  /** Poses every hero; returns how many chase targets (playing heroes) it stored. */
  private drawHeroes(world: World, t: number, dt: number): number {
    for (const h of this.heroes) {
      h.root.visible = false;
    }
    const coop = world.heroes.length > 1;
    let targets = 0;
    for (const hero of world.heroes) {
      if (hero.status === "playing" && targets < 4) {
        this.heroX[targets] = hero.x;
        this.heroZ[targets] = hero.z;
        targets += 1;
      }
      if (hero.status !== "left") {
        const f = this.heroFigure(hero);
        poseHero(f, hero, coop, t, dt);
        // The colour ring under a hero, so it reads inside the crowd.
        f.ring.visible = hero.status === "playing";
        if (!(coop && hero.status === "down")) {
          this.addShadow(hero.x, hero.z, 0.62);
        }
      }
    }
    if (targets === 0 && world.heroes[0]) {
      this.heroX[0] = world.heroes[0].x;
      this.heroZ[0] = world.heroes[0].z;
      targets = 1;
    }
    return targets;
  }

  /** Enemies: one InstancedMesh per type, each facing the nearest hero it chases. */
  private drawEnemies(world: World, t: number, targets: number) {
    const types = this.enemyTypesFor(world);
    const counts = this.enemyCounts;
    counts.fill(0);
    const e = world.enemies.fields;
    for (let i = 0; i < world.enemies.count; i++) {
      const typeIndex = e.type[i]!;
      const type = types[typeIndex]!;
      const slot = counts[typeIndex]!;
      counts[typeIndex] = slot + 1;
      const x = e.x[i]!;
      const z = e.z[i]!;
      let best = Infinity;
      let dx = 0;
      let dz = 1;
      for (let h = 0; h < targets; h++) {
        const ax = this.heroX[h]! - x;
        const az = this.heroZ[h]! - z;
        const d = ax * ax + az * az;
        if (d < best) {
          best = d;
          dx = ax;
          dz = az;
        }
      }
      const phase = ((i * 0.618) % 1) * 12.566;
      const flash = e.hitFlash[i]! > 0 ? 1 : 0;
      const shadow = animate(type.kind, type.radius, t, phase, MOTION);
      const pop = type.radius * (1 + flash * 0.12);
      tmpQuat.setFromEuler(
        tmpEuler.set(MOTION.pitch, Math.atan2(dx, dz), MOTION.roll, "YXZ")
      );
      tmpScale.set(pop * MOTION.sx, pop * MOTION.sy, pop * MOTION.sx);
      tmpMatrix.compose(tmpPos.set(x, MOTION.y, z), tmpQuat, tmpScale);
      type.mesh.setMatrixAt(slot, tmpMatrix);
      (type.phase.array as Float32Array)[slot] = phase;
      (type.flash.array as Float32Array)[slot] = flash;
      this.addShadow(x, z, shadow);
    }
    for (const [k, type] of types.entries()) {
      commit(type.mesh, counts[k]!);
      type.phase.needsUpdate = true;
      type.flash.needsUpdate = true;
    }
  }

  /** Gems: faceted crystals that bob and spin, with a small glow pool under each. */
  private drawGems(world: World, t: number) {
    const g = world.gems.fields;
    for (let i = 0; i < world.gems.count; i++) {
      const v = g.value[i]!;
      let tier = 0;
      if (v >= 5) {
        tier = 2;
      } else if (v >= 3) {
        tier = 1;
      }
      const color = GEM_COLORS[tier]!;
      const s = 1 + tier * 0.25;
      tmpQuat.setFromEuler(tmpEuler.set(0, t * 2.2 + i, 0.25, "YXZ"));
      tmpMatrix.compose(
        tmpPos.set(g.x[i]!, 0.45 + Math.sin(t * 3.5 + i) * 0.1, g.z[i]!),
        tmpQuat,
        tmpScale.set(s, s, s)
      );
      this.gems.setMatrixAt(i, tmpMatrix);
      setColor(this.gems, i, color);
      this.addGlow(g.x[i]!, g.z[i]!, 0.55 * s, color, 0.7);
    }
    commit(this.gems, world.gems.count);
  }

  /** Projectiles: darts for fast bolts, orbs for slow ones; an additive halo and a light pool. */
  private drawProjectiles(world: World, t: number) {
    const pr = world.projectiles.fields;
    let darts = 0;
    let orbs = 0;
    for (let i = 0; i < world.projectiles.count; i++) {
      const w = pr.weapon[i]!;
      const color = this.weaponColors[w] ?? WHITE;
      const def = this.weaponDefs[w];
      const fast =
        def?.behavior.kind === "bolt"
          ? def.behavior.projectileSpeed >= 15
          : true;
      const x = pr.x[i]!;
      const z = pr.z[i]!;
      const yaw = Math.atan2(pr.vx[i]!, pr.vz[i]!);
      tmpQuat.setFromEuler(tmpEuler.set(0, yaw, fast ? 0 : t * 3, "YXZ"));
      tmpPos.set(x, 0.75, z);
      if (fast) {
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale.set(1, 1, 1));
        this.bolts.setMatrixAt(darts, tmpMatrix);
        setColor(this.bolts, darts, color, 1.3);
        darts += 1;
      } else {
        const wob = 1 + Math.sin(t * 9 + i) * 0.08;
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale.set(wob, 1 / wob, wob));
        this.orbs.setMatrixAt(orbs, tmpMatrix);
        setColor(this.orbs, orbs, color, 1.2);
        orbs += 1;
      }
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale.set(1, 1, fast ? 1.8 : 1));
      this.halos.setMatrixAt(i, tmpMatrix);
      setColor(this.halos, i, color);
      this.addGlow(x, z, fast ? 0.9 : 1.1, color, 0.8);
    }
    commit(this.bolts, darts);
    commit(this.orbs, orbs);
    commit(this.halos, world.projectiles.count);
  }

  /** Auras: a glowing rune circle on the ground that flares on each damage pulse. */
  private drawAuras(world: World, t: number) {
    let auraIndex = 0;
    for (const hero of world.heroes) {
      for (let w = 0; w < hero.weapons.length; w++) {
        const slot = hero.weapons[w]!;
        if (
          hero.status === "playing" &&
          slot.def.behavior.kind === "aura" &&
          auraIndex < MAX_AURAS
        ) {
          const aura = this.auras[auraIndex]!;
          auraIndex += 1;
          const radius = auraRadius(hero, slot);
          const pulse = Math.max(0, 1 - slot.sinceFired * 3);
          const s = radius * (1 + pulse * 0.04);
          aura.visible = true;
          aura.position.set(hero.x, 0.1 + auraIndex * 0.005, hero.z);
          aura.scale.set(s, 1, s);
          aura.rotation.y = t * 0.4 * (auraIndex % 2 ? 1 : -1);
          aura.material.color.copy(
            this.weaponColors[hero.slot * MAX_WEAPONS + w] ?? WHITE
          );
          aura.material.opacity = 0.55 + pulse * 0.6;
        }
      }
    }
    for (let i = auraIndex; i < MAX_AURAS; i++) {
      this.auras[i]!.visible = false;
    }
  }

  private updatePalette(world: World) {
    if (this.paletteWorld !== world) {
      this.paletteWorld = world;
      this.weaponColors = [];
      this.weaponDefs = [];
    }
    for (const hero of world.heroes) {
      for (let w = 0; w < hero.weapons.length; w++) {
        const index = hero.slot * MAX_WEAPONS + w;
        this.weaponDefs[index] ??= hero.weapons[w]!.def;
        this.weaponColors[index] ??= new THREE.Color(
          hero.weapons[w]!.def.color
        );
      }
    }
  }

  private enemyTypesFor(world: World): EnemyType[] {
    if (this.enemyWorld === world) {
      return this.enemyTypes;
    }
    const { capacity } = world.enemies;
    if (
      this.enemyTypes.length === world.enemyDefs.length &&
      this.enemyTypes.every(
        (t, k) =>
          t.kind === enemyKind(world.enemyDefs[k]!.id) &&
          t.mesh.instanceMatrix.count === capacity
      )
    ) {
      this.enemyWorld = world;
      return this.enemyTypes;
    }
    for (const t of this.enemyTypes) {
      t.mesh.removeFromParent();
      t.mesh.geometry.dispose();
      (t.mesh.material as THREE.Material).dispose();
    }
    this.enemyTypes = world.enemyDefs.map((def) => {
      const kind = enemyKind(def.id);
      const geometry = ENEMY_GEOMETRY[kind](def.color);
      const phase = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity),
        1
      );
      const flash = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity),
        1
      );
      phase.setUsage(THREE.DynamicDrawUsage);
      flash.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("aPhase", phase);
      geometry.setAttribute("aFlash", flash);
      const mesh = instanced(
        geometry,
        modelMaterial(this.time, {
          side: kind === "bat" ? THREE.DoubleSide : THREE.FrontSide,
        }),
        capacity
      );
      this.scene.add(mesh);
      return { kind, radius: def.radius, mesh, phase, flash };
    });
    this.enemyCounts = new Int32Array(this.enemyTypes.length);
    this.enemyWorld = world;
    return this.enemyTypes;
  }

  // ------------------------------------------------------------ heroes

  private heroFigure(hero: Hero): HeroFigure {
    const existing = this.heroes[hero.slot];
    if (existing?.id === hero.def.id) {
      return existing;
    }
    if (existing) {
      existing.root.removeFromParent();
      existing.ring.removeFromParent();
    }
    const weaponColor = hero.weapons[0]?.def.color ?? hero.def.color;
    const parts = heroGeometry(hero.def.id, hero.def.color, weaponColor);
    const hurt = { value: 0 };
    const grey = { value: 0 };
    const material = modelMaterial(this.time, { hurt, grey });
    const root = new THREE.Group();
    const pose = new THREE.Group();
    root.add(pose);
    pose.scale.setScalar(1.3);
    pose.add(new THREE.Mesh(parts.body, material));
    const legs: THREE.Object3D[] = [];
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(parts.leg, material);
      leg.position.set(s * 0.12, 0.38, 0);
      legs.push(leg);
      pose.add(leg);
    }
    const cape = new THREE.Mesh(parts.cape, material);
    cape.position.set(0, 0.9, -0.24);
    pose.add(cape);
    const hand = new THREE.Mesh(parts.hand, material);
    hand.position.set(0.38, 0.62, 0.12);
    pose.add(hand);
    const ring = new THREE.Mesh(
      flatPlane(2),
      new THREE.MeshBasicMaterial({
        map: this.glowTex,
        color: hero.def.color,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.5,
      })
    );
    ring.renderOrder = 2;
    ring.position.y = 0.1;
    ring.scale.setScalar(1.1);
    root.add(ring);
    this.scene.add(root);
    const figure: HeroFigure = {
      id: hero.def.id,
      root,
      pose,
      legs,
      cape,
      hand,
      hurt,
      grey,
      ring,
      lastX: hero.x,
      lastZ: hero.z,
      walk: 0,
      speed: 0,
      yaw: Math.atan2(hero.faceX, hero.faceZ),
    };
    this.heroes[hero.slot] = figure;
    return figure;
  }

  // ------------------------------------------------------------ the ground

  private ensureGround(half: number) {
    if (this.groundSize === half) {
      return;
    }
    if (this.ground) {
      this.ground.removeFromParent();
      this.ground.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.groundSize = half;
    this.ground = buildGround(half, this.time);
    this.scene.add(this.ground);
  }
}

const poseHero = (
  f: HeroFigure,
  hero: Hero,
  coop: boolean,
  t: number,
  dt: number
) => {
  f.root.visible = true;
  const moved = Math.hypot(hero.x - f.lastX, hero.z - f.lastZ);
  f.lastX = hero.x;
  f.lastZ = hero.z;
  const speed = dt > 0 ? Math.min(1, moved / dt / 6) : 0;
  f.speed += (speed - f.speed) * Math.min(1, dt * 10);
  f.walk += dt * 11 * f.speed;
  const target = Math.atan2(hero.faceX, hero.faceZ);
  let d = target - f.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  f.yaw += d * Math.min(1, dt * 14);
  const down = coop && hero.status === "down";
  f.root.position.set(hero.x, 0, hero.z);
  f.grey.value = down ? DOWN_TINT : 0;
  f.hurt.value = !down && hero.hurtTimer > 0 && Math.sin(t * 50) > 0 ? 0.8 : 0;
  if (down) {
    f.root.rotation.set(0, f.yaw, 0);
    f.pose.rotation.set(Math.PI / 2, 0, 0);
    f.pose.position.set(0, 0.2, 0);
    for (const leg of f.legs) {
      leg.rotation.x = 0;
    }
    f.cape.rotation.x = 0;
    return;
  }
  const swing = Math.sin(f.walk) * 0.7 * f.speed;
  const bob =
    Math.abs(Math.cos(f.walk)) * 0.07 * f.speed + Math.sin(t * 2.5) * 0.015;
  f.root.rotation.set(0, f.yaw, 0);
  f.pose.rotation.set(0.12 * f.speed, 0, Math.sin(f.walk) * 0.04 * f.speed);
  f.pose.position.set(0, bob, 0);
  f.legs[0]!.rotation.x = swing;
  f.legs[1]!.rotation.x = -swing;
  f.cape.rotation.x = -0.15 - f.speed * 0.5 - Math.sin(t * 6 + f.walk) * 0.06;
  f.hand.rotation.x = -swing * 0.4;
};

// ---------------------------------------------------------------- terrain and scenery (static)

const tint = (k: number, hue = 0) =>
  new THREE.Color()
    .setHSL(0.25 + hue, 0.15, 0.5)
    .lerp(WHITE, 0.6)
    .multiplyScalar(k);

const hash = (x: number, z: number) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

const smooth = (x: number, z: number) => {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
};

const fbm = (x: number, z: number) =>
  smooth(x, z) * 0.6 +
  smooth(x * 2.1, z * 2.1) * 0.3 +
  smooth(x * 4.3, z * 4.3) * 0.1;

const buildGround = (half: number, time: Uniform<number>) => {
  const group = new THREE.Group();
  const random = rng(42);
  const extent = half + 40;
  const step = 1.6;
  const n = Math.ceil((extent * 2) / step);
  const outside = (x: number, z: number) =>
    Math.max(Math.abs(x), Math.abs(z)) - half;
  const height = (x: number, z: number) => {
    const d = outside(x, z);
    const wobble = fbm(x * 0.35, z * 0.35) - 0.5;
    if (d < 0) {
      return wobble * 0.14;
    }
    const rise = THREE.MathUtils.smoothstep(d, 1, 12);
    return wobble * 0.14 + rise * (2.2 + wobble * 3);
  };
  const grassA = new THREE.Color("#678c44");
  const grassB = new THREE.Color("#93984f");
  const grassDark = new THREE.Color("#4f6a3a");
  const dirt = new THREE.Color("#9b7b52");
  const forest = new THREE.Color("#3a5233");
  const stone = new THREE.Color("#8c8576");
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const pushTri = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number
  ) => {
    const mx = (ax + bx + cx) / 3;
    const mz = (az + bz + cz) / 3;
    const d = outside(mx, mz);
    const n1 = fbm(mx * 0.06 + 3, mz * 0.06 - 7);
    const n2 = fbm(mx * 0.09 - 11, mz * 0.09 + 5);
    if (d < -0.6) {
      c.copy(grassA).lerp(grassB, THREE.MathUtils.smoothstep(n1, 0.35, 0.7));
      c.lerp(grassDark, THREE.MathUtils.smoothstep(n2, 0.55, 0.8) * 0.8);
      const path = THREE.MathUtils.smoothstep(
        fbm(mx * 0.05 + 40, mz * 0.05 + 40),
        0.6,
        0.66
      );
      c.lerp(dirt, path * 0.85);
    } else if (d < 1.5) {
      c.copy(stone).lerp(grassDark, random() * 0.3);
    } else {
      c.copy(forest).lerp(grassDark, n1 * 0.6);
    }
    c.multiplyScalar(0.94 + random() * 0.12);
    for (const [x, z] of [
      [ax, az],
      [bx, bz],
      [cx, cz],
    ] as const) {
      pos.push(x, height(x, z), z);
      col.push(c.r, c.g, c.b);
    }
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x0 = -extent + i * step;
      const z0 = -extent + j * step;
      const x1 = x0 + step;
      const z1 = z0 + step;
      if ((i + j) % 2) {
        pushTri(x0, z0, x0, z1, x1, z0);
        pushTri(x1, z0, x0, z1, x1, z1);
      } else {
        pushTri(x0, z0, x0, z1, x1, z1);
        pushTri(x0, z0, x1, z1, x1, z0);
      }
    }
  }
  const terrain = new THREE.BufferGeometry();
  terrain.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  terrain.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  terrain.computeVertexNormals();
  group.add(
    new THREE.Mesh(
      terrain,
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
    )
  );

  const place = (
    geometry: THREE.BufferGeometry,
    spots: {
      x: number;
      z: number;
      s: number;
      tint: THREE.Color;
      tilt?: number;
    }[]
  ) => {
    // Static props are split into tiles so the frustum culls the ones off screen.
    const material = modelMaterial(time);
    const tiles = new Map<string, typeof spots>();
    for (const p of spots) {
      const key = `${Math.floor(p.x / 24)},${Math.floor(p.z / 24)}`;
      const tile = tiles.get(key) ?? [];
      tile.push(p);
      tiles.set(key, tile);
    }
    for (const tile of tiles.values()) {
      const mesh = new THREE.InstancedMesh(geometry, material, tile.length);
      for (const [k, p] of tile.entries()) {
        tmpQuat.setFromEuler(
          tmpEuler.set(
            p.tilt ?? 0,
            random() * Math.PI * 2,
            (p.tilt ?? 0) * 0.5,
            "YXZ"
          )
        );
        tmpMatrix.compose(
          tmpPos.set(p.x, height(p.x, p.z) - 0.02, p.z),
          tmpQuat,
          tmpScale.set(p.s, p.s, p.s)
        );
        mesh.setMatrixAt(k, tmpMatrix);
        mesh.setColorAt(k, p.tint);
      }
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  };
  const inArena = (margin: number) => ({
    x: (random() * 2 - 1) * (half - margin),
    z: (random() * 2 - 1) * (half - margin),
  });

  // The arena wall: a ring of boulders.
  const border: Parameters<typeof place>[1] = [];
  for (let side = 0; side < 4; side++) {
    for (let a = -half - 1; a <= half + 1; a += 1.1) {
      const off = 0.6 + random() * 1.4;
      const along = a + (random() - 0.5) * 0.6;
      const edge = side % 2 ? half + off : -half - off;
      const [x, z] = side < 2 ? [along, edge] : [edge, along];
      border.push({
        x,
        z,
        s: 1 + random() * 1.3,
        tint: tint(0.85 + random() * 0.3),
        tilt: random() * 0.4,
      });
    }
  }
  const pebbles: Parameters<typeof place>[1] = [];
  for (let k = 0; k < 260; k++) {
    pebbles.push({
      ...inArena(2),
      s: 0.25 + random() * 0.45,
      tint: tint(0.9 + random() * 0.2),
    });
  }
  place(rockGeometry(), [...border, ...pebbles]);

  const pines: Parameters<typeof place>[1] = [];
  while (pines.length < 1100) {
    const x = (random() * 2 - 1) * extent;
    const z = (random() * 2 - 1) * extent;
    const d = outside(x, z);
    if (d < 3 || random() > THREE.MathUtils.smoothstep(d, 2, 8)) {
      continue;
    }
    pines.push({
      x,
      z,
      s: 0.9 + random() * 0.9,
      tint: tint(0.8 + random() * 0.35, (random() - 0.5) * 0.08),
    });
  }
  place(pineGeometry(), pines);

  const tufts: Parameters<typeof place>[1] = [];
  for (let k = 0; k < 1500; k++) {
    tufts.push({
      ...inArena(1),
      s: 0.7 + random() * 0.8,
      tint: tint(0.85 + random() * 0.35, (random() - 0.5) * 0.1),
    });
  }
  place(tuftGeometry(), tufts);

  const petals = ["#ffffff", "#ffd1e8", "#ffe17a", "#b8c8ff", "#ff9a8a"].map(
    (h) => new THREE.Color(h)
  );
  const flowers: Parameters<typeof place>[1] = [];
  for (let cluster = 0; cluster < 110; cluster++) {
    const center = inArena(3);
    const color = petals[Math.floor(random() * petals.length)]!;
    for (let k = 0; k < 7; k++) {
      flowers.push({
        x: center.x + (random() - 0.5) * 2.6,
        z: center.z + (random() - 0.5) * 2.6,
        s: 0.8 + random() * 0.6,
        tint: color,
      });
    }
  }
  place(flowerGeometry(), flowers);
  return group;
};
