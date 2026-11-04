import {
  MeshInstances,
  Stage,
  followTarget,
  orbitAround,
} from "@gamekit/render-three";
import type { GameView } from "@gamekit/runtime/browser";
import * as THREE from "three";

import { MAX_HEROES, MAX_WEAPONS, auraRadius } from "../hero";
import type { Hero } from "../hero";
import type { World } from "../world";

const CAMERA_OFFSET = { x: 0, y: 20, z: 13 };
const MAX_AURAS = MAX_HEROES * MAX_WEAPONS;
const WHITE = new THREE.Color("#ffffff");
const HURT = "#ff4d4d";
const DOWN = "#5a5f6b";

export interface SurvivorsViewOptions {
  /** The slot of the hero the camera follows: this browser's player. Defaults to 0. */
  readonly localHero?: number;
}

interface HeroFigure {
  readonly group: THREE.Group;
  readonly body: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
}

const heroColor = (hero: Hero): string => {
  if (hero.status === "down") {
    return DOWN;
  }
  return hero.hurtTimer > 0 ? HURT : hero.def.color;
};

/** Draws a survivors World with Three.js. Reads the simulation; never changes it. */
export class SurvivorsView implements GameView<World> {
  private readonly stage: Stage;
  private readonly localHero: number;
  /** One figure per hero slot, made when a run first has that many heroes. */
  private readonly heroes: HeroFigure[] = [];
  private readonly projectiles: MeshInstances;
  private readonly gems: MeshInstances;
  private readonly auras: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >[] = [];
  private enemies: MeshInstances | null = null;
  private ground: THREE.Group | null = null;
  /** Colors cached per World so they're parsed once, not every frame. */
  private palette: {
    world: World;
    enemies: THREE.Color[];
    /** Indexed like the projectiles' `weapon` field: slot * MAX_WEAPONS + weapon index. */
    weapons: (THREE.Color | undefined)[];
  } | null = null;

  constructor(container: HTMLElement, options: SurvivorsViewOptions = {}) {
    this.localHero = options.localHero ?? 0;
    this.stage = new Stage(container, {
      background: "#1b2130",
      fog: { near: 30, far: 70 },
    });
    const { scene } = this.stage;

    scene.add(new THREE.HemisphereLight("#dfe8ff", "#3a3f2a", 1.6));
    const sun = new THREE.DirectionalLight("#ffffff", 1.4);
    sun.position.set(8, 20, 6);
    scene.add(sun);

    this.heroFigure(0);

    this.projectiles = new MeshInstances(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshBasicMaterial(),
      512
    );
    this.gems = new MeshInstances(
      new THREE.OctahedronGeometry(0.22),
      new THREE.MeshStandardMaterial({ color: "#5ef2ff", emissive: "#1a8fa0" }),
      1024
    );
    scene.add(this.projectiles.mesh, this.gems.mesh);

    for (let i = 0; i < MAX_AURAS; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 64),
        new THREE.MeshBasicMaterial({
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.auras.push(ring);
      scene.add(ring);
    }
  }

  render(world: World | null, timeSeconds: number): void {
    if (world) {
      this.drawWorld(world, timeSeconds);
    } else {
      this.drawMenuBackdrop(timeSeconds);
    }
    this.stage.render();
  }

  dispose(): void {
    // Stage.dispose frees everything in the scene, instances included.
    this.stage.dispose();
  }

  private drawMenuBackdrop(t: number) {
    this.ensureGround(60);
    for (const figure of this.heroes) {
      figure.group.visible = false;
    }
    this.enemies?.commit(0);
    this.projectiles.commit(0);
    this.gems.commit(0);
    for (const ring of this.auras) {
      ring.visible = false;
    }
    orbitAround(
      this.stage.camera,
      { x: 0, z: 0 },
      { radius: 18, height: 16, angle: t * 0.05 }
    );
  }

  private drawWorld(world: World, t: number) {
    const palette = this.paletteFor(world);
    this.ensureGround(world.content.rules.arenaHalfSize);

    for (const figure of this.heroes) {
      figure.group.visible = false;
    }
    for (const hero of world.heroes) {
      const figure = this.heroFigure(hero.slot);
      // A hero whose player left is gone; a downed one lies greyed where it fell.
      figure.group.visible = hero.status !== "left";
      figure.group.position.set(hero.x, 0, hero.z);
      figure.group.rotation.set(
        hero.status === "down" ? Math.PI / 2 : 0,
        Math.atan2(hero.faceX, hero.faceZ),
        0,
        "YXZ"
      );
      figure.body.material.color.set(heroColor(hero));
    }

    const enemies = this.enemyInstances(world.enemies.capacity);
    const e = world.enemies.fields;
    for (let i = 0; i < world.enemies.count; i++) {
      const def = world.enemyDefs[e.type[i]!]!;
      const bob = Math.abs(Math.sin(t * 6 + i)) * 0.15;
      enemies.set(i, e.x[i]!, def.radius + bob, e.z[i]!, def.radius);
      enemies.setColor(
        i,
        e.hitFlash[i]! > 0 ? WHITE : palette.enemies[e.type[i]!]!
      );
    }
    enemies.commit(world.enemies.count);

    const pr = world.projectiles.fields;
    for (let i = 0; i < world.projectiles.count; i++) {
      this.projectiles.set(i, pr.x[i]!, 0.7, pr.z[i]!);
      this.projectiles.setColor(i, palette.weapons[pr.weapon[i]!] ?? WHITE);
    }
    this.projectiles.commit(world.projectiles.count);

    const g = world.gems.fields;
    for (let i = 0; i < world.gems.count; i++) {
      this.gems.set(
        i,
        g.x[i]!,
        0.35 + Math.sin(t * 4 + i) * 0.08,
        g.z[i]!,
        1,
        t * 3 + i
      );
    }
    this.gems.commit(world.gems.count);

    // Aura rings: flash bright on each damage pulse, then fade.
    let ringIndex = 0;
    for (const hero of world.heroes) {
      if (hero.status !== "playing") {
        continue;
      }
      for (let w = 0; w < hero.weapons.length && ringIndex < MAX_AURAS; w++) {
        const slot = hero.weapons[w]!;
        if (slot.def.behavior.kind !== "aura") {
          continue;
        }
        const ring = this.auras[ringIndex]!;
        ringIndex += 1;
        const r = auraRadius(hero, slot);
        ring.visible = true;
        ring.position.set(hero.x, 0.05, hero.z);
        ring.scale.set(r, r, 1);
        ring.material.color.copy(
          palette.weapons[hero.slot * MAX_WEAPONS + w] ?? WHITE
        );
        ring.material.opacity = 0.25 + Math.max(0, 0.6 - slot.sinceFired * 2);
      }
    }
    for (let i = ringIndex; i < MAX_AURAS; i++) {
      this.auras[i]!.visible = false;
    }

    const followed = world.heroes[this.localHero] ?? world.heroes[0]!;
    followTarget(this.stage.camera, followed, CAMERA_OFFSET);
  }

  /** The figure for a hero slot, made the first time a run has that slot. */
  private heroFigure(slot: number): HeroFigure {
    for (let s = this.heroes.length; s <= slot; s++) {
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.4, 0.5, 4, 12),
        new THREE.MeshStandardMaterial({ color: "#ffffff" })
      );
      body.position.y = 0.65;
      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.15, 0.35, 10),
        new THREE.MeshStandardMaterial()
      );
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, 0.7, 0.5);
      const group = new THREE.Group();
      group.add(body, nose);
      group.visible = false;
      this.stage.scene.add(group);
      this.heroes.push({ group, body });
    }
    return this.heroes[slot]!;
  }

  private paletteFor(world: World) {
    if (this.palette?.world !== world) {
      this.palette = {
        world,
        enemies: world.enemyDefs.map((def) => new THREE.Color(def.color)),
        weapons: [],
      };
    }
    // Weapons picked up mid-run get their color here.
    const { weapons } = this.palette;
    for (const hero of world.heroes) {
      for (let w = 0; w < hero.weapons.length; w++) {
        const index = hero.slot * MAX_WEAPONS + w;
        weapons[index] ??= new THREE.Color(hero.weapons[w]!.def.color);
      }
    }
    return this.palette;
  }

  private enemyInstances(capacity: number): MeshInstances {
    if (this.enemies?.capacity !== capacity) {
      this.enemies?.dispose();
      this.enemies = new MeshInstances(
        new THREE.SphereGeometry(1, 14, 10),
        new THREE.MeshStandardMaterial(),
        capacity
      );
      this.stage.scene.add(this.enemies.mesh);
    }
    return this.enemies;
  }

  private ensureGround(halfSize: number) {
    if (this.ground?.userData["halfSize"] === halfSize) {
      return;
    }
    this.ground?.removeFromParent();
    const size = halfSize * 2;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: "#2f3d33" })
    );
    plane.rotation.x = -Math.PI / 2;
    const grid = new THREE.GridHelper(size, halfSize, "#3f5244", "#3f5244");
    grid.position.y = 0.01;
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size, 1, size)),
      new THREE.LineBasicMaterial({ color: "#8aa0ff" })
    );
    border.position.y = 0.5;
    this.ground = new THREE.Group();
    this.ground.userData["halfSize"] = halfSize;
    this.ground.add(plane, grid, border);
    this.stage.scene.add(this.ground);
  }
}
