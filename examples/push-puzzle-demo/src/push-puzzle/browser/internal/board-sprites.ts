/**
 * The board's sprites: a run drawn as pixel art from the app's sheet, seen straight down, in two
 * draw calls. The tiles are a tile layer, and the boxes and the player a batch over them. With no
 * run, they are a dim floor behind the menus, drifting slowly.
 *
 * The rules jump a box or the player to its new cell in one step; the board slides it there over
 * a moment of real time. The board's cell (0, 0) has its corner at the origin, and cell
 * (col, row) its centre at (col + 0.5, row + 0.5), as the tile layer's cells. No WebGL here: the
 * sprite view adds `root` to its stage's scene and renders it, and a test reads back what the
 * layer and the batch show.
 *
 * Plain on purpose: a frame draws whole before the browser shows it, so `draw` is a plain call.
 * Its Three.js resources come from a plain `make` and go with a plain `dispose`, which the sprite
 * view calls from its own.
 */
import {
  EntityPool,
  ExactMath,
  Ring,
  RingReader,
  TileMap,
  Tween,
} from "arcadekit/core";
import {
  Gait,
  InstancedSprites,
  PixelCamera,
  SpriteSheet,
  TileLayer,
} from "arcadekit/render-three";
import type { Camera } from "arcadekit/render-three";
import * as THREE from "three";

import * as Level from "../../level";
import * as World from "../../world";
import * as Art from "../art";

/** Real seconds a slide from one cell to the next takes. Shorter than the hold-repeat interval. */
const SLIDE_SECONDS = 0.09;
/** The player keeps walking this long after a slide, so a held key walks without a stutter. */
const WALK_LINGER = 0.06;
/** Cells of room around the board, and extra above it for the HUD. */
const MARGIN = 0.5;
const HUD_ROOM = 1;

/** Behind the menus: a dim dungeon floor, drifting slowly. */
const MENU = {
  viewHeight: 11,
  driftX: 0.35,
  driftZ: 0.2,
  tint: new THREE.Color(0.34, 0.32, 0.4),
} as const;

type Facing = "left" | "right" | "up" | "down";

/**
 * Where a moving thing is drawn. The simulation jumps it to its new cell in one step;
 * the view slides it there over SLIDE_SECONDS of real time.
 */
interface Slide {
  /** The cell the simulation last had it in. */
  cell: number;
  fromX: number;
  fromZ: number;
  startedAt: number;
  x: number;
  z: number;
}

/**
 * The board's sprites: what a caller reads of them. The sprite view adds `root` to its scene, and
 * a test reads back what `tiles` and `actors` show.
 */
export interface BoardSprites {
  /** Holds the tile layer's mesh and the batch's. */
  readonly root: THREE.Group;
  /** The board's tiles, or the menu's floor: the cells on screen. */
  readonly tiles: TileLayer.TileLayer;
  /** The boxes and the player, over the tiles. */
  readonly actors: InstancedSprites.InstancedSprites;
}

/** What the module's functions keep between frames, beyond what a caller reads. */
interface Internal extends BoardSprites {
  readonly sheet: SpriteSheet.SpriteSheet;
  readonly camera: PixelCamera.PixelCamera;
  /** The sheet's tags the board draws, picked once: a missing one is a near one, or frame 0. */
  readonly tags: SpriteSheet.ResolvedTags<typeof Art.tags>["tags"];
  /** The run being drawn. A new run (a restart, another level) resets everything below. */
  puzzle: World.Puzzle | null;
  /** True while the menu backdrop is set up. */
  showingMenu: boolean;
  /** The board, with room above it for the HUD: what the camera fits. */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** The ground the camera shows, filled each frame for the tile layer. */
  readonly onScreen: Camera.MutableGroundBounds;
  /** The time of the frame being drawn, for the frames `levelFrame` picks. */
  time: number;
  /** The goal's frame on the menu's floor now: the floor is filled again when it changes. */
  menuGoal: number;
  playerSlide: Slide;
  facing: Facing;
  /** Whether the player is walking: through a slide and a little after, so a held key walks without a stutter. */
  readonly gait: Gait.Gait;
  /** How far the board has read the run's `changes`: what a turn did that the board no longer shows. */
  readonly seen: RingReader.RingReader;
  /** Indexed by box stable id. Pool indices move when a box fills a hole, so they can't be used. */
  boxSlides: Slide[];
  /** 1 for each box id still sliding into the hole it filled, drawn until it gets there. */
  boxSinking: Uint8Array;
  /** 1 for each cell that was a hole when the run started: once it's floor, a box filled it. */
  startedAsHole: Uint8Array;
  /** When each hole was filled. It shows open until the box slides in. */
  filledAt: Float64Array;
  /**
   * The frame a cell of the run's level shows at `time`, or -1 for none: off the map, or
   * outside the walls. Kept, as `menuFrame` is, so a frame makes no closure for the layer.
   */
  readonly levelFrame: (col: number, row: number) => number;
  /** The frame a cell of the menu's floor shows: a goal now and then, from the cell's hash. */
  readonly menuFrame: (col: number, row: number) => number;
}

/**
 * Makes the board's sprites over `sheet`, fitted by `camera`: a tile layer and a batch, both in
 * `root`, which hold no run yet.
 *
 * The sheet's tags are picked here, once (`Art.tags`), so a frame looks none up.
 */
export const make = (
  sheet: SpriteSheet.SpriteSheet,
  camera: PixelCamera.PixelCamera
): BoardSprites => {
  const tiles = TileLayer.make(sheet, {
    unitsPerPixel: 1 / Art.pixelsPerCell,
    layer: 0,
  });
  const actors = InstancedSprites.make(sheet, {
    unitsPerPixel: 1 / Art.pixelsPerCell,
    layer: 1,
    // A slide moves by screen pixels, finer than sprite pixels at any scale above 1.
    snap: "screen",
  });
  const root = new THREE.Group();
  root.add(tiles.mesh, actors.mesh);
  const self: Internal = {
    root,
    tiles,
    actors,
    sheet,
    camera,
    tags: SpriteSheet.resolveTags(sheet.data, Art.tags).tags,
    puzzle: null,
    showingMenu: false,
    bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    onScreen: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    time: 0,
    menuGoal: -1,
    playerSlide: newSlide(-1),
    facing: "right",
    gait: Gait.make({ linger: SLIDE_SECONDS + WALK_LINGER }),
    seen: RingReader.make(),
    boxSlides: [],
    boxSinking: new Uint8Array(0),
    startedAsHole: new Uint8Array(0),
    filledAt: new Float64Array(0),
    levelFrame: (col, row) => levelFrame(self, col, row),
    menuFrame: (col, row) => menuFrame(self, col, row),
  };
  return self;
};

/**
 * Draws `puzzle` at `t` real seconds, or the menu's floor when there's no run.
 *
 * A new run, told apart by its state object, fits the camera to its board and puts every slide at
 * rest: what its turns did before is not shown. After that, each frame slides what the turns
 * since the last one moved, and shows a box that filled a hole until it has slid in.
 */
export const draw = (
  self: BoardSprites,
  puzzle: World.Puzzle | null,
  t: number
): void => {
  const sprites = self as Internal;
  if (puzzle) {
    drawPuzzle(sprites, puzzle, t);
  } else {
    drawMenu(sprites, t);
  }
};

/** Frees the tile layer and the batch, and takes `root` out of its scene. Never the sheet: the app owns it. */
export const dispose = (self: BoardSprites): void => {
  TileLayer.dispose(self.tiles);
  InstancedSprites.dispose(self.actors);
  self.root.removeFromParent();
};

const levelFrame = (sprites: Internal, col: number, row: number): number => {
  const { tags, time } = sprites;
  const { map } = sprites.puzzle!;
  const cell = TileMap.cellAt(map, col, row);
  if (cell === -1) {
    return -1;
  }
  const { tile, goal } = map.fields;
  const kind = tile[cell];
  // Outside the walls: nothing is drawn.
  if (kind === Level.Tile.void) {
    return -1;
  }
  let tag: SpriteSheet.Tag;
  if (kind === Level.Tile.wall) {
    // A wall shows its face when the cell below it is inside the walls.
    const below = TileMap.cellAt(map, col, row + 1);
    tag =
      below !== -1 &&
      tile[below] !== Level.Tile.wall &&
      tile[below] !== Level.Tile.void
        ? tags.wallFace
        : tags.wall;
  } else if (kind === Level.Tile.hole) {
    tag = tags.hole;
  } else if (sprites.startedAsHole[cell] === 1) {
    tag =
      time - sprites.filledAt[cell]! < SLIDE_SECONDS
        ? tags.hole
        : tags.holeFilled;
  } else if (goal[cell] === 1) {
    tag = tags.goal;
  } else {
    return tags.floor.from + floorVariant(cell, tags.floor);
  }
  return SpriteSheet.frameAt(sprites.sheet.data, tag, time);
};

const menuFrame = (sprites: Internal, col: number, row: number): number => {
  const h = ExactMath.hashCell(col, row);
  return h % 31 === 0
    ? sprites.menuGoal
    : sprites.tags.floor.from + floorVariant(h, sprites.tags.floor);
};

const drawPuzzle = (sprites: Internal, puzzle: World.Puzzle, t: number) => {
  if (sprites.puzzle !== puzzle) {
    startDrawing(sprites, puzzle);
  }
  // What the turns since the last frame did that the board no longer shows.
  const { changes } = puzzle;
  let undid = false;
  for (
    let n = RingReader.take(sprites.seen, changes);
    n < changes.written;
    n++
  ) {
    const i = Ring.slotOf(changes, n);
    if (changes.fields.kind[i] === World.Change.undone) {
      undid = true;
    } else {
      sinkBox(sprites, changes.fields.box[i]!, changes.fields.cell[i]!, t);
    }
  }
  // A level's frames follow its turns and the time, so its tiles are filled again each
  // frame: a board is small.
  sprites.time = t;
  TileLayer.invalidate(sprites.tiles);
  TileLayer.draw(
    sprites.tiles,
    PixelCamera.groundOnScreen(sprites.camera, sprites.onScreen),
    sprites.levelFrame
  );
  InstancedSprites.begin(sprites.actors);
  drawBoxes(sprites, puzzle, t);
  drawPlayer(sprites, puzzle, t, undid);
  InstancedSprites.end(sprites.actors);
};

/** Pushes every box, and any still sliding into a hole. */
const drawBoxes = (sprites: Internal, puzzle: World.Puzzle, t: number) => {
  const { boxes } = puzzle;
  const { actors, tags } = sprites;
  for (let i = 0; i < boxes.count; i++) {
    const id = EntityPool.idOf(boxes, i);
    const cell = boxes.fields.cell[i]!;
    // On the board, so not sinking: an undo brought back a box that was.
    sprites.boxSinking[id] = 0;
    const tag = puzzle.map.fields.goal[cell] === 1 ? tags.boxOnGoal : tags.box;
    const slide = slideTo(sprites, sprites.boxSlides[id]!, cell, t);
    InstancedSprites.push(
      actors,
      slide.x,
      slide.z,
      SpriteSheet.frameAt(sprites.sheet.data, tag, t)
    );
  }
  // A box that filled a hole has left the pool: it is drawn until it has slid in.
  for (let id = 0; id < sprites.boxSinking.length; id++) {
    if (sprites.boxSinking[id] === 0) {
      continue;
    }
    const slide = sprites.boxSlides[id]!;
    if (t - slide.startedAt >= SLIDE_SECONDS) {
      sprites.boxSinking[id] = 0;
    } else {
      slideTo(sprites, slide, slide.cell, t);
      InstancedSprites.push(
        actors,
        slide.x,
        slide.z,
        SpriteSheet.frameAt(sprites.sheet.data, tags.box, t)
      );
    }
  }
};

/** Pushes the player. `undid` says whether a turn since the last frame was an undo. */
const drawPlayer = (
  sprites: Internal,
  puzzle: World.Puzzle,
  t: number,
  undid: boolean
) => {
  const slide = sprites.playerSlide;
  const from = slide.cell;
  slideTo(sprites, slide, puzzle.player, t);
  // Undo walks the player back the way it came, still facing the same way.
  if (from !== slide.cell && !undid) {
    sprites.facing = facingOf(
      slide.cell - from,
      puzzle.map.cols,
      sprites.facing
    );
  }
  // By the cell the rules have it in: it walks from the turn that moved it.
  Gait.update(
    sprites.gait,
    cellX(sprites, puzzle.player),
    cellZ(sprites, puzzle.player),
    t
  );
  const walking = sprites.gait.moving;
  const { tags } = sprites;
  let tag: SpriteSheet.Tag;
  if (sprites.facing === "up") {
    tag = tags.up;
  } else if (sprites.facing === "down") {
    tag = tags.down;
  } else {
    tag = walking ? tags.walk : tags.idle;
  }
  let frame: number;
  if (walking) {
    frame = SpriteSheet.frameAt(
      sprites.sheet.data,
      tag,
      t - sprites.gait.since
    );
  } else if (tag === tags.up || tag === tags.down) {
    // Standing still facing up or down: the first step of that walk.
    frame = tag.from;
  } else {
    frame = SpriteSheet.frameAt(sprites.sheet.data, tag, t);
  }
  InstancedSprites.push(
    sprites.actors,
    slide.x,
    slide.z,
    frame,
    sprites.facing === "left"
  );
};

/** Behind the menus: a dim floor with a few goals and crates, drifting under a still camera. */
const drawMenu = (sprites: Internal, t: number) => {
  const { camera, tags, tiles, actors } = sprites;
  if (!sprites.showingMenu) {
    sprites.showingMenu = true;
    sprites.puzzle = null;
    PixelCamera.setViewHeight(camera, MENU.viewHeight);
    // The menu dims every tile, and the layer has a level's tiles to fill over.
    tiles.tint.copy(MENU.tint);
    TileLayer.invalidate(tiles);
  }
  PixelCamera.follow(camera, t * MENU.driftX, t * MENU.driftZ);
  // The floor is filled again when the drift brings other cells on screen, and when the
  // goal's animation moves on.
  const goal = SpriteSheet.frameAt(sprites.sheet.data, tags.goal, t);
  if (goal !== sprites.menuGoal) {
    sprites.menuGoal = goal;
    TileLayer.invalidate(tiles);
  }
  const seen = PixelCamera.groundOnScreen(camera, sprites.onScreen);
  TileLayer.draw(tiles, seen, sprites.menuFrame);
  // The crates are no tiles: over the same cells, in the batch above them.
  const left = Math.floor(seen.minX);
  const right = Math.ceil(seen.maxX);
  const top = Math.floor(seen.minZ);
  const bottom = Math.ceil(seen.maxZ);
  InstancedSprites.begin(actors);
  for (let row = top; row < bottom; row++) {
    for (let col = left; col < right; col++) {
      const h = ExactMath.hashCell(col, row);
      if ((h >>> 8) % 29 === 0) {
        const crate = h % 31 === 0 ? tags.boxOnGoal : tags.box;
        InstancedSprites.setTint(
          actors,
          InstancedSprites.push(actors, col + 0.5, row + 0.5, crate.from),
          MENU.tint
        );
      }
    }
  }
  InstancedSprites.end(actors);
};

/** Fits the camera to this run's board, and puts every slide at rest. */
const startDrawing = (sprites: Internal, puzzle: World.Puzzle) => {
  sprites.puzzle = puzzle;
  sprites.showingMenu = false;
  const { boxes, map } = puzzle;
  const { cells } = map;
  // Cells are one unit wide, and the board's corner is at the origin.
  sprites.bounds.minX = 0;
  sprites.bounds.maxX = map.cols;
  sprites.bounds.minZ = -HUD_ROOM;
  sprites.bounds.maxZ = map.rows;
  PixelCamera.fit(sprites.camera, sprites.bounds, MARGIN);
  // A level's tiles are not dimmed, as the menu's are.
  sprites.tiles.tint.setRGB(1, 1, 1);

  sprites.startedAsHole = new Uint8Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    sprites.startedAsHole[cell] =
      map.fields.tile[cell] === Level.Tile.hole ? 1 : 0;
  }
  sprites.filledAt = new Float64Array(cells).fill(-Infinity);
  // What this run's turns did before now is not shown: the board is drawn at rest.
  RingReader.reset(sprites.seen);

  sprites.playerSlide = restingSlide(sprites, puzzle.player);
  Gait.reset(sprites.gait);
  sprites.facing = "right";
  // Every box that will ever exist in this run is in the pool now, before any hole is filled.
  sprites.boxSlides = [];
  sprites.boxSinking = new Uint8Array(boxes.capacity);
  for (let i = 0; i < boxes.count; i++) {
    const id = EntityPool.idOf(boxes, i);
    sprites.boxSlides[id] = restingSlide(sprites, boxes.fields.cell[i]!);
  }
  for (let id = 0; id < boxes.capacity; id++) {
    sprites.boxSlides[id] ??= newSlide(-1);
  }
};

/**
 * A turn since the last frame put the box `id` in the hole at `cell` and took it out of the
 * pool: the hole shows open and the box is drawn until it has slid in.
 *
 * A frame may take several turns' records, so a fall is shown only if the board still has
 * it and the view does not. Not one a later turn undid, which put the box back on the
 * board. And not one into the hole the box was last drawn in, undone and made again since.
 */
const sinkBox = (sprites: Internal, id: number, cell: number, t: number) => {
  const slide = sprites.boxSlides[id]!;
  // Where the pool has the box, or -1: it has it again once the fall is undone.
  const index = EntityPool.indexOf(sprites.puzzle!.boxes, id);
  if (index !== -1 || slide.cell === cell) {
    return;
  }
  sprites.filledAt[cell] = t;
  sprites.boxSinking[id] = 1;
  slideTo(sprites, slide, cell, t);
};

/** Starts a slide when the simulation moved the thing to another cell, then advances it. */
const slideTo = (
  sprites: Internal,
  slide: Slide,
  cell: number,
  t: number
): Slide => {
  if (slide.cell !== cell) {
    if (slide.cell === -1) {
      slide.x = cellX(sprites, cell);
      slide.z = cellZ(sprites, cell);
    }
    slide.cell = cell;
    slide.fromX = slide.x;
    slide.fromZ = slide.z;
    slide.startedAt = t;
  }
  const eased = Tween.easeOut(
    Tween.progress(t, slide.startedAt, SLIDE_SECONDS)
  );
  slide.x = ExactMath.lerp(slide.fromX, cellX(sprites, cell), eased);
  slide.z = ExactMath.lerp(slide.fromZ, cellZ(sprites, cell), eased);
  return slide;
};

const restingSlide = (sprites: Internal, cell: number): Slide => {
  const x = cellX(sprites, cell);
  const z = cellZ(sprites, cell);
  return { cell, fromX: x, fromZ: z, startedAt: -Infinity, x, z };
};

/** World x of a cell's center. Columns run along +x from the origin, as the tile layer's do. */
const cellX = (sprites: Internal, cell: number): number =>
  TileMap.colOf(sprites.puzzle!.map, cell) + 0.5;

/** World z of a cell's center. Rows run along +z, so row 0 is at the top of the screen. */
const cellZ = (sprites: Internal, cell: number): number =>
  TileMap.rowOf(sprites.puzzle!.map, cell) + 0.5;

const newSlide = (cell: number): Slide => ({
  cell,
  fromX: 0,
  fromZ: 0,
  startedAt: -Infinity,
  x: 0,
  z: 0,
});

/** Which way a move of `delta` cells faces. */
const facingOf = (delta: number, cols: number, current: Facing): Facing => {
  if (delta === 1) {
    return "right";
  }
  if (delta === -1) {
    return "left";
  }
  if (delta === cols) {
    return "down";
  }
  if (delta === -cols) {
    return "up";
  }
  return current;
};

/** Which floor frame a cell gets: mostly the plain one, now and then another. */
const floorVariant = (seed: number, floor: SpriteSheet.Tag): number => {
  const count = floor.to - floor.from + 1;
  const h = ExactMath.hashCell(seed, 7);
  const roll = h % 5;
  return roll < 3 || count === 1 ? 0 : 1 + ((h >>> 4) % (count - 1));
};
