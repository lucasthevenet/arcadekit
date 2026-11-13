import {
  Gait,
  InstancedSprites,
  frameAt,
  resolveTags,
  snapToPixel,
} from "arcadekit/render-three";
import type { ResolvedTags, SpriteTag } from "arcadekit/render-three";
import * as THREE from "three";

import { MAX_HEROES, MAX_WEAPONS, auraRadius } from "../hero";
import type { Hero } from "../hero";
import type { World } from "../world";
import { SCENE_TAGS, TAG_NAMES, contentTags, heroTags } from "./art";
import type { SurvivorsArt } from "./art";
import { AuraRings } from "./aura";
import { GroundTiles } from "./ground";

// What the survivors view draws, as sprites from the app's sheet, in four draw calls: the ground
// (tiles and dirt patches), the soft shadows, the aura rings (drawn from the sheet's art by their
// own shader, so they stay in whole pixels at any radius), and everything standing on the
// ground (markers, gems, heroes, enemies, projectiles and their trails). No renderer here, so
// tests can draw a World without WebGL. Sprite pixels are 1/16 world unit.

/** Sprite pixels per world unit. */
export const PIXELS_PER_UNIT = 16;
const PX = 1 / PIXELS_PER_UNIT;

/** The background beyond the ground: the void tiles' colour. */
export const VOID_COLOR = "#0c0f17";

/**
 * One distinct colour per player slot, for the hero's ground marker: how co-op players tell
 * their heroes apart, even two of the same hero. A single player's is slot 0's.
 */
const SLOT_COLORS = ["#3ee0ff", "#ff4f9a", "#9dff5c", "#ffb13b"] as const;

/** Enemy tags drawn floating above their shadow, and how high, in world units. */
const FLOATING: ReadonlyMap<string, number> = new Map([
  ["bat/move", 0.3],
  ["wraith/move", 0.12],
]);

/** Layers, bottom to top. Within one, lower on screen draws in front. */
const LAYER = {
  shadows: 2,
  /** The aura's depth, inside the shadows' layer band. */
  aura: 2.5,
  marks: 3,
  bodies: 4,
  shots: 5,
} as const;

/** The arena the menu backdrop shows until a run tells it the real one. */
const MENU_HALF_SIZE = 60;
/** Phases from the golden ratio: spread evenly, whatever how many. */
const GOLDEN = 0.61803398875;
/** Trail puffs per projectile. */
const TRAIL = 3;
/** A hero still walks this long after it last moved, so a frame with no step doesn't stop it. */
const WALK_GRACE = 0.12;
/** A hero's frame is 24 px tall: its feet are this far below its middle. */
const HERO_FEET = 0.75;
/** An enemy's frame is 16 px tall. */
const ENEMY_FEET = 0.5;
const DOWN_TINT = new THREE.Color("#8a90a8");
const WHITE = new THREE.Color("#ffffff");

interface HeroLook {
  readonly walk: SpriteTag;
  readonly idle: SpriteTag;
  readonly down: SpriteTag;
  readonly tint: THREE.Color;
}

interface EnemyLook {
  readonly tag: SpriteTag;
  readonly tint: THREE.Color;
  /** World units above its shadow. */
  readonly float: number;
}

interface WeaponLook {
  readonly tag: SpriteTag;
  readonly tint: THREE.Color;
  /** The weapon's colour, for its trail and aura. */
  readonly color: THREE.Color;
}

/** The tags and tints for one run's content. */
interface Looks {
  readonly world: World;
  /** The content's tags as the sheet has them, by their `TAG_NAMES`. */
  readonly tags: ResolvedTags<ReturnType<typeof contentTags>>["tags"];
  readonly heroes: readonly HeroLook[];
  readonly enemies: readonly EnemyLook[];
  /** Indexed like projectiles' `weapon` field: slot * MAX_WEAPONS + weapon index. */
  readonly weapons: (WeaponLook | undefined)[];
}

/** A hero's own tags, or the generic hero's in its colour if the sheet lacks any of them. */
const heroLook = (tags: Looks["tags"], hero: Hero): HeroLook => {
  const { id, sprite } = hero.def;
  const walk = tags[TAG_NAMES.hero(id, "walk")]!;
  const idle = tags[TAG_NAMES.hero(id, "idle")]!;
  const down = tags[TAG_NAMES.hero(id, "down")]!;
  const own = sprite === undefined ? undefined : heroTags(sprite);
  const whole =
    walk.name === own?.walk && idle.name === own.idle && down.name === own.down;
  return {
    walk,
    idle,
    down,
    tint: whole ? WHITE : new THREE.Color(hero.def.color),
  };
};

/** Frame `age` (0 the first) of a tag, held on its last. */
const frameOf = (tag: SpriteTag, age: number) =>
  Math.min(tag.from + age, tag.to);

/** The x of the playing hero nearest (x, z), or x itself with none. */
const nearestHeroX = (world: World, x: number, z: number): number => {
  let best = Number.POSITIVE_INFINITY;
  let bestX = x;
  for (const hero of world.heroes) {
    if (hero.status === "playing") {
      const d = (hero.x - x) ** 2 + (hero.z - z) ** 2;
      if (d < best) {
        best = d;
        bestX = hero.x;
      }
    }
  }
  return bestX;
};

/**
 * An entity's animation phase in [0, 1), from its pool id. A pool moves its last entity into a
 * removed one's index, so an index isn't an entity: the id stays with it for as long as it
 * lives, and so does its phase. A later entity may take the id, and the phase with it.
 */
const phaseOf = (id: number): number => (id * GOLDEN) % 1;

const gemTier = (value: number) => {
  if (value <= 1) {
    return 0;
  }
  return value <= 3 ? 1 : 2;
};

const firstHero = () => 0;

interface SurvivorsSceneOptions {
  /**
   * The slot of the hero to centre on, read on every draw, so a co-op view follows the local
   * player's seat without being made again. Defaults to slot 0.
   */
  readonly localHero?: () => number;
}

/**
 * Draws a survivors World, or the menu backdrop, as sprites under `root`. Add `root` to a scene
 * seen by a `PixelCamera`; each frame, give it the view's size, `draw`, then centre the camera on
 * `focus`. Once a run's looks are made and its batches have grown to hold it, a frame allocates
 * nothing of the view's own, only what each batch's `end` costs. `dispose` frees what it made,
 * never the sheet.
 */
export class SurvivorsScene {
  readonly root = new THREE.Group();
  /**
   * Where the camera should look this frame: the followed hero, snapped to sprite pixels like
   * its sprite, or the backdrop's pan.
   */
  readonly focus = { x: 0, z: 0 };
  private readonly art: SurvivorsArt;
  private readonly localHero: () => number;
  private readonly ground: GroundTiles;
  private readonly auras: AuraRings;
  /** The tags every run draws. */
  private readonly common: ResolvedTags<typeof SCENE_TAGS>["tags"];
  /** By a gem's tier: small, medium, large. */
  private readonly gems: readonly SpriteTag[];
  private readonly slotColors = SLOT_COLORS.map((c) => new THREE.Color(c));
  /** Everything standing on the ground. */
  private readonly actors: InstancedSprites;
  /** The soft shadows under heroes and enemies, blended over the ground. */
  private readonly shadows: InstancedSprites;
  private looks: Looks | null = null;
  /** The last run's arena, for the backdrop. */
  private halfSize = MENU_HALF_SIZE;
  private viewWidth = 48;
  private viewDepth = 30;
  /** Per hero slot: whether it is walking, and whether it faces left. */
  private readonly gaits = Array.from(
    { length: MAX_HEROES },
    () => new Gait({ linger: WALK_GRACE })
  );
  private readonly facingLeft = new Uint8Array(MAX_HEROES);

  constructor(art: SurvivorsArt, options: SurvivorsSceneOptions = {}) {
    this.art = art;
    this.localHero = options.localHero ?? firstHero;
    this.common = resolveTags(art.sheet.data, SCENE_TAGS).tags;
    const { gemSmall, gemMedium, gemLarge } = this.common;
    this.gems = [gemSmall, gemMedium, gemLarge];
    this.ground = new GroundTiles(art.sheet, this.common);
    this.root.add(this.ground.batch.mesh);
    this.auras = new AuraRings(
      art.sheet,
      this.common.aura,
      MAX_HEROES * MAX_WEAPONS,
      PIXELS_PER_UNIT,
      LAYER.aura
    );
    this.root.add(this.auras.mesh);
    this.actors = new InstancedSprites(art.sheet, {
      // Characters stand on the frame's bottom row; centred art is placed half a frame lower.
      anchor: { x: 0.5, y: 1 },
    });
    this.root.add(this.actors.mesh);
    this.shadows = new InstancedSprites(art.sheet, {
      transparent: true,
      layer: LAYER.shadows,
    });
    // After the aura rings, which are transparent too.
    this.shadows.mesh.renderOrder = 1;
    this.root.add(this.shadows.mesh);
  }

  /** The batch everything standing on the ground is drawn in, for tests. */
  get actorSprites(): InstancedSprites {
    return this.actors;
  }

  /** The shadow batch, for tests. */
  get shadowSprites(): InstancedSprites {
    return this.shadows;
  }

  /** The ground tile batch, for tests. */
  get groundSprites(): InstancedSprites {
    return this.ground.batch;
  }

  /** The aura rings, for tests. */
  get auraRings(): AuraRings {
    return this.auras;
  }

  /** The view's size in world units, so the ground covers it. */
  setViewSize(width: number, depth: number): void {
    this.viewWidth = width;
    this.viewDepth = depth;
  }

  draw(world: World | null, time: number): void {
    if (world === null) {
      this.drawBackdrop(time);
    } else {
      this.drawWorld(world, time);
    }
    this.ground.draw(
      this.halfSize,
      this.focus.x,
      this.focus.z,
      this.viewWidth,
      this.viewDepth
    );
  }

  dispose(): void {
    this.ground.dispose();
    this.actors.dispose();
    this.shadows.dispose();
    this.auras.dispose();
    this.root.removeFromParent();
  }

  /** No run: a slow loop over the arena. */
  private drawBackdrop(time: number) {
    this.actors.begin();
    this.actors.end();
    this.shadows.begin();
    this.shadows.end();
    this.auras.commit(0);
    const reach = this.halfSize * 0.5;
    this.focus.x = Math.sin(time * 0.025) * reach;
    this.focus.z = Math.sin(time * 0.017) * reach * 0.6;
  }

  private drawWorld(world: World, time: number) {
    const looks = this.looksFor(world);
    this.halfSize = world.content.rules.arenaHalfSize;
    const { actors, shadows } = this;
    actors.begin();
    shadows.begin();
    const auras = this.drawHeroes(world, looks, actors, shadows, time);
    this.drawEnemies(world, looks, actors, shadows, time);
    this.drawGems(world, actors, time);
    this.drawShots(world, looks, actors, time);
    actors.end();
    shadows.end();
    this.auras.commit(auras);
    // On the sprite-pixel grid the hero is drawn on, so the camera moves in the same steps as
    // the hero and it stays still on screen.
    const followed = world.heroes[this.localHero()] ?? world.heroes[0]!;
    this.focus.x = snapToPixel(followed.x, PIXELS_PER_UNIT);
    this.focus.z = snapToPixel(followed.z, PIXELS_PER_UNIT);
  }

  /** Heroes, their slot markers and shadows, and their aura rings. Returns how many rings. */
  private drawHeroes(
    world: World,
    looks: Looks,
    actors: InstancedSprites,
    shadows: InstancedSprites,
    time: number
  ): number {
    const { data } = this.art.sheet;
    const coop = world.heroes.length > 1;
    let rings = 0;
    for (const hero of world.heroes) {
      if (hero.status === "left") {
        continue;
      }
      const look = looks.heroes[hero.slot]!;
      const walking = this.walking(hero, time);
      const feet = hero.z + HERO_FEET;
      let tag = walking ? look.walk : look.idle;
      if (hero.status === "down") {
        tag = look.down;
      }
      const a = actors.push(
        hero.x,
        feet,
        frameAt(data, tag, time + hero.slot * 0.13),
        this.facingLeft[hero.slot] === 1
      );
      actors.setLayer(a, LAYER.bodies);
      // A downed hero is greyed only in co-op; a lone hero's run is over.
      if (hero.status === "down" && coop) {
        actors.setTint(a, DOWN_TINT);
        actors.setFlash(a, 0.15);
      } else {
        actors.setTint(a, look.tint);
        if (hero.hurtTimer > 0) {
          actors.setFlash(a, Math.floor(time * 20) % 2 === 0 ? 0.85 : 0.35);
        }
      }
      const mark = actors.push(hero.x, feet + 3 * PX, this.common.marker.from);
      actors.setLayer(mark, LAYER.marks);
      actors.setTint(
        mark,
        this.slotColors[hero.slot % this.slotColors.length]!
      );
      shadows.push(hero.x, feet - PX, this.common.shadow.from);
      if (hero.status === "playing") {
        rings = this.drawAuras(hero, looks, rings);
      }
    }
    return rings;
  }

  private drawAuras(hero: Hero, looks: Looks, from: number): number {
    let rings = from;
    for (let w = 0; w < hero.weapons.length; w++) {
      const slot = hero.weapons[w]!;
      if (slot.def.behavior.kind === "aura") {
        const weapon = looks.weapons[hero.slot * MAX_WEAPONS + w];
        this.auras.set(
          rings,
          hero.x,
          hero.z,
          auraRadius(hero, slot),
          Math.max(0, 1 - slot.sinceFired * 2.5),
          weapon?.color ?? WHITE
        );
        rings += 1;
      }
    }
    return rings;
  }

  /** Enemies facing the nearest playing hero, each a little out of step with the rest. */
  private drawEnemies(
    world: World,
    looks: Looks,
    actors: InstancedSprites,
    shadows: InstancedSprites,
    time: number
  ) {
    const { data } = this.art.sheet;
    const { type, x, z, hitFlash } = world.enemies.fields;
    for (let i = 0; i < world.enemies.count; i++) {
      const look = looks.enemies[type[i]!]!;
      const ex = x[i]!;
      const feet = z[i]! + ENEMY_FEET;
      const phase = phaseOf(world.enemies.idOf(i)) * 4;
      const a = actors.push(
        ex,
        feet,
        frameAt(data, look.tag, time + phase),
        nearestHeroX(world, ex, z[i]!) < ex
      );
      actors.setLayer(a, LAYER.bodies);
      actors.setTint(a, look.tint);
      if (look.float > 0) {
        actors.setLift(a, look.float + Math.sin(time * 5 + phase * 1.6) * 0.06);
      }
      if (hitFlash[i]! > 0) {
        actors.setFlash(a, Math.min(1, hitFlash[i]! * 10));
      }
      shadows.push(ex, feet - PX, this.common.shadow.from);
    }
  }

  /** Gems by value, glinting now and then. */
  private drawGems(world: World, actors: InstancedSprites, time: number) {
    const { data } = this.art.sheet;
    const { x, z, value } = world.gems.fields;
    for (let i = 0; i < world.gems.count; i++) {
      const tag = this.gems[gemTier(value[i]!)]!;
      const gem = actors.push(
        x[i]!,
        z[i]! + 0.5,
        frameAt(data, tag, time + phaseOf(world.gems.idOf(i)) * 3)
      );
      actors.setLayer(gem, LAYER.marks);
    }
  }

  /** Projectiles, each with a trail of puffs behind it, fading. */
  private drawShots(
    world: World,
    looks: Looks,
    actors: InstancedSprites,
    time: number
  ) {
    const { data } = this.art.sheet;
    const { trail, bolt } = this.common;
    const { x, z, vx, vz, weapon } = world.projectiles.fields;
    for (let i = 0; i < world.projectiles.count; i++) {
      const look = looks.weapons[weapon[i]!];
      const speed = Math.hypot(vx[i]!, vz[i]!) || 1;
      // Puffs a few pixels apart, closer for slow shots.
      const spacing = Math.min(0.28, Math.max(0.16, speed * 0.015)) / speed;
      for (let k = TRAIL; k >= 1; k--) {
        const puff = actors.push(
          x[i]! - vx[i]! * spacing * k,
          z[i]! - vz[i]! * spacing * k + 2 * PX,
          frameOf(trail, k - 1)
        );
        actors.setLayer(puff, LAYER.shots);
        actors.setTint(puff, look?.color ?? WHITE);
      }
      const shot = actors.push(
        x[i]!,
        z[i]! + 6 * PX,
        frameAt(data, look?.tag ?? bolt, time + i * 0.05),
        vx[i]! < 0
      );
      actors.setLayer(shot, LAYER.shots);
      actors.setTint(shot, look?.tint ?? WHITE);
    }
  }

  /** Whether a hero is walking, and which way it faces; kept per slot across frames. */
  private walking(hero: Hero, time: number): boolean {
    const { slot } = hero;
    const gait = this.gaits[slot]!;
    gait.update(hero.x, hero.z, time);
    if (hero.faceX < -0.1) {
      this.facingLeft[slot] = 1;
    } else if (hero.faceX > 0.1) {
      this.facingLeft[slot] = 0;
    }
    return hero.status === "playing" && gait.moving;
  }

  /** The looks for a run's content, made once per run; weapons picked up mid-run join here. */
  private looksFor(world: World): Looks {
    if (this.looks?.world !== world) {
      const { tags } = resolveTags(
        this.art.sheet.data,
        contentTags(world.content)
      );
      this.looks = {
        world,
        tags,
        heroes: world.heroes.map((hero) => heroLook(tags, hero)),
        enemies: world.enemyDefs.map((def, type) => {
          const tag = tags[TAG_NAMES.enemy(type)]!;
          return {
            tag,
            tint: tag.name === def.sprite ? WHITE : new THREE.Color(def.color),
            float: FLOATING.get(tag.name) ?? 0,
          };
        }),
        weapons: [],
      };
      for (const gait of this.gaits) {
        gait.reset();
      }
      this.facingLeft.fill(0);
    }
    const { tags, weapons } = this.looks;
    for (const hero of world.heroes) {
      for (let w = 0; w < hero.weapons.length; w++) {
        const index = hero.slot * MAX_WEAPONS + w;
        if (weapons[index] === undefined) {
          const { def } = hero.weapons[w]!;
          const color = new THREE.Color(def.color);
          const tag = tags[TAG_NAMES.weapon(def.id)]!;
          weapons[index] = {
            tag,
            tint: tag.name === def.sprite ? WHITE : color,
            color,
          };
        }
      }
    }
    return this.looks;
  }
}
