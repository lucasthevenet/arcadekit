import type * as Game from "arcadekit/game/browser";
import { Stage } from "arcadekit/render-three";
import type { MutableGroundBounds } from "arcadekit/render-three";

import type { World } from "../world";
import type { SurvivorsArt } from "./art";
import { PIXELS_PER_UNIT, SurvivorsScene, VOID_COLOR } from "./scene";

/** About how many world units of ground the view shows top to bottom. */
const VIEW_HEIGHT = 20;

interface SurvivorsViewOptions {
  /**
   * The slot of the hero the camera follows: this browser's player. Read on every render.
   * Defaults to slot 0.
   */
  readonly localHero?: () => number;
}

/**
 * Draws a survivors World as pixel-art sprites from the app's sheet, seen straight down by a
 * pixel camera that follows the local hero; with no run, a slow pan over the arena. Reads the
 * simulation; never changes it. `dispose` frees what the view made, never the sheet.
 */
export class SurvivorsView implements Game.View<World> {
  private readonly stage: Stage<"pixel">;
  private readonly scene: SurvivorsScene;
  /** The ground the camera shows, filled each frame. */
  private readonly seen: MutableGroundBounds = {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
  };

  constructor(
    container: HTMLElement,
    art: SurvivorsArt,
    options: SurvivorsViewOptions = {}
  ) {
    this.stage = new Stage(container, {
      camera: "pixel",
      pixelsPerUnit: PIXELS_PER_UNIT,
      viewHeight: VIEW_HEIGHT,
      background: VOID_COLOR,
    });
    this.scene = new SurvivorsScene(art, options);
    this.stage.scene.add(this.scene.root);
  }

  render(world: World | null, timeSeconds: number): void {
    const { camera } = this.stage;
    this.scene.draw(world, timeSeconds);
    camera.follow(this.scene.focus.x, this.scene.focus.z);
    this.scene.drawGround(camera.groundOnScreen(this.seen));
    this.stage.render();
  }

  dispose(): void {
    this.scene.dispose();
    // Frees the rest of the scene; the sheet's texture is kept for its owner, the app.
    this.stage.dispose();
  }
}
