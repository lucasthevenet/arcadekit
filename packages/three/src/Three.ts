/**
 * The `@arcadekit/three/Three` entry point, which draws a game with Three.js.
 *
 *   import * as Transform3d from "arcadekit/Transform3d"
 *   import * as Three from "@arcadekit/three/Three"
 *
 *   // The rules: a rock has a position. They know nothing about how it looks.
 *   commands.spawn(Rock, Transform3d.Position.of({ x: 0, y: 4, z: 0 }))
 *
 *   // The page: every rock is one instance of one mesh, where its Transform3d puts it.
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     geometry: new IcosahedronGeometry(1),
 *     material: new MeshStandardMaterial({ color: "#8a8f98" }),
 *   })
 *   const Look = Plugin.make("game/Look", {
 *     plugins: [Three.plugin],
 *     systems: [Rocks],
 *   })
 *
 *   Browser.runMain(
 *     Driver.run(App.define({ plugins: [Rules, Look] }), { hz: 60 }).pipe(
 *       Effect.provide(Three.layerWebGL({ canvas }))
 *     )
 *   )
 *
 * Its systems run in the frame stage, between ticks, and only read the world. A
 * game that is drawn is the same game as one that isn't, and a server or a
 * replay installs none of this.
 *
 * An entity's components decide what is drawn. The transform its kind names
 * decides where: arcadekit's own `Transform3d`, or a flat game's `Transform2d`,
 * drawn the same way in the x-y plane. An entity is drawn at that module's
 * `Position`, turned and sized by its `Rotation` and `Scale` when it has them.
 *
 * Each kind of entity is drawn by one of two systems:
 *
 * - `Three.instances` draws every entity of a kind as an instance of one mesh,
 *   for crowds. It reads the columns directly and writes one matrix per entity
 *   into the mesh's buffer. It creates no object per entity, and allocates
 *   nothing per entity per frame.
 * - `Three.objects` keeps one `Object3D` per entity, for the few entities that
 *   are more than a copy of one mesh. The object exists from the frame the
 *   entity first matches to the frame it stops matching, and receives the
 *   entity's transform each frame.
 *
 * Either system takes a look that exists from the start. `Gltf.instances`
 * and `Gltf.objects` build one `from` a bundle's assets instead, while the
 * bundle is loaded. `Three.texture` makes a texture asset for such a bundle.
 * After every frame-stage system has run, `Three.Render` renders the scene
 * through `Three.Renderer`.
 *
 * Each part is also a module of its own, which gives the same exports:
 * `@arcadekit/three/Scene`, `Renderer`, `Assets`, `Instances` and `Objects`.
 */
import type * as Assets from "arcadekit/Assets";
import type { ComponentDef, RequiredOf } from "arcadekit/ecs";
import type { Frame, Time, World } from "arcadekit/Services";
import type * as Transform2d from "arcadekit/Transform2d";
import type * as Transform3d from "arcadekit/Transform3d";

import type { Scene } from "./Scene.ts";

export { Scene } from "./Scene.ts";
export type { SceneShape } from "./Scene.ts";
export {
  layerRenderer,
  layerWebGL,
  plugin,
  Render,
  Renderer,
} from "./Renderer.ts";
export type { FitOptions, RendererLike, RendererShape } from "./Renderer.ts";
export { manager, texture } from "./Assets.ts";
export type { TextureOptions } from "./Assets.ts";
export { instances } from "./Instances.ts";
export type { InstancesOptions, InstancesShared, Look } from "./Instances.ts";
export { objects } from "./Objects.ts";
export type { ObjectsOptions, ObjectsShared } from "./Objects.ts";

/**
 * Which entities a drawing system draws. `Three.instances`, `Three.objects`
 * and their forms built from assets take these options, and a `transform`
 * typed by `Three.TransformOf`.
 *
 * @category Options
 */
export interface Which {
  /**
   * The component that marks an entity as one of the kind, or several
   * components, all of which it must have. An entity is drawn while it has
   * them, none of `without`, and the `Position` of the kind's `transform`.
   * One of them is that `Position` or requires it, so that a spawn or an add
   * of it gives the entity one, and a kind whose components don't doesn't
   * compile:
   *
   *   const Rock = Component.tag("game/Rock", { requires: [Transform3d.Position] })
   */
  readonly of: ComponentDef | readonly ComponentDef[];
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

type PositionName =
  | (typeof Transform3d)["Position"]["name"]
  | (typeof Transform2d)["Position"]["name"];

/** A name the compiler reads, and `never` for one it only knows as `string`. */
type Known<N> = string extends N ? never : N;

/** The names that a component is or requires, as far as the compiler reads them. */
type Gives<D> = D extends { readonly name: infer N extends string }
  ? Known<N> | Known<RequiredOf<D>>
  : never;

/** The positions that one of the components `of` may be neither is nor requires. */
type Missing<O> = O extends unknown
  ? Exclude<PositionName, Gives<O extends readonly (infer D)[] ? D : O>>
  : never;

/**
 * The type of `transform` in `Three.instances`, `Three.objects` and their forms
 * built from assets: the module whose components place the entities of a kind
 * of `of`. It is `Transform3d`, or `Transform2d` for a flat game, whose
 * entities are drawn in the x-y plane at z = 0, and it is the module whose
 * `Position` `of` is or requires, whichever of the components of its type it
 * is. An entity is drawn at that module's `Position`, turned and sized by its
 * `Rotation` and `Scale` when it has them. A kind reads nothing of the other
 * module, so a kind of `Transform2d` draws an entity that has both positions
 * from its `Transform2d` components alone.
 *
 *   Three.instances("game/Cards", { of: Card, transform: Transform2d, geometry, material })
 *
 * A helper that makes kinds types its own `transform` with it, so that it
 * can't pair a component with the other module:
 *
 *   const crowd = <const O extends Three.Which["of"]>(
 *     name: string,
 *     of: O,
 *     transform: Three.TransformOf<O>,
 *   ) => Three.instances(name, { of, transform, geometry, material })
 *
 *   crowd("game/Rocks", Rock, Transform3d)
 *   crowd("game/Lifted", Rock, Transform2d)   // doesn't compile
 *
 * A helper that takes `of` and `transform` as two unions doesn't compile:
 * the compiler can't tell that a call pairs a 3D marker with `Transform2d`,
 * whose entities, spawned with the marker alone, are never drawn. Nor does
 * an `of` typed as a plain `ComponentDef`: the compiler knows its name and
 * its requirements only as `string`, and can't tell that it requires a
 * `Position`. For an `of` that requires neither `Position`, it is a type
 * whose `Position`'s name is the reason, which the compiler reports as the
 * error of the call.
 *
 * @category Type-level
 */
export type TransformOf<O> = [Exclude<PositionName, Missing<O>>] extends [never]
  ? {
      readonly Position: {
        readonly name: `The kind's "of" doesn't require one transform's Position, whichever of its components it is, so an entity spawned with it alone may never be drawn. Add the kind's transform's Position to its component's requires, and type it as that component, not as a ComponentDef.`;
      };
    }
  : (typeof Transform3d | typeof Transform2d) & {
      readonly Position: { readonly name: Exclude<PositionName, Missing<O>> };
    };

/**
 * The assets of a bundle, whatever their types: what a look built `from` a
 * bundle is given, in `Gltf.instances` and `Gltf.objects`.
 *
 * @category Type-level
 */
export type Entries = Readonly<Record<string, Assets.Asset<unknown>>>;

/**
 * What a system of `Three.instances` or `Three.objects` requires from an app.
 * One of `Gltf.instances` or `Gltf.objects` requires `Assets.Store`
 * too.
 *
 * @category Type-level
 */
export type Needs = Frame | Scene | Time | World;
