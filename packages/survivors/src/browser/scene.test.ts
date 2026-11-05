import { decodeSpriteSheet, makeSpriteSheet } from "@arcadekit/render-three";
import type { InstancedSprites } from "@arcadekit/render-three";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameContent } from "../schema";
import { createWorld } from "../world";
import type { World } from "../world";
import { SPRITE_TAGS, missingSpriteTags } from "./art";
import { SurvivorsScene } from "./scene";

// Draws Worlds into the sprite batches with a small in-memory sheet: no WebGL, only the
// instance attributes the GPU would read.

/** Every tag the view uses, and a few of this test's own, as [tag, frames, width, height]. */
const TAGS: readonly (readonly [string, number, number, number])[] = [
  ["hero/walk", 4, 24, 24],
  ["hero/idle", 1, 24, 24],
  ["hero/down", 1, 24, 24],
  ["knight/walk", 4, 24, 24],
  ["knight/idle", 1, 24, 24],
  ["knight/down", 1, 24, 24],
  ["enemy/move", 2, 16, 16],
  ["grunt/move", 2, 16, 16],
  ["bolt/generic", 2, 12, 12],
  ["bolt/plain", 2, 12, 12],
  ["trail", 3, 4, 4],
  ["gem/small", 3, 16, 16],
  ["gem/medium", 3, 16, 16],
  ["gem/large", 3, 16, 16],
  ["aura/ring", 2, 64, 64],
  ["marker/ring", 1, 22, 10],
  ["shadow", 1, 16, 6],
  ["ground/grass", 4, 16, 16],
  ["ground/patch", 3, 48, 32],
  ...Object.values(SPRITE_TAGS.edges).map((tag) => [tag, 1, 16, 16] as const),
  ["edge/void", 2, 16, 16],
];

const sheetJson = () => {
  const frames: Record<string, unknown> = {};
  const frameTags: unknown[] = [];
  let x = 0;
  let index = 0;
  for (const [tag, count, w, h] of TAGS) {
    frameTags.push({
      name: tag,
      from: index,
      to: index + count - 1,
      direction: "forward",
    });
    for (let i = 0; i < count; i++) {
      frames[`${tag} ${i}`] = {
        frame: { x, y: 0, w, h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w, h },
        sourceSize: { w, h },
        duration: 100,
      };
      x += w;
      index += 1;
    }
  }
  return {
    frames,
    meta: { image: "test.png", size: { w: x, h: 64 }, frameTags },
  };
};

const sheetData = Effect.runSync(decodeSpriteSheet("test.json", sheetJson()));
const tag = (name: string) => sheetData.tags.get(name)!;
const image = { width: 1, height: 1 } as unknown as TexImageSource;
const art = { sheet: makeSpriteSheet(sheetData, image) };

const weapon = {
  description: "",
  color: "#ffffff",
  damage: 10,
  damagePerLevel: 3,
  cooldown: 0.5,
  cooldownScalePerLevel: 0.9,
  maxLevel: 5,
};

const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 8,
    maxEnemies: 20,
    xpToLevel2: 3,
    xpGrowth: 1.3,
    baseMoveSpeedScale: 1,
    basePickupRadius: 2.5,
    choicesPerLevelUp: 3,
    runLength: 120,
  },
  heroes: [
    {
      id: "knight",
      name: "Knight",
      description: "",
      color: "#ffffff",
      maxHp: 100,
      moveSpeed: 6,
      startingWeapon: "plain",
      sprite: "knight",
    },
    {
      id: "plain",
      name: "Plain",
      description: "",
      color: "#ff0000",
      maxHp: 120,
      moveSpeed: 5,
      startingWeapon: "aura",
    },
  ],
  enemies: [
    {
      id: "grunt",
      name: "Grunt",
      color: "#00ff00",
      hp: 8,
      speed: 2.5,
      damage: 10,
      radius: 0.45,
      xp: 1,
      sprite: "grunt/move",
    },
    {
      id: "ghost",
      name: "Ghost",
      color: "#0000ff",
      hp: 8,
      speed: 2.5,
      damage: 10,
      radius: 0.45,
      xp: 3,
      sprite: "ghost/move",
    },
  ],
  weapons: [
    {
      ...weapon,
      id: "plain",
      name: "Plain",
      sprite: "bolt/plain",
      behavior: {
        kind: "bolt",
        projectileSpeed: 20,
        count: 1,
        countPerLevel: 0.5,
        pierce: 0,
        range: 14,
      },
    },
    {
      ...weapon,
      id: "aura",
      name: "Aura",
      color: "#ff8000",
      behavior: { kind: "aura", radius: 2.6, radiusPerLevel: 0.3 },
    },
  ],
  passives: [],
  waves: [{ from: 0, to: 120, enemy: "grunt", perSecond: 3 }],
});

/** One sprite's attributes, as the shader reads them. */
const sprite = (sprites: InstancedSprites, index: number) => {
  const read = (name: string, size: number) =>
    Array.from(
      (sprites.mesh.geometry.getAttribute(name).array as Float32Array).slice(
        index * size,
        index * size + size
      ),
      (v) => Math.round(v * 1000) / 1000
    );
  const [x, z, lift, layer] = read("aPlace", 4);
  const [frame, flip, flash] = read("aFrame", 3);
  const [r, g, b, a] = read("aTint", 4);
  return { x, z, lift, layer, frame, flip, flash, tint: [r, g, b, a] };
};

const count = (sprites: InstancedSprites | null) =>
  sprites?.mesh.geometry.instanceCount ?? 0;

const addEnemy = (world: World, type: number, x: number, z: number) => {
  const i = world.enemies.add();
  world.enemies.fields.type[i] = type;
  world.enemies.fields.x[i] = x;
  world.enemies.fields.z[i] = z;
  world.enemies.fields.hp[i] = 8;
  return i;
};

describe(SurvivorsScene, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws every hero, marker, enemy, gem, projectile and trail in one batch", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = createWorld({ content, heroIds: ["knight", "plain"] }, 1);
    addEnemy(world, 0, 3, 0);
    addEnemy(world, 1, -3, 0);
    for (const value of [1, 3, 5]) {
      const g = world.gems.add();
      world.gems.fields.value[g] = value;
    }
    const p = world.projectiles.add();
    world.projectiles.fields.vx[p] = 10;
    world.projectiles.fields.weapon[p] = 0;

    const scene = new SurvivorsScene(art);
    scene.draw(world, 1);

    // 2 heroes and their markers, 2 enemies, 3 gems, 1 projectile and its 3 trail puffs.
    expect(count(scene.actorSprites)).toBe(4 + 2 + 3 + 4);
    // A shadow under each hero and enemy.
    expect(count(scene.shadowSprites)).toBe(4);
    // The second hero's aura.
    expect(scene.auraMesh.geometry instanceof Object).toBe(true);
    expect(
      (scene.auraMesh.geometry as { instanceCount?: number }).instanceCount
    ).toBe(1);
    scene.dispose();
  });

  it("draws the aura from the sheet's aura art: its rest and pulse frames", () => {
    const scene = new SurvivorsScene(art);
    const { uniforms } = scene.auraMesh.material;
    const ring = tag("aura/ring");
    const rects = (uniforms["uRect"]!.value as { x: number }[]).map(
      (rect) => rect.x
    );
    expect({
      map: uniforms["uMap"]!.value === art.sheet.texture,
      rects,
    }).toStrictEqual({
      map: true,
      rects: [sheetData.frames[ring.from]!.x, sheetData.frames[ring.to]!.x],
    });
    scene.dispose();
  });

  it("draws a hero's own sprite, or the generic one in its colour, and its slot's marker", () => {
    const world = createWorld({ content, heroIds: ["knight", "plain"] }, 1);
    const scene = new SurvivorsScene(art);
    scene.draw(world, 0);
    const actors = scene.actorSprites!;
    const knight = sprite(actors, 0);
    const plain = sprite(actors, 2);
    const markers = [sprite(actors, 1), sprite(actors, 3)];
    expect({
      knight: [knight.frame, knight.tint],
      plain: [plain.frame, plain.tint],
      markers: markers.map((m) => m.frame),
    }).toStrictEqual({
      knight: [tag("knight/idle").from, [1, 1, 1, 1]],
      plain: [tag("hero/idle").from, [1, 0, 0, 1]],
      markers: [tag("marker/ring").from, tag("marker/ring").from],
    });
    expect(markers[0]!.tint).not.toStrictEqual(markers[1]!.tint);
    expect(markers[0]!.layer).toBeLessThan(knight.layer!);
    scene.dispose();
  });

  it("walks a moving hero, flips it facing left, and flashes it when hurt", () => {
    const world = createWorld({ content, heroIds: ["knight"] }, 1);
    const scene = new SurvivorsScene(art);
    scene.draw(world, 0);
    const hero = world.heroes[0]!;
    hero.x -= 0.5;
    hero.faceX = -1;
    hero.hurtTimer = 0.1;
    scene.draw(world, 0.05);
    const drawn = sprite(scene.actorSprites!, 0);
    const walk = tag("knight/walk");
    expect(drawn.frame).toBeGreaterThanOrEqual(walk.from);
    expect(drawn.frame).toBeLessThanOrEqual(walk.to);
    expect(drawn.flip).toBe(1);
    expect(drawn.flash).toBeGreaterThan(0);
    // Standing still a moment later: idle.
    scene.draw(world, 1);
    expect(sprite(scene.actorSprites!, 0).frame).toBe(tag("knight/idle").from);
    scene.dispose();
  });

  it("greys a downed co-op hero lying down, and leaves out a hero whose player left", () => {
    const world = createWorld({ content, heroIds: ["knight", "plain"] }, 1);
    world.heroes[0]!.status = "down";
    (world.heroes[1] as { status: string }).status = "left";
    const scene = new SurvivorsScene(art);
    scene.draw(world, 0);
    const down = sprite(scene.actorSprites!, 0);
    expect(down.frame).toBe(tag("knight/down").from);
    expect(down.tint.slice(0, 3).every((c) => c! < 1)).toBe(true);
    // The downed hero and its marker only.
    expect(count(scene.actorSprites)).toBe(2);
    scene.dispose();
  });

  it("draws enemies by type, the generic one for a missing tag (logged once), flashing when hit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = createWorld({ content, heroIds: ["knight"] }, 1);
    const grunt = addEnemy(world, 0, 2, 0);
    const ghost = addEnemy(world, 1, -2, 0);
    world.enemies.fields.hitFlash[grunt] = 0.1;
    const scene = new SurvivorsScene(art);
    scene.draw(world, 0);
    scene.draw(world, 0.1);
    const actors = scene.actorSprites!;
    const drawnGrunt = sprite(actors, 2 + grunt);
    const drawnGhost = sprite(actors, 2 + ghost);
    const grunts = tag("grunt/move");
    const generic = tag("enemy/move");
    // The ghost is left of the hero, the grunt right: each faces it.
    expect({
      grunt: drawnGrunt.frame! >= grunts.from && drawnGrunt.frame! <= grunts.to,
      ghost:
        drawnGhost.frame! >= generic.from && drawnGhost.frame! <= generic.to,
      flash: [drawnGrunt.flash, drawnGhost.flash],
      flip: [drawnGrunt.flip, drawnGhost.flip],
      ghostTint: drawnGhost.tint,
    }).toStrictEqual({
      grunt: true,
      ghost: true,
      flash: [1, 0],
      flip: [1, 0],
      ghostTint: [0, 0, 1, 1],
    });
    expect(
      warn.mock.calls.filter(([text]) => String(text).includes("ghost/move"))
    ).toHaveLength(1);
    scene.dispose();
  });

  it("draws gems by value and the projectile its weapon names", () => {
    const world = createWorld({ content, heroIds: ["knight"] }, 1);
    for (const value of [1, 3, 5]) {
      world.gems.fields.value[world.gems.add()] = value;
    }
    const p = world.projectiles.add();
    world.projectiles.fields.vx[p] = -10;
    const scene = new SurvivorsScene(art);
    scene.draw(world, 0);
    const actors = scene.actorSprites!;
    const gems = [2, 3, 4].map((i) => sprite(actors, i).frame!);
    const tiers = ["gem/small", "gem/medium", "gem/large"].map(tag);
    expect(
      gems.every((frame, i) => frame >= tiers[i]!.from && frame <= tiers[i]!.to)
    ).toBe(true);
    const trail = [5, 6, 7].map((i) => sprite(actors, i).frame);
    expect(trail).toStrictEqual([
      tag("trail").to,
      tag("trail").from + 1,
      tag("trail").from,
    ]);
    const shot = sprite(actors, 8);
    expect(shot.frame).toBeGreaterThanOrEqual(tag("bolt/plain").from);
    expect(shot.flip).toBe(1);
    expect(shot.layer).toBeGreaterThan(sprite(actors, 0).layer!);
    scene.dispose();
  });

  it("follows the local hero, and pans slowly over the ground with no run", () => {
    const world = createWorld({ content, heroIds: ["knight", "plain"] }, 1);
    const scene = new SurvivorsScene(art, { localHero: 1 });
    world.heroes[1]!.x = 2.53;
    world.heroes[1]!.z = -1.01;
    scene.draw(world, 0);
    // Snapped to sprite pixels, as the hero's sprite is, so the hero doesn't wobble on screen.
    expect(scene.focus).toStrictEqual({ x: 40 / 16, z: -16 / 16 });
    expect(count(scene.groundSprites)).toBeGreaterThan(16 * 16);

    scene.draw(null, 10);
    const before = { ...scene.focus };
    scene.draw(null, 11);
    const moved = Math.hypot(
      scene.focus.x - before.x,
      scene.focus.z - before.z
    );
    expect({
      actors: count(scene.actorSprites),
      shadows: count(scene.shadowSprites),
      slowly: moved > 0 && moved < 1,
    }).toStrictEqual({ actors: 0, shadows: 0, slowly: true });
    scene.dispose();
  });

  it("frees what it made on dispose, never the sheet", () => {
    const world = createWorld({ content, heroIds: ["knight"] }, 1);
    const scene = new SurvivorsScene(art);
    scene.draw(world, 0);
    let sheetFreed = false;
    art.sheet.texture.addEventListener("dispose", () => {
      sheetFreed = true;
    });
    const materials = [
      scene.actorSprites!.mesh.material,
      scene.groundSprites!.mesh.material,
    ];
    const freed: unknown[] = [];
    for (const material of materials) {
      material.addEventListener("dispose", (event) => freed.push(event.target));
    }
    scene.dispose();
    expect({
      freed: freed.length,
      sheetFreed,
      children: scene.root.children.length,
    }).toStrictEqual({
      freed: 2,
      sheetFreed: false,
      children: 0,
    });
  });
});

describe(missingSpriteTags, () => {
  it("lists the tags content names that the sheet lacks", () => {
    expect(missingSpriteTags(sheetData, content)).toStrictEqual(["ghost/move"]);
  });
});
