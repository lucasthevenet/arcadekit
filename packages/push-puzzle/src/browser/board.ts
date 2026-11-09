import { InstancedSprites, frameAt, snapToPixel } from "arcadekit/render-three";
import type {
  PixelCamera,
  SpriteSheet,
  SpriteTag,
} from "arcadekit/render-three";
import * as THREE from "three";

import { Tile } from "../level";
import type { Puzzle } from "../world";

/** Every tag the view draws. A sheet for push-puzzle needs them all. */
export const PUSH_PUZZLE_SPRITE_TAGS = [
  "floor",
  "wall",
  "wall/face",
  "goal",
  "hole",
  "hole/filled",
  "box",
  "box/on-goal",
  "player/idle",
  "player/walk",
  "player/up",
  "player/down",
] as const;

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
  /** Most backdrop tiles drawn at once. Plenty for an ultrawide 4K screen. */
  capacity: 2048,
  /** Most crates scattered on it. */
  crates: 64,
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

/** The sheet's tags this view uses, looked up once. A missing tag falls back to a near one, or isn't drawn. */
interface Tags {
  readonly floor: SpriteTag | undefined;
  readonly wall: SpriteTag | undefined;
  readonly wallFace: SpriteTag | undefined;
  readonly goal: SpriteTag | undefined;
  readonly hole: SpriteTag | undefined;
  readonly holeFilled: SpriteTag | undefined;
  readonly box: SpriteTag | undefined;
  readonly boxOnGoal: SpriteTag | undefined;
  readonly idle: SpriteTag | undefined;
  readonly walk: SpriteTag | undefined;
  readonly up: SpriteTag | undefined;
  readonly down: SpriteTag | undefined;
}

/**
 * Draws a Puzzle as pixel-art sprites from the push-puzzle sheet, in two batches (two draw
 * calls): the tiles, then the boxes and the player. Fits the board to the pixel camera at a
 * whole pixel scale. With no puzzle, it draws a dim floor behind the menus. No WebGL here:
 * `PushPuzzleView` adds `root` to its stage's scene and renders it.
 */
export class PuzzleSprites {
  /** Holds both batches. */
  readonly root = new THREE.Group();
  private readonly sheet: SpriteSheet;
  private readonly camera: PixelCamera;
  private readonly tags: Tags;
  private tiles: InstancedSprites;
  private actors: InstancedSprites;

  /** The run being drawn. A new run (a restart, another level) resets everything below. */
  private puzzle: Puzzle | null = null;
  /** True while the menu backdrop is set up. */
  private showingMenu = false;
  private readonly bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private playerSlide: Slide = newSlide(-1);
  private facing: Facing = "right";
  /** When the current walk began, for its animation. */
  private walkStartedAt = 0;
  private lastUndos = 0;
  /** Indexed by box stable id. Pool indices move when a box fills a hole, so they can't be used. */
  private boxSlides: Slide[] = [];
  /** 1 for each box id that was on the board last frame. */
  private boxWasOn = new Uint8Array(0);
  /** 1 for each box id on the board this frame. */
  private boxIsOn = new Uint8Array(0);
  /** 1 for each box id still sliding into the hole it filled, drawn until it gets there. */
  private boxSinking = new Uint8Array(0);
  /** 1 for each cell that was a hole when the run started: once it's floor, a box filled it. */
  private startedAsHole = new Uint8Array(0);
  /** Each cell's tile last frame, to see a hole get filled. */
  private lastTiles = new Uint8Array(0);
  /** When each hole was filled. It shows open until the box slides in. */
  private filledAt = new Float64Array(0);

  constructor(sheet: SpriteSheet, camera: PixelCamera) {
    this.sheet = sheet;
    this.camera = camera;
    const tag = (...names: string[]) =>
      names
        .map((name) => sheet.data.tags.get(name))
        .find((found) => found !== undefined);
    this.tags = {
      floor: tag("floor"),
      wall: tag("wall"),
      wallFace: tag("wall/face", "wall"),
      goal: tag("goal", "floor"),
      hole: tag("hole"),
      holeFilled: tag("hole/filled", "floor"),
      box: tag("box"),
      boxOnGoal: tag("box/on-goal", "box"),
      idle: tag("player/idle", "player/walk"),
      walk: tag("player/walk", "player/idle"),
      up: tag("player/up", "player/walk", "player/idle"),
      down: tag("player/down", "player/walk", "player/idle"),
    };
    this.tiles = this.makeTiles(MENU.capacity);
    this.actors = this.makeActors(MENU.crates);
  }

  /** Draws `puzzle` at `t` real seconds, or the menu backdrop when there's no run. */
  draw(puzzle: Puzzle | null, t: number): void {
    if (puzzle) {
      this.drawPuzzle(puzzle, t);
    } else {
      this.drawMenu(t);
    }
  }

  /** Frees both batches. Never the sheet: the app owns it. */
  dispose(): void {
    this.tiles.dispose();
    this.actors.dispose();
    this.root.removeFromParent();
  }

  private drawPuzzle(puzzle: Puzzle, t: number) {
    if (this.puzzle !== puzzle) {
      this.startDrawing(puzzle);
    }
    this.drawTiles(puzzle, t);
    let count = this.drawBoxes(puzzle, t);
    count = this.drawPlayer(puzzle, t, count);
    this.actors.commit(count);
  }

  private drawTiles(puzzle: Puzzle, t: number) {
    const { tags, tiles } = this;
    const { cols } = puzzle;
    const cells = puzzle.tiles.length;
    let count = 0;
    for (let cell = 0; cell < cells; cell++) {
      const tile = puzzle.tiles[cell];
      if (tile === Tile.floor && this.lastTiles[cell] === Tile.hole) {
        this.filledAt[cell] = t;
      }
      this.lastTiles[cell] = tile!;
      let tag: SpriteTag | undefined;
      let frame = -1;
      if (tile === Tile.wall) {
        const below = puzzle.tiles[cell + cols];
        tag =
          below !== undefined && below !== Tile.wall && below !== Tile.void
            ? tags.wallFace
            : tags.wall;
      } else if (tile === Tile.hole) {
        tag = tags.hole;
      } else if (tile === Tile.floor) {
        if (this.startedAsHole[cell] === 1) {
          tag =
            t - this.filledAt[cell]! < SLIDE_SECONDS
              ? tags.hole
              : tags.holeFilled;
        } else if (puzzle.goals[cell] === 1) {
          tag = tags.goal;
        } else if (tags.floor) {
          tag = tags.floor;
          frame = tags.floor.from + floorVariant(cell, tags.floor);
        }
      }
      if (!tag) {
        continue;
      }
      tiles.set(
        count,
        this.cellX(cell),
        this.cellZ(cell),
        frame === -1 ? frameAt(this.sheet.data, tag, t) : frame
      );
      count += 1;
    }
    tiles.commit(count);
  }

  /** Writes every box, and any still sliding into a hole, from sprite 0. Returns the count. */
  private drawBoxes(puzzle: Puzzle, t: number): number {
    const { boxes } = puzzle;
    const { actors, tags } = this;
    this.boxIsOn.fill(0);
    let count = 0;
    for (let i = 0; i < boxes.count; i++) {
      const id = boxes.idOf(i);
      const cell = boxes.fields.cell[i]!;
      this.boxIsOn[id] = 1;
      this.boxSinking[id] = 0;
      const tag = puzzle.goals[cell] === 1 ? tags.boxOnGoal : tags.box;
      const slide = this.slideTo(this.boxSlides[id]!, cell, t);
      if (tag) {
        actors.set(
          count,
          this.snap(slide.x),
          this.snap(slide.z),
          frameAt(this.sheet.data, tag, t)
        );
        count += 1;
      }
    }
    // A box that left the pool fell into a hole next to where it was: slide it in, then drop it.
    for (let id = 0; id < this.boxWasOn.length; id++) {
      const slide = this.boxSlides[id]!;
      if (this.boxWasOn[id] === 1 && this.boxIsOn[id] === 0) {
        const hole = this.filledNeighbor(puzzle, slide.cell, t);
        this.boxSinking[id] = hole === -1 ? 0 : 1;
        if (hole !== -1) {
          this.slideTo(slide, hole, t);
        }
      }
      this.boxWasOn[id] = this.boxIsOn[id]!;
      if (this.boxSinking[id] === 1 && this.boxIsOn[id] === 0) {
        if (t - slide.startedAt >= SLIDE_SECONDS) {
          this.boxSinking[id] = 0;
        } else if (tags.box) {
          this.slideTo(slide, slide.cell, t);
          actors.set(
            count,
            this.snap(slide.x),
            this.snap(slide.z),
            frameAt(this.sheet.data, tags.box, t)
          );
          count += 1;
        }
      }
    }
    return count;
  }

  /** Writes the player as sprite `index`. Returns the count after it. */
  private drawPlayer(puzzle: Puzzle, t: number, index: number): number {
    const slide = this.playerSlide;
    const from = slide.cell;
    const wasWalking = t - slide.startedAt < SLIDE_SECONDS + WALK_LINGER;
    this.slideTo(slide, puzzle.player, t);
    const undid = puzzle.cues.undos !== this.lastUndos;
    this.lastUndos = puzzle.cues.undos;
    if (from !== slide.cell) {
      if (!wasWalking) {
        this.walkStartedAt = t;
      }
      // Undo walks the player back the way it came, still facing the same way.
      if (!undid) {
        this.facing = facingOf(slide.cell - from, puzzle.cols, this.facing);
      }
    }
    const walking = t - slide.startedAt < SLIDE_SECONDS + WALK_LINGER;
    const { tags } = this;
    let tag: SpriteTag | undefined;
    if (this.facing === "up") {
      tag = tags.up;
    } else if (this.facing === "down") {
      tag = tags.down;
    } else {
      tag = walking ? tags.walk : tags.idle;
    }
    if (!tag) {
      return index;
    }
    let frame: number;
    if (walking) {
      frame = frameAt(this.sheet.data, tag, t - this.walkStartedAt);
    } else if (tag === tags.up || tag === tags.down) {
      // Standing still facing up or down: the first step of that walk.
      frame = tag.from;
    } else {
      frame = frameAt(this.sheet.data, tag, t);
    }
    this.actors.set(
      index,
      this.snap(slide.x),
      this.snap(slide.z),
      frame,
      this.facing === "left"
    );
    return index + 1;
  }

  /** Behind the menus: a dim floor with a few goals and crates, drifting under a still camera. */
  private drawMenu(t: number) {
    const { camera, tags, tiles, actors } = this;
    if (!this.showingMenu) {
      this.showingMenu = true;
      this.puzzle = null;
      camera.setViewHeight(MENU.viewHeight);
    }
    camera.follow(t * MENU.driftX, t * MENU.driftZ);
    const left = Math.floor(camera.position.x + camera.left);
    const right = Math.ceil(camera.position.x + camera.right);
    const top = Math.floor(camera.position.z - camera.top);
    const bottom = Math.ceil(camera.position.z - camera.bottom);
    let count = 0;
    let crates = 0;
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) {
        if (count >= tiles.capacity) {
          break;
        }
        const h = hash2(col, row);
        let tag = tags.floor;
        let frame = -1;
        if (h % 31 === 0 && tags.goal) {
          tag = tags.goal;
        } else if (tags.floor) {
          frame = tags.floor.from + floorVariant(h, tags.floor);
        }
        if (!tag) {
          continue;
        }
        tiles.set(
          count,
          col + 0.5,
          row + 0.5,
          frame === -1 ? frameAt(this.sheet.data, tag, t) : frame
        );
        tiles.setTint(count, MENU.tint);
        count += 1;
        const crate = h % 31 === 0 ? tags.boxOnGoal : tags.box;
        if ((h >>> 8) % 29 === 0 && crate && crates < actors.capacity) {
          actors.set(crates, col + 0.5, row + 0.5, crate.from);
          actors.setTint(crates, MENU.tint);
          crates += 1;
        }
      }
    }
    tiles.commit(count);
    actors.commit(crates);
  }

  /** Sizes the batches for this run's board, fits the camera to it, and puts every slide at rest. */
  private startDrawing(puzzle: Puzzle) {
    this.puzzle = puzzle;
    this.showingMenu = false;
    const cells = puzzle.tiles.length;
    if (cells > this.tiles.capacity) {
      this.tiles.dispose();
      this.tiles = this.makeTiles(cells);
    }
    const { boxes } = puzzle;
    if (boxes.capacity + 1 > this.actors.capacity) {
      this.actors.dispose();
      this.actors = this.makeActors(boxes.capacity + 1);
    }
    // Cells are one unit wide and centered on the origin.
    this.bounds.maxX = puzzle.cols / 2;
    this.bounds.minX = -this.bounds.maxX;
    this.bounds.maxZ = puzzle.rows / 2;
    this.bounds.minZ = -this.bounds.maxZ - HUD_ROOM;
    this.camera.fit(this.bounds, MARGIN);

    this.startedAsHole = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell++) {
      this.startedAsHole[cell] = puzzle.tiles[cell] === Tile.hole ? 1 : 0;
    }
    this.lastTiles = Uint8Array.from(puzzle.tiles);
    this.filledAt = new Float64Array(cells).fill(-Infinity);

    this.playerSlide = this.restingSlide(puzzle.player);
    this.facing = "right";
    this.lastUndos = puzzle.cues.undos;
    // Every box that will ever exist in this run is in the pool now, before any hole is filled.
    this.boxSlides = [];
    this.boxWasOn = new Uint8Array(boxes.capacity);
    this.boxIsOn = new Uint8Array(boxes.capacity);
    this.boxSinking = new Uint8Array(boxes.capacity);
    for (let i = 0; i < boxes.count; i++) {
      const id = boxes.idOf(i);
      this.boxSlides[id] = this.restingSlide(boxes.fields.cell[i]!);
      this.boxWasOn[id] = 1;
    }
    for (let id = 0; id < boxes.capacity; id++) {
      this.boxSlides[id] ??= newSlide(-1);
    }
  }

  private makeTiles(capacity: number): InstancedSprites {
    const tiles = new InstancedSprites(this.sheet, {
      capacity,
      unitsPerPixel: 1 / PIXELS_PER_CELL,
      layer: 0,
    });
    this.root.add(tiles.mesh);
    return tiles;
  }

  private makeActors(capacity: number): InstancedSprites {
    const actors = new InstancedSprites(this.sheet, {
      capacity,
      unitsPerPixel: 1 / PIXELS_PER_CELL,
      layer: 1,
      // Slides snap to screen pixels (`snap`), finer than sprite pixels at any scale above 1.
      snap: false,
    });
    this.root.add(actors.mesh);
    return actors;
  }

  /** The hole next to `cell` that was filled this frame, or -1. */
  private filledNeighbor(puzzle: Puzzle, cell: number, t: number): number {
    const { cols } = puzzle;
    const col = cell % cols;
    const { filledAt } = this;
    if (filledAt[cell - cols] === t) {
      return cell - cols;
    }
    if (filledAt[cell + cols] === t) {
      return cell + cols;
    }
    if (col > 0 && filledAt[cell - 1] === t) {
      return cell - 1;
    }
    if (col < cols - 1 && filledAt[cell + 1] === t) {
      return cell + 1;
    }
    return -1;
  }

  /** A world position rounded to the nearest screen pixel, so a slide never blurs or shimmers. */
  private snap(value: number): number {
    return snapToPixel(value, this.camera.screenPixelsPerUnit);
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
    const k = Math.min(1, (t - slide.startedAt) / SLIDE_SECONDS);
    const eased = k * (2 - k);
    slide.x = slide.fromX + (this.cellX(cell) - slide.fromX) * eased;
    slide.z = slide.fromZ + (this.cellZ(cell) - slide.fromZ) * eased;
    return slide;
  }

  private restingSlide(cell: number): Slide {
    const x = this.cellX(cell);
    const z = this.cellZ(cell);
    return { cell, fromX: x, fromZ: z, startedAt: -Infinity, x, z };
  }

  /** World x of a cell's center. The tile map is centered on the origin; columns run along +x. */
  private cellX(cell: number): number {
    const { cols } = this.puzzle!;
    return (cell % cols) - (cols - 1) / 2;
  }

  /** World z of a cell's center. Rows run along +z, so row 0 is at the top of the screen. */
  private cellZ(cell: number): number {
    const { cols, rows } = this.puzzle!;
    return Math.floor(cell / cols) - (rows - 1) / 2;
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

/** Mixes two whole numbers into a well-spread unsigned one. */
const hash2 = (a: number, b: number): number => {
  let h = Math.imul(a, 0x27_d4_eb_2d) ^ Math.imul(b, 0x16_56_67_b1);
  h = Math.imul(h ^ (h >>> 15), 0x85_eb_ca_6b);
  return (h ^ (h >>> 13)) >>> 0;
};

/** Which floor frame a cell gets: mostly the plain one, now and then another. */
const floorVariant = (seed: number, floor: SpriteTag): number => {
  const count = floor.to - floor.from + 1;
  const h = hash2(seed, 7);
  const roll = h % 5;
  return roll < 3 || count === 1 ? 0 : 1 + ((h >>> 4) % (count - 1));
};
