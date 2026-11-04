import type { GameView } from "@gamekit/runtime/browser";
import type { World } from "@gamekit/survivors";
// PROTOTYPE (#24 art). Placeholder until this variant is built.
import { SurvivorsView } from "@gamekit/survivors/browser";

import type { ArtOptions } from "./options";

export const name = "TODO";

export const makeView = (
  container: HTMLElement,
  options: ArtOptions
): GameView<World> => new SurvivorsView(container, options);
