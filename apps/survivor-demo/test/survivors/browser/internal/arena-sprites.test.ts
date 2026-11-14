import { EntityPool } from "arcadekit/core";
import {
  InstancedSprites,
  SpriteSheet,
  TileLayer,
} from "arcadekit/render-three";
import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as Art from "../../../../src/survivors/browser/art";
import * as ArenaSprites from "../../../../src/survivors/browser/internal/arena-sprites";
import * as SpriteTags from "../../../../src/survivors/browser/internal/sprite-tags";
import * as GameContent from "../../../../src/survivors/game-content";
import * as World from "../../../../src/survivors/world";

// Draws arenas into the sprite batches with a sheet that has no image: no WebGL, only what
// each batch shows.

/** Every tag the view uses, and a few of this test's own, with its number of frames. */
const art = {
  sheet: TestSpriteSheet.fromTags({
    "hero/walk": 4,
    "hero/idle": 1,
    "hero/down": 1,
    "knight/walk": 4,
    "knight/idle": 1,
    "knight/down": 1,
    "enemy/move": 2,
    "grunt/move": 2,
    "bolt/generic": 2,
    "bolt/plain": 2,
    trail: 3,
    "gem/small": 3,
    "gem/medium": 3,
    "gem/large": 3,
    "aura/ring": 2,
    "marker/ring": 1,
    shadow: 1,
    "ground/grass": 4,
    "ground/patch": 3,
    ...Object.fromEntries(
      Object.values(SpriteTags.generic.edges).map((tag) => [tag, 1])
    ),
    "edge/void": 2,
  }),
};
const sheetData = art.sheet.data;
const tag = (name: string) => sheetData.tags.get(name)!;

const weapon = {
  description: "",
  color: "#ffffff",
  damage: 10,
  damagePerLevel: 3,
  cooldown: 0.5,
  cooldownScalePerLevel: 0.9,
  maxLevel: 5,
};

const content = Schema.decodeUnknownSync(GameContent.GameContent)({
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

/** Sprite `index` of what a batch shows. */
const sprite = (sprites: InstancedSprites.InstancedSprites, index: number) =>
  DrawnSprites.read(sprites)[index]!;

/** How many sprites a batch shows. */
const count = (sprites: InstancedSprites.InstancedSprites) =>
  DrawnSprites.read(sprites).length;

/**
 * The ground's tiles as drawn, one string per row of cells from `minZ`, each cell by its tag
 * without the folder: `grass`, `void`, or the wall's side. A cell with no tile is `-`.
 */
const groundPicture = (
  layer: TileLayer.TileLayer,
  seen: { readonly minX: number; readonly minZ: number },
  cols: number,
  rows: number
): string[] => {
  const cells = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => "-")
  );
  for (const tile of DrawnSprites.read(layer)) {
    const row = cells[Math.floor(tile.z) - seen.minZ];
    if (row !== undefined) {
      row[Math.floor(tile.x) - seen.minX] = tile.tag.split("/")[1]!;
    }
  }
  return cells.map((row) => row.join(" "));
};

const addEnemy = (world: World.Arena, type: number, x: number, z: number) => {
  const i = EntityPool.add(world.enemies);
  world.enemies.fields.type[i] = type;
  world.enemies.fields.x[i] = x;
  world.enemies.fields.z[i] = z;
  world.enemies.fields.hp[i] = 8;
  return i;
};

describe("the arena's sprites", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws every hero, marker, enemy, gem, projectile and trail in one batch", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = World.make(
      { content, heroIds: ["knight", "plain"] },
      { seed: 1 }
    );
    addEnemy(world, 0, 3, 0);
    addEnemy(world, 1, -3, 0);
    for (const value of [1, 3, 5]) {
      const g = EntityPool.add(world.gems);
      world.gems.fields.value[g] = value;
    }
    const p = EntityPool.add(world.projectiles);
    world.projectiles.fields.vx[p] = 10;
    world.projectiles.fields.weapon[p] = 0;

    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 1);

    // 2 heroes and their markers, 2 enemies, 3 gems, 1 projectile and its 3 trail puffs.
    expect(count(sprites.actors)).toBe(4 + 2 + 3 + 4);
    // A shadow under each hero and enemy.
    expect(count(sprites.shadows)).toBe(4);
    // The second hero's aura.
    expect(sprites.auras.mesh.count).toBe(1);
    ArenaSprites.dispose(sprites);
  });

  it("draws the aura from the sheet's aura art: its rest and pulse frames", () => {
    const sprites = ArenaSprites.make(art.sheet);
    const { uniforms } = sprites.auras.material;
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
    ArenaSprites.dispose(sprites);
  });

  it("draws a hero's own sprite, or the generic one in its colour, and its slot's marker", () => {
    const world = World.make(
      { content, heroIds: ["knight", "plain"] },
      { seed: 1 }
    );
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 0);
    const { actors } = sprites;
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
    expect(markers[0]!.layer).toBeLessThan(knight.layer);
    ArenaSprites.dispose(sprites);
  });

  it("walks a moving hero, flips it facing left, and flashes it when hurt", () => {
    const world = World.make({ content, heroIds: ["knight"] }, { seed: 1 });
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 0);
    const hero = world.heroes[0]!;
    hero.x -= 0.5;
    hero.faceX = -1;
    hero.hurtTimer = 0.1;
    ArenaSprites.draw(sprites, world, 0.05);
    const drawn = sprite(sprites.actors, 0);
    expect(drawn.tag).toBe("knight/walk");
    expect(drawn.flipX).toBe(true);
    expect(drawn.flash).toBeGreaterThan(0);
    // Standing still a moment later: idle.
    ArenaSprites.draw(sprites, world, 1);
    expect(sprite(sprites.actors, 0).tag).toBe("knight/idle");
    ArenaSprites.dispose(sprites);
  });

  it("greys a downed co-op hero lying down, and leaves out a hero whose player left", () => {
    const world = World.make(
      { content, heroIds: ["knight", "plain"] },
      { seed: 1 }
    );
    world.heroes[0]!.status = "down";
    (world.heroes[1] as { status: string }).status = "left";
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 0);
    const down = sprite(sprites.actors, 0);
    expect(down.tag).toBe("knight/down");
    expect(down.tint.slice(0, 3).every((c) => c < 1)).toBe(true);
    // The downed hero and its marker only.
    expect(count(sprites.actors)).toBe(2);
    ArenaSprites.dispose(sprites);
  });

  it("draws enemies by type, the generic one for a missing tag (logged once), flashing when hit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = World.make({ content, heroIds: ["knight"] }, { seed: 1 });
    const grunt = addEnemy(world, 0, 2, 0);
    const ghost = addEnemy(world, 1, -2, 0);
    world.enemies.fields.hitFlash[grunt] = 0.1;
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 0);
    ArenaSprites.draw(sprites, world, 0.1);
    const { actors } = sprites;
    const drawnGrunt = sprite(actors, 2 + grunt);
    const drawnGhost = sprite(actors, 2 + ghost);
    // The ghost is left of the hero, the grunt right: each faces it.
    expect({
      grunt: drawnGrunt.tag,
      ghost: drawnGhost.tag,
      flash: [drawnGrunt.flash, drawnGhost.flash],
      flip: [drawnGrunt.flipX, drawnGhost.flipX],
      ghostTint: drawnGhost.tint,
    }).toStrictEqual({
      grunt: "grunt/move",
      ghost: "enemy/move",
      flash: [1, 0],
      flip: [true, false],
      ghostTint: [0, 0, 1, 1],
    });
    expect(
      warn.mock.calls.filter(([text]) => String(text).includes("ghost/move"))
    ).toHaveLength(1);
    ArenaSprites.dispose(sprites);
  });

  it("draws gems by value and the projectile its weapon names", () => {
    const world = World.make({ content, heroIds: ["knight"] }, { seed: 1 });
    for (const value of [1, 3, 5]) {
      world.gems.fields.value[EntityPool.add(world.gems)] = value;
    }
    const p = EntityPool.add(world.projectiles);
    world.projectiles.fields.vx[p] = -10;
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 0);
    const { actors } = sprites;
    expect([2, 3, 4].map((i) => sprite(actors, i).tag)).toStrictEqual([
      "gem/small",
      "gem/medium",
      "gem/large",
    ]);
    const trail = [5, 6, 7].map((i) => sprite(actors, i).frame);
    expect(trail).toStrictEqual([
      tag("trail").to,
      tag("trail").from + 1,
      tag("trail").from,
    ]);
    const shot = sprite(actors, 8);
    expect(shot.tag).toBe("bolt/plain");
    expect(shot.flipX).toBe(true);
    expect(shot.layer).toBeGreaterThan(sprite(actors, 0).layer);
    ArenaSprites.dispose(sprites);
  });

  it("keeps each enemy's and gem's animation phase with it when the pool moves it to another slot", () => {
    const world = World.make({ content, heroIds: ["knight"] }, { seed: 1 });
    // Its x names each one here: enemies right of the hero, gems left.
    for (const x of [1, 2, 3, 4, 5]) {
      addEnemy(world, 0, x, 0);
      const g = EntityPool.add(world.gems);
      world.gems.fields.x[g] = -x;
      world.gems.fields.value[g] = 1;
    }
    const sprites = ArenaSprites.make(art.sheet);
    /** The frame each enemy and gem is drawn on at one time, by its x. */
    const framesByX = () => {
      ArenaSprites.draw(sprites, world, 0.03);
      const { actors } = sprites;
      const frames: Record<number, number> = {};
      // The hero and its marker, then the enemies, then the gems.
      for (let i = 0; i < world.enemies.count + world.gems.count; i++) {
        const drawn = sprite(actors, 2 + i);
        frames[drawn.x] = drawn.frame;
      }
      return frames;
    };
    const before = framesByX();
    // The last of each pool is out of step with the first, whose slot it is about to take: a
    // phase kept by slot would put it on the first one's frame.
    expect([before[5] === before[1], before[-5] === before[-1]]).toStrictEqual([
      false,
      false,
    ]);
    EntityPool.remove(world.enemies, 0);
    EntityPool.remove(world.gems, 0);
    expect([world.enemies.fields.x[0], world.gems.fields.x[0]]).toStrictEqual([
      5, -5,
    ]);
    const { 1: _enemy, [-1]: _gem, ...kept } = before;
    expect(framesByX()).toStrictEqual(kept);
    ArenaSprites.dispose(sprites);
  });

  it("follows the local hero, and pans slowly over the ground with no run", () => {
    const world = World.make(
      { content, heroIds: ["knight", "plain"] },
      { seed: 1 }
    );
    let slot = 0;
    const sprites = ArenaSprites.make(art.sheet, { localHero: () => slot });
    world.heroes[1]!.x = 2.53;
    world.heroes[1]!.z = -1.01;
    ArenaSprites.draw(sprites, world, 0);
    expect(sprites.focus).toStrictEqual({ x: 0, z: 0 });
    // The slot is read on every draw: the view follows a seat that changes.
    slot = 1;
    ArenaSprites.draw(sprites, world, 0);
    // Snapped to sprite pixels, as the hero's sprite is, so the hero doesn't wobble on screen.
    expect(sprites.focus).toStrictEqual({ x: 40 / 16, z: -16 / 16 });

    ArenaSprites.draw(sprites, null, 10);
    const before = { ...sprites.focus };
    ArenaSprites.draw(sprites, null, 11);
    const moved = Math.hypot(
      sprites.focus.x - before.x,
      sprites.focus.z - before.z
    );
    expect({
      actors: count(sprites.actors),
      shadows: count(sprites.shadows),
      slowly: moved > 0 && moved < 1,
    }).toStrictEqual({ actors: 0, shadows: 0, slowly: true });
    ArenaSprites.dispose(sprites);
  });

  it("frees what it made on dispose, never the sheet", () => {
    const world = World.make({ content, heroIds: ["knight"] }, { seed: 1 });
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 0);
    let sheetFreed = false;
    art.sheet.texture.addEventListener("dispose", () => {
      sheetFreed = true;
    });
    ArenaSprites.drawGround(sprites, { minX: -4, maxX: 4, minZ: -4, maxZ: 4 });
    const materials = [
      sprites.actors.mesh.material,
      sprites.ground.mesh.material,
      sprites.patches.mesh.material,
    ];
    const freed: unknown[] = [];
    for (const material of materials) {
      material.addEventListener("dispose", (event) => freed.push(event.target));
    }
    ArenaSprites.dispose(sprites);
    expect({
      freed: freed.length,
      sheetFreed,
      children: sprites.root.children.length,
    }).toStrictEqual({
      freed: 3,
      sheetFreed: false,
      children: 0,
    });
  });
});

describe("the survivors ground", () => {
  // The south-east corner of the content's arena, 8 units from its centre to its wall: the
  // wall's tiles are in column 8 and row 8, and the void is beyond them.
  const CORNER = { minX: 6, maxX: 10, minZ: 6, maxZ: 10 };

  it("draws the cells on screen: grass inside the arena, its wall around it and the void beyond", () => {
    const world = World.make({ content, heroIds: ["knight"] }, { seed: 1 });
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, world, 0);
    ArenaSprites.drawGround(sprites, CORNER);
    expect(groundPicture(sprites.ground, CORNER, 4, 4)).toStrictEqual([
      "grass grass e void",
      "grass grass e void",
      "s s se void",
      "void void void void",
    ]);
    // The other corner: the wall's tiles are in column -9 and row -9 there.
    const far = { minX: -11, maxX: -7, minZ: -11, maxZ: -7 };
    ArenaSprites.drawGround(sprites, far);
    expect(groundPicture(sprites.ground, far, 4, 4)).toStrictEqual([
      "void void void void",
      "void void void void",
      "void void nw n",
      "void void w grass",
    ]);
    // Every tile is at its cell's centre, in the lowest layer.
    const tiles = DrawnSprites.read(sprites.ground);
    expect([tiles.length, tiles[0]?.x, tiles[0]?.z]).toStrictEqual([
      16, -10.5, -10.5,
    ]);
    expect(tiles.every((tile) => tile.layer === 0)).toBe(true);
    ArenaSprites.dispose(sprites);
  });

  it("shows a cell the same variant of its tile wherever the camera is", () => {
    const sprites = ArenaSprites.make(art.sheet);
    ArenaSprites.draw(sprites, null, 0);
    /** The frame drawn at each cell of the last fill. */
    const frames = () =>
      new Map(
        DrawnSprites.read(sprites.ground).map((tile) => [
          `${tile.x} ${tile.z}`,
          tile.frame,
        ])
      );
    ArenaSprites.drawGround(sprites, { minX: 0, maxX: 12, minZ: 0, maxZ: 8 });
    const before = frames();
    // The four grass frames are all in use, picked by each cell's hash.
    expect(new Set(before.values())).toStrictEqual(
      new Set([0, 1, 2, 3].map((i) => tag("ground/grass").from + i))
    );
    ArenaSprites.drawGround(sprites, {
      minX: 5.5,
      maxX: 17.5,
      minZ: -3.25,
      maxZ: 4.75,
    });
    const after = frames();
    const shared = [...after.keys()].filter((cell) => before.has(cell));
    expect(shared).toHaveLength(7 * 5);
    expect(shared.map((cell) => after.get(cell))).toStrictEqual(
      shared.map((cell) => before.get(cell))
    );
    ArenaSprites.dispose(sprites);
  });

  it("gives its layer one function for every frame, so a frame makes no closure", () => {
    const sprites = ArenaSprites.make(art.sheet);
    const drawn = vi.spyOn(TileLayer, "draw");
    ArenaSprites.draw(sprites, null, 0);
    ArenaSprites.drawGround(sprites, CORNER);
    ArenaSprites.draw(sprites, null, 1);
    ArenaSprites.drawGround(sprites, CORNER);
    // Each call is the layer's: (layer, seen, frameOf).
    expect(drawn.mock.calls.map(([layer]) => layer)).toStrictEqual([
      sprites.ground,
      sprites.ground,
    ]);
    expect(drawn.mock.calls[1]![2]).toBe(drawn.mock.calls[0]![2]);
    ArenaSprites.dispose(sprites);
  });

  it("draws every dirt patch of an arena, over the grass and clear of the wall", () => {
    const sprites = ArenaSprites.make(art.sheet);
    // No run yet: the backdrop's arena, 60 units from its centre to its wall.
    ArenaSprites.draw(sprites, null, 0);
    ArenaSprites.drawGround(sprites, CORNER);
    const patches = DrawnSprites.read(sprites.patches);
    // One patch per 420 square units of its 120 by 120, each at a place of its own.
    expect([
      patches.length,
      new Set(patches.map((patch) => `${patch.x} ${patch.z}`)).size,
    ]).toStrictEqual([34, 34]);
    expect(
      patches.filter(
        (patch) =>
          patch.tag !== "ground/patch" ||
          // Over the ground's tiles, which are in layer 0.
          patch.layer !== 1 ||
          // On whole units, and never touching the wall.
          !Number.isInteger(patch.x) ||
          !Number.isInteger(patch.z) ||
          Math.abs(patch.x) > 57 ||
          Math.abs(patch.z) > 57
      )
    ).toStrictEqual([]);
    // In the patch's three frames.
    expect(new Set(patches.map((patch) => patch.frame))).toStrictEqual(
      new Set([0, 1, 2].map((i) => tag("ground/patch").from + i))
    );
    ArenaSprites.dispose(sprites);
  });

  it("fills the patches once for an arena, and the ground and the patches again for another", () => {
    const sprites = ArenaSprites.make(art.sheet);
    const ended = vi.spyOn(InstancedSprites, "end");
    /** The fills of the patches' batch: each batch ends a fill of its own. */
    const filled = () =>
      ended.mock.calls.filter(([batch]) => batch === sprites.patches);
    ArenaSprites.draw(sprites, null, 0);
    ArenaSprites.drawGround(sprites, CORNER);
    // In the middle of the backdrop's arena, the corner of the content's is grass.
    expect(groundPicture(sprites.ground, CORNER, 4, 4)[2]).toBe(
      "grass grass grass grass"
    );
    // The camera moves: the patches are not filled again.
    ArenaSprites.draw(sprites, null, 1);
    ArenaSprites.drawGround(sprites, { minX: 20, maxX: 24, minZ: 6, maxZ: 10 });
    expect(filled()).toHaveLength(1);

    // A run in a smaller arena, drawn twice: its wall where the grass was, on the same cells,
    // and an arena too small for a patch.
    const world = World.make({ content, heroIds: ["knight"] }, { seed: 1 });
    ArenaSprites.draw(sprites, world, 2);
    ArenaSprites.drawGround(sprites, CORNER);
    ArenaSprites.drawGround(sprites, CORNER);
    expect(filled()).toHaveLength(2);
    expect(count(sprites.patches)).toBe(0);
    expect(groundPicture(sprites.ground, CORNER, 4, 4)[2]).toBe("s s se void");
    ArenaSprites.dispose(sprites);
  });
});

describe("Art.tags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every tag the view draws for a content, so a test finds the ones a sheet lacks", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      SpriteSheet.resolveTags(sheetData, Art.tags(content)).missing
    ).toStrictEqual(["ghost/move"]);
    // A sheet with none of them: what the view always draws, then each content entry's own
    // sprite before the generic one it falls back to.
    const { data } = TestSpriteSheet.fromTags({ other: 1 });
    expect(
      SpriteSheet.resolveTags(data, Art.tags(content)).missing
    ).toStrictEqual([
      "bolt/generic",
      "trail",
      "gem/small",
      "gem/medium",
      "gem/large",
      "aura/ring",
      "marker/ring",
      "shadow",
      "ground/grass",
      "ground/patch",
      "edge/void",
      ...Object.values(SpriteTags.generic.edges),
      "knight/walk",
      "hero/walk",
      "knight/idle",
      "hero/idle",
      "knight/down",
      "hero/down",
      "grunt/move",
      "enemy/move",
      "ghost/move",
      "bolt/plain",
    ]);
  });
});
