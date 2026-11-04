import { Stage } from "@gamekit/render-three";
import type { SpriteSheet } from "@gamekit/render-three";
import type { GameView } from "@gamekit/runtime/browser";

import type { Puzzle } from "../world";
import { PIXELS_PER_CELL, PuzzleSprites } from "./board";

/** Shows between and around the walls: the dungeon's darkest stone. */
const BACKGROUND = "#17151f";

/**
 * Draws a Puzzle as pixel art seen straight down, from the app's push-puzzle sheet. Reads the
 * simulation; never changes it. Two draw calls: the tiles, then the boxes and the player.
 * `dispose` frees what the view made and never the sheet, which the app owns.
 */
export class PushPuzzleView implements GameView<Puzzle> {
  private readonly stage: Stage<"pixel">;
  private readonly sprites: PuzzleSprites;

  constructor(container: HTMLElement, sheet: SpriteSheet) {
    this.stage = new Stage(container, {
      camera: "pixel",
      pixelsPerUnit: PIXELS_PER_CELL,
      background: BACKGROUND,
    });
    this.sprites = new PuzzleSprites(sheet, this.stage.camera);
    this.stage.scene.add(this.sprites.root);
  }

  render(puzzle: Puzzle | null, timeSeconds: number): void {
    this.sprites.draw(puzzle, timeSeconds);
    this.stage.render();
  }

  dispose(): void {
    this.sprites.dispose();
    // Frees the rest of the scene. The sheet's texture is kept: the app frees it.
    this.stage.dispose();
  }
}
