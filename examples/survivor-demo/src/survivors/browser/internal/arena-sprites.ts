/**
 * The arena's sprites: a run drawn as pixel art from the app's sheet, seen straight down, in five
 * draw calls. The ground's tiles are a tile layer (only the cells on screen), then its dirt
 * patches, the soft shadows, the aura rings (drawn from the sheet's art by their own shader, so
 * they stay in whole pixels at any radius), and everything standing on the ground: markers, gems,
 * heroes, enemies, projectiles and their trails. With no run, they are a slow pan over an empty
 * arena behind the menus.
 *
 * Sprite pixels are 1/16 world unit (`Art.pixelsPerUnit`). No WebGL here: the sprite view adds
 * `root` to its stage's scene, points its camera at `focus` and renders it, and a test reads back
 * what each batch and the layer show. Once a run's looks are made and its batches have grown to
 * hold it, a frame allocates nothing of the sprites' own, only what each batch's `end` costs.
 *
 * Plain on purpose: a frame draws whole before the browser shows it, so `draw` is a plain call.
 * Its Three.js resources come from a plain `make` and go with a plain `dispose`, which the sprite
 * view calls from its own.
 */
import { EntityPool } from "arcadekit/core";
import {
  Gait,
  InstancedSprites,
  PixelCamera,
  SpriteSheet,
  TileLayer,
} from "arcadekit/render-three";
import type { Camera } from "arcadekit/render-three";
import * as THREE from "three";

import * as Hero from "../../hero";
import type * as World from "../../world";
import * as Art from "../art";
import * as AuraRings from "./aura-rings";
import * as Ground from "./ground";
import * as SpriteTags from "./sprite-tags";

const PX = 1 / Art.pixelsPerUnit;

/** The background beyond the ground: the void tiles' colour. */
export const voidColor = "#0c0f17";

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

/** Layers, bottom to top. Within one, lower on screen draws in front. The ground's tiles are in layer 0. */
const LAYER = {
  patches: 1,
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
  readonly walk: SpriteSheet.Tag;
  readonly idle: SpriteSheet.Tag;
  readonly down: SpriteSheet.Tag;
  readonly tint: THREE.Color;
}

interface EnemyLook {
  readonly tag: SpriteSheet.Tag;
  readonly tint: THREE.Color;
  /** World units above its shadow. */
  readonly float: number;
}

interface WeaponLook {
  readonly tag: SpriteSheet.Tag;
  readonly tint: THREE.Color;
  /** The weapon's colour, for its trail and aura. */
  readonly color: THREE.Color;
}

/** The tags and tints for one run's content. */
interface Looks {
  readonly arena: World.Arena;
  /** The content's tags as the sheet has them, by their `SpriteTags.names`. */
  readonly tags: SpriteSheet.ResolvedTags<
    ReturnType<typeof SpriteTags.forContent>
  >["tags"];
  readonly heroes: readonly HeroLook[];
  readonly enemies: readonly EnemyLook[];
  /** Indexed like projectiles' `weapon` field: slot * `Hero.maxWeapons` + weapon index. */
  readonly weapons: (WeaponLook | undefined)[];
}

/** A hero's own tags, or the generic hero's in its colour if the sheet lacks any of them. */
const heroLook = (tags: Looks["tags"], hero: Hero.Hero): HeroLook => {
  const { id, sprite } = hero.def;
  const walk = tags[SpriteTags.names.hero(id, "walk")]!;
  const idle = tags[SpriteTags.names.hero(id, "idle")]!;
  const down = tags[SpriteTags.names.hero(id, "down")]!;
  const own = sprite === undefined ? undefined : SpriteTags.forHero(sprite);
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
const frameOf = (tag: SpriteSheet.Tag, age: number) =>
  Math.min(tag.from + age, tag.to);

/** The x of the playing hero nearest (x, z), or x itself with none. */
const nearestHeroX = (arena: World.Arena, x: number, z: number): number => {
  let best = Number.POSITIVE_INFINITY;
  let bestX = x;
  for (const hero of arena.heroes) {
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

/**
 * The arena's sprites: what a caller reads of them. The sprite view adds `root` to its scene and
 * follows `focus`, and a test reads back what each batch, the layer and the rings show.
 */
export interface ArenaSprites {
  /** Holds every mesh the sprites draw with. */
  readonly root: THREE.Group;
  /**
   * Where the camera should look this frame: the followed hero, snapped to sprite pixels like
   * its sprite, or the backdrop's pan.
   */
  readonly focus: { x: number; z: number };
  /** The ground's tiles: the cells on screen. */
  readonly ground: TileLayer.TileLayer;
  /** The dirt patches over the grass: all of an arena's, filled when the arena changes. */
  readonly patches: InstancedSprites.InstancedSprites;
  /** The soft shadows under heroes and enemies, blended over the ground. */
  readonly shadows: InstancedSprites.InstancedSprites;
  /** The rings of the heroes' aura weapons. */
  readonly auras: AuraRings.AuraRings;
  /** Everything standing on the ground. */
  readonly actors: InstancedSprites.InstancedSprites;
}

/** What the module's functions keep between frames, beyond what a caller reads. */
interface Internal extends ArenaSprites {
  readonly sheet: SpriteSheet.SpriteSheet;
  /** The slot of the hero to centre on, read on every draw. */
  readonly localHero: () => number;
  /** The tags every run draws, the ground's among them. */
  readonly common: SpriteSheet.ResolvedTags<typeof SpriteTags.scene>["tags"];
  /** By a gem's tier: small, medium, large. */
  readonly gems: readonly SpriteSheet.Tag[];
  readonly slotColors: readonly THREE.Color[];
  /** The looks of the run drawn last. A new run (a restart, another content) makes new ones. */
  looks: Looks | null;
  /** The last run's arena, for the backdrop. */
  halfSize: number;
  /** The arena the ground was last drawn for, in whole units from its centre to its wall. */
  half: number;
  /** Per hero slot: whether it is walking. */
  readonly gaits: readonly Gait.Gait[];
  /** Per hero slot: 1 while it faces left. */
  readonly facingLeft: Uint8Array;
  /** The frame the ground shows at a cell. Kept, so a frame makes no closure for the layer. */
  readonly groundFrame: (col: number, row: number) => number;
}

/**
 * Makes the arena's sprites over `sheet`: a tile layer, a batch of patches, one of shadows, the
 * aura rings and a batch of actors, all in `root`, which show no run yet.
 *
 * The sheet's tags every run draws are picked here, once (`SpriteTags.scene`), and the content's
 * once per run. `localHero` is the slot of the hero to centre on, read on every draw, so a co-op
 * view follows the local player's seat without being made again; it defaults to slot 0.
 */
export const make = (
  sheet: SpriteSheet.SpriteSheet,
  options: { readonly localHero?: () => number } = {}
): ArenaSprites => {
  const common = SpriteSheet.resolveTags(sheet.data, SpriteTags.scene).tags;
  const { gemSmall, gemMedium, gemLarge } = common;
  const root = new THREE.Group();
  const ground = TileLayer.make(sheet);
  root.add(ground.mesh);
  const patches = InstancedSprites.make(sheet, { layer: LAYER.patches });
  root.add(patches.mesh);
  const auras = AuraRings.make(
    sheet,
    common.aura,
    Hero.maxPerRun * Hero.maxWeapons,
    Art.pixelsPerUnit,
    LAYER.aura
  );
  root.add(auras.mesh);
  const actors = InstancedSprites.make(sheet, {
    // Characters stand on the frame's bottom row; centred art is placed half a frame lower.
    anchor: { x: 0.5, y: 1 },
  });
  root.add(actors.mesh);
  const shadows = InstancedSprites.make(sheet, {
    transparent: true,
    layer: LAYER.shadows,
  });
  // After the aura rings, which are transparent too.
  shadows.mesh.renderOrder = 1;
  root.add(shadows.mesh);
  const sprites: Internal = {
    root,
    focus: { x: 0, z: 0 },
    ground,
    patches,
    shadows,
    auras,
    actors,
    sheet,
    localHero: options.localHero ?? firstHero,
    common,
    gems: [gemSmall, gemMedium, gemLarge],
    slotColors: SLOT_COLORS.map((c) => new THREE.Color(c)),
    looks: null,
    halfSize: MENU_HALF_SIZE,
    half: -1,
    gaits: Array.from({ length: Hero.maxPerRun }, () =>
      Gait.make({ linger: WALK_GRACE })
    ),
    facingLeft: new Uint8Array(Hero.maxPerRun),
    groundFrame: (col, row) =>
      Ground.variant(
        Ground.tileTag(sprites.common, sprites.half, col, row),
        Ground.fraction(col, row)
      ),
  };
  return sprites;
};

/**
 * Draws one frame of `arena`, or the menu backdrop with none, and moves `focus` to where the
 * camera should look: the local hero, or the backdrop's pan. Then the caller centres its camera
 * on `focus` and calls `drawGround`.
 */
export const draw = (
  self: ArenaSprites,
  arena: World.Arena | null,
  time: number
): void => {
  const sprites = self as Internal;
  if (arena === null) {
    drawBackdrop(sprites, time);
  } else {
    drawArena(sprites, arena, time);
  }
};

/**
 * Shows the ground of the arena last drawn that touches `seen`, the rectangle of ground the
 * camera shows: call it after `draw`, once the camera is on `focus`. The tiles are filled again
 * only when `seen` touches other cells, and the patches only for another arena.
 */
export const drawGround = (
  self: ArenaSprites,
  seen: Camera.GroundBounds
): void => {
  const sprites = self as Internal;
  const half = Math.ceil(sprites.halfSize);
  if (half !== sprites.half) {
    sprites.half = half;
    TileLayer.invalidate(sprites.ground);
    Ground.fillPatches(sprites.patches, sprites.common.patch, half);
  }
  TileLayer.draw(sprites.ground, seen, sprites.groundFrame);
};

/** Frees what `make` made and takes `root` out of its scene. Never the sheet, which the app owns. */
export const dispose = (self: ArenaSprites): void => {
  TileLayer.dispose(self.ground);
  InstancedSprites.dispose(self.patches);
  InstancedSprites.dispose(self.actors);
  InstancedSprites.dispose(self.shadows);
  AuraRings.dispose(self.auras);
  self.root.removeFromParent();
};

/** No run: a slow loop over the arena. */
const drawBackdrop = (sprites: Internal, time: number) => {
  InstancedSprites.begin(sprites.actors);
  InstancedSprites.end(sprites.actors);
  InstancedSprites.begin(sprites.shadows);
  InstancedSprites.end(sprites.shadows);
  AuraRings.commit(sprites.auras, 0);
  const reach = sprites.halfSize * 0.5;
  sprites.focus.x = Math.sin(time * 0.025) * reach;
  sprites.focus.z = Math.sin(time * 0.017) * reach * 0.6;
};

const drawArena = (sprites: Internal, arena: World.Arena, time: number) => {
  const looks = looksFor(sprites, arena);
  sprites.halfSize = arena.content.rules.arenaHalfSize;
  const { actors, shadows } = sprites;
  InstancedSprites.begin(actors);
  InstancedSprites.begin(shadows);
  const auras = drawHeroes(sprites, arena, looks, time);
  drawEnemies(sprites, arena, looks, time);
  drawGems(sprites, arena, time);
  drawShots(sprites, arena, looks, time);
  InstancedSprites.end(actors);
  InstancedSprites.end(shadows);
  AuraRings.commit(sprites.auras, auras);
  // On the sprite-pixel grid the hero is drawn on, so the camera moves in the same steps as
  // the hero and it stays still on screen.
  const followed = arena.heroes[sprites.localHero()] ?? arena.heroes[0]!;
  sprites.focus.x = PixelCamera.snapToPixel(followed.x, Art.pixelsPerUnit);
  sprites.focus.z = PixelCamera.snapToPixel(followed.z, Art.pixelsPerUnit);
};

/** Heroes, their slot markers and shadows, and their aura rings. Returns how many rings. */
const drawHeroes = (
  sprites: Internal,
  arena: World.Arena,
  looks: Looks,
  time: number
): number => {
  const { actors, shadows, common, slotColors } = sprites;
  const { data } = sprites.sheet;
  const coop = arena.heroes.length > 1;
  let rings = 0;
  for (const hero of arena.heroes) {
    if (hero.status === "left") {
      continue;
    }
    const look = looks.heroes[hero.slot]!;
    const walking = isWalking(sprites, hero, time);
    const feet = hero.z + HERO_FEET;
    let tag = walking ? look.walk : look.idle;
    if (hero.status === "down") {
      tag = look.down;
    }
    const a = InstancedSprites.push(
      actors,
      hero.x,
      feet,
      SpriteSheet.frameAt(data, tag, time + hero.slot * 0.13),
      sprites.facingLeft[hero.slot] === 1
    );
    InstancedSprites.setLayer(actors, a, LAYER.bodies);
    // A downed hero is greyed only in co-op; a lone hero's run is over.
    if (hero.status === "down" && coop) {
      InstancedSprites.setTint(actors, a, DOWN_TINT);
      InstancedSprites.setFlash(actors, a, 0.15);
    } else {
      InstancedSprites.setTint(actors, a, look.tint);
      if (hero.hurtTimer > 0) {
        InstancedSprites.setFlash(
          actors,
          a,
          Math.floor(time * 20) % 2 === 0 ? 0.85 : 0.35
        );
      }
    }
    const mark = InstancedSprites.push(
      actors,
      hero.x,
      feet + 3 * PX,
      common.marker.from
    );
    InstancedSprites.setLayer(actors, mark, LAYER.marks);
    InstancedSprites.setTint(
      actors,
      mark,
      slotColors[hero.slot % slotColors.length]!
    );
    InstancedSprites.push(shadows, hero.x, feet - PX, common.shadow.from);
    if (hero.status === "playing") {
      rings = drawAuras(sprites, hero, looks, rings);
    }
  }
  return rings;
};

const drawAuras = (
  sprites: Internal,
  hero: Hero.Hero,
  looks: Looks,
  from: number
): number => {
  let rings = from;
  for (let w = 0; w < hero.weapons.length; w++) {
    const slot = hero.weapons[w]!;
    if (slot.def.behavior.kind === "aura") {
      const weapon = looks.weapons[hero.slot * Hero.maxWeapons + w];
      AuraRings.set(
        sprites.auras,
        rings,
        hero.x,
        hero.z,
        Hero.auraRadius(hero, slot),
        Math.max(0, 1 - slot.sinceFired * 2.5),
        weapon?.color ?? WHITE
      );
      rings += 1;
    }
  }
  return rings;
};

/** Enemies facing the nearest playing hero, each a little out of step with the rest. */
const drawEnemies = (
  sprites: Internal,
  arena: World.Arena,
  looks: Looks,
  time: number
) => {
  const { actors, shadows, common } = sprites;
  const { data } = sprites.sheet;
  const { type, x, z, hitFlash } = arena.enemies.fields;
  for (let i = 0; i < arena.enemies.count; i++) {
    const look = looks.enemies[type[i]!]!;
    const ex = x[i]!;
    const feet = z[i]! + ENEMY_FEET;
    const phase = phaseOf(EntityPool.idOf(arena.enemies, i)) * 4;
    const a = InstancedSprites.push(
      actors,
      ex,
      feet,
      SpriteSheet.frameAt(data, look.tag, time + phase),
      nearestHeroX(arena, ex, z[i]!) < ex
    );
    InstancedSprites.setLayer(actors, a, LAYER.bodies);
    InstancedSprites.setTint(actors, a, look.tint);
    if (look.float > 0) {
      InstancedSprites.setLift(
        actors,
        a,
        look.float + Math.sin(time * 5 + phase * 1.6) * 0.06
      );
    }
    if (hitFlash[i]! > 0) {
      InstancedSprites.setFlash(actors, a, Math.min(1, hitFlash[i]! * 10));
    }
    InstancedSprites.push(shadows, ex, feet - PX, common.shadow.from);
  }
};

/** Gems by value, glinting now and then. */
const drawGems = (sprites: Internal, arena: World.Arena, time: number) => {
  const { actors } = sprites;
  const { data } = sprites.sheet;
  const { x, z, value } = arena.gems.fields;
  for (let i = 0; i < arena.gems.count; i++) {
    const tag = sprites.gems[gemTier(value[i]!)]!;
    const gem = InstancedSprites.push(
      actors,
      x[i]!,
      z[i]! + 0.5,
      SpriteSheet.frameAt(
        data,
        tag,
        time + phaseOf(EntityPool.idOf(arena.gems, i)) * 3
      )
    );
    InstancedSprites.setLayer(actors, gem, LAYER.marks);
  }
};

/** Projectiles, each with a trail of puffs behind it, fading. */
const drawShots = (
  sprites: Internal,
  arena: World.Arena,
  looks: Looks,
  time: number
) => {
  const { actors } = sprites;
  const { data } = sprites.sheet;
  const { trail, bolt } = sprites.common;
  const { x, z, vx, vz, weapon } = arena.projectiles.fields;
  for (let i = 0; i < arena.projectiles.count; i++) {
    const look = looks.weapons[weapon[i]!];
    const speed = Math.hypot(vx[i]!, vz[i]!) || 1;
    // Puffs a few pixels apart, closer for slow shots.
    const spacing = Math.min(0.28, Math.max(0.16, speed * 0.015)) / speed;
    for (let k = TRAIL; k >= 1; k--) {
      const puff = InstancedSprites.push(
        actors,
        x[i]! - vx[i]! * spacing * k,
        z[i]! - vz[i]! * spacing * k + 2 * PX,
        frameOf(trail, k - 1)
      );
      InstancedSprites.setLayer(actors, puff, LAYER.shots);
      InstancedSprites.setTint(actors, puff, look?.color ?? WHITE);
    }
    const shot = InstancedSprites.push(
      actors,
      x[i]!,
      z[i]! + 6 * PX,
      SpriteSheet.frameAt(data, look?.tag ?? bolt, time + i * 0.05),
      vx[i]! < 0
    );
    InstancedSprites.setLayer(actors, shot, LAYER.shots);
    InstancedSprites.setTint(actors, shot, look?.tint ?? WHITE);
  }
};

/** Whether a hero is walking, and which way it faces; kept per slot across frames. */
const isWalking = (
  sprites: Internal,
  hero: Hero.Hero,
  time: number
): boolean => {
  const { slot } = hero;
  const gait = sprites.gaits[slot]!;
  Gait.update(gait, hero.x, hero.z, time);
  if (hero.faceX < -0.1) {
    sprites.facingLeft[slot] = 1;
  } else if (hero.faceX > 0.1) {
    sprites.facingLeft[slot] = 0;
  }
  return hero.status === "playing" && gait.moving;
};

/** The looks for a run's content, made once per run; weapons picked up mid-run join here. */
const looksFor = (sprites: Internal, arena: World.Arena): Looks => {
  if (sprites.looks?.arena !== arena) {
    const { tags } = SpriteSheet.resolveTags(
      sprites.sheet.data,
      SpriteTags.forContent(arena.content)
    );
    sprites.looks = {
      arena,
      tags,
      heroes: arena.heroes.map((hero) => heroLook(tags, hero)),
      enemies: arena.enemyDefs.map((def, type) => {
        const tag = tags[SpriteTags.names.enemy(type)]!;
        return {
          tag,
          tint: tag.name === def.sprite ? WHITE : new THREE.Color(def.color),
          float: FLOATING.get(tag.name) ?? 0,
        };
      }),
      weapons: [],
    };
    for (const gait of sprites.gaits) {
      Gait.reset(gait);
    }
    sprites.facingLeft.fill(0);
  }
  const { tags, weapons } = sprites.looks;
  for (const hero of arena.heroes) {
    for (let w = 0; w < hero.weapons.length; w++) {
      const index = hero.slot * Hero.maxWeapons + w;
      if (weapons[index] === undefined) {
        const { def } = hero.weapons[w]!;
        const color = new THREE.Color(def.color);
        const tag = tags[SpriteTags.names.weapon(def.id)]!;
        weapons[index] = {
          tag,
          tint: tag.name === def.sprite ? WHITE : color,
          color,
        };
      }
    }
  }
  return sprites.looks;
};
