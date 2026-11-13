import { RingReader, easeOut, hashCell, lerp, progress } from "arcadekit/core";
import {
  Gait,
  InstancedSprites,
  TileLayer,
  frameAt,
  resolveTags,
} from "arcadekit/render-three";
import type {
  MutableGroundBounds,
  PixelCamera,
  ResolvedTags,
  SpriteSheet,
  SpriteTag,
} from "arcadekit/render-three";
import * as THREE from "three";

import { Tile } from "../level";
import { Change } from "../world";
import type { Puzzle } from "../world";

/**
 * Every tag the view draws, by the name it reads each under, with the tags it draws in its
 * place when the sheet lacks it. A sheet for push-puzzle needs the first of each: a test
 * checks one with `resolveTags(sheet, PUSH_PUZZLE_TAGS).missing`.
 */
export const PUSH_PUZZLE_TAGS = {
  floor: "floor",
  wall: "wall",
  wallFace: ["wall/face", "wall"],
  goal: ["goal", "floor"],
  hole: "hole",
  holeFilled: ["hole/filled", "floor"],
  box: "box",
  boxOnGoal: ["box/on-goal", "box"],
  idle: ["player/idle", "player/walk"],
  walk: ["player/walk", "player/idle"],
  up: ["player/up", "player/walk", "player/idle"],
  down: ["player/down", "player/walk", "player/idle"],
} as const;

/** Sprite pixels per cell: tiles are 16 px, and a cell is one world unit. */
export const PIXELS_PER_CELL = 16;
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
 * Draws a Puzzle as pixel-art sprites from the push-puzzle sheet, in two draw calls: the tiles,
 * a tile layer, then the boxes and the player, a batch. The board's cell (0, 0) has its corner
 * at the origin, and cell (col, row) its centre at (col + 0.5, row + 0.5): the tile layer's
 * cells. Fits the board to the pixel camera at a whole pixel scale. With no puzzle, it draws a
 * dim floor behind the menus. No WebGL here: `PushPuzzleView` adds `root` to its stage's scene
 * and renders it.
 */
export class PuzzleSprites {
  /** Holds the tile layer's mesh and the batch's. */
  readonly root = new THREE.Group();
  /** The board's tiles, or the menu's floor: the cells on screen. */
  readonly tiles: TileLayer;
  /** The boxes and the player, over the tiles. */
  readonly actors: InstancedSprites;
  private readonly sheet: SpriteSheet;
  private readonly camera: PixelCamera;
  /** The sheet's tags this view draws, picked once: a missing one is a near one, or frame 0. */
  private readonly tags: ResolvedTags<typeof PUSH_PUZZLE_TAGS>["tags"];

  /** The run being drawn. A new run (a restart, another level) resets everything below. */
  private puzzle: Puzzle | null = null;
  /** True while the menu backdrop is set up. */
  private showingMenu = false;
  /** The board, with room above it for the HUD: what the camera fits. */
  private readonly bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  /** The ground the camera shows, filled each frame for the tile layer. */
  private readonly onScreen: MutableGroundBounds = {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
  };
  /** The time of the frame being drawn, for the frames `levelFrame` picks. */
  private time = 0;
  /** The goal's frame on the menu's floor now: the floor is filled again when it changes. */
  private menuGoal = -1;
  private playerSlide: Slide = newSlide(-1);
  private facing: Facing = "right";
  /** Whether the player is walking: through a slide and a little after, so a held key walks without a stutter. */
  private readonly gait = new Gait({ linger: SLIDE_SECONDS + WALK_LINGER });
  /** How far this view has read the run's `changes`: what a turn did that the board no longer shows. */
  private readonly seen = new RingReader();
  /** Indexed by box stable id. Pool indices move when a box fills a hole, so they can't be used. */
  private boxSlides: Slide[] = [];
  /** 1 for each box id still sliding into the hole it filled, drawn until it gets there. */
  private boxSinking = new Uint8Array(0);
  /** 1 for each cell that was a hole when the run started: once it's floor, a box filled it. */
  private startedAsHole = new Uint8Array(0);
  /** When each hole was filled. It shows open until the box slides in. */
  private filledAt = new Float64Array(0);

  /**
   * The frame a cell of the run's level shows at `time`, or -1 for none: off the map, or
   * outside the walls. Kept, as `menuFrame` is, so a frame makes no closure for the layer.
   */
  private readonly levelFrame = (col: number, row: number): number => {
    const { tags, time } = this;
    const { map } = this.puzzle!;
    const cell = map.cellAt(col, row);
    if (cell === -1) {
      return -1;
    }
    const { tile, goal } = map.fields;
    const kind = tile[cell];
    // Outside the walls: nothing is drawn.
    if (kind === Tile.void) {
      return -1;
    }
    let tag: SpriteTag;
    if (kind === Tile.wall) {
      // A wall shows its face when the cell below it is inside the walls.
      const below = map.cellAt(col, row + 1);
      tag =
        below !== -1 && tile[below] !== Tile.wall && tile[below] !== Tile.void
          ? tags.wallFace
          : tags.wall;
    } else if (kind === Tile.hole) {
      tag = tags.hole;
    } else if (this.startedAsHole[cell] === 1) {
      tag =
        time - this.filledAt[cell]! < SLIDE_SECONDS
          ? tags.hole
          : tags.holeFilled;
    } else if (goal[cell] === 1) {
      tag = tags.goal;
    } else {
      return tags.floor.from + floorVariant(cell, tags.floor);
    }
    return frameAt(this.sheet.data, tag, time);
  };

  /** The frame a cell of the menu's floor shows: a goal now and then, from the cell's hash. */
  private readonly menuFrame = (col: number, row: number): number => {
    const h = hashCell(col, row);
    return h % 31 === 0
      ? this.menuGoal
      : this.tags.floor.from + floorVariant(h, this.tags.floor);
  };

  constructor(sheet: SpriteSheet, camera: PixelCamera) {
    this.sheet = sheet;
    this.camera = camera;
    this.tags = resolveTags(sheet.data, PUSH_PUZZLE_TAGS).tags;
    this.tiles = new TileLayer(sheet, {
      unitsPerPixel: 1 / PIXELS_PER_CELL,
      layer: 0,
    });
    this.actors = new InstancedSprites(sheet, {
      unitsPerPixel: 1 / PIXELS_PER_CELL,
      layer: 1,
      // A slide moves by screen pixels, finer than sprite pixels at any scale above 1.
      snap: "screen",
    });
    this.root.add(this.tiles.mesh, this.actors.mesh);
  }

  /** Draws `puzzle` at `t` real seconds, or the menu backdrop when there's no run. */
  draw(puzzle: Puzzle | null, t: number): void {
    if (puzzle) {
      this.drawPuzzle(puzzle, t);
    } else {
      this.drawMenu(t);
    }
  }

  /** Frees the tile layer and the batch. Never the sheet: the app owns it. */
  dispose(): void {
    this.tiles.dispose();
    this.actors.dispose();
    this.root.removeFromParent();
  }

  private drawPuzzle(puzzle: Puzzle, t: number) {
    if (this.puzzle !== puzzle) {
      this.startDrawing(puzzle);
    }
    // What the turns since the last frame did that the board no longer shows.
    const { changes } = puzzle;
    let undid = false;
    for (let n = this.seen.take(changes); n < changes.written; n++) {
      const i = changes.slotOf(n);
      if (changes.fields.kind[i] === Change.undone) {
        undid = true;
      } else {
        this.sinkBox(changes.fields.box[i]!, changes.fields.cell[i]!, t);
      }
    }
    // A level's frames follow its turns and the time, so its tiles are filled again each
    // frame: a board is small.
    this.time = t;
    this.tiles.invalidate();
    this.tiles.draw(this.camera.groundOnScreen(this.onScreen), this.levelFrame);
    this.actors.begin();
    this.drawBoxes(puzzle, t);
    this.drawPlayer(puzzle, t, undid);
    this.actors.end();
  }

  /** Pushes every box, and any still sliding into a hole. */
  private drawBoxes(puzzle: Puzzle, t: number) {
    const { boxes } = puzzle;
    const { actors, tags } = this;
    for (let i = 0; i < boxes.count; i++) {
      const id = boxes.idOf(i);
      const cell = boxes.fields.cell[i]!;
      // On the board, so not sinking: an undo brought back a box that was.
      this.boxSinking[id] = 0;
      const tag =
        puzzle.map.fields.goal[cell] === 1 ? tags.boxOnGoal : tags.box;
      const slide = this.slideTo(this.boxSlides[id]!, cell, t);
      actors.push(slide.x, slide.z, frameAt(this.sheet.data, tag, t));
    }
    // A box that filled a hole has left the pool: it is drawn until it has slid in.
    for (let id = 0; id < this.boxSinking.length; id++) {
      if (this.boxSinking[id] === 0) {
        continue;
      }
      const slide = this.boxSlides[id]!;
      if (t - slide.startedAt >= SLIDE_SECONDS) {
        this.boxSinking[id] = 0;
      } else {
        this.slideTo(slide, slide.cell, t);
        actors.push(slide.x, slide.z, frameAt(this.sheet.data, tags.box, t));
      }
    }
  }

  /** Pushes the player. `undid` says whether a turn since the last frame was an undo. */
  private drawPlayer(puzzle: Puzzle, t: number, undid: boolean) {
    const slide = this.playerSlide;
    const from = slide.cell;
    this.slideTo(slide, puzzle.player, t);
    // Undo walks the player back the way it came, still facing the same way.
    if (from !== slide.cell && !undid) {
      this.facing = facingOf(slide.cell - from, puzzle.map.cols, this.facing);
    }
    // By the cell the rules have it in: it walks from the turn that moved it.
    this.gait.update(this.cellX(puzzle.player), this.cellZ(puzzle.player), t);
    const walking = this.gait.moving;
    const { tags } = this;
    let tag: SpriteTag;
    if (this.facing === "up") {
      tag = tags.up;
    } else if (this.facing === "down") {
      tag = tags.down;
    } else {
      tag = walking ? tags.walk : tags.idle;
    }
    let frame: number;
    if (walking) {
      frame = frameAt(this.sheet.data, tag, t - this.gait.since);
    } else if (tag === tags.up || tag === tags.down) {
      // Standing still facing up or down: the first step of that walk.
      frame = tag.from;
    } else {
      frame = frameAt(this.sheet.data, tag, t);
    }
    this.actors.push(slide.x, slide.z, frame, this.facing === "left");
  }

  /** Behind the menus: a dim floor with a few goals and crates, drifting under a still camera. */
  private drawMenu(t: number) {
    const { camera, tags, tiles, actors } = this;
    if (!this.showingMenu) {
      this.showingMenu = true;
      this.puzzle = null;
      camera.setViewHeight(MENU.viewHeight);
      // The menu dims every tile, and the layer has a level's tiles to fill over.
      tiles.tint.copy(MENU.tint);
      tiles.invalidate();
    }
    camera.follow(t * MENU.driftX, t * MENU.driftZ);
    // The floor is filled again when the drift brings other cells on screen, and when the
    // goal's animation moves on.
    const goal = frameAt(this.sheet.data, tags.goal, t);
    if (goal !== this.menuGoal) {
      this.menuGoal = goal;
      tiles.invalidate();
    }
    const seen = camera.groundOnScreen(this.onScreen);
    tiles.draw(seen, this.menuFrame);
    // The crates are no tiles: over the same cells, in the batch above them.
    const left = Math.floor(seen.minX);
    const right = Math.ceil(seen.maxX);
    const top = Math.floor(seen.minZ);
    const bottom = Math.ceil(seen.maxZ);
    actors.begin();
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) {
        const h = hashCell(col, row);
        if ((h >>> 8) % 29 === 0) {
          const crate = h % 31 === 0 ? tags.boxOnGoal : tags.box;
          actors.setTint(
            actors.push(col + 0.5, row + 0.5, crate.from),
            MENU.tint
          );
        }
      }
    }
    actors.end();
  }

  /** Fits the camera to this run's board, and puts every slide at rest. */
  private startDrawing(puzzle: Puzzle) {
    this.puzzle = puzzle;
    this.showingMenu = false;
    const { boxes, map } = puzzle;
    const { cells } = map;
    // Cells are one unit wide, and the board's corner is at the origin.
    this.bounds.minX = 0;
    this.bounds.maxX = map.cols;
    this.bounds.minZ = -HUD_ROOM;
    this.bounds.maxZ = map.rows;
    this.camera.fit(this.bounds, MARGIN);
    // A level's tiles are not dimmed, as the menu's are.
    this.tiles.tint.setRGB(1, 1, 1);

    this.startedAsHole = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell++) {
      this.startedAsHole[cell] = map.fields.tile[cell] === Tile.hole ? 1 : 0;
    }
    this.filledAt = new Float64Array(cells).fill(-Infinity);
    // What this run's turns did before now is not shown: the board is drawn at rest.
    this.seen.reset();

    this.playerSlide = this.restingSlide(puzzle.player);
    this.gait.reset();
    this.facing = "right";
    // Every box that will ever exist in this run is in the pool now, before any hole is filled.
    this.boxSlides = [];
    this.boxSinking = new Uint8Array(boxes.capacity);
    for (let i = 0; i < boxes.count; i++) {
      const id = boxes.idOf(i);
      this.boxSlides[id] = this.restingSlide(boxes.fields.cell[i]!);
    }
    for (let id = 0; id < boxes.capacity; id++) {
      this.boxSlides[id] ??= newSlide(-1);
    }
  }

  /**
   * A turn since the last frame put the box `id` in the hole at `cell` and took it out of the
   * pool: the hole shows open and the box is drawn until it has slid in.
   *
   * A frame may take several turns' records, so a fall is shown only if the board still has
   * it and the view does not. Not one a later turn undid, which put the box back on the
   * board. And not one into the hole the box was last drawn in, undone and made again since.
   */
  private sinkBox(id: number, cell: number, t: number) {
    const slide = this.boxSlides[id]!;
    // Where the pool has the box, or -1: it has it again once the fall is undone.
    const index = this.puzzle!.boxes.indexOf(id);
    if (index !== -1 || slide.cell === cell) {
      return;
    }
    this.filledAt[cell] = t;
    this.boxSinking[id] = 1;
    this.slideTo(slide, cell, t);
  }

  /** Starts a slide when the simulation moved the thing to another cell, then advances it. */
  private slideTo(slide: Slide, cell: number, t: number): Slide {
    if (slide.cell !== cell) {
      if (slide.cell === -1) {
        slide.x = this.cellX(cell);
        slide.z = this.cellZ(cell);
      }
      slide.cell = cell;
      slide.fromX = slide.x;
      slide.fromZ = slide.z;
      slide.startedAt = t;
    }
    const eased = easeOut(progress(t, slide.startedAt, SLIDE_SECONDS));
    slide.x = lerp(slide.fromX, this.cellX(cell), eased);
    slide.z = lerp(slide.fromZ, this.cellZ(cell), eased);
    return slide;
  }

  private restingSlide(cell: number): Slide {
    const x = this.cellX(cell);
    const z = this.cellZ(cell);
    return { cell, fromX: x, fromZ: z, startedAt: -Infinity, x, z };
  }

  /** World x of a cell's center. Columns run along +x from the origin, as the tile layer's do. */
  private cellX(cell: number): number {
    return this.puzzle!.map.colOf(cell) + 0.5;
  }

  /** World z of a cell's center. Rows run along +z, so row 0 is at the top of the screen. */
  private cellZ(cell: number): number {
    return this.puzzle!.map.rowOf(cell) + 0.5;
  }
}

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
const floorVariant = (seed: number, floor: SpriteTag): number => {
  const count = floor.to - floor.from + 1;
  const h = hashCell(seed, 7);
  const roll = h % 5;
  return roll < 3 || count === 1 ? 0 : 1 + ((h >>> 4) % (count - 1));
};
