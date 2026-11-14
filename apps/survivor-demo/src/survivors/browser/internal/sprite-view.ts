/**
 * Survivors' sprite view: a view that draws a run as pixel art seen straight down, from the app's
 * sheet, on a stage of its own, with a pixel camera that follows the local player's hero.
 *
 * With no run it draws a slow pan over an empty arena behind the menus. It reads the run and
 * never changes it.
 *
 * Plain on purpose: a frame draws whole before the browser shows it, so `render` is a plain call.
 * Its stage and its sprites come from a plain `make` and go with the view's plain `dispose`,
 * which the engine calls in the release of the attach that made the view.
 */
import type * as Game from "arcadekit/game/browser";
import { PixelCamera, Stage } from "arcadekit/render-three";
import type { Camera, SpriteSheet } from "arcadekit/render-three";

import type * as World from "../../world";
import * as Art from "../art";
import * as ArenaSprites from "./arena-sprites";

/** About how many world units of ground the view shows top to bottom. */
const VIEW_HEIGHT = 20;

/**
 * Makes a view that draws a run into `container` from `sheet`, in five draw calls, centred on the
 * hero at the slot `localHero` gives: this browser's player, read on every frame, so a co-op view
 * follows its seat. It follows slot 0 without one.
 *
 * `dispose` frees what the view made: its sprites and its stage, with the WebGL context. Never
 * the sheet's texture, which the app owns.
 */
export const make = (
  container: HTMLElement,
  sheet: SpriteSheet.SpriteSheet,
  options: { readonly localHero?: () => number } = {}
): Game.View<World.Arena> => {
  const stage = Stage.make(container, {
    camera: "pixel",
    pixelsPerUnit: Art.pixelsPerUnit,
    viewHeight: VIEW_HEIGHT,
    background: ArenaSprites.voidColor,
  });
  const sprites = ArenaSprites.make(sheet, options);
  stage.scene.add(sprites.root);
  /** The ground the camera shows, filled each frame. */
  const seen: Camera.MutableGroundBounds = {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
  };
  return {
    render: (arena, timeSeconds) => {
      const { camera } = stage;
      ArenaSprites.draw(sprites, arena, timeSeconds);
      PixelCamera.follow(camera, sprites.focus.x, sprites.focus.z);
      ArenaSprites.drawGround(
        sprites,
        PixelCamera.groundOnScreen(camera, seen)
      );
      Stage.render(stage);
    },
    dispose: () => {
      ArenaSprites.dispose(sprites);
      // Frees the rest of the scene. The sheet's texture is kept: the app frees it.
      Stage.dispose(stage);
    },
  };
};
