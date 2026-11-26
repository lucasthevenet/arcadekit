/**
 * A picture on a flat quad: the look of a flat game's entity, made from a
 * texture.
 *
 *   import * as Sprite from "@arcadekit/three/Sprite"
 *
 *   const Cards = Three.instancesFrom("game/Cards", {
 *     of: Card,
 *     transform: Transform2d,
 *     from: Deck,
 *     look: ({ face }) => Sprite.sprite(face, { height: 4 }),
 *   })
 *
 * `@arcadekit/three/Three` gives the same exports. A sprite is a look like any
 * other, so `Three.instances` draws a crowd of it and `Three.objects` makes a
 * `Mesh` of its geometry and material.
 */
import { MeshBasicMaterial, PlaneGeometry } from "three";
import type { Texture } from "three";

import type { Look } from "./Instances.ts";

/**
 * A sprite's look: a quad in the x-y plane, centred on its entity, and a
 * material that draws the texture on it as it is, unlit, with its
 * transparency.
 *
 * @category Models
 */
export interface Sprite extends Look {
  readonly geometry: PlaneGeometry;
  readonly material: MeshBasicMaterial;
}

/**
 * The size of a sprite, in the game's units. Given one side, the other
 * follows the picture's shape.
 *
 * @category Options
 */
export interface SpriteOptions {
  /** How wide the quad is. */
  readonly width?: number;
  /** How high the quad is. Defaults to 1 when `width` isn't given either. */
  readonly height?: number;
}

const sizeOf = (
  texture: Texture,
  options: SpriteOptions
): { readonly width: number; readonly height: number } => {
  const { height, width } = options;
  if (width !== undefined && height !== undefined) {
    return { width, height };
  }
  const image = texture.image as
    | { readonly width?: number; readonly height?: number }
    | null
    | undefined;
  const across = image?.width ?? 0;
  const down = image?.height ?? 0;
  if (!(across > 0 && down > 0)) {
    throw new Error(
      `Three.sprite was given a texture whose picture has no size yet, so the quad's shape can't follow it. Build the look once the picture is loaded, as Three.instancesFrom's look is, or give both width and height.`
    );
  }
  return width === undefined
    ? { width: ((height ?? 1) * across) / down, height: height ?? 1 }
    : { width, height: (width * down) / across };
};

/**
 * Makes the look of a sprite: a quad of the texture, centred on its entity,
 * in the plane a kind of `Transform2d` is drawn in.
 *
 *   look: ({ face }) => Three.sprite(face, { height: 4 })   // as wide as the picture makes it
 *
 * **Details**
 *
 * - Its material is a `MeshBasicMaterial` with the texture as its `map`, so
 *   no light is needed, and `transparent`, so a picture's clear pixels show
 *   what is behind. An instance's `Color.Rgb` tints it.
 * - Every call makes a geometry and a material of its own. They are disposed
 *   of with the kind that draws them, as any look's are.
 *
 * **Gotchas**
 *
 * - It throws when only one side or none is given and the texture's picture
 *   has no size, as a texture that is still loading has none. A texture of a
 *   bundle, given to a look built from it, has its picture.
 *
 * @category Constructors
 */
export const sprite = (
  texture: Texture,
  options: SpriteOptions = {}
): Sprite => {
  const { height, width } = sizeOf(texture, options);
  return {
    geometry: new PlaneGeometry(width, height),
    material: new MeshBasicMaterial({ map: texture, transparent: true }),
  };
};
