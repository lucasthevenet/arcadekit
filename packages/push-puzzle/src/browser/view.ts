import { InstancedCrowd, Stage, fitCamera } from "@gamekit/render-three";
import type { GameView } from "@gamekit/runtime";
import * as THREE from "three";

import { Tile } from "../level";
import type { Puzzle } from "../world";

/** Real seconds a slide from one cell to the next takes. Shorter than the hold-repeat interval. */
const SLIDE_SECONDS = 0.09;
/** A fixed camera, high above and slightly in front, that keeps the whole tile map in view. */
const CAMERA = { margin: 1, tilt: 0.35 } as const;

const BOX_COLOR = new THREE.Color("#d9a441");
const BOX_ON_GOAL_COLOR = new THREE.Color("#7ddc6a");

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

/** Draws a Puzzle with Three.js. Reads the simulation; never changes it. */
export class PushPuzzleView implements GameView<Puzzle> {
  // Orthographic: a flat board reads best when far cells aren't drawn smaller.
  private readonly stage: Stage<"orthographic">;
  private readonly player: THREE.Mesh;
  private crowds: {
    floor: InstancedCrowd;
    wall: InstancedCrowd;
    hole: InstancedCrowd;
    goal: InstancedCrowd;
    box: InstancedCrowd;
  } | null = null;
  /** The run being drawn. A new run (a restart, another level) resets everything below. */
  private puzzle: Puzzle | null = null;
  private playerSlide: Slide = newSlide();
  /** Indexed by box stable id. Pool indices move when a box fills a hole, so they can't be used. */
  private boxSlides: Slide[] = [];
  /** The tile map's outline in world units, set once per run so framing allocates nothing. */
  private readonly bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  constructor(container: HTMLElement) {
    this.stage = new Stage(container, {
      camera: "orthographic",
      background: "#1d1b26",
    });
    const { scene } = this.stage;
    scene.add(new THREE.HemisphereLight("#f2ecff", "#2a2633", 1.8));
    const sun = new THREE.DirectionalLight("#ffffff", 1.2);
    sun.position.set(4, 12, 6);
    scene.add(sun);

    this.player = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 20, 14),
      new THREE.MeshStandardMaterial({ color: "#5ec8ff" })
    );
    this.player.visible = false;
    scene.add(this.player);
  }

  render(puzzle: Puzzle | null, timeSeconds: number): void {
    if (puzzle) {
      this.drawPuzzle(puzzle, timeSeconds);
    } else {
      this.player.visible = false;
      this.removeCrowds();
    }
    this.stage.render();
  }

  dispose(): void {
    // Stage.dispose frees everything in the scene, crowds included.
    this.stage.dispose();
  }

  private drawPuzzle(puzzle: Puzzle, t: number) {
    if (this.puzzle !== puzzle) {
      this.startDrawing(puzzle);
    }
    const crowds = this.crowds!;
    let walls = 0;
    let holes = 0;
    let floors = 0;
    let goals = 0;
    for (let cell = 0; cell < puzzle.tiles.length; cell++) {
      const x = this.cellX(cell);
      const z = this.cellZ(cell);
      const tile = puzzle.tiles[cell];
      if (tile === Tile.wall) {
        crowds.wall.set(walls, x, 0.5, z);
        walls += 1;
      } else if (tile === Tile.hole) {
        crowds.hole.set(holes, x, -0.04, z);
        holes += 1;
      } else if (tile === Tile.floor) {
        crowds.floor.set(floors, x, -0.05, z);
        floors += 1;
      }
      if (puzzle.goals[cell] === 1) {
        crowds.goal.set(goals, x, 0.01, z);
        goals += 1;
      }
    }
    crowds.wall.commit(walls);
    crowds.hole.commit(holes);
    crowds.floor.commit(floors);
    crowds.goal.commit(goals);

    const { boxes } = puzzle;
    for (let i = 0; i < boxes.count; i++) {
      const cell = boxes.fields.cell[i]!;
      const slide = this.slideTo(this.boxSlides[boxes.idOf(i)]!, cell, t);
      crowds.box.set(i, slide.x, 0.4, slide.z);
      crowds.box.setColor(
        i,
        puzzle.goals[cell] === 1 ? BOX_ON_GOAL_COLOR : BOX_COLOR
      );
    }
    crowds.box.commit(puzzle.boxes.count);

    const slide = this.slideTo(this.playerSlide, puzzle.player, t);
    this.player.visible = true;
    this.player.position.set(slide.x, 0.34, slide.z);

    fitCamera(this.stage.camera, this.bounds, CAMERA);
  }

  /** Builds crowds sized for this run's tile map, and puts every slide at rest on its cell. */
  private startDrawing(puzzle: Puzzle) {
    this.removeCrowds();
    this.puzzle = puzzle;
    // Cells are one unit wide and centered on the origin.
    this.bounds.maxX = puzzle.cols / 2;
    this.bounds.minX = -this.bounds.maxX;
    this.bounds.maxZ = puzzle.rows / 2;
    this.bounds.minZ = -this.bounds.maxZ;
    const cells = puzzle.tiles.length;
    const flat = (color: string, size: number, height: number) =>
      new InstancedCrowd(
        new THREE.BoxGeometry(size, height, size),
        new THREE.MeshStandardMaterial({ color }),
        cells
      );
    const goal = new InstancedCrowd(
      new THREE.RingGeometry(0.18, 0.3, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#7ddc6a" }),
      cells
    );
    this.crowds = {
      floor: flat("#3b3748", 0.96, 0.1),
      wall: flat("#7a6f8f", 1, 1),
      hole: flat("#08070b", 0.9, 0.1),
      goal,
      box: new InstancedCrowd(
        new THREE.BoxGeometry(0.8, 0.8, 0.8),
        new THREE.MeshStandardMaterial(),
        Math.max(1, puzzle.boxes.capacity)
      ),
    };
    for (const crowd of Object.values(this.crowds)) {
      this.stage.scene.add(crowd.mesh);
    }

    this.playerSlide = this.restingSlide(puzzle.player);
    // Every box that will ever exist in this run is in the pool now, before any hole is filled.
    this.boxSlides = [];
    const { boxes } = puzzle;
    for (let i = 0; i < boxes.count; i++) {
      this.boxSlides[boxes.idOf(i)] = this.restingSlide(boxes.fields.cell[i]!);
    }
  }

  private removeCrowds() {
    if (!this.crowds) {
      return;
    }
    for (const crowd of Object.values(this.crowds)) {
      crowd.dispose();
    }
    this.crowds = null;
    this.puzzle = null;
  }

  /** Starts a slide when the simulation moved the thing to another cell, then advances it. */
  private slideTo(slide: Slide, cell: number, t: number): Slide {
    if (slide.cell !== cell) {
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
    return { cell, fromX: x, fromZ: z, startedAt: 0, x, z };
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

const newSlide = (): Slide => ({
  cell: -1,
  fromX: 0,
  fromZ: 0,
  startedAt: 0,
  x: 0,
  z: 0,
});
