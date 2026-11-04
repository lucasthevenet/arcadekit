import type { GameView } from "@gamekit/runtime/browser";
// PROTOTYPE (#24 art): the art variants, picked with ?art=<key>.
import type { World } from "@gamekit/survivors";
import { SurvivorsView } from "@gamekit/survivors/browser";

import type { ArtOptions } from "./options";
import * as b from "./variant-b";
import * as c from "./variant-c";
import * as d from "./variant-d";

export interface ArtVariant {
  readonly key: string;
  readonly name: string;
  readonly makeView: (
    container: HTMLElement,
    options: ArtOptions
  ) => GameView<World>;
}

export const ART_VARIANTS: readonly ArtVariant[] = [
  {
    key: "a",
    name: "Today: coloured primitives",
    makeView: (container, options) => new SurvivorsView(container, options),
  },
  { key: "b", name: b.name, makeView: b.makeView },
  { key: "c", name: c.name, makeView: c.makeView },
  { key: "d", name: d.name, makeView: d.makeView },
];

const params = new URLSearchParams(window.location.search);

/** The variant the URL asks for, or undefined without ?art (the demo as it is). */
export const currentVariant: ArtVariant | undefined = params.has("art")
  ? (ART_VARIANTS.find((v) => v.key === params.get("art")) ?? ART_VARIANTS[0])
  : undefined;

export const isShowcase = params.has("showcase");
