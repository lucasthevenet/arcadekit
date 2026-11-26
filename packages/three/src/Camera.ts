/**
 * A camera for a flat game, whose unit is the game's own, and the point of the
 * game's plane under a point of the canvas, such as the pointer.
 *
 *   import * as Camera from "@arcadekit/three/Camera"
 *
 *   // The view is 20 of the game's units high, on the player, and never shows
 *   // past the level's edges.
 *   const View = Camera.camera2d("game/View", {
 *     height: 20,
 *     follow: Player,
 *     within: { left: 0, right: 64, bottom: 0, top: 36 },
 *   })
 *
 *   // In an input-stage system: where the pointer is, in the game's units.
 *   const devices = yield* Input.Devices
 *   const at = yield* Camera.toPlane({
 *     x: devices.axes.get(Input.pointerX) ?? 0,
 *     y: devices.axes.get(Input.pointerY) ?? 0,
 *   })
 *
 * `@arcadekit/three/Three` gives the same exports. The pointer is in CSS
 * pixels from the canvas's top left, with y down, and the game's plane has y
 * up. `Camera.toPlane` joins the two through the camera the scene was last
 * drawn with, whatever made it, so an input-stage system can turn a click into
 * an action that carries a place in the game.
 */
import type { ComponentDef } from "arcadekit/ecs";
import type * as System from "arcadekit/System";
import type { Effect } from "effect";

import * as internal from "./internal/camera.ts";
import type { Scene } from "./Scene.ts";
import type { Needs } from "./Three.ts";

/**
 * A rectangle of the game's plane, in the game's units, with y up.
 *
 * @category Models
 */
export interface Bounds {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

/**
 * The options of `Three.camera2d`.
 *
 * @category Options
 */
export interface Camera2dOptions {
  /**
   * How many of the game's units the view shows from its bottom edge to its
   * top. Its width follows the canvas's shape: a canvas twice as wide as it
   * is high shows twice as many units across. A smaller height zooms in.
   */
  readonly height: number;
  /**
   * The component that marks the entity the view is centred on, or several,
   * all of which it must have, at its `Transform2d.Position`. The view is on
   * the first entity a query finds. While none matches, it stays where it
   * was. Defaults to none: the view stays at `at`.
   */
  readonly follow?: ComponentDef | readonly ComponentDef[];
  /** Where the view is centred until it finds the entity it follows. Defaults to the origin. */
  readonly at?: { readonly x: number; readonly y: number };
  /**
   * The rectangle the view stays inside. Near its edges, the view stops
   * short of the entity it follows, which is then off the middle of the
   * canvas. Along a side shorter than the view, the view is centred on the
   * rectangle. Defaults to none.
   */
  readonly within?: Bounds;
  /**
   * Whether the view follows the entity between its last two positions, at
   * `Frame.alpha` of the way. Defaults to false. It reads
   * `Transform2d.smooth`, the store a kind drawn with `smooth` draws from, so
   * the entity stays where it is on the canvas. Give it the `smooth` of the
   * kind that draws the entity, or the entity shakes against the view.
   */
  readonly smooth?: boolean;
  /**
   * With `smooth`, the farthest the entity may move in one tick and still be
   * followed between its two positions. Give it the `snap` of the kind that
   * draws the entity. Defaults to no limit.
   */
  readonly snap?: number;
}

/**
 * Makes a frame-stage system that sets `Three.Scene`'s camera to an
 * orthographic camera looking down on the game's plane, and keeps its view
 * `height` of the game's units high, as wide as the canvas's shape makes it.
 *
 *   const View = Three.camera2d("game/View", {
 *     height: 20,
 *     follow: Player,
 *     within: { left: 0, right: 64, bottom: 0, top: 36 },
 *   })
 *   const Look = Plugin.make("game/Look", {
 *     plugins: [Three.plugin],
 *     systems: [View, Sprites],
 *   })
 *
 * **When to use**
 *
 * Use for a flat game, whose entities are placed with `Transform2d`. A game
 * with a camera of its own leaves it out and sets `Three.Scene`'s camera
 * itself.
 *
 * **Details**
 *
 * - Each frame, it sets the scene's camera to its own, centres it on the
 *   entity it follows, and fits the view to the canvas's size of that frame,
 *   which `Three.plugin` measures before the frame's systems run, held inside
 *   `within`. A canvas that changes shape shows more or less of the plane
 *   across, never a stretched image.
 * - Its camera, and where it aims while it finds nothing to follow, are kept
 *   in a `System.local`, each app its own.
 * - The camera stands 1000 units in front of the plane and looks straight
 *   at it, with y up. It shows what is from 1000 units in front of the plane
 *   to 1000 behind it, and draws nothing in perspective, so a kind placed at
 *   a higher z is in front of one at a lower z and looks the same size.
 * - Before the first frame is rendered, the canvas has no size yet, and the
 *   view is as wide as it is high.
 * - It requires `Three.plugin`, and its name must be unique among the app's
 *   systems.
 *
 * **Gotchas**
 *
 * - It throws when `height` is not a number above 0, or when `within` has a
 *   right that is not past its left or a top that is not above its bottom.
 *
 * @category Systems
 */
export const camera2d: (
  name: string,
  options: Camera2dOptions
) => System.System<never, Needs | System.Locals, string, "frame"> =
  internal.camera2d;

/**
 * Returns the point of the game's plane, z = 0, under a point of the canvas,
 * in CSS pixels from its top left, such as the pointer's position. It reads
 * `Three.Scene`'s camera and canvas size as the scene was last rendered: what
 * the player saw when they clicked.
 *
 *   const Aim = System.input("game/Aim", function* () {
 *     const devices = yield* Input.Devices
 *     if (devices.pressed.includes(Input.pointerButton())) {
 *       const at = yield* Three.toPlane({
 *         x: devices.axes.get(Input.pointerX) ?? 0,
 *         y: devices.axes.get(Input.pointerY) ?? 0,
 *       })
 *       ;(yield* Action.Actions).enqueue(Fire, at)  // at.x, at.y in the game's units
 *     }
 *   })
 *
 * **When to use**
 *
 * Use in an input-stage system that turns where the player pointed into an
 * action: the action carries the place, so the tick, a replay and the other
 * peers read it from the log and need no camera.
 *
 * **Details**
 *
 * - It works through any camera: the orthographic camera of `Three.camera2d`,
 *   one of your own, or a perspective camera, through which it is the point
 *   where the line under the pointer crosses the plane.
 * - Before the scene is first rendered, the canvas has no size yet, and every
 *   point of it is the one under the middle of the view.
 * - A tick cannot require `Three.Scene`, so a tick cannot call it.
 *
 * @category Utilities
 */
export const toPlane: (point: {
  readonly x: number;
  readonly y: number;
}) => Effect.Effect<{ readonly x: number; readonly y: number }, never, Scene> =
  internal.toPlane;
