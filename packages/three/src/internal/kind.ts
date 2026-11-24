import type { ComponentDef } from "arcadekit/ecs";
import type { Frame, Time, World } from "arcadekit/Services";
import * as Transform2d from "arcadekit/Transform2d";

import type { Scene } from "../Scene";
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

/**
 * What a system of this module requires from an app, and what one that draws
 * from a bundle requires in addition.
 *
 * @internal
 */
export type Needs = Frame | Scene | Time | World;
