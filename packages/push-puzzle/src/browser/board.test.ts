import { PixelCamera, resolveTags } from "arcadekit/render-three";
import type { InstancedSprites, SpriteSheet } from "arcadekit/render-three";
import { drawnSprites, testSheet } from "arcadekit/render-three/testing";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PuzzleContent } from "../schema";
import { createPuzzle, step } from "../world";
import type { Direction, Puzzle } from "../world";
import { PUSH_PUZZLE_TAGS, PuzzleSprites } from "./board";

// The view's drawing, without WebGL: each test reads back what the view's two sprite batches
// show. Boards are read back as pictures, like the simulation's tests: `#` wall, `=` wall
// face, `,` floor, `.` goal, `^` hole, `o` filled hole, `$` box, `*` box on a goal, `@` the
// player. Cells with nothing drawn are blank.

/** Every tag the view draws, with its number of frames: a stand-in for the app's sheet. */
const TAGS = {
  floor: 3,
  wall: 1,
  "wall/face": 1,
  goal: 1,
  hole: 1,
  "hole/filled": 1,
  box: 1,
  "box/on-goal": 1,
  "player/idle": 2,
  "player/walk": 4,
  "player/up": 4,
  "player/down": 4,
} as const;

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

const setup = (sheet: SpriteSheet = testSheet(TAGS)) => {
  const camera = new PixelCamera({ pixelsPerUnit: 16 });
  camera.setBufferSize(800, 600);
  const sprites = new PuzzleSprites(sheet, camera);
  return { sheet, camera, sprites };
};

interface Shown {
  readonly x: number;
  readonly z: number;
  readonly tag: string;
  readonly frame: number;
  readonly flip: boolean;
  readonly tinted: boolean;
}

/** Every sprite a batch shows now. */
const shown = (batch: InstancedSprites): Shown[] =>
  drawnSprites(batch).map(({ x, z, tag, frame, flipX, tint }) => ({
    x,
    z,
    tag,
    frame,
    flip: flipX,
    tinted: tint[0] !== 1,
  }));

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
const picture = (sprites: PuzzleSprites, puzzle: Puzzle): string[] => {
  const rows = Array.from({ length: puzzle.rows }, () =>
    Array.from({ length: puzzle.cols }, () => " ")
  );
  for (const sprite of [...shown(sprites.tiles), ...shown(sprites.actors)]) {
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

const player = (sprites: PuzzleSprites) =>
  shown(sprites.actors).find((sprite) => sprite.tag.startsWith("player"))!;

/** Every box drawn now, on the board or on its way into a hole. */
const boxes = (sprites: PuzzleSprites) =>
  shown(sprites.actors).filter((sprite) => sprite.tag.startsWith("box"));

describe("the push-puzzle sprites", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws a tile per cell inside the walls, then the boxes and the player, in two batches", () => {
    const { sprites } = setup();
    const puzzle = start(["  ####", "###@ #", "#  $.#", "# ^* #", "######"]);
    sprites.draw(puzzle, 0);
    expect(sprites.root.children).toHaveLength(2);
    expect(picture(sprites, puzzle)).toStrictEqual([
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

  it("slides the player to its new cell, walking", () => {
    const { sprites } = setup();
    const puzzle = start(["#####", "#@  #", "#$. #", "#####"]);
    sprites.draw(puzzle, 1);
    const before = player(sprites);
    tap(puzzle, "right");
    sprites.draw(puzzle, 2);
    sprites.draw(puzzle, 2 + SLIDE / 3);
    const midway = player(sprites);
    sprites.draw(puzzle, 3);
    const after = player(sprites);

    expect(after.x - before.x).toBe(1);
    expect(midway.x).toBeGreaterThan(before.x);
    expect(midway.x).toBeLessThan(after.x);
    expect([midway.tag, after.tag]).toStrictEqual([
      "player/walk",
      "player/idle",
    ]);
  });

  it("rounds what slides to screen pixels, and its tiles to sprite pixels", () => {
    const { sprites } = setup();
    // A slide moves by screen pixels, finer than sprite pixels at any scale above 1. The
    // rounding is the batch's, in its shader, and the kit's test: this holds which was asked.
    expect([sprites.tiles.snap, sprites.actors.snap]).toStrictEqual([
      "sprite",
      "screen",
    ]);
  });

  it("faces the way it last moved, and keeps facing through an undo", () => {
    const { sprites } = setup();
    // The box and goal keep the level unsolved, so every turn is taken.
    const puzzle = start(["######", "#    #", "# @  #", "#$.  #", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "left");
    settle(sprites, puzzle, 1);
    const left = player(sprites);
    undo(puzzle);
    settle(sprites, puzzle, 2);
    const undone = player(sprites);
    tap(puzzle, "up");
    settle(sprites, puzzle, 3);
    const up = player(sprites);

    expect([left.tag, left.flip]).toStrictEqual(["player/idle", true]);
    expect([undone.tag, undone.flip]).toStrictEqual(["player/idle", true]);
    expect(up.tag).toBe("player/up");
  });

  it("draws a box on a goal as on-goal", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$ .#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    expect(picture(sprites, puzzle)).toStrictEqual([
      "#====#",
      "#,,@*#",
      "######",
    ]);
  });

  it("slides a box into a hole, fills the hole, and undo opens it again", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    // The simulation has already filled the hole; the box is still on its way in.
    sprites.draw(puzzle, 1);
    const sinking = picture(sprites, puzzle);
    sprites.draw(puzzle, 1 + SLIDE);
    const filled = picture(sprites, puzzle);
    undo(puzzle);
    sprites.draw(puzzle, 2);
    sprites.draw(puzzle, 3);
    const undone = picture(sprites, puzzle);

    expect([sinking[1], filled[1], undone[1]]).toStrictEqual([
      "#@$^.#",
      "#,@o.#",
      "#@$^.#",
    ]);
  });

  it("draws a box once when its fall is undone while it slides in", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    sprites.draw(puzzle, 1);
    undo(puzzle);
    sprites.draw(puzzle, 1 + SLIDE / 3);
    // Back in the pool, so no longer drawn as a box on its way into the hole.
    expect(boxes(sprites)).toHaveLength(1);
    sprites.draw(puzzle, 2);
    expect(picture(sprites, puzzle)[1]).toBe("#@$^.#");
  });

  it("slides the second box to fall, though the first fall moved it in the pool", () => {
    const { sprites } = setup();
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
    const sinking = picture(sprites, puzzle);
    sprites.draw(puzzle, 3.5);
    const filled = picture(sprites, puzzle);

    expect([sinking.slice(1, 3), filled.slice(1, 3)]).toStrictEqual([
      ["#,,o,,,#", "#@$^,,,#"],
      ["#,,o,,,#", "#,@o,,,#"],
    ]);
  });

  it("slides a box into a hole from where it was last drawn, after a push and the fall in one frame", () => {
    const { sprites } = setup();
    const puzzle = start(["#######", "#@$ ^.#", "#######"]);
    sprites.draw(puzzle, 0);
    // A push and then the fall, with no frame between them: the hole is two cells from where
    // the box was last drawn, and the board has neither any more.
    tap(puzzle, "right");
    tap(puzzle, "right");
    sprites.draw(puzzle, 1);
    sprites.draw(puzzle, 1 + SLIDE / 3);
    const midway = boxes(sprites);
    const sinking = picture(sprites, puzzle);
    sprites.draw(puzzle, 1.5);

    expect(midway).toHaveLength(1);
    // Columns 2 and 4 of 7 are at x -1 and 1.
    expect(midway[0]!.x).toBeGreaterThan(-1);
    expect(midway[0]!.x).toBeLessThan(1);
    expect([sinking[1]!.charAt(4), boxes(sprites)]).toStrictEqual(["^", []]);
    expect(picture(sprites, puzzle)[1]).toBe("#,,@o.#");
  });

  it("goes on with a box's slide through a fall that was undone before it looked", () => {
    const { sprites } = setup();
    const puzzle = start(["#######", "#@$ ^.#", "#######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    sprites.draw(puzzle, 1);
    // Into the hole and back out between two frames: the box is in the cell it was sliding to.
    tap(puzzle, "right");
    undo(puzzle);
    sprites.draw(puzzle, 1 + SLIDE / 3);
    const midway = boxes(sprites);
    sprites.draw(puzzle, 1 + SLIDE);
    const after = boxes(sprites);

    expect([midway.length, after.length]).toStrictEqual([1, 1]);
    // Columns 2 and 3 of 7 are at x -1 and 0.
    expect(midway[0]!.x).toBeGreaterThan(-1);
    expect(midway[0]!.x).toBeLessThan(0);
    expect(after[0]!.x).toBe(0);
    expect(picture(sprites, puzzle)[1]).toBe("#,@$^.#");
  });

  it("keeps a hole filled through an undo and the same fall again before it looked", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    // Out of the hole and into it again between two frames: the box is in the hole, as it was.
    undo(puzzle);
    tap(puzzle, "right");
    sprites.draw(puzzle, 2);
    expect(picture(sprites, puzzle)[1]).toBe("#,@o.#");
  });

  it("still slides a box into a hole once the run's changes have gone round their ring", () => {
    const { sprites } = setup();
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
    const sinking = picture(sprites, puzzle);
    sprites.draw(puzzle, 9.5);
    const filled = picture(sprites, puzzle);

    expect([
      puzzle.changes.capacity,
      puzzle.changes.written,
      sinking[1],
      filled[1],
    ]).toStrictEqual([8, 9, "#@$^.#", "#,@o.#"]);
  });

  it("draws a run again after the menu at rest, with nothing of the turns it missed", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    sprites.draw(puzzle, 0);
    sprites.draw(null, 1);
    // A box falls while the menu shows.
    tap(puzzle, "right");
    sprites.draw(puzzle, 2);
    // No box is on its way into the hole: the player alone, standing where it is. Column 2 of
    // 6 is at x -0.5.
    expect(shown(sprites.actors).map(({ tag, x }) => [tag, x])).toStrictEqual([
      ["player/idle", -0.5],
    ]);
  });

  it("starts a new run at rest, and shows a dim floor with no run", () => {
    const { sprites } = setup();
    const first = start(["#####", "#@  #", "#$. #", "#####"]);
    sprites.draw(first, 0);
    tap(first, "right");
    sprites.draw(first, 1);

    sprites.draw(null, 1.01);
    const menuTiles = shown(sprites.tiles);
    const menuActors = shown(sprites.actors);

    const second = start(["#####", "#@  #", "#$. #", "#####"]);
    sprites.draw(second, 1.02);
    expect({
      menuTiles:
        menuTiles.length > 20 && menuTiles.every((tile) => tile.tinted),
      menuActors: menuActors.every((sprite) => sprite.tag.startsWith("box")),
      second: picture(sprites, second),
    }).toStrictEqual({
      menuTiles: true,
      menuActors: true,
      second: ["#===#", "#@,,#", "#$.,#", "#####"],
    });
  });

  it("falls back to a near tag when the sheet lacks one, and says which it lacks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sprites } = setup(
      testSheet({
        floor: 3,
        wall: 1,
        hole: 1,
        box: 1,
        "player/idle": 2,
        "player/walk": 4,
      })
    );
    const puzzle = start(["#####", "#@$.#", "#  ^#", "#####"]);
    sprites.draw(puzzle, 0);
    tap(puzzle, "down");
    settle(sprites, puzzle, 1);
    // No wall face, filled hole or walking-down frames: wall, floor and the right-facing walk.
    expect(picture(sprites, puzzle)).toStrictEqual([
      "#####",
      "#,$,#",
      "#@,^#",
      "#####",
    ]);
    // Once, when the view is made: each tag it looked for and did not find.
    expect(warn.mock.calls).toStrictEqual([
      [
        expect.stringContaining(
          'test.png has no tag "wall/face", "goal", "hole/filled", "box/on-goal", "player/up", "player/down"'
        ),
      ],
    ]);
  });

  it("draws the sheet's first frame for a tag it lacks with all its fallbacks", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // No box of any kind, and the wall is the first frame.
    const { sprites } = setup(
      testSheet({ wall: 1, floor: 3, hole: 1, "player/idle": 2 })
    );
    const puzzle = start(["#####", "#@$.#", "#####"]);
    sprites.draw(puzzle, 0);
    // Where it drew nothing: the box is there, as frame 0, then the player.
    expect(
      shown(sprites.actors).map(({ x, frame, tag }) => [x, frame, tag])
    ).toStrictEqual([
      [0, 0, "wall"],
      [-1, 5, "player/idle"],
    ]);
  });

  it("makes no batch again for a board larger than the last: each grows, and keeps its mesh", () => {
    const { sprites } = setup();
    const meshes = [sprites.tiles.mesh, sprites.actors.mesh];
    const room = [sprites.tiles.capacity, sprites.actors.capacity];
    const wide = "#".repeat(40);
    const crates = `#${"$".repeat(38)}#`;
    // 240 tiles, and 94 boxes with the player: more than either batch was made with room for.
    const puzzle = start([
      wide,
      `#@${"$ ".repeat(18)} #`,
      crates,
      crates,
      `#${".".repeat(18)}${" ".repeat(20)}#`,
      wide,
    ]);
    sprites.draw(puzzle, 0);
    expect({
      room,
      tiles: shown(sprites.tiles).length,
      boxes: boxes(sprites).length,
      actors: shown(sprites.actors).length,
      grown: [sprites.tiles.capacity, sprites.actors.capacity],
      meshes:
        sprites.tiles.mesh === meshes[0] && sprites.actors.mesh === meshes[1],
      children: sprites.root.children,
    }).toStrictEqual({
      room: [64, 64],
      tiles: 240,
      boxes: 94,
      actors: 95,
      grown: [256, 128],
      meshes: true,
      children: meshes,
    });
  });

  it("needs every first tag of PUSH_PUZZLE_TAGS: the stand-in sheet lacks none", () => {
    expect(
      resolveTags(testSheet(TAGS).data, PUSH_PUZZLE_TAGS).missing
    ).toStrictEqual([]);
  });

  it("frees its batches on dispose, never the sheet", () => {
    const { sheet, sprites } = setup();
    const freed = vi.spyOn(sheet.texture, "dispose");
    const geometries = [sprites.tiles, sprites.actors].map((batch) =>
      vi.spyOn(batch.mesh.geometry, "dispose")
    );
    sprites.dispose();
    expect({
      sheet: freed.mock.calls.length,
      batches: geometries.map((spy) => spy.mock.calls.length),
      children: sprites.root.children.length,
    }).toStrictEqual({ sheet: 0, batches: [1, 1], children: 0 });
  });
});
