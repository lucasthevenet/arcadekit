import type { ComponentDef } from "arcadekit/ecs";
import type { Frame, Time, World } from "arcadekit/Services";
import * as Transform2d from "arcadekit/Transform2d";
import type * as Transform3d from "arcadekit/Transform3d";

import type { Scene } from "./scene";

/**
 * A numeric column, as a loop reads it.
 *
 * @internal
 */
export interface Numbers {
  readonly [row: number]: number;
}
/**
 * The columns of a three-number component, as a loop reads them.
 *
 * @internal
 */
export interface Xyz {
  readonly x: Numbers;
  readonly y: Numbers;
  readonly z: Numbers;
}
/**
 * The columns of a colour.
 *
 * @internal
 */
export interface Rgb {
  readonly r: Numbers;
  readonly g: Numbers;
  readonly b: Numbers;
  readonly space: Numbers;
}
/**
 * The columns of a quaternion.
 *
 * @internal
 */
export interface Xyzw extends Xyz {
  readonly w: { readonly [row: number]: number };
}
/**
 * The columns of a 2D position or scale.
 *
 * @internal
 */
export interface Xy {
  readonly x: { readonly [row: number]: number };
  readonly y: { readonly [row: number]: number };
}
/**
 * The column of a 2D rotation.
 *
 * @internal
 */
export interface Angle {
  readonly angle: { readonly [row: number]: number };
}

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

/**
 * The components that mark an entity as one of the kind, as a list.
 *
 * @internal
 */
export const required = (which: Which): readonly ComponentDef[] =>
  "id" in which.of ? [which.of] : which.of;

/**
 * Whether a kind is drawn from a flat game's transform, with the loops of the
 * plane.
 *
 * @internal
 */
export const isFlat = (which: Which): boolean =>
  which.transform.Position === Transform2d.Position;

/**
 * A loop over the columns of a query, whichever its terms. Typed as a method's
 * type, whose parameters are compared both ways, so that each of the loops
 * below is one, and can be handed to the query it was written for.
 *
 * @internal
 */
export type Columns = { loop(...columns: unknown[]): void }["loop"];

/**
 * What a system of this module requires from an app, and what one that draws
 * from a bundle requires in addition.
 *
 * @internal
 */
export type Needs = Frame | Scene | Time | World;
