/**
 * Which entities a drawing system draws, and the transform it draws them
 * from: the options `Three.instances` and `Three.objects` share.
 *
 *   import type { Which } from "@arcadekit/three/three/Which"
 *
 *   const rocks: Which = { of: Rock, transform: Transform3d, smooth: true }
 *
 * `@arcadekit/three/Three` gives the same export.
 */
import type { ComponentDef } from "arcadekit/ecs";
import type * as Transform2d from "arcadekit/Transform2d";
import type * as Transform3d from "arcadekit/Transform3d";

/**
 * Which entities a drawing system draws, and the transform it draws them from.
 * `Three.instances` and `Three.objects` both take these options.
 *
 * @category Options
 */
export interface Which {
  /**
   * The component that marks an entity as one of the kind, or several
   * components, all of which it must have. An entity is drawn while it has
   * them, none of `without`, and the `Position` of the kind's `transform`.
   */
  readonly of: ComponentDef | readonly ComponentDef[];
  /**
   * The module whose components place the entities: `Transform3d`, or
   * `Transform2d` for a flat game, whose entities are drawn in the x-y plane at
   * z = 0. An entity is drawn at that module's `Position`, turned and sized by
   * its `Rotation` and `Scale` when it has them. A kind reads nothing of the
   * other module, so a kind of `Transform2d` draws an entity that has both
   * positions from its `Transform2d` components alone.
   *
   *   Three.instances("game/Cards", { of: Card, transform: Transform2d, geometry, material })
   */
  readonly transform: typeof Transform3d | typeof Transform2d;
  /** Components that keep an entity from being drawn, such as one that hides it. */
  readonly without?: readonly ComponentDef[];
  /**
   * Whether each entity is drawn between its last two positions, at
   * `Frame.alpha` of the way from where it was a tick ago to where it is now,
   * instead of where the last tick left it. Defaults to false. With it, a game
   * whose ticks and frames don't line up moves smoothly, up to a tick behind.
   * `Three.instances` says what is interpolated.
   */
  readonly smooth?: boolean;
  /**
   * With `smooth`, the farthest an entity may move in one tick and still be
   * interpolated, in scene units. An entity that moves farther, such as one
   * that wraps from one edge to the other, is drawn where it is. Defaults to no
   * limit.
   */
  readonly snap?: number;
}
