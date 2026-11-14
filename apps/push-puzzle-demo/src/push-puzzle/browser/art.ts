/**
 * Push-puzzle's art: the tags its view draws from the app's sprite sheet, and how many of the
 * sheet's pixels make one cell.
 *
 * The genre ships no art. The app's sheet (`PushPuzzleSheet`) has a tag for each thing the view
 * draws, and the app's test checks its sheet against `tags`.
 *
 * Plain on purpose: it is data, which the view reads once when it is made.
 */

/**
 * Every tag the view draws, by the name it reads each under, with the tags it draws in its place
 * when the sheet lacks it.
 *
 * **When to use**
 *
 * In an app's test, to check that its sheet has the first tag of each name:
 * `SpriteSheet.resolveTags(sheet.data, Art.tags).missing` is empty.
 *
 * **Details**
 *
 * The player walks with `player/walk` left and right, flipped for left, and with `player/up` and
 * `player/down` up and down; it stands with `player/idle`, or the first frame of its walk up or
 * down. A wall shows `wall/face` where the cell below it is inside the walls. A name the sheet has
 * none of draws frame 0.
 *
 * **Example** (A sheet without a filled hole)
 *
 * ```ts
 * import { Art } from "#push-puzzle/browser";
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const { data } = TestSpriteSheet.fromTags({
 *   floor: 3,
 *   wall: 1,
 *   "wall/face": 1,
 *   goal: 1,
 *   hole: 1,
 *   box: 1,
 *   "box/on-goal": 1,
 *   "player/idle": 2,
 *   "player/walk": 4,
 *   "player/up": 4,
 *   "player/down": 4,
 * });
 * // Warns once that the sheet has no tag "hole/filled".
 * const { tags, missing } = SpriteSheet.resolveTags(data, Art.tags);
 * tags.holeFilled.name; // => "floor"
 * missing; // => ["hole/filled"]
 * ```
 *
 * @category models
 */
export const tags = {
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

/**
 * The sheet's pixels in one cell: tiles are 16 pixels square, and a cell is one world unit.
 *
 * **When to use**
 *
 * To size the app's art, and to place the view's pixel camera: one cell is this many of the
 * sheet's pixels at a scale of 1.
 *
 * **Example** (The size of a tile)
 *
 * ```ts
 * import { Art } from "#push-puzzle/browser";
 *
 * Art.pixelsPerCell; // => 16
 * ```
 *
 * @category models
 */
export const pixelsPerCell = 16;
