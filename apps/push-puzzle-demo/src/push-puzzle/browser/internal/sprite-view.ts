/**
 * Push-puzzle's sprite view: a view that draws a run as pixel art seen straight down, from the
 * app's sheet, on a stage of its own.
 *
 * It fits the board to a pixel camera at a whole pixel scale, and with no run draws a dim floor
 * behind the menus. It reads the run and never changes it.
 *
 * Plain on purpose: a frame draws whole before the browser shows it, so `render` is a plain call.
 * Its stage and its sprites come from a plain `make` and go with the view's plain `dispose`,
 * which the engine calls in the release of the attach that made the view.
 */
import type * as Game from "arcadekit/game/browser";
import { Stage } from "arcadekit/render-three";
import type { SpriteSheet } from "arcadekit/render-three";

import type * as World from "../../world";
import * as Art from "../art";
import * as BoardSprites from "./board-sprites";

/** Shows between and around the walls: the dungeon's darkest stone. */
const BACKGROUND = "#17151f";

/**
 * Makes a view that draws a run into `container` from `sheet`, in two draw calls: the tiles, then
 * the boxes and the player.
 *
 * `dispose` frees what the view made: its sprites and its stage, with the WebGL context. Never the
 * sheet's texture, which the app owns.
 */
export const make = (
  container: HTMLElement,
  sheet: SpriteSheet.SpriteSheet
): Game.View<World.Puzzle> => {
  const stage = Stage.make(container, {
    camera: "pixel",
    pixelsPerUnit: Art.pixelsPerCell,
    background: BACKGROUND,
  });
  const sprites = BoardSprites.make(sheet, stage.camera);
  stage.scene.add(sprites.root);
  return {
    render: (puzzle, timeSeconds) => {
      BoardSprites.draw(sprites, puzzle, timeSeconds);
      Stage.render(stage);
    },
    dispose: () => {
      BoardSprites.dispose(sprites);
      // Frees the rest of the scene. The sheet's texture is kept: the app frees it.
      Stage.dispose(stage);
    },
  };
};
