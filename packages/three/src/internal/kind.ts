import type { ComponentDef } from "arcadekit/ecs";
import * as Transform2d from "arcadekit/Transform2d";

import type { Which } from "../Three";

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
