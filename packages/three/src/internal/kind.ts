import type { ComponentDef } from "arcadekit/ecs";
import * as Transform2d from "arcadekit/Transform2d";
import * as Transform3d from "arcadekit/Transform3d";

import type { KindOptions } from "../Three.ts";

/** The module whose components place the entities of a kind. */
type Transform = typeof Transform3d | typeof Transform2d;

/**
 * A kind's options, with the module that places its entities.
 *
 * @internal
 */
export interface Placing {
  readonly transform: Transform;
}

/**
 * A system's options as its public signature takes them, with a `transform`
 * of `Three.TransformOf`.
 *
 * @internal
 */
export type Placeable<T> = T & {
  readonly transform: { readonly Position: unknown };
};

/**
 * The module whose `Position` a kind's `transform` has: what the compiler
 * reads of `Three.TransformOf` in a body that is generic in `of`.
 *
 * @internal
 */
export const placedBy = (transform: {
  readonly Position: unknown;
}): Transform =>
  transform.Position === Transform2d.Position ? Transform2d : Transform3d;

/**
 * The components that mark an entity as one of the kind, as a list.
 *
 * @internal
 */
export const required = (which: KindOptions): readonly ComponentDef[] =>
  "id" in which.of ? [which.of] : which.of;

/**
 * Whether a kind is drawn from a flat game's transform, with the loops of the
 * plane.
 *
 * @internal
 */
export const isFlat = (placed: Placing): boolean =>
  placed.transform === Transform2d;
