import { PixelCamera, SpriteSheet, TileLayer } from "arcadekit/render-three";
import type { InstancedSprites } from "arcadekit/render-three";
import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as Art from "../../../src/browser/art";
import * as BoardSprites from "../../../src/browser/internal/board-sprites";
import * as PuzzleContent from "../../../src/puzzle-content";
import * as World from "../../../src/world";

// The view's drawing, without WebGL: each test reads back what the view's tile layer and its
// sprite batch show. Boards are read back as pictures, like the simulation's tests: `#` wall,
// `=` wall face, `,` floor, `.` goal, `^` hole, `o` filled hole, `$` box, `*` box on a goal,
// `@` the player. Cells with nothing drawn are blank. Cell (col, row) has its centre at
// (col + 0.5, row + 0.5).

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

const start = (rows: readonly string[]): World.Puzzle =>
  World.make({
    content: Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
      levels: [{ id: "test", name: "Test", rows }],
    }),
    levelId: "test",
  });

const NOTHING = { held: null, pressed: null, undo: false } as const;
/** A step's context for a test that calls `step` itself: its events go nowhere. */
const STEP = { dt: 1 / 60, step: 0, report: () => {} };

const tap = (puzzle: World.Puzzle, direction: World.Direction) => {
  World.step(
    puzzle,
    { held: direction, pressed: direction, undo: false },
    STEP
  );
  World.step(puzzle, NOTHING, STEP);
};

const undo = (puzzle: World.Puzzle) => {
  World.step(puzzle, { held: null, pressed: null, undo: true }, STEP);
  World.step(puzzle, NOTHING, STEP);
};

const setup = (
  sheet: SpriteSheet.SpriteSheet = TestSpriteSheet.fromTags(TAGS)
) => {
  const camera = PixelCamera.make({ pixelsPerUnit: 16 });
  PixelCamera.setBufferSize(camera, 800, 600);
  const sprites = BoardSprites.make(sheet, camera);
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

/** Every sprite a batch shows now, or every tile of the layer's last fill. */
const shown = (
  batch: InstancedSprites.InstancedSprites | TileLayer.TileLayer
): Shown[] =>
  DrawnSprites.read(batch).map(({ x, z, tag, frame, flipX, tint }) => ({
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
const picture = (
  sprites: BoardSprites.BoardSprites,
  puzzle: World.Puzzle
): string[] => {
  const rows = Array.from({ length: puzzle.map.rows }, () =>
    Array.from({ length: puzzle.map.cols }, () => " ")
  );
  for (const sprite of [...shown(sprites.tiles), ...shown(sprites.actors)]) {
    // The nearest cell's: a box or the player may be between two.
    const col = Math.round(sprite.x - 0.5);
    const row = Math.round(sprite.z - 0.5);
    rows[row]![col] = CHARS[sprite.tag]!;
  }
  return rows.map((row) => row.join(""));
};

/** Draws a moment after a turn and again once its slide is over. */
const settle = (
  sprites: BoardSprites.BoardSprites,
  puzzle: World.Puzzle,
  t: number
) => {
  BoardSprites.draw(sprites, puzzle, t);
  BoardSprites.draw(sprites, puzzle, t + 0.5);
};

const player = (sprites: BoardSprites.BoardSprites) =>
  shown(sprites.actors).find((sprite) => sprite.tag.startsWith("player"))!;

/** Every box drawn now, on the board or on its way into a hole. */
const boxes = (sprites: BoardSprites.BoardSprites) =>
  shown(sprites.actors).filter((sprite) => sprite.tag.startsWith("box"));

describe("the push-puzzle sprites", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws a tile per cell inside the walls, then the boxes and the player, in two draw calls", () => {
    const { sprites } = setup();
    const puzzle = start(["  ####", "###@ #", "#  $.#", "# ^* #", "######"]);
    BoardSprites.draw(sprites, puzzle, 0);
    expect(sprites.root.children).toStrictEqual([
      sprites.tiles.mesh,
      sprites.actors.mesh,
    ]);
    expect(picture(sprites, puzzle)).toStrictEqual([
      "  #==#",
      "#==@,#",
      "#,,$.#",
      "#,^*,#",
      "######",
    ]);
    // One tile for each cell inside the walls, and none for the two outside them or for the
    // ground the camera shows around the board.
    expect(sprites.tiles.count).toBe(28);
  });

  it("puts the board's corner at the origin, a tile at each cell's centre", () => {
    const { sprites } = setup();
    const puzzle = start(["####", "#@$.", "####"]);
    BoardSprites.draw(sprites, puzzle, 0);
    expect(shown(sprites.tiles).map(({ x, z }) => [x, z])).toStrictEqual([
      [0.5, 0.5],
      [1.5, 0.5],
      [2.5, 0.5],
      [3.5, 0.5],
      [0.5, 1.5],
      [1.5, 1.5],
      [2.5, 1.5],
      [3.5, 1.5],
      [0.5, 2.5],
      [1.5, 2.5],
      [2.5, 2.5],
      [3.5, 2.5],
    ]);
    // The box and the player are on their cells' centres too.
    expect(shown(sprites.actors).map(({ x, z }) => [x, z])).toStrictEqual([
      [2.5, 1.5],
      [1.5, 1.5],
    ]);
  });

  it("fits the board in view at a whole pixel scale, with room above it for the HUD", () => {
    const { camera, sprites } = setup();
    const puzzle = start(["#######", "#@ $ .#", "#######"]);
    BoardSprites.draw(sprites, puzzle, 0);
    // 800x600 buffer, 7x3 cells plus margins: 800 / (8 * 16) = 6.25 → 6.
    expect(camera.pixelScale).toBe(6);
    // 96 screen pixels to a cell: 800 / 96 cells across and 600 / 96 down. The board is
    // columns 0 to 7 and rows 0 to 3, with a cell of room above row 0: the camera is over
    // the middle of the two together, (3.5, 1).
    expect(
      PixelCamera.groundOnScreen(camera, { minX: 0, maxX: 0, minZ: 0, maxZ: 0 })
    ).toStrictEqual({
      minX: 3.5 - 400 / 96,
      maxX: 3.5 + 400 / 96,
      minZ: 1 - 300 / 96,
      maxZ: 1 + 300 / 96,
    });
  });

  it("fills the level's tiles again on each frame, with what the turns since the last made of them", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    BoardSprites.draw(sprites, puzzle, 0);
    const tiles = () =>
      shown(sprites.tiles)
        .filter(({ z }) => z === 1.5)
        .map(({ tag }) => tag);
    expect(tiles()).toStrictEqual([
      "wall",
      "floor",
      "floor",
      "hole",
      "goal",
      "wall",
    ]);
    // The camera has not moved, and the hole is filled: the layer shows it.
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    expect(tiles()[3]).toBe("hole/filled");
  });

  it("slides the player to its new cell, walking", () => {
    const { sprites } = setup();
    const puzzle = start(["#####", "#@  #", "#$. #", "#####"]);
    BoardSprites.draw(sprites, puzzle, 1);
    const before = player(sprites);
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 2);
    BoardSprites.draw(sprites, puzzle, 2 + SLIDE / 3);
    const midway = player(sprites);
    BoardSprites.draw(sprites, puzzle, 3);
    const after = player(sprites);

    expect(after.x - before.x).toBe(1);
    expect(midway.x).toBeGreaterThan(before.x);
    expect(midway.x).toBeLessThan(after.x);
    expect([midway.tag, after.tag]).toStrictEqual([
      "player/walk",
      "player/idle",
    ]);
  });

  it("rounds what slides to screen pixels", () => {
    const { sprites } = setup();
    // A slide moves by screen pixels, finer than sprite pixels at any scale above 1. The
    // rounding is the batch's, in its shader, and the kit's test: this holds which was asked.
    // The tiles are a tile layer's, which rounds to sprite pixels.
    expect(sprites.actors.snap).toBe("screen");
  });

  it("faces the way it last moved, and keeps facing through an undo", () => {
    const { sprites } = setup();
    // The box and goal keep the level unsolved, so every turn is taken.
    const puzzle = start(["######", "#    #", "# @  #", "#$.  #", "######"]);
    BoardSprites.draw(sprites, puzzle, 0);
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
    BoardSprites.draw(sprites, puzzle, 0);
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
    BoardSprites.draw(sprites, puzzle, 0);
    tap(puzzle, "right");
    // The simulation has already filled the hole; the box is still on its way in.
    BoardSprites.draw(sprites, puzzle, 1);
    const sinking = picture(sprites, puzzle);
    BoardSprites.draw(sprites, puzzle, 1 + SLIDE);
    const filled = picture(sprites, puzzle);
    undo(puzzle);
    BoardSprites.draw(sprites, puzzle, 2);
    BoardSprites.draw(sprites, puzzle, 3);
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
    BoardSprites.draw(sprites, puzzle, 0);
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 1);
    undo(puzzle);
    BoardSprites.draw(sprites, puzzle, 1 + SLIDE / 3);
    // Back in the pool, so no longer drawn as a box on its way into the hole.
    expect(boxes(sprites)).toHaveLength(1);
    BoardSprites.draw(sprites, puzzle, 2);
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
    BoardSprites.draw(sprites, puzzle, 0);
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    tap(puzzle, "left");
    tap(puzzle, "down");
    settle(sprites, puzzle, 2);
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 3);
    const sinking = picture(sprites, puzzle);
    BoardSprites.draw(sprites, puzzle, 3.5);
    const filled = picture(sprites, puzzle);

    expect([sinking.slice(1, 3), filled.slice(1, 3)]).toStrictEqual([
      ["#,,o,,,#", "#@$^,,,#"],
      ["#,,o,,,#", "#,@o,,,#"],
    ]);
  });

  it("slides a box into a hole from where it was last drawn, after a push and the fall in one frame", () => {
    const { sprites } = setup();
    const puzzle = start(["#######", "#@$ ^.#", "#######"]);
    BoardSprites.draw(sprites, puzzle, 0);
    // A push and then the fall, with no frame between them: the hole is two cells from where
    // the box was last drawn, and the board has neither any more.
    tap(puzzle, "right");
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 1);
    BoardSprites.draw(sprites, puzzle, 1 + SLIDE / 3);
    const midway = boxes(sprites);
    const sinking = picture(sprites, puzzle);
    BoardSprites.draw(sprites, puzzle, 1.5);

    expect(midway).toHaveLength(1);
    // Columns 2 and 4 are at x 2.5 and 4.5.
    expect(midway[0]!.x).toBeGreaterThan(2.5);
    expect(midway[0]!.x).toBeLessThan(4.5);
    expect([sinking[1]!.charAt(4), boxes(sprites)]).toStrictEqual(["^", []]);
    expect(picture(sprites, puzzle)[1]).toBe("#,,@o.#");
  });

  it("goes on with a box's slide through a fall that was undone before it looked", () => {
    const { sprites } = setup();
    const puzzle = start(["#######", "#@$ ^.#", "#######"]);
    BoardSprites.draw(sprites, puzzle, 0);
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 1);
    // Into the hole and back out between two frames: the box is in the cell it was sliding to.
    tap(puzzle, "right");
    undo(puzzle);
    BoardSprites.draw(sprites, puzzle, 1 + SLIDE / 3);
    const midway = boxes(sprites);
    BoardSprites.draw(sprites, puzzle, 1 + SLIDE);
    const after = boxes(sprites);

    expect([midway.length, after.length]).toStrictEqual([1, 1]);
    // Columns 2 and 3 are at x 2.5 and 3.5.
    expect(midway[0]!.x).toBeGreaterThan(2.5);
    expect(midway[0]!.x).toBeLessThan(3.5);
    expect(after[0]!.x).toBe(3.5);
    expect(picture(sprites, puzzle)[1]).toBe("#,@$^.#");
  });

  it("keeps a hole filled through an undo and the same fall again before it looked", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    BoardSprites.draw(sprites, puzzle, 0);
    tap(puzzle, "right");
    settle(sprites, puzzle, 1);
    // Out of the hole and into it again between two frames: the box is in the hole, as it was.
    undo(puzzle);
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 2);
    expect(picture(sprites, puzzle)[1]).toBe("#,@o.#");
  });

  it("still slides a box into a hole once the run's changes have gone round their ring", () => {
    const { sprites } = setup();
    const puzzle = start(["######", "#@$^.#", "######"]);
    BoardSprites.draw(sprites, puzzle, 0);
    // Four times into the hole and back out, with a frame after each turn: eight records.
    for (let i = 0; i < 4; i++) {
      tap(puzzle, "right");
      BoardSprites.draw(sprites, puzzle, 2 * i + 1);
      undo(puzzle);
      BoardSprites.draw(sprites, puzzle, 2 * i + 2);
    }
    // The ninth is written over the first.
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 9);
    const sinking = picture(sprites, puzzle);
    BoardSprites.draw(sprites, puzzle, 9.5);
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
    BoardSprites.draw(sprites, puzzle, 0);
    BoardSprites.draw(sprites, null, 1);
    // A box falls while the menu shows.
    tap(puzzle, "right");
    BoardSprites.draw(sprites, puzzle, 2);
    // No box is on its way into the hole: the player alone, standing where it is. Column 2 is
    // at x 2.5.
    expect(shown(sprites.actors).map(({ tag, x }) => [tag, x])).toStrictEqual([
      ["player/idle", 2.5],
    ]);
  });

  it("starts a new run at rest, and shows a dim floor with no run", () => {
    const { sprites } = setup();
    const first = start(["#####", "#@  #", "#$. #", "#####"]);
    BoardSprites.draw(sprites, first, 0);
    tap(first, "right");
    BoardSprites.draw(sprites, first, 1);

    BoardSprites.draw(sprites, null, 1.01);
    const menuTiles = shown(sprites.tiles);
    const menuActors = shown(sprites.actors);

    const second = start(["#####", "#@  #", "#$. #", "#####"]);
    BoardSprites.draw(sprites, second, 1.02);
    expect({
      menuTiles:
        menuTiles.length > 20 && menuTiles.every((tile) => tile.tinted),
      menuActors: menuActors.every((sprite) => sprite.tag.startsWith("box")),
      second: picture(sprites, second),
      // The menu's dim is gone from the level's tiles.
      secondTinted: shown(sprites.tiles).some((tile) => tile.tinted),
    }).toStrictEqual({
      menuTiles: true,
      menuActors: true,
      second: ["#===#", "#@,,#", "#$.,#", "#####"],
      secondTinted: false,
    });
  });

  it("covers what the camera shows with the menu's floor", () => {
    const { camera, sprites } = setup();
    BoardSprites.draw(sprites, null, 0);
    // 800x600 at 3 screen pixels per sprite pixel: 48 to a cell, around the origin. Columns -9
    // to 8 and rows -7 to 6 are on screen, the outer ones in part.
    expect(camera.pixelScale).toBe(3);
    const tiles = shown(sprites.tiles);
    expect([tiles.length, sprites.tiles.count]).toStrictEqual([18 * 14, 252]);
    expect(
      [tiles[0], tiles.at(-1)].map((tile) => [tile?.x, tile?.z])
    ).toStrictEqual([
      [-8.5, -6.5],
      [8.5, 6.5],
    ]);
    expect(new Set(tiles.map((tile) => tile.tag))).toStrictEqual(
      new Set(["floor", "goal"])
    );
  });

  it("puts the menu's crates on cells of its floor, dimmed, and on a goal where the floor has one", () => {
    const { sprites } = setup();
    BoardSprites.draw(sprites, null, 0);
    const tagAt = new Map(
      shown(sprites.tiles).map((tile) => [`${tile.x} ${tile.z}`, tile.tag])
    );
    const crates = shown(sprites.actors);
    expect(crates.length).toBeGreaterThan(0);
    expect(crates.filter((crate) => !crate.tinted)).toStrictEqual([]);
    // Each crate is at the centre of a cell on screen, and shows as on a goal where the
    // floor under it is one.
    expect(
      crates.map((crate) => tagAt.get(`${crate.x} ${crate.z}`))
    ).toStrictEqual(
      crates.map((crate) => (crate.tag === "box/on-goal" ? "goal" : "floor"))
    );
  });

  it("fills the menu's floor again when the drift brings other cells on screen, not before", () => {
    const { sprites } = setup();
    BoardSprites.draw(sprites, null, 0);
    const invalidated = vi.spyOn(TileLayer, "invalidate");
    const before = shown(sprites.tiles);
    // A hundredth of a second of drift: the same cells, and the layer is left as it is.
    BoardSprites.draw(sprites, null, 0.01);
    expect(shown(sprites.tiles)).toStrictEqual(before);
    // Three seconds: a cell to the east and a cell down, and the layer fills the cells now
    // on screen. The view asks for neither fill: the layer sees the cells change.
    BoardSprites.draw(sprites, null, 3);
    expect(invalidated).not.toHaveBeenCalled();
    const after = shown(sprites.tiles);
    expect([after[0]!.x, after[0]!.z]).toStrictEqual([
      before[0]!.x + 1,
      before[0]!.z + 1,
    ]);
    // A cell shows the same tile wherever the camera is.
    const frameBefore = new Map(
      before.map((tile) => [`${tile.x} ${tile.z}`, tile.frame])
    );
    const both = after.filter((tile) => frameBefore.has(`${tile.x} ${tile.z}`));
    expect(both).toHaveLength(17 * 13);
    expect(both.map((tile) => tile.frame)).toStrictEqual(
      both.map((tile) => frameBefore.get(`${tile.x} ${tile.z}`))
    );
  });

  it("fills the menu's floor again when the goal's animation moves on", () => {
    // A sheet whose goal has two frames of 100 ms.
    const { sheet, sprites } = setup(
      TestSpriteSheet.fromTags({ ...TAGS, goal: 2 })
    );
    const goal = sheet.data.tags.get("goal")!;
    const goalFrames = () => [
      ...new Set(
        shown(sprites.tiles)
          .filter((tile) => tile.tag === "goal")
          .map((tile) => tile.frame)
      ),
    ];
    BoardSprites.draw(sprites, null, 0);
    expect(goalFrames()).toStrictEqual([goal.from]);
    // The same cells are on screen: only the time has changed.
    BoardSprites.draw(sprites, null, 0.15);
    expect(goalFrames()).toStrictEqual([goal.to]);
  });

  it("falls back to a near tag when the sheet lacks one, and says which it lacks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sprites } = setup(
      TestSpriteSheet.fromTags({
        floor: 3,
        wall: 1,
        hole: 1,
        box: 1,
        "player/idle": 2,
        "player/walk": 4,
      })
    );
    const puzzle = start(["#####", "#@$.#", "#  ^#", "#####"]);
    BoardSprites.draw(sprites, puzzle, 0);
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
      TestSpriteSheet.fromTags({ wall: 1, floor: 3, hole: 1, "player/idle": 2 })
    );
    const puzzle = start(["#####", "#@$.#", "#####"]);
    BoardSprites.draw(sprites, puzzle, 0);
    // Where it drew nothing: the box is there, as frame 0, then the player.
    expect(
      shown(sprites.actors).map(({ x, frame, tag }) => [x, frame, tag])
    ).toStrictEqual([
      [2.5, 0, "wall"],
      [1.5, 5, "player/idle"],
    ]);
  });

  it("makes no layer or batch again for a board larger than the last: each grows, and keeps its mesh", () => {
    const { sprites } = setup();
    const meshes = [sprites.tiles.mesh, sprites.actors.mesh];
    const room = sprites.actors.capacity;
    const wide = "#".repeat(40);
    const crates = `#${"$".repeat(38)}#`;
    // 240 tiles, and 94 boxes with the player: more than a batch is made with room for.
    const puzzle = start([
      wide,
      `#@${"$ ".repeat(18)} #`,
      crates,
      crates,
      `#${".".repeat(18)}${" ".repeat(20)}#`,
      wide,
    ]);
    BoardSprites.draw(sprites, puzzle, 0);
    expect({
      room,
      tiles: [shown(sprites.tiles).length, sprites.tiles.count],
      boxes: boxes(sprites).length,
      actors: shown(sprites.actors).length,
      grown: sprites.actors.capacity,
      meshes:
        sprites.tiles.mesh === meshes[0] && sprites.actors.mesh === meshes[1],
      children: sprites.root.children,
    }).toStrictEqual({
      room: 64,
      tiles: [240, 240],
      boxes: 94,
      actors: 95,
      grown: 128,
      meshes: true,
      children: meshes,
    });
  });

  it("needs every first tag of Art.tags: the stand-in sheet lacks none", () => {
    expect(
      SpriteSheet.resolveTags(TestSpriteSheet.fromTags(TAGS).data, Art.tags)
        .missing
    ).toStrictEqual([]);
  });

  it("frees its tile layer and its batch on dispose, never the sheet", () => {
    const { sheet, sprites } = setup();
    const freed = vi.spyOn(sheet.texture, "dispose");
    const geometries = [sprites.tiles, sprites.actors].map((batch) =>
      vi.spyOn(batch.mesh.geometry, "dispose")
    );
    BoardSprites.dispose(sprites);
    expect({
      sheet: freed.mock.calls.length,
      batches: geometries.map((spy) => spy.mock.calls.length),
      children: sprites.root.children.length,
    }).toStrictEqual({ sheet: 0, batches: [1, 1], children: 0 });
  });
});
