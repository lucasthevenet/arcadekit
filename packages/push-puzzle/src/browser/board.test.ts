import { PixelCamera } from "arcadekit/render-three";
import type { SpriteSheet } from "arcadekit/render-three";
import { Schema } from "effect";
import type * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { PuzzleContent } from "../schema";
import { createPuzzle, step } from "../world";
import type { Direction, Puzzle } from "../world";
import { PuzzleSprites } from "./board";
import { testSheet } from "./test-sheet";

// The view's drawing, without WebGL: the sprite batches are plain Three.js objects, so each
// test reads back what was written to them. Boards are read back as pictures, like the
// simulation's tests: `#` wall, `=` wall face, `,` floor, `.` goal, `^` hole, `o` filled hole,
// `$` box, `*` box on a goal, `@` the player. Cells with nothing drawn are blank.

const SLIDE = 0.09;

const start = (rows: readonly string[]): Puzzle =>
  createPuzzle({
    content: Schema.decodeUnknownSync(PuzzleContent)({
      levels: [{ id: "test", name: "Test", rows }],
    }),
    levelId: "test",
  });

const NOTHING = { held: null, pressed: null, undo: false } as const;
/** A step's context for a test that calls `step` itself: its events go nowhere. */
const STEP = { dt: 1 / 60, step: 0, report: () => {} };

const tap = (puzzle: Puzzle, direction: Direction) => {
  step(puzzle, { held: direction, pressed: direction, undo: false }, STEP);
  step(puzzle, NOTHING, STEP);
};

const undo = (puzzle: Puzzle) => {
  step(puzzle, { held: null, pressed: null, undo: true }, STEP);
  step(puzzle, NOTHING, STEP);
};

const setup = (sheet: SpriteSheet = testSheet()) => {
  const camera = new PixelCamera({ pixelsPerUnit: 16 });
  camera.setBufferSize(800, 600);
  const sprites = new PuzzleSprites(sheet, camera);
  return { sheet, camera, sprites };
};

type Batch = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

/** The batch drawn in `layer`: 0 for tiles, 1 for boxes and the player. */
const batch = (sprites: PuzzleSprites, layer: number): Batch =>
  sprites.root.children.find(
    (child) => (child as Batch).material.uniforms["uLayer"]!.value === layer
  ) as Batch;

interface Shown {
  readonly x: number;
  readonly z: number;
  readonly tag: string;
  readonly frame: number;
  readonly flip: boolean;
  readonly tinted: boolean;
}

/** Every sprite a batch draws now. */
const shown = (
  sprites: PuzzleSprites,
  sheet: SpriteSheet,
  layer: number
): Shown[] => {
  const { geometry } = batch(sprites, layer);
  const place = geometry.getAttribute("aPlace").array;
  const frame = geometry.getAttribute("aFrame").array;
  const tint = geometry.getAttribute("aTint").array;
  return Array.from({ length: geometry.instanceCount }, (_, i) => {
    const { name } = sheet.data.frames[frame[i * 3]!]!;
    return {
      x: place[i * 4]!,
      z: place[i * 4 + 1]!,
      tag: name.slice(0, name.lastIndexOf(" ")),
      frame: frame[i * 3]!,
      flip: frame[i * 3 + 1] === 1,
      tinted: tint[i * 4] !== 1,
    };
  });
};

const CHARS: Record<string, string> = {
  wall: "#",
  "wall/face": "=",
  floor: ",",
  goal: ".",
  hole: "^",
  "hole/filled": "o",
  box: "$",
  "box/on-goal": "*",
  "player/idle": "@",
  "player/walk": "@",
  "player/up": "@",
  "player/down": "@",
};

/** The board as drawn, one character per cell; boxes and the player over their tile. */
const picture = (
  sprites: PuzzleSprites,
  sheet: SpriteSheet,
  puzzle: Puzzle
): string[] => {
  const rows = Array.from({ length: puzzle.rows }, () =>
    Array.from({ length: puzzle.cols }, () => " ")
  );
  for (const sprite of [
    ...shown(sprites, sheet, 0),
    ...shown(sprites, sheet, 1),
  ]) {
    const col = Math.round(sprite.x + (puzzle.cols - 1) / 2);
    const row = Math.round(sprite.z + (puzzle.rows - 1) / 2);
    rows[row]![col] = CHARS[sprite.tag]!;
  }
  return rows.map((row) => row.join(""));
};

/** Draws a moment after a turn and again once its slide is over. */
const settle = (sprites: PuzzleSprites, puzzle: Puzzle, t: number) => {
  sprites.draw(puzzle, t);
  sprites.draw(puzzle, t + 0.5);
};

const player = (sprites: PuzzleSprites, sheet: SpriteSheet) =>
  shown(sprites, sheet, 1).find((sprite) => sprite.tag.startsWith("player"))!;

/** Every box drawn now, on the board or on its way into a hole. */
const boxes = (sprites: PuzzleSprites, sheet: SpriteSheet) =>
  shown(sprites, sheet, 1).filter((sprite) => sprite.tag.startsWith("box"));

describe("the push-puzzle sprites", () => {
  it("draws a tile per cell inside the walls, then the boxes and the player, in two batches", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["  ####", "###@ #", "#  $.#", "# ^* #", "######"]);
    sprites.draw(puzzle, 0);
    expect(sprites.root.children).toHaveLength(2);
    expect(picture(sprites, sheet, puzzle)).toStrictEqual([
      "  #==#",
      "#==@,#",
      "#,,$.#",
      "#,^*,#",
      "######",
    ]);
  });

  it("fits the board in view at a whole pixel scale", () => {
    const { camera, sprites } = setup();
    const puzzle = start(["#######", "#@ $ .#", "#######"]);
    sprites.draw(puzzle, 0);
    // 800x600 buffer, 7x3 cells plus margins: 800 / (8 * 16) = 6.25 → 6.
    expect(camera.pixelScale).toBe(6);
    expect(camera.position.x + camera.left).toBeLessThanOrEqual(-3.5);
    expect(camera.position.x + camera.right).toBeGreaterThanOrEqual(3.5);
  });

  it("slides the player to its new cell, on whole screen pixels, walking", () => {
    const { sheet, camera, sprites } = setup();
    const puzzle = start(["#####", "#@  #", "#$. #", "#####"]);
    sprites.draw(puzzle, 1);
    const before = player(sprites, sheet);
    tap(puzzle, "right");
    sprites.draw(puzzle, 2);
    sprites.draw(puzzle, 2 + SLIDE / 3);
    const midway = player(sprites, sheet);
    sprites.draw(puzzle, 3);
    const after = player(sprites, sheet);

    expect(after.x - before.x).toBe(1);
    expect(midway.x).toBeGreaterThan(before.x);
    expect(midway.x).toBeLessThan(after.x);
    const screenPixel = 1 / camera.screenPixelsPerUnit;
    const pixels = midway.x / screenPixel;
    expect(Math.abs(pixels - Math.round(pixels))).toBeLessThan(1e-6);
    expect([midway.tag, after.tag]).toStrictEqual([
      "player/walk",
      "player/idle",
    ]);
  });

  it("faces the way it last moved, and keeps facing through an undo", () => {
    const { sheet, sprites } = setup();
    // The box and goal keep the level unsolved, so every turn is taken.
    const puzzle = start(["######", "#    #", "# @  #", "#$.  #", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "left");
    settle(sprites, puzzle, 1);
    const left = player(sprites, sheet);
    undo(puzzle);
    settle(sprites, puzzle, 2);
    const undone = player(sprites, sheet);
    tap(puzzle, "up");
    settle(sprites, puzzle, 3);
    const up = player(sprites, sheet);

    expect([left.tag, left.flip]).toStrictEqual(["player/idle", true]);
    expect([undone.tag, undone.flip]).toStrictEqual(["player/idle", true]);
    expect(up.tag).toBe("player/up");
  });

  it("draws a box on a goal as on-goal", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["######", "#@$ .#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    expect(picture(sprites, sheet, puzzle)).toStrictEqual([
      "#====#",
      "#,,@*#",
      "######",
    ]);
  });

  it("slides a box into a hole, fills the hole, and undo opens it again", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    // The simulation has already filled the hole; the box is still on its way in.
    sprites.draw(puzzle, 1);
    const sinking = picture(sprites, sheet, puzzle);
    sprites.draw(puzzle, 1 + SLIDE);
    const filled = picture(sprites, sheet, puzzle);
    undo(puzzle);
    sprites.draw(puzzle, 2);
    sprites.draw(puzzle, 3);
    const undone = picture(sprites, sheet, puzzle);

    expect([sinking[1], filled[1], undone[1]]).toStrictEqual([
      "#@$^.#",
      "#,@o.#",
      "#@$^.#",
    ]);
  });

  it("draws a box once when its fall is undone while it slides in", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    sprites.draw(puzzle, 1);
    undo(puzzle);
    sprites.draw(puzzle, 1 + SLIDE / 3);
    // Back in the pool, so no longer drawn as a box on its way into the hole.
    expect(boxes(sprites, sheet)).toHaveLength(1);
    sprites.draw(puzzle, 2);
    expect(picture(sprites, sheet, puzzle)[1]).toBe("#@$^.#");
  });

  it("slides the second box to fall, though the first fall moved it in the pool", () => {
    const { sheet, sprites } = setup();
    const puzzle = start([
      "########",
      "#@$^   #",
      "# $^   #",
      "#   .  #",
      "########",
    ]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    tap(puzzle, "left");
    tap(puzzle, "down");
    settle(sprites, puzzle, 2);
    tap(puzzle, "right");
    sprites.draw(puzzle, 3);
    const sinking = picture(sprites, sheet, puzzle);
    sprites.draw(puzzle, 3.5);
    const filled = picture(sprites, sheet, puzzle);

    expect([sinking.slice(1, 3), filled.slice(1, 3)]).toStrictEqual([
      ["#,,o,,,#", "#@$^,,,#"],
      ["#,,o,,,#", "#,@o,,,#"],
    ]);
  });

  it("slides a box into a hole from where it was last drawn, after a push and the fall in one frame", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["#######", "#@$ ^.#", "#######"]);
    sprites.draw(puzzle, 0);
    // A push and then the fall, with no frame between them: the hole is two cells from where
    // the box was last drawn, and the board has neither any more.
    tap(puzzle, "right");
    tap(puzzle, "right");
    sprites.draw(puzzle, 1);
    sprites.draw(puzzle, 1 + SLIDE / 3);
    const midway = boxes(sprites, sheet);
    const sinking = picture(sprites, sheet, puzzle);
    sprites.draw(puzzle, 1.5);

    expect(midway).toHaveLength(1);
    // Columns 2 and 4 of 7 are at x -1 and 1.
    expect(midway[0]!.x).toBeGreaterThan(-1);
    expect(midway[0]!.x).toBeLessThan(1);
    expect([sinking[1]!.charAt(4), boxes(sprites, sheet)]).toStrictEqual([
      "^",
      [],
    ]);
    expect(picture(sprites, sheet, puzzle)[1]).toBe("#,,@o.#");
  });

  it("goes on with a box's slide through a fall that was undone before it looked", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["#######", "#@$ ^.#", "#######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    sprites.draw(puzzle, 1);
    // Into the hole and back out between two frames: the box is in the cell it was sliding to.
    tap(puzzle, "right");
    undo(puzzle);
    sprites.draw(puzzle, 1 + SLIDE / 3);
    const midway = boxes(sprites, sheet);
    sprites.draw(puzzle, 1 + SLIDE);
    const after = boxes(sprites, sheet);

    expect([midway.length, after.length]).toStrictEqual([1, 1]);
    // Columns 2 and 3 of 7 are at x -1 and 0.
    expect(midway[0]!.x).toBeGreaterThan(-1);
    expect(midway[0]!.x).toBeLessThan(0);
    expect(after[0]!.x).toBe(0);
    expect(picture(sprites, sheet, puzzle)[1]).toBe("#,@$^.#");
  });

  it("keeps a hole filled through an undo and the same fall again before it looked", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    // Out of the hole and into it again between two frames: the box is in the hole, as it was.
    undo(puzzle);
    tap(puzzle, "right");
    sprites.draw(puzzle, 2);
    expect(picture(sprites, sheet, puzzle)[1]).toBe("#,@o.#");
  });

  it("still slides a box into a hole once the run's changes have gone round their ring", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    // Four times into the hole and back out, with a frame after each turn: eight records.
    for (let i = 0; i < 4; i++) {
      tap(puzzle, "right");
      sprites.draw(puzzle, 2 * i + 1);
      undo(puzzle);
      sprites.draw(puzzle, 2 * i + 2);
    }
    // The ninth is written over the first.
    tap(puzzle, "right");
    sprites.draw(puzzle, 9);
    const sinking = picture(sprites, sheet, puzzle);
    sprites.draw(puzzle, 9.5);
    const filled = picture(sprites, sheet, puzzle);

    expect([
      puzzle.changes.capacity,
      puzzle.changes.written,
      sinking[1],
      filled[1],
    ]).toStrictEqual([8, 9, "#@$^.#", "#,@o.#"]);
  });

  it("draws a run again after the menu at rest, with nothing of the turns it missed", () => {
    const { sheet, sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    sprites.draw(null, 1);
    // A box falls while the menu shows.
    tap(puzzle, "right");
    sprites.draw(puzzle, 2);
    // No box is on its way into the hole: the player alone, standing where it is. Column 2 of
    // 6 is at x -0.5.
    expect(
      shown(sprites, sheet, 1).map(({ tag, x }) => [tag, x])
    ).toStrictEqual([["player/idle", -0.5]]);
  });

  it("starts a new run at rest, and shows a dim floor with no run", () => {
    const { sheet, sprites } = setup();
    const first = start(["#####", "#@  #", "#$. #", "#####"]);
    sprites.draw(first, 0);
    tap(first, "right");
    sprites.draw(first, 1);

    sprites.draw(null, 1.01);
    const menuTiles = shown(sprites, sheet, 0);
    const menuActors = shown(sprites, sheet, 1);

    const second = start(["#####", "#@  #", "#$. #", "#####"]);
    sprites.draw(second, 1.02);
    expect({
      menuTiles:
        menuTiles.length > 20 && menuTiles.every((tile) => tile.tinted),
      menuActors: menuActors.every((sprite) => sprite.tag.startsWith("box")),
      second: picture(sprites, sheet, second),
    }).toStrictEqual({
      menuTiles: true,
      menuActors: true,
      second: ["#===#", "#@,,#", "#$.,#", "#####"],
    });
  });

  it("falls back to a near tag when the sheet lacks one", () => {
    const { sheet, sprites } = setup(
      testSheet(["floor", "wall", "hole", "box", "player/idle", "player/walk"])
    );
    const puzzle = start(["#####", "#@$.#", "#  ^#", "#####"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "down");
    settle(sprites, puzzle, 1);
    // No wall face, filled hole or walking-down frames: wall, floor and the right-facing walk.
    expect(picture(sprites, sheet, puzzle)).toStrictEqual([
      "#####",
      "#,$,#",
      "#@,^#",
      "#####",
    ]);
  });

  it("frees its batches on dispose, never the sheet", () => {
    const { sheet, sprites } = setup();
    const freed = vi.spyOn(sheet.texture, "dispose");
    const geometries = sprites.root.children.map((child) =>
      vi.spyOn((child as Batch).geometry, "dispose")
    );
    sprites.dispose();
    expect({
      sheet: freed.mock.calls.length,
      batches: geometries.map((spy) => spy.mock.calls.length),
      children: sprites.root.children.length,
    }).toStrictEqual({ sheet: 0, batches: [1, 1], children: 0 });
  });
});
