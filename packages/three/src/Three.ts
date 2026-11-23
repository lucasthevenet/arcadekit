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
 *     Driver.run(App.make(App.define({ plugins: [Rules, Look] })), { hz: 60 }).pipe(
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
 * Either system takes a look that exists from the start, or builds one `from` a
 * bundle's assets while the bundle is loaded. `Three.texture` makes a texture
 * asset for such a bundle. After every frame-stage system has run,
 * `Three.Render` renders the scene through `Three.Renderer`.
 */
import * as Assets from "arcadekit/Assets";
import * as Color from "arcadekit/Color";
import { entityIndex } from "arcadekit/ecs";
import type { ComponentDef, Entity, EntityColumn } from "arcadekit/ecs";
import * as Plugin from "arcadekit/Plugin";
import * as Query from "arcadekit/Query";
import { Frame, Time } from "arcadekit/Services";
import type { World } from "arcadekit/Services";
import * as System from "arcadekit/System";
import * as Transform2d from "arcadekit/Transform2d";
import * as Transform3d from "arcadekit/Transform3d";
import { Context, Effect, Layer } from "effect";
import {
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  PerspectiveCamera,
  SRGBColorSpace,
  Texture,
  Scene as ThreeScene,
  WebGLRenderer,
} from "three";
import type {
  Camera,
  Material,
  Object3D,
  WebGLRendererParameters,
} from "three";

// --- the scene -------------------------------------------------------------------

/** What a system of this module has created, released with the app. */
interface Kept {
  readonly dispose: () => void;
  /**
   * Called just before the scene is drawn, for things built from assets: are
   * the assets still loaded? Anything whose assets aren't is removed from the
   * scene now, so nothing is drawn with assets released since its system ran.
   */
  readonly settle?: () => void;
}

/** A geometry or a material: what this module disposes of for the game. */
type Owned = BufferGeometry | Material;

/**
 * The geometries and materials one system draws with. One that several
 * systems draw with is disposed of when the last of them lets go: when the
 * bundle it was made from is released, or the app closes. Three.js uploads a
 * disposed one again if it is drawn again.
 */
class Holdings {
  private readonly mine = new Set<Owned>();

  constructor(
    // How many systems hold each one: the scene's.
    private readonly counts: Map<Owned, number>
  ) {}

  hold(resource: Owned | readonly Owned[]): void {
    if (Array.isArray(resource)) {
      for (const one of resource) {
        this.hold(one);
      }
      return;
    }
    const one = resource as Owned;
    if (this.mine.has(one)) {
      return;
    }
    this.mine.add(one);
    this.counts.set(one, (this.counts.get(one) ?? 0) + 1);
    // Disposed of by the game, in a `free`: it is not held any longer.
    one.addEventListener("dispose", this.forget);
  }

  /** Holds what each mesh of an object is drawn with. */
  holdAll(object: Object3D): void {
    object.traverse((part) => {
      if ("geometry" in part && part.geometry instanceof BufferGeometry) {
        this.hold(part.geometry);
      }
      if ("material" in part && part.material !== undefined) {
        this.hold(part.material as Material | Material[]);
      }
    });
  }

  private readonly forget = (event: { readonly target: Owned }): void => {
    const one = event.target;
    one.removeEventListener("dispose", this.forget);
    if (this.mine.delete(one)) {
      this.drop(one);
    }
  };

  /** Fewer systems hold it: returns whether none does. */
  private drop(one: Owned): boolean {
    const left = (this.counts.get(one) ?? 1) - 1;
    if (left > 0) {
      this.counts.set(one, left);
      return false;
    }
    this.counts.delete(one);
    return true;
  }

  letGo(): void {
    for (const one of this.mine) {
      one.removeEventListener("dispose", this.forget);
      if (this.drop(one)) {
        one.dispose();
      }
    }
    this.mine.clear();
  }
}

/**
 * The scene and its camera, as a system gets them from `yield* Three.Scene`.
 *
 * @category Services
 */
export interface SceneShape {
  /** The scene everything is drawn into. Add lights and anything else to it. */
  readonly scene: ThreeScene;
  /**
   * The camera the scene is rendered through. It starts as a perspective camera
   * at (0, 0, 10), looking at the origin. Move it, or assign another camera,
   * such as an `OrthographicCamera`.
   */
  camera: Camera;
  /**
   * The meshes and objects the systems of this module keep, by the name of
   * the system that keeps them.
   * @internal
   */
  readonly _kept: Map<string, Kept>;
  /**
   * How many systems draw with each geometry and material.
   * @internal
   */
  readonly _owned: Map<Owned, number>;
}

/**
 * An app's scene and camera, which `Three.plugin` provides. A plugin that
 * depends on `Three.plugin` sets up the scene in its `layer`, and a frame-stage
 * system moves the camera.
 *
 *   const Lights = Layer.effectDiscard(
 *     Effect.map(Three.Scene, ({ scene, camera }) => {
 *       scene.add(new AmbientLight("#ffffff", 1))
 *       camera.position.set(0, 20, 40)
 *       camera.lookAt(0, 0, 0)
 *     })
 *   )
 *
 * **Details**
 *
 * It belongs to rendering, not to the game. A tick cannot require it, and none
 * of it is saved.
 *
 * @category Services
 */
export class Scene extends Context.Service<Scene, SceneShape>()(
  "arcadekit/three/Scene"
) {}

const sceneLayer = Layer.effect(
  Scene,
  Effect.acquireRelease(
    Effect.sync((): SceneShape => {
      const camera = new PerspectiveCamera(50, 1, 0.1, 2000);
      camera.position.set(0, 0, 10);
      return {
        scene: new ThreeScene(),
        camera,
        _kept: new Map(),
        _owned: new Map(),
      };
    }),
    // What the systems made goes with the app, and the geometries and
    // materials they drew with once no system holds them.
    (kept) =>
      Effect.sync(() => {
        for (const one of kept._kept.values()) {
          one.dispose();
        }
        kept._kept.clear();
      })
  )
);

// --- the renderer ----------------------------------------------------------------

/**
 * The shape of `Three.Renderer`: a Three.js renderer, or a test's renderer that
 * draws nothing or records what it was asked to render.
 *
 * @category Services
 */
export interface RendererShape {
  /** Renders the scene as the camera sees it. `Three.Render` calls it once per frame. */
  readonly render: (scene: ThreeScene, camera: Camera) => void;
}

/**
 * What renders the scene. It needs a canvas, so it comes from outside the app,
 * such as `Three.layerWebGL({ canvas })` in a page. A game that installs
 * `Three.plugin` without providing one doesn't compile.
 *
 * **Details**
 *
 * A test provides a renderer that draws nothing, or one that records what it
 * was asked, and inspects the scene. Three.js builds the scene under Node as it
 * does in a page.
 *
 *   Layer.succeed(Three.Renderer, { render(scene, camera) {} })
 *
 * @category Services
 */
export class Renderer extends Context.Service<Renderer, RendererShape>()(
  "arcadekit/three/Renderer"
) {}

/**
 * The parts of a Three.js renderer that `Three.layerRenderer` uses.
 * `WebGLRenderer` and `WebGPURenderer` both have them.
 *
 * @category Models
 */
export interface RendererLike {
  /** The canvas. The image is fitted to its size on the page. */
  readonly domElement: {
    readonly clientWidth?: number;
    readonly clientHeight?: number;
  };
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: ThreeScene, camera: Camera): void;
  dispose(): void;
}

/**
 * Options for how a page's renderer follows its canvas.
 *
 * @category Options
 */
export interface FitOptions {
  /**
   * Whether the image follows the canvas's size on the page. When that size
   * changes, the renderer is resized without touching the canvas's style, and a
   * perspective camera gets the new aspect ratio. Defaults to true. Your game
   * fits any other kind of camera itself.
   */
  readonly fit?: boolean;
  /**
   * How many pixels are drawn per CSS pixel. Defaults to the page's
   * `devicePixelRatio`, capped at 2. It is set only while `fit` is on, so with
   * `fit: false` your game sets the renderer's pixel ratio itself.
   */
  readonly pixelRatio?: number;
}

const isPerspective = (camera: Camera): camera is PerspectiveCamera =>
  (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;

/**
 * Returns a layer that provides `Three.Renderer` from a Three.js renderer you
 * create. The renderer is disposed of when the scope the layer is provided to
 * closes.
 *
 *   Three.layerRenderer(() => new WebGPURenderer({ canvas }))
 *
 * **When to use**
 *
 * Use for a renderer other than a `WebGLRenderer`, such as a `WebGPURenderer`.
 * For a `WebGLRenderer`, use `Three.layerWebGL`.
 *
 * **Gotchas**
 *
 * - Provide it to the whole program, such as `Driver.run(...)`, and not to
 *   something shorter. The renderer is disposed of when that scope closes.
 *
 * @category Layers
 */
export const layerRenderer = (
  make: () => RendererLike,
  options: FitOptions = {}
): Layer.Layer<Renderer> =>
  Layer.effect(
    Renderer,
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => make()),
        (renderer) => Effect.sync(() => renderer.dispose())
      ),
      (renderer): RendererShape => {
        const fit = options.fit !== false;
        let width = 0;
        let height = 0;
        let ratio = 0;
        return {
          render(scene, camera) {
            const w = renderer.domElement.clientWidth ?? 0;
            const h = renderer.domElement.clientHeight ?? 0;
            // A canvas that is not laid out has no size to fit.
            if (fit && w > 0 && h > 0) {
              const r =
                options.pixelRatio ??
                Math.min(
                  (globalThis as { devicePixelRatio?: number })
                    .devicePixelRatio ?? 1,
                  2
                );
              if (w !== width || h !== height || r !== ratio) {
                width = w;
                height = h;
                ratio = r;
                renderer.setPixelRatio(r);
                renderer.setSize(w, h, false);
              }
              // Asked of the camera each frame, since it can be replaced.
              if (isPerspective(camera) && camera.aspect !== w / h) {
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
              }
            }
            renderer.render(scene, camera);
          },
        };
      }
    )
  );

/**
 * Returns a layer that provides `Three.Renderer` as a `WebGLRenderer` on a
 * page's canvas. It takes the parameters Three.js's `WebGLRenderer` accepts,
 * and fits the image to the canvas unless `fit` is false.
 *
 *   Driver.run(app, { hz: 60 }).pipe(
 *     Effect.provide(Three.layerWebGL({ canvas, antialias: true }))
 *   )
 *
 * **Gotchas**
 *
 * - Provide it to the whole program, as above. The renderer is disposed of
 *   when that scope closes, as with `Three.layerRenderer`.
 *
 * @category Layers
 */
export const layerWebGL = (
  parameters: WebGLRendererParameters & FitOptions = {}
): Layer.Layer<Renderer> =>
  layerRenderer(() => new WebGLRenderer(parameters), parameters);

/**
 * The system that renders the scene once per frame, through `Three.Renderer`.
 * `Three.plugin` installs it.
 *
 * **Details**
 *
 * It runs in `"postFrame"`, the stage after the frame's own. Every frame-stage
 * system therefore runs before it, wherever it is listed and with no ordering:
 * `Three.instances`, `Three.objects`, and a system of your own that moves the
 * camera.
 *
 * Just before rendering, it checks that the assets of each kind built from a
 * bundle are still loaded, and removes from the scene what was built from
 * released ones. Nothing is drawn with released assets, whichever runs first
 * of the system that releases a bundle and the system that draws with it.
 *
 * @category Systems
 */
export const Render = System.frame("arcadekit/three/Render", function* () {
  const { _kept, camera, scene } = yield* Scene;
  for (const one of _kept.values()) {
    one.settle?.();
  }
  (yield* Renderer).render(scene, camera);
}).pipe(System.inStage("postFrame"));

/**
 * Gives an app a scene, `Three.Scene`, and renders it each frame with
 * `Three.Render`. The plugin that defines how the game looks lists it in its
 * `plugins`, beside its systems made with `Three.instances` and
 * `Three.objects`.
 *
 * **Details**
 *
 * The app then needs a `Three.Renderer` from outside, such as
 * `Effect.provide(Three.layerWebGL({ canvas }))`.
 *
 * Each of those systems draws from the transform it names, `Transform3d` or
 * `Transform2d`, and an instance's colour from `Color`. This package defines
 * no components of its own.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/three", {
  layer: sceneLayer,
  systems: [Render],
});

// --- which entities ----------------------------------------------------------------

/** A numeric column, as a loop reads it. */
interface Numbers {
  readonly [row: number]: number;
}
/** The columns of a three-number component, as a loop reads them. */
interface Xyz {
  readonly x: Numbers;
  readonly y: Numbers;
  readonly z: Numbers;
}
/** The columns of a colour. */
interface Rgb {
  readonly r: Numbers;
  readonly g: Numbers;
  readonly b: Numbers;
  readonly space: Numbers;
}
interface Xyzw extends Xyz {
  readonly w: { readonly [row: number]: number };
}
/** The columns of a 2D position or scale. */
interface Xy {
  readonly x: { readonly [row: number]: number };
  readonly y: { readonly [row: number]: number };
}
interface Angle {
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

const required = (which: Which): readonly ComponentDef[] =>
  "id" in which.of ? [which.of] : which.of;

/** Whether a kind is drawn from a flat game's transform, with the loops of the plane. */
const isFlat = (which: Which): boolean =>
  which.transform.Position === Transform2d.Position;

// --- between two ticks -------------------------------------------------------------
// What a system keeps to draw its entities between their last two places:
// for each component it reads, the value an entity had a tick ago and the
// value it has, by the entity's index. It is the renderer's own, never the
// world's: a game that is drawn smoothly is the same game.

/** What one system's stores agree on, for the frame being drawn. */
interface Clock {
  /**
   * The app's frame number, counted from 2, since 0 in a store means never
   * seen. It is the app's count, not the system's, so the store knows the
   * entity was drawn in the previous frame, not merely the last time the system
   * ran.
   */
  stamp: number;
  /** Whether a tick ran since the previous frame, which makes the current values a tick old. */
  shift: boolean;
  /** How far the frame is between the last two ticks. */
  alpha: number;
}

/** One component's two values per entity, and the columns they are blended into. */
abstract class Blend {
  protected readonly clock: Clock;
  private readonly width: number;
  /** For each entity index, the id of the entity these values belong to. */
  protected owner = new Float64Array(0);
  /** For each entity index, the frame its entity was last drawn in. */
  protected seen = new Uint32Array(0);
  protected prev = new Float32Array(0);
  protected cur = new Float32Array(0);
  /** The number of rows the blended columns have room for. */
  protected rows = 0;

  constructor(clock: Clock, width: number) {
    this.clock = clock;
    this.width = width;
  }

  /** Makes room for these rows and their entities, before the loop reads either. */
  protected fit(start: number, end: number, entities: EntityColumn): void {
    let most = -1;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      if (index > most) {
        most = index;
      }
    }
    if (most >= this.owner.length) {
      let length = Math.max(64, this.owner.length);
      while (length <= most) {
        length *= 2;
      }
      const owner = new Float64Array(length);
      owner.set(this.owner);
      this.owner = owner;
      const seen = new Uint32Array(length);
      seen.set(this.seen);
      this.seen = seen;
      const prev = new Float32Array(length * this.width);
      prev.set(this.prev);
      this.prev = prev;
      const cur = new Float32Array(length * this.width);
      cur.set(this.cur);
      this.cur = cur;
    }
    if (end > this.rows) {
      this.rows = Math.max(end, this.rows * 2);
      this.widen(this.rows);
    }
  }

  /** Reallocates the blended columns with this many rows. */
  protected abstract widen(rows: number): void;
}

/** A 3D position or size: each number is interpolated linearly. */
class Lerp3 extends Blend {
  private readonly out = {
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
  };
  /** The square of the distance that is too far to have moved in one tick. */
  private readonly snap: number;

  constructor(clock: Clock, snap = Infinity) {
    super(clock, 3);
    this.snap = snap * snap;
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
    this.out.z = new Float32Array(rows);
  }

  blend(start: number, end: number, from: Xyz, entities: EntityColumn): Xyz {
    return this.run(start, end, from.x, from.y, from.z, entities);
  }

  /** Like `blend`, for any three columns, such as a colour's. */
  run(
    start: number,
    end: number,
    x: Numbers,
    y: Numbers,
    z: Numbers,
    entities: EntityColumn
  ): Xyz {
    this.fit(start, end, entities);
    const { cur, out, owner, prev, seen, snap } = this;
    const { alpha, shift, stamp } = this.clock;
    const { x: ox, y: oy, z: oz } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const at = index * 3;
      const a = x[i]!;
      const b = y[i]!;
      const c = z[i]!;
      let px = a;
      let py = b;
      let pz = c;
      // Drawn in the frame before this one: it has a place to come from.
      if (owner[index] === entity && seen[index] === stamp - 1) {
        px = shift ? cur[at]! : prev[at]!;
        py = shift ? cur[at + 1]! : prev[at + 1]!;
        pz = shift ? cur[at + 2]! : prev[at + 2]!;
        const dx = a - px;
        const dy = b - py;
        const dz = c - pz;
        if (dx * dx + dy * dy + dz * dz > snap) {
          px = a;
          py = b;
          pz = c;
        }
      }
      owner[index] = entity;
      seen[index] = stamp;
      prev[at] = px;
      prev[at + 1] = py;
      prev[at + 2] = pz;
      cur[at] = a;
      cur[at + 1] = b;
      cur[at + 2] = c;
      ox[i] = px + (a - px) * alpha;
      oy[i] = py + (b - py) * alpha;
      oz[i] = pz + (c - pz) * alpha;
    }
    return out;
  }
}

/** A 2D position or size. */
class Lerp2 extends Blend {
  private readonly out = { x: new Float32Array(0), y: new Float32Array(0) };
  private readonly snap: number;

  constructor(clock: Clock, snap = Infinity) {
    super(clock, 2);
    this.snap = snap * snap;
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
  }

  blend(start: number, end: number, from: Xy, entities: EntityColumn): Xy {
    this.fit(start, end, entities);
    const { cur, out, owner, prev, seen, snap } = this;
    const { alpha, shift, stamp } = this.clock;
    const { x, y } = from;
    const { x: ox, y: oy } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const at = index * 2;
      const a = x[i]!;
      const b = y[i]!;
      let px = a;
      let py = b;
      if (owner[index] === entity && seen[index] === stamp - 1) {
        px = shift ? cur[at]! : prev[at]!;
        py = shift ? cur[at + 1]! : prev[at + 1]!;
        const dx = a - px;
        const dy = b - py;
        if (dx * dx + dy * dy > snap) {
          px = a;
          py = b;
        }
      }
      owner[index] = entity;
      seen[index] = stamp;
      prev[at] = px;
      prev[at + 1] = py;
      cur[at] = a;
      cur[at + 1] = b;
      ox[i] = px + (a - px) * alpha;
      oy[i] = py + (b - py) * alpha;
    }
    return out;
  }
}

/**
 * A 3D rotation: from one quaternion towards the other along the shorter arc.
 * The result isn't normalized, and doesn't need to be.
 */
class Nlerp4 extends Blend {
  private readonly out = {
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
    w: new Float32Array(0),
  };

  constructor(clock: Clock) {
    super(clock, 4);
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
    this.out.z = new Float32Array(rows);
    this.out.w = new Float32Array(rows);
  }

  blend(start: number, end: number, from: Xyzw, entities: EntityColumn): Xyzw {
    this.fit(start, end, entities);
    const { cur, out, owner, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const { x, y, z, w } = from;
    const { x: ox, y: oy, z: oz, w: ow } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const at = index * 4;
      const a = x[i]!;
      const b = y[i]!;
      const c = z[i]!;
      const d = w[i]!;
      let px = a;
      let py = b;
      let pz = c;
      let pw = d;
      if (owner[index] === entity && seen[index] === stamp - 1) {
        px = shift ? cur[at]! : prev[at]!;
        py = shift ? cur[at + 1]! : prev[at + 1]!;
        pz = shift ? cur[at + 2]! : prev[at + 2]!;
        pw = shift ? cur[at + 3]! : prev[at + 3]!;
      }
      owner[index] = entity;
      seen[index] = stamp;
      prev[at] = px;
      prev[at + 1] = py;
      prev[at + 2] = pz;
      prev[at + 3] = pw;
      cur[at] = a;
      cur[at + 1] = b;
      cur[at + 2] = c;
      cur[at + 3] = d;
      // A quaternion and its opposite are one turn: towards whichever of
      // the two is nearer, or the blend would go the long way round.
      const near = px * a + py * b + pz * c + pw * d < 0 ? -1 : 1;
      const bx = px + (a * near - px) * alpha;
      const by = py + (b * near - py) * alpha;
      const bz = pz + (c * near - pz) * alpha;
      const bw = pw + (d * near - pw) * alpha;
      // Of whatever length it comes out: what draws it takes the turn a
      // quaternion stands for, and all zeros for not turned.
      ox[i] = bx;
      oy[i] = by;
      oz[i] = bz;
      ow[i] = bw;
    }
    return out;
  }
}

const TURN = Math.PI * 2;

/** A 2D rotation: from one angle to the other the shorter way round. */
class Arc extends Blend {
  private readonly out = { angle: new Float32Array(0) };

  constructor(clock: Clock) {
    super(clock, 1);
  }

  protected widen(rows: number): void {
    this.out.angle = new Float32Array(rows);
  }

  blend(
    start: number,
    end: number,
    from: Angle,
    entities: EntityColumn
  ): Angle {
    this.fit(start, end, entities);
    const { cur, owner, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const { angle } = from;
    const out = this.out.angle;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const a = angle[i]!;
      let before = a;
      if (owner[index] === entity && seen[index] === stamp - 1) {
        before = shift ? cur[index]! : prev[index]!;
      }
      owner[index] = entity;
      seen[index] = stamp;
      prev[index] = before;
      cur[index] = a;
      const turned = a - before;
      out[i] = before + (turned - TURN * Math.round(turned / TURN)) * alpha;
    }
    return this.out;
  }
}

/** Everything one system keeps to interpolate its entities between two ticks. */
class Smooth {
  private readonly clock: Clock = { stamp: 0, shift: false, alpha: 0 };
  private tick = -1;
  readonly position: Lerp3;
  readonly rotation: Nlerp4;
  readonly scale: Lerp3;
  readonly flatPosition: Lerp2;
  readonly flatRotation: Arc;
  readonly flatScale: Lerp2;
  readonly color: Lerp3;

  constructor(snap: number | undefined) {
    this.position = new Lerp3(this.clock, snap);
    this.rotation = new Nlerp4(this.clock);
    this.scale = new Lerp3(this.clock);
    this.flatPosition = new Lerp2(this.clock, snap);
    this.flatRotation = new Arc(this.clock);
    this.flatScale = new Lerp2(this.clock);
    this.color = new Lerp3(this.clock);
  }

  /** Starts a frame: its number, the game's tick, and how far it is towards the next. */
  begin(tick: number, alpha: number, frame: number): void {
    this.clock.stamp = frame + 1;
    this.clock.shift = tick !== this.tick;
    this.clock.alpha = Math.min(1, Math.max(0, alpha));
    this.tick = tick;
  }
}

const smoothOf = (which: Which): Smooth | undefined =>
  which.smooth === true ? new Smooth(which.snap) : undefined;

// --- what is made of assets ----------------------------------------------------------

/** The assets of a bundle, whatever their types. */
type Entries = Readonly<Record<string, Assets.Asset<unknown>>>;

/**
 * What a system builds from a bundle's assets: available while the app has the
 * bundle loaded, released when it doesn't, and rebuilt from the next load.
 */
class FromAssets<T extends Kept> implements Kept {
  private assets: unknown;
  private made: T | undefined;

  constructor(
    private readonly store: Assets.StoreShape,
    private readonly bundle: Assets.Bundle<Entries>,
    // Handed the assets of `bundle`, and of no other.
    private readonly make: (assets: never) => T
  ) {}

  /** Returns the assets the app currently holds, if any. */
  private held(): unknown {
    const status = this.store.status(this.bundle);
    return status._tag === "Ready" ? status.assets : undefined;
  }

  /** Returns what is built from the assets the app currently holds, if it holds them. */
  now(): T | undefined {
    // Loaded again is loaded anew: other pictures, though of the same files.
    const assets = this.held();
    if (assets !== this.assets) {
      this.dispose();
      this.assets = assets;
      if (assets !== undefined) {
        this.made = this.make(assets as never);
      }
    }
    return this.made;
  }

  // Only lets go: what is loaded now is made something of by the system,
  // the next time it runs, which also has the entities to draw with it.
  readonly settle = (): void => {
    if (this.made !== undefined && this.held() !== this.assets) {
      this.dispose();
    }
  };

  dispose(): void {
    const { made } = this;
    this.made = undefined;
    made?.dispose();
  }
}

/**
 * Options for an image loaded with `Three.texture`.
 *
 * @category Options
 */
export interface TextureOptions {
  /**
   * Called once with the texture, before it is first uploaded to the renderer,
   * to mark it as non-colour data or to set its wrapping and filtering. The
   * texture it receives has no `flipY`, which the `flipY` option sets.
   */
  readonly prepare?: (texture: Omit<Texture, "flipY">) => void;
  /**
   * Whether the image is flipped vertically when it is decoded, so its first
   * row is at the top of a Three.js geometry. Defaults to `true`, as with a
   * `TextureLoader`. `false` keeps the file's orientation, which a model's own
   * UV coordinates expect.
   */
  readonly flipY?: boolean;
}

/**
 * Makes a texture asset, a Three.js `Texture` loaded with the rest of its
 * bundle. The texture and its image are disposed of when the scope it was
 * loaded in closes.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     bark: Three.texture("/bark.png"),
 *     normals: Three.texture("/bark-normals.png", {
 *       prepare: (texture) => {
 *         texture.colorSpace = NoColorSpace
 *       },
 *     }),
 *   })
 *
 * **Details**
 *
 * - It is an sRGB colour image unless `prepare` sets another colour space.
 * - It is oriented for Three.js geometries unless `flipY: false` keeps the
 *   file's orientation. The orientation is an option, and `prepare` cannot set
 *   it, because a bitmap is flipped when it is decoded and Three.js ignores a
 *   bitmap's `flipY` afterwards.
 * - It is decoded off the page's main thread, with `createImageBitmap`.
 * - A file that isn't an image fails the bundle with `Assets.AssetFailed`,
 *   which names the URL.
 *
 * **Gotchas**
 *
 * - Node has no `createImageBitmap`, so a texture loads only in a page. Under
 *   Node, loading one fails its bundle.
 *
 * @category Constructors
 */
export const texture = (
  url: string,
  options: TextureOptions = {}
): Assets.Asset<Texture> => {
  const flipY = options.flipY ?? true;
  return Assets.make(url, (data, at) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const bitmap = await createImageBitmap(
            // A copy: a Blob wants bytes that nothing else can change.
            new Blob([data.slice()]),
            { imageOrientation: flipY ? "flipY" : "from-image" }
          );
          const made = new Texture(bitmap);
          made.colorSpace = SRGBColorSpace;
          // What the texture says of itself is how it was decoded.
          made.flipY = flipY;
          options.prepare?.(made);
          made.needsUpdate = true;
          return made;
        },
        catch: (error) =>
          new Assets.AssetFailed({
            url: at,
            message: `It could not be made a texture: ${
              error instanceof Error
                ? error.message || error.name
                : String(error)
            }`,
          }),
      }),
      (made) =>
        Effect.sync(() => {
          made.dispose();
          (made.image as { close?: () => void } | null)?.close?.();
        })
    )
  );
};

// --- instances -------------------------------------------------------------------

/**
 * How finely a colour is converted; the table has one more entry than this.
 * Sixteen steps for each of a byte's 255, so every byte value falls exactly on
 * a step, and any float is within a thirty-second of a byte of one.
 */
const STEPS = 4080;

/**
 * The linear value of each sRGB channel value, which is what a renderer works
 * in: the standard's transfer curve, at each of the table's steps from 0 to 1.
 * Computing a power per channel per instance per frame would cost more than the
 * rest of the instance.
 */
const LINEAR = /* @__PURE__ */ (() => {
  const table = new Float32Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) {
    const c = i / STEPS;
    table[i] = c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/**
 * How an instance looks: its mesh's geometry and material.
 *
 * @category Models
 */
export interface Look {
  readonly geometry: BufferGeometry;
  readonly material: Material | Material[];
}

/**
 * The options of `Three.instances`, wherever its look comes from.
 *
 * @category Options
 */
export interface InstancesShared extends Which {
  /**
   * `Color.Rgb`, for each instance to have its entity's colour, which
   * multiplies the material's own. An entity without one is drawn in the
   * material's own colour, as if its colour were white.
   *
   *   Three.instances("game/Rocks", { of: Rock, transform: Transform3d, geometry, material, color: Color.Rgb })
   *
   * Each entity's colour is drawn by the space its `space` names:
   *
   * - `Color.Srgb` is a colour as a hex code writes it. The renderer works in
   *   linear colour, so a lookup table converts each number: a hex code's byte
   *   over 255 exactly, and any other number to the nearest sixteenth of a
   *   byte. A number below 0 or over 1 isn't a colour, and fails the frame with
   *   an error that names the entity.
   * - `Color.Linear` is the renderer's own numbers, passed through as they are.
   *   A number over 1 is brighter than white, which a renderer with bloom can
   *   show.
   *
   * With `smooth`, a colour is interpolated between two ticks like a position,
   * however far it changes, since `snap` doesn't apply to it. It is
   * interpolated in the game's numbers, then converted by the space it has at
   * the later tick.
   */
  readonly color?: typeof Color.Rgb;
  /**
   * How many instances the mesh has room for at first. Defaults to 256. The
   * room doubles when it runs out, which is the only time the system
   * allocates.
   */
  readonly capacity?: number;
  /**
   * Called with the mesh each time one is created, to make it cast shadows or
   * to put it on a layer, for example. The mesh isn't frustum culled, since its
   * instances can be anywhere. A game that knows where they are can turn
   * culling on here.
   */
  readonly prepare?: (mesh: InstancedMesh) => void;
}

/**
 * Options for instances whose look exists when the system is created.
 *
 * @category Options
 */
export interface InstancesOptions extends InstancesShared, Look {}

/**
 * Options for instances whose look is built from assets that are loaded later
 * and released again, such as a level's.
 *
 * @category Options
 */
export interface InstancesFromOptions<
  B extends Entries,
  L extends Look = Look,
> extends InstancesShared {
  /** The bundle the look is built from. The instances are drawn while it is loaded. */
  readonly from: Assets.Bundle<B>;
  /**
   * Builds the look from the bundle's assets, once each time they are loaded.
   * Anything it returns besides a geometry and a material is kept for `free`.
   */
  readonly look: (assets: Assets.Loaded<B>) => L;
  /**
   * Called with what `look` returned, after the mesh is removed from the scene,
   * when the assets are released or the app is closed. Use it to dispose
   * of anything `look` created besides the geometry and the material, which are
   * disposed of for you. The bundle releases the assets themselves.
   */
  readonly free?: (look: L) => void;
}

/** The four loops of a kind: positioned, scaled, rotated or all three. */
type Loop = "placed" | "sized" | "turned" | "whole";

/**
 * A loop over the columns of a query, whichever its terms. Typed as a method's
 * type, whose parameters are compared both ways, so that each of the loops
 * below is one, and can be handed to the query it was written for.
 */
type Columns = { loop(...columns: unknown[]): void }["loop"];

/** One instanced mesh, and the loops that fill its buffer from columns. */
class Instances implements Kept {
  readonly mesh: InstancedMesh;
  private readonly scene: ThreeScene;
  /** The instances' matrices, sixteen numbers each: the mesh's own buffer. */
  private array: Float32Array;
  private capacity: number;
  private count = 0;
  /** The part of the buffer uploaded to the renderer, reused every frame. */
  private readonly range = { start: 0, count: 0 };
  /** What interpolates the entities between two ticks, when the system was asked to. */
  private readonly smooth: Smooth | undefined;
  /** The instances' colours, three numbers each, for a kind that has them. */
  private colors: Float32Array | undefined;
  private readonly colorRange = { start: 0, count: 0 };
  private readonly name: string;
  /**
   * The four loops of the kind's transform as the system passes them to its
   * queries: as is, or, for a kind with a colour, each followed by the colours
   * of its rows.
   */
  readonly loops: Record<Loop, Columns>;
  /**
   * For a kind with a colour, the four loops for the entities that have none:
   * each followed by white for its rows.
   */
  readonly plain: Record<Loop, Columns>;

  constructor(
    scene: ThreeScene,
    name: string,
    options: InstancesOptions,
    private readonly holdings: Holdings
  ) {
    holdings.hold(options.geometry);
    holdings.hold(options.material);
    this.scene = scene;
    this.name = name;
    this.smooth = smoothOf(options);
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 256));
    this.array = new Float32Array(this.capacity * 16);
    const own: Record<Loop, Columns> = isFlat(options)
      ? {
          placed: this.placedFlat,
          sized: this.sizedFlat,
          turned: this.turnedFlat,
          whole: this.wholeFlat,
        }
      : {
          placed: this.placed,
          sized: this.sized,
          turned: this.turned,
          whole: this.whole,
        };
    if (options.color === undefined) {
      this.loops = own;
      this.plain = own;
    } else {
      this.plain = {
        placed: this.whitened(own.placed),
        sized: this.whitened(own.sized),
        turned: this.whitened(own.turned),
        whole: this.whitened(own.whole),
      };
      this.colors = new Float32Array(this.capacity * 3);
      this.loops = {
        placed: this.painted1(own.placed),
        sized: this.painted2(own.sized),
        turned: this.painted2(own.turned),
        whole: this.painted3(own.whole),
      };
    }
    this.mesh = new InstancedMesh(options.geometry, options.material, 0);
    this.mesh.name = name;
    // Its instances are wherever the entities are, which a bounding sphere
    // worked out once would not follow.
    this.mesh.frustumCulled = false;
    this.attach();
    options.prepare?.(this.mesh);
    scene.add(this.mesh);
  }

  private attach(): void {
    const attribute = new InstancedBufferAttribute(this.array, 16);
    attribute.setUsage(DynamicDrawUsage);
    this.mesh.instanceMatrix = attribute;
    if (this.colors !== undefined) {
      const colors = new InstancedBufferAttribute(this.colors, 3);
      colors.setUsage(DynamicDrawUsage);
      this.mesh.instanceColor = colors;
    }
  }

  // A kind with a colour is handed one more component by its queries, after
  // the ones a loop reads: the loop runs as it is, and the colours of the
  // same rows are written beside the matrices it wrote.

  private painted1<A>(
    loop: (start: number, end: number, a: A, entities: EntityColumn) => void
  ) {
    return (
      start: number,
      end: number,
      a: A,
      color: Rgb,
      entities: EntityColumn
    ): void => {
      const from = this.count;
      loop(start, end, a, entities);
      this.paint(from, start, end, color, entities);
    };
  }

  private painted2<A, B>(
    loop: (
      start: number,
      end: number,
      a: A,
      b: B,
      entities: EntityColumn
    ) => void
  ) {
    return (
      start: number,
      end: number,
      a: A,
      b: B,
      color: Rgb,
      entities: EntityColumn
    ): void => {
      const from = this.count;
      loop(start, end, a, b, entities);
      this.paint(from, start, end, color, entities);
    };
  }

  private painted3<A, B, C>(
    loop: (
      start: number,
      end: number,
      a: A,
      b: B,
      c: C,
      entities: EntityColumn
    ) => void
  ) {
    return (
      start: number,
      end: number,
      a: A,
      b: B,
      c: C,
      color: Rgb,
      entities: EntityColumn
    ): void => {
      const from = this.count;
      loop(start, end, a, b, c, entities);
      this.paint(from, start, end, color, entities);
    };
  }

  /** A loop of a kind with a colour, for entities that have none: white. */
  private whitened(loop: Columns): Columns {
    return (...columns: unknown[]): void => {
      const from = this.count;
      loop(...columns);
      // Read after the loop, which may have made more room.
      this.colors!.fill(1, from * 3, this.count * 3);
    };
  }

  /** Writes the colours of these rows, for the instances from `from` on. */
  private paint(
    from: number,
    start: number,
    end: number,
    color: Rgb,
    entities: EntityColumn
  ): void {
    // Read after the loop, which may have made more room for both.
    const out = this.colors!;
    const { space } = color;
    let { r, g, b } = color;
    if (this.smooth !== undefined) {
      ({
        x: r,
        y: g,
        z: b,
      } = this.smooth.color.run(start, end, r, g, b, entities));
    }
    let at = from * 3;
    for (let i = start; i < end; i++) {
      if (space[i] === Color.Linear) {
        out[at] = r[i]!;
        out[at + 1] = g[i]!;
        out[at + 2] = b[i]!;
        at += 3;
        continue;
      }
      // A hex code's numbers, each looked up in the table at the nearest of
      // its steps. One that is off either end of it is no colour.
      const u = (r[i]! * STEPS + 0.5) | 0;
      const v = (g[i]! * STEPS + 0.5) | 0;
      const w = (b[i]! * STEPS + 0.5) | 0;
      // A space that is neither, or a number under zero or past the table's
      // end, either of which leaves one of the six below zero.
      if (
        space[i] !== Color.Srgb ||
        (u | v | w | (STEPS - u) | (STEPS - v) | (STEPS - w)) < 0
      ) {
        this.refuse(entities[i]!, r[i]!, g[i]!, b[i]!, space[i]!);
      }
      out[at] = LINEAR[u]!;
      out[at + 1] = LINEAR[v]!;
      out[at + 2] = LINEAR[w]!;
      at += 3;
    }
  }

  private refuse(
    entity: Entity,
    r: number,
    g: number,
    b: number,
    space: number
  ): never {
    const why =
      space === Color.Srgb
        ? "each number of a colour in Color.Srgb is from 0 to 1, as a hex code's bytes over 255 are. A colour brighter than white is in Color.Linear, the renderer's own numbers, which are drawn as they are."
        : `its space is ${space}, and a colour's space is Color.Srgb (${Color.Srgb}) or Color.Linear (${Color.Linear}).`;
    throw new Error(
      `Three.instances("${this.name}") was given the colour (${r}, ${g}, ${b}) by entity ${entity}, which is no colour: ${why}`
    );
  }

  /** Makes room for `rows` more instances, and returns where the first goes. */
  private reserve(rows: number): number {
    const at = this.count;
    const needed = at + rows;
    if (needed > this.capacity) {
      let { capacity } = this;
      while (capacity < needed) {
        capacity *= 2;
      }
      const array = new Float32Array(capacity * 16);
      array.set(this.array.subarray(0, at * 16));
      if (this.colors !== undefined) {
        const colors = new Float32Array(capacity * 3);
        colors.set(this.colors.subarray(0, at * 3));
        this.colors = colors;
      }
      // A buffer cannot grow where it is: the renderer lets go of the ones
      // it made for the old attributes, and makes new ones.
      this.mesh.dispose();
      this.array = array;
      this.capacity = capacity;
      this.attach();
    }
    this.count = needed;
    return at * 16;
  }

  begin(tick: number, alpha: number, frame: number): void {
    this.count = 0;
    this.smooth?.begin(tick, alpha, frame);
  }

  /** Entities with only a position: drawn unrotated, at the geometry's size. */
  readonly placed = (
    start: number,
    end: number,
    position: Xyz,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y, z } = position;
    for (let i = start; i < end; i++) {
      out[at] = 1;
      out[at + 1] = 0;
      out[at + 2] = 0;
      out[at + 3] = 0;
      out[at + 4] = 0;
      out[at + 5] = 1;
      out[at + 6] = 0;
      out[at + 7] = 0;
      out[at + 8] = 0;
      out[at + 9] = 0;
      out[at + 10] = 1;
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = z[i]!;
      out[at + 15] = 1;
      at += 16;
    }
  };

  /** Entities with a position and a scale. */
  readonly sized = (
    start: number,
    end: number,
    position: Xyz,
    scale: Xyz,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
      scale = smooth.scale.blend(start, end, scale, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y, z } = position;
    const { x: sx, y: sy, z: sz } = scale;
    for (let i = start; i < end; i++) {
      out[at] = sx[i]!;
      out[at + 1] = 0;
      out[at + 2] = 0;
      out[at + 3] = 0;
      out[at + 4] = 0;
      out[at + 5] = sy[i]!;
      out[at + 6] = 0;
      out[at + 7] = 0;
      out[at + 8] = 0;
      out[at + 9] = 0;
      out[at + 10] = sz[i]!;
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = z[i]!;
      out[at + 15] = 1;
      at += 16;
    }
  };

  /** Rotated entities: a matrix from the position and the quaternion. */
  readonly turned = (
    start: number,
    end: number,
    position: Xyz,
    rotation: Xyzw,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
      rotation = smooth.rotation.blend(start, end, rotation, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y, z } = position;
    const { x: qx, y: qy, z: qz, w: qw } = rotation;
    for (let i = start; i < end; i++) {
      const a = qx[i]!;
      const b = qy[i]!;
      const c = qz[i]!;
      const d = qw[i]!;
      // Twice over its length squared, which is 2 for a quaternion of
      // length 1: one of any other length draws as the turn it stands
      // for, and not skewed. All zeros is no turn at all.
      const n = a * a + b * b + c * c + d * d;
      const s = n > 0 ? 2 / n : 0;
      const a2 = a * s;
      const b2 = b * s;
      const c2 = c * s;
      out[at] = 1 - (b * b2 + c * c2);
      out[at + 1] = a * b2 + d * c2;
      out[at + 2] = a * c2 - d * b2;
      out[at + 3] = 0;
      out[at + 4] = a * b2 - d * c2;
      out[at + 5] = 1 - (a * a2 + c * c2);
      out[at + 6] = b * c2 + d * a2;
      out[at + 7] = 0;
      out[at + 8] = a * c2 + d * b2;
      out[at + 9] = b * c2 - d * a2;
      out[at + 10] = 1 - (a * a2 + b * b2);
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = z[i]!;
      out[at + 15] = 1;
      at += 16;
    }
  };

  /** Entities with all three: what `Matrix4.compose` computes, written out. */
  readonly whole = (
    start: number,
    end: number,
    position: Xyz,
    rotation: Xyzw,
    scale: Xyz,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
      rotation = smooth.rotation.blend(start, end, rotation, entities);
      scale = smooth.scale.blend(start, end, scale, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y, z } = position;
    const { x: qx, y: qy, z: qz, w: qw } = rotation;
    const { x: sx, y: sy, z: sz } = scale;
    for (let i = start; i < end; i++) {
      const a = qx[i]!;
      const b = qy[i]!;
      const c = qz[i]!;
      const d = qw[i]!;
      // Twice over its length squared, which is 2 for a quaternion of
      // length 1: one of any other length draws as the turn it stands
      // for, and not skewed. All zeros is no turn at all.
      const n = a * a + b * b + c * c + d * d;
      const s = n > 0 ? 2 / n : 0;
      const a2 = a * s;
      const b2 = b * s;
      const c2 = c * s;
      const u = sx[i]!;
      const v = sy[i]!;
      const w = sz[i]!;
      out[at] = (1 - (b * b2 + c * c2)) * u;
      out[at + 1] = (a * b2 + d * c2) * u;
      out[at + 2] = (a * c2 - d * b2) * u;
      out[at + 3] = 0;
      out[at + 4] = (a * b2 - d * c2) * v;
      out[at + 5] = (1 - (a * a2 + c * c2)) * v;
      out[at + 6] = (b * c2 + d * a2) * v;
      out[at + 7] = 0;
      out[at + 8] = (a * c2 + d * b2) * w;
      out[at + 9] = (b * c2 - d * a2) * w;
      out[at + 10] = (1 - (a * a2 + b * b2)) * w;
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = z[i]!;
      out[at + 15] = 1;
      at += 16;
    }
  };

  // A flat game's entities, for a kind of Transform2d: in the plane of x and
  // y, turned about the axis that comes out of it. The same four loops, with
  // fewer columns.

  /** 2D entities with only a position. */
  readonly placedFlat = (
    start: number,
    end: number,
    position: Xy,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y } = position;
    for (let i = start; i < end; i++) {
      out[at] = 1;
      out[at + 1] = 0;
      out[at + 2] = 0;
      out[at + 3] = 0;
      out[at + 4] = 0;
      out[at + 5] = 1;
      out[at + 6] = 0;
      out[at + 7] = 0;
      out[at + 8] = 0;
      out[at + 9] = 0;
      out[at + 10] = 1;
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = 0;
      out[at + 15] = 1;
      at += 16;
    }
  };

  /** 2D entities with a position and a scale. */
  readonly sizedFlat = (
    start: number,
    end: number,
    position: Xy,
    scale: Xy,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
      scale = smooth.flatScale.blend(start, end, scale, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y } = position;
    const { x: sx, y: sy } = scale;
    for (let i = start; i < end; i++) {
      out[at] = sx[i]!;
      out[at + 1] = 0;
      out[at + 2] = 0;
      out[at + 3] = 0;
      out[at + 4] = 0;
      out[at + 5] = sy[i]!;
      out[at + 6] = 0;
      out[at + 7] = 0;
      out[at + 8] = 0;
      out[at + 9] = 0;
      out[at + 10] = 1;
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = 0;
      out[at + 15] = 1;
      at += 16;
    }
  };

  /** Rotated 2D entities: a sine and a cosine each. */
  readonly turnedFlat = (
    start: number,
    end: number,
    position: Xy,
    rotation: Angle,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
      rotation = smooth.flatRotation.blend(start, end, rotation, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y } = position;
    const { angle } = rotation;
    for (let i = start; i < end; i++) {
      const cos = Math.cos(angle[i]!);
      const sin = Math.sin(angle[i]!);
      out[at] = cos;
      out[at + 1] = sin;
      out[at + 2] = 0;
      out[at + 3] = 0;
      out[at + 4] = -sin;
      out[at + 5] = cos;
      out[at + 6] = 0;
      out[at + 7] = 0;
      out[at + 8] = 0;
      out[at + 9] = 0;
      out[at + 10] = 1;
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = 0;
      out[at + 15] = 1;
      at += 16;
    }
  };

  /** 2D entities with all three. */
  readonly wholeFlat = (
    start: number,
    end: number,
    position: Xy,
    rotation: Angle,
    scale: Xy,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
      rotation = smooth.flatRotation.blend(start, end, rotation, entities);
      scale = smooth.flatScale.blend(start, end, scale, entities);
    }
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y } = position;
    const { angle } = rotation;
    const { x: sx, y: sy } = scale;
    for (let i = start; i < end; i++) {
      const cos = Math.cos(angle[i]!);
      const sin = Math.sin(angle[i]!);
      const u = sx[i]!;
      const v = sy[i]!;
      out[at] = cos * u;
      out[at + 1] = sin * u;
      out[at + 2] = 0;
      out[at + 3] = 0;
      out[at + 4] = -sin * v;
      out[at + 5] = cos * v;
      out[at + 6] = 0;
      out[at + 7] = 0;
      out[at + 8] = 0;
      out[at + 9] = 0;
      out[at + 10] = 1;
      out[at + 11] = 0;
      out[at + 12] = x[i]!;
      out[at + 13] = y[i]!;
      out[at + 14] = 0;
      out[at + 15] = 1;
      at += 16;
    }
  };

  /** Sets the mesh's instance count, and the range to upload to the renderer. */
  finish(): void {
    const { count, mesh, range } = this;
    mesh.count = count;
    if (count > 0) {
      const attribute = mesh.instanceMatrix;
      // Only what is drawn is sent. The one range is this object every
      // frame: the renderer empties the list once it has sent it.
      range.count = count * 16;
      attribute.updateRanges.length = 0;
      attribute.updateRanges.push(range);
      attribute.needsUpdate = true;
      const colors = mesh.instanceColor;
      if (colors !== null) {
        this.colorRange.count = count * 3;
        colors.updateRanges.length = 0;
        colors.updateRanges.push(this.colorRange);
        colors.needsUpdate = true;
      }
    }
  }

  /** How many instances the buffer currently has room for. */
  get room(): number {
    return this.capacity;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.holdings.letGo();
  }
}

/** The instances of a look built from assets, while those assets are loaded. */
interface Sourced extends Kept {
  readonly instances: Instances;
}

/**
 * What a system of this module requires from an app, and what one that draws
 * from a bundle requires in addition.
 */
type Needs = Frame | Scene | Time | World;

/**
 * Makes a frame-stage system that draws every entity of a kind as one instance
 * of one mesh.
 *
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     geometry: new IcosahedronGeometry(1),
 *     material: new MeshStandardMaterial({ color: "#8a8f98" }),
 *   })
 *
 * **When to use**
 *
 * Use for crowds, many entities that look the same. For the few entities that
 * are more than a copy of one mesh, use `Three.objects`.
 *
 * **Details**
 *
 * An entity is drawn while it has what `of` specifies, none of `without`, and
 * the `Position` of the kind's `transform`. It is rotated and scaled by that
 * module's `Rotation` and `Scale` when it has them. A kind of `Transform2d`
 * draws in the x-y plane, at z = 0. A kind reads nothing of the other module.
 *
 * - Each frame, it reads the columns directly with `eachChunk`, and writes one
 *   matrix per entity into the mesh's instance buffer. It creates no object,
 *   matrix or vector per entity. It reallocates the buffer only to double it
 *   when it is full.
 * - A `Rotation` is drawn as the rotation it represents, whatever its length,
 *   so it neither skews nor scales the instance. A `Rotation` whose four fields
 *   are 0, as one added without a value is, means no rotation.
 * - Entities are drawn where the last tick left them, unless `smooth` is set.
 * - The mesh is created on the first frame, named after the system, and added
 *   to the scene. When the app is closed, the mesh is removed and disposed
 *   of. So are the geometry and the material, once no other system draws with
 *   them, so share them between systems freely.
 * - It requires `Three.plugin`, and its name must be unique among the app's
 *   systems.
 *
 * With `smooth: true`, each entity is interpolated between its last two
 * positions, at `Frame.alpha` of the way from where it was a tick ago to where
 * it is now:
 *
 * - The image is then up to one tick behind the game. Just after a tick, at an
 *   `alpha` of 0, an entity is drawn where it was before the tick. A game that
 *   ticks only when needed receives an `alpha` of 1 while it rests, and is
 *   drawn where it is.
 * - Positions, scales and colours are interpolated linearly. A rotation takes
 *   the shorter arc.
 * - An entity that wasn't drawn in the previous frame is drawn where it is: a
 *   new entity, one in a slot that belonged to another, one that was hidden,
 *   and every entity on the first frame, after a load, or after a frame the
 *   system didn't run in. So is an entity that moved farther than `snap` in a
 *   tick.
 * - When several ticks ran since the last frame, an entity moves from where it
 *   was last drawn. When none ran, it stays between the same two positions as
 *   in the previous frame. A position changed without a tick becomes the new
 *   end of that move, which keeps its start.
 * - What interpolation keeps, each component's value a tick ago, isn't part of
 *   the world. The game's hash, log and save are the same with it or without.
 *
 * A look built from assets, such as a level's texture, is given as the bundle
 * it comes `from` and a function that builds it:
 *
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     from: Forest,
 *     look: ({ bark }) => ({
 *       geometry: new IcosahedronGeometry(1),
 *       material: new MeshStandardMaterial({ map: bark }),
 *     }),
 *   })
 *
 * - The entities are drawn only while the app has the bundle loaded, which
 *   `Assets.during` or a system of your own manages. At any other time, no
 *   mesh of the kind is in the scene.
 * - `look` is called once each time the bundle loads. When the bundle is
 *   released or the app is closed, the mesh is disposed of, with the
 *   geometry and the material once no other system draws with them. Then
 *   `free` receives what `look` returned. A mesh built from a reloaded bundle
 *   starts with the room the previous one had grown to.
 * - It also requires `Assets.plugin`, as the system's type shows.
 *
 * **Gotchas**
 *
 * - Instances are drawn in no particular order.
 *
 * @category Systems
 */
export function instances<B extends Entries, L extends Look = Look>(
  name: string,
  options: InstancesFromOptions<B, L>
): System.System<never, Needs | Assets.Store, string, "frame">;
export function instances(
  name: string,
  options: InstancesOptions
): System.System<never, Needs, string, "frame">;
// One body for both: the system of a look that is there asks for no store of
// assets, which the second signature says.
export function instances(
  name: string,
  options: InstancesOptions | InstancesFromOptions<Entries>
): System.System<never, Needs | Assets.Store, string, "frame"> {
  const from = "from" in options ? options : undefined;
  const smooth = options.smooth === true;
  const marked = required(options);
  const excluded = options.without ?? [];
  const { color } = options;
  // The terms of a query are a tuple in its type, and a kind with a colour
  // has one more than one without, after the ones its loop reads: its type
  // only says that they are components, and its loop takes any columns.
  const kind = (
    own: readonly ComponentDef[],
    absent: readonly ComponentDef[]
  ): Query.Query<Query.Reading<readonly ComponentDef[]>, never> =>
    Query.all(...own, ...(color === undefined ? [] : [color])).pipe(
      Query.with(...marked),
      Query.without(...excluded, ...absent)
    );
  // With a colour, the same kinds once more for the entities without one,
  // which are drawn white: a colour on some changes how those look, and
  // hides nothing.
  const plain = (
    own: readonly ComponentDef[],
    absent: readonly ComponentDef[]
  ): Query.Query<Query.Reading<readonly ComponentDef[]>, never> | undefined =>
    color === undefined
      ? undefined
      : Query.all(...own).pipe(
          Query.with(...marked),
          Query.without(...excluded, ...absent, color)
        );
  // An entity's table has a rotation or it does not, and a scale or not:
  // four queries of the kind's transform, each handed exactly the columns
  // its entities have.
  const { Position, Rotation, Scale } = options.transform;
  const shapes: readonly (readonly [
    Loop,
    readonly ComponentDef[],
    readonly ComponentDef[],
  ])[] = [
    ["placed", [Position], [Rotation, Scale]],
    ["sized", [Position, Scale], [Rotation]],
    ["turned", [Position, Rotation], [Scale]],
    ["whole", [Position, Rotation, Scale], []],
  ];
  const kinds = shapes.map(([loop, own, absent]) => ({
    loop,
    query: kind(own, absent),
    plain: plain(own, absent),
  }));
  return System.frame(name, function* () {
    const kept = yield* Scene;
    // Which tick the game is at and how far towards the next the frame is:
    // asked only by a system that draws between the two.
    const tick = smooth ? (yield* Time).tick : 0;
    const frame = smooth ? yield* Frame : undefined;
    let drawn: Instances | undefined;
    if (from === undefined) {
      drawn = kept._kept.get(name) as Instances | undefined;
      if (drawn === undefined) {
        drawn = new Instances(
          kept.scene,
          name,
          options as InstancesOptions,
          new Holdings(kept._owned)
        );
        kept._kept.set(name, drawn);
      }
    } else {
      let sourced = kept._kept.get(name) as FromAssets<Sourced> | undefined;
      if (sourced === undefined) {
        // The room the instances came to need is kept from one loading of
        // the bundle to the next.
        let room = from.capacity ?? 256;
        const { _owned, scene } = kept;
        sourced = new FromAssets(
          yield* Assets.Store,
          from.from,
          (assets): Sourced => {
            const look = from.look(assets);
            const made = new Instances(
              scene,
              name,
              {
                ...from,
                geometry: look.geometry,
                material: look.material,
                capacity: room,
              },
              new Holdings(_owned)
            );
            return {
              instances: made,
              dispose: () => {
                ({ room } = made);
                made.dispose();
                from.free?.(look);
              },
            };
          }
        );
        kept._kept.set(name, sourced);
      }
      drawn = sourced.now()?.instances;
      // Its assets are not there: nothing of it is in the scene.
      if (drawn === undefined) {
        return;
      }
    }
    // Plain loops from here on: one pass over the columns of each kind.
    drawn.begin(tick, frame?.alpha ?? 0, frame?.count ?? 0);
    const { loops, plain: white } = drawn;
    for (const each of kinds) {
      (yield* each.query).eachChunk(loops[each.loop]);
      if (each.plain !== undefined) {
        (yield* each.plain).eachChunk(white[each.loop]);
      }
    }
    drawn.finish();
  });
}

// --- objects ---------------------------------------------------------------------

/**
 * The options of `Three.objects`, wherever its objects come from.
 *
 * @category Options
 */
export interface ObjectsShared<O extends Object3D = Object3D> extends Which {
  /**
   * Called with an entity's object after it is removed from the scene, when
   * the entity stops matching, its bundle is released, or the app
   * is closed. Use it to dispose of what `make` created for this object alone,
   * such as its own material, as soon as the object goes. Every object's
   * geometries and materials are disposed of when the bundle they were made
   * from is released or the app is closed, once no other system draws
   * with them.
   */
  readonly free?: (object: O, entity: Entity) => void;
}

/**
 * Options for objects whose `make` needs no assets.
 *
 * @category Options
 */
export interface ObjectsOptions<
  O extends Object3D = Object3D,
> extends ObjectsShared<O> {
  /**
   * Creates an entity's object, on the first frame the entity matches. The
   * object is added to the scene, and given the entity's transform.
   */
  readonly make: (entity: Entity) => O;
}

/**
 * Options for objects built from assets that are loaded later and released
 * again, such as a level's models.
 *
 * @category Options
 */
export interface ObjectsFromOptions<
  B extends Entries,
  O extends Object3D = Object3D,
> extends ObjectsShared<O> {
  /** The bundle the objects are built from. Objects exist while it is loaded. */
  readonly from: Assets.Bundle<B>;
  /**
   * Creates an entity's object from the bundle's assets. It is called on the
   * first frame that the entity matches and the assets are loaded, and again
   * each time the assets load again.
   */
  readonly make: (entity: Entity, assets: Assets.Loaded<B>) => O;
}

/** Either set of options, as the class that keeps the objects sees them. */
interface ObjectsOf<O extends Object3D> extends ObjectsShared<O> {
  // Handed the assets of its bundle, or none for a kind without one.
  readonly make: (entity: Entity, assets: never) => O;
}

/** One object per entity, by entity index, and the loops that position them. */
class Objects<O extends Object3D> implements Kept {
  private readonly scene: ThreeScene;
  private readonly options: ObjectsOf<O>;
  /** What the objects are built from, for a kind built from assets. */
  private readonly assets: unknown;
  private readonly objects: (O | undefined)[] = [];
  /** For each entity index, the id of the entity its object was created for. */
  private owner = new Float64Array(0);
  /** For each entity index, the frame its entity was last found in, rotated, and scaled. */
  private seen = new Uint32Array(0);
  private turnedAt = new Uint32Array(0);
  private sizedAt = new Uint32Array(0);
  /** The entity indexes that have an object, unordered. */
  private readonly live: number[] = [];
  private stamp = 0;
  /** What interpolates the objects between two ticks, when the system was asked to. */
  private readonly smooth: Smooth | undefined;
  /** Whether the kind is placed by a flat game's transform. */
  private readonly flat: boolean;
  /** The three loops of the kind's transform, as the system passes them to its queries. */
  readonly loops: Record<"placed" | "turned" | "sized", Columns>;

  constructor(
    scene: ThreeScene,
    options: ObjectsOf<O>,
    assets: unknown,
    private readonly holdings: Holdings
  ) {
    this.scene = scene;
    this.options = options;
    this.assets = assets;
    this.smooth = smoothOf(options);
    this.flat = isFlat(options);
    this.loops = this.flat
      ? {
          placed: this.placedFlat,
          turned: this.turnedFlat,
          sized: this.sizedFlat,
        }
      : { placed: this.placed, turned: this.turned, sized: this.sized };
  }

  private grow(size: number): void {
    let length = Math.max(64, this.seen.length);
    while (length < size) {
      length *= 2;
    }
    // An id is wider than a frame's number: an array of 64-bit floats.
    const owner = new Float64Array(length);
    owner.set(this.owner);
    this.owner = owner;
    for (const name of ["seen", "turnedAt", "sizedAt"] as const) {
      const bigger = new Uint32Array(length);
      bigger.set(this[name]);
      this[name] = bigger;
    }
  }

  private release(index: number): void {
    const object = this.objects[index]!;
    this.objects[index] = undefined;
    this.scene.remove(object);
    this.options.free?.(object, this.owner[index] as Entity);
  }

  /** Creates the object of an entity that has none, or whose slot held another entity's. */
  private adopt(index: number, entity: Entity): O {
    if (this.objects[index] === undefined) {
      this.live.push(index);
    } else {
      this.release(index);
    }
    const object = this.options.make(entity, this.assets as never);
    this.holdings.holdAll(object);
    this.objects[index] = object;
    this.owner[index] = entity;
    this.turnedAt[index] = 0;
    this.sizedAt[index] = 0;
    this.scene.add(object);
    return object;
  }

  begin(tick: number, alpha: number, frame: number): void {
    this.stamp++;
    this.smooth?.begin(tick, alpha, frame);
  }

  readonly placed = (
    start: number,
    end: number,
    position: Xyz,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      position = this.smooth.position.blend(start, end, position, entities);
    }
    const { x, y, z } = position;
    const { objects, stamp } = this;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      if (index >= this.seen.length) {
        this.grow(index + 1);
      }
      let object = objects[index];
      if (object === undefined || this.owner[index] !== entity) {
        object = this.adopt(index, entity);
      }
      object.position.set(x[i]!, y[i]!, z[i]!);
      this.seen[index] = stamp;
    }
  };

  // A flat game's entities, for a kind of Transform2d. Only what its
  // components say is set: where an object is along the third axis, how it
  // is turned about the other two and how deep it is are as `make` left
  // them, or as the game sets them.

  readonly placedFlat = (
    start: number,
    end: number,
    position: Xy,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      position = this.smooth.flatPosition.blend(start, end, position, entities);
    }
    const { x, y } = position;
    const { objects, stamp } = this;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      if (index >= this.seen.length) {
        this.grow(index + 1);
      }
      let object = objects[index];
      if (object === undefined || this.owner[index] !== entity) {
        object = this.adopt(index, entity);
      }
      object.position.x = x[i]!;
      object.position.y = y[i]!;
      this.seen[index] = stamp;
    }
  };

  readonly turnedFlat = (
    start: number,
    end: number,
    rotation: Angle,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      rotation = this.smooth.flatRotation.blend(start, end, rotation, entities);
    }
    const { angle } = rotation;
    const { objects, stamp, turnedAt } = this;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      objects[index]!.rotation.z = angle[i]!;
      turnedAt[index] = stamp;
    }
  };

  readonly sizedFlat = (
    start: number,
    end: number,
    scale: Xy,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      scale = this.smooth.flatScale.blend(start, end, scale, entities);
    }
    const { x, y } = scale;
    const { objects, sizedAt, stamp } = this;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      const size = objects[index]!.scale;
      size.x = x[i]!;
      size.y = y[i]!;
      sizedAt[index] = stamp;
    }
  };

  readonly turned = (
    start: number,
    end: number,
    rotation: Xyzw,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      rotation = this.smooth.rotation.blend(start, end, rotation, entities);
    }
    const { x, y, z, w } = rotation;
    const { objects, stamp, turnedAt } = this;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      // An Object3D's quaternion has to be of length 1, which the game's
      // may not be: it is given the turn that one stands for. All zeros
      // is no turn at all.
      const a = x[i]!;
      const b = y[i]!;
      const c = z[i]!;
      const d = w[i]!;
      const n = a * a + b * b + c * c + d * d;
      if (n > 0) {
        const s = 1 / Math.sqrt(n);
        objects[index]!.quaternion.set(a * s, b * s, c * s, d * s);
      } else {
        objects[index]!.quaternion.identity();
      }
      turnedAt[index] = stamp;
    }
  };

  readonly sized = (
    start: number,
    end: number,
    scale: Xyz,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      scale = this.smooth.scale.blend(start, end, scale, entities);
    }
    const { x, y, z } = scale;
    const { objects, sizedAt, stamp } = this;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      objects[index]!.scale.set(x[i]!, y[i]!, z[i]!);
      sizedAt[index] = stamp;
    }
  };

  /** Releases the objects whose entities weren't found this frame. */
  finish(): void {
    const { flat, live, objects, seen, sizedAt, stamp, turnedAt } = this;
    for (let k = live.length - 1; k >= 0; k--) {
      const index = live[k]!;
      if (seen[index] !== stamp) {
        this.release(index);
        live[k] = live.at(-1)!;
        live.pop();
        continue;
      }
      // An entity that is no longer turned, or sized, is drawn as one that
      // never was.
      if (turnedAt[index] !== stamp && turnedAt[index] !== 0) {
        if (flat) {
          objects[index]!.rotation.z = 0;
        } else {
          objects[index]!.quaternion.identity();
        }
        turnedAt[index] = 0;
      }
      if (sizedAt[index] !== stamp && sizedAt[index] !== 0) {
        const size = objects[index]!.scale;
        if (flat) {
          size.x = 1;
          size.y = 1;
        } else {
          size.set(1, 1, 1);
        }
        sizedAt[index] = 0;
      }
    }
  }

  dispose(): void {
    for (const index of this.live) {
      this.release(index);
    }
    this.live.length = 0;
    this.holdings.letGo();
  }
}

/**
 * Makes a frame-stage system that keeps one `Object3D` per entity of a kind, at
 * the entity's transform.
 *
 *   const Ships = Three.objects("game/Ships", {
 *     of: Ship,
 *     transform: Transform3d,
 *     make: () => new Mesh(hull, paint),
 *   })
 *
 * **When to use**
 *
 * Use for the few entities that are more than a copy of one mesh, such as a
 * model with parts, a light, or something that carries the camera. For crowds,
 * use `Three.instances`.
 *
 * **Details**
 *
 * - `make` is called on the first frame an entity has what `of` specifies,
 *   none of `without`, and the `Position` of the kind's `transform`. Its object
 *   is added to the scene. On the frame the entity stops matching, or is
 *   despawned, the object is removed and passed to `free`.
 * - Each frame, every object receives its entity's `Position`, and its
 *   `Rotation` and `Scale` when the entity has them, all from the kind's
 *   `transform`. A rotation of any length is applied as a unit quaternion. An
 *   entity that loses its `Rotation` or `Scale` is drawn as if it never had
 *   it. Your game sets anything else about an object, in `make` or in a frame
 *   system of its own.
 * - For a kind of `Transform2d`, the system sets the object's x and y, its
 *   rotation about the z axis, and its scale along x and y. Its z position,
 *   tilt and depth scale stay as `make` set them. Set the z position in `make`
 *   to layer one kind in front of another.
 * - An entity that reuses a despawned entity's slot gets its own object.
 * - When the app is closed, or the bundle is released, every object is
 *   removed and passed to `free`. The geometries and materials the objects
 *   were made with are disposed of, once no other system draws with them.
 * - Nothing is kept in the world. A game loaded from a save, or an app that
 *   starts with entities, has its objects created on the first frame.
 * - With `smooth: true`, an object is interpolated between its entity's last
 *   two transforms, as `Three.instances` draws an instance.
 * - It requires `Three.plugin`, and its name must be unique among the app's
 *   systems.
 *
 * Objects built from a level's assets name the bundle they come `from`, and
 * `make` receives its assets:
 *
 *   const Trees = Three.objects("game/Trees", {
 *     of: Tree,
 *     transform: Transform3d,
 *     from: Forest,
 *     make: (entity, { oak }) => oak.scene.clone(),
 *   })
 *
 * - Objects exist only while the app has the bundle loaded. Each is created in
 *   the frame the bundle loads. When the bundle is released, every object is
 *   removed and passed to `free` before the scene is next rendered. When the
 *   bundle loads again, each object is created again.
 * - It also requires `Assets.plugin`.
 *
 * @category Systems
 */
// The one made of assets is first, so that the two things its `make` is
// handed are typed from it.
export function objects<B extends Entries, O extends Object3D = Object3D>(
  name: string,
  options: ObjectsFromOptions<B, O>
): System.System<never, Needs | Assets.Store, string, "frame">;
export function objects<O extends Object3D = Object3D>(
  name: string,
  options: ObjectsOptions<O>
): System.System<never, Needs, string, "frame">;
// One body for both, as for `instances`.
export function objects<O extends Object3D>(
  name: string,
  options: ObjectsOptions<O> | ObjectsFromOptions<Entries, O>
): System.System<never, Needs | Assets.Store, string, "frame"> {
  const from = "from" in options ? options.from : undefined;
  const smooth = options.smooth === true;
  const marked = required(options);
  const excluded = options.without ?? [];
  const { Position, Rotation, Scale } = options.transform;
  const query = (term: ComponentDef, also: readonly ComponentDef[]) =>
    Query.all(term).pipe(
      Query.with(...also, ...marked),
      Query.without(...excluded)
    );
  const Placed = query(Position, []);
  const Turned = query(Rotation, [Position]);
  const Sized = query(Scale, [Position]);
  return System.frame(name, function* () {
    const kept = yield* Scene;
    const placed = yield* Placed;
    const turned = yield* Turned;
    const sized = yield* Sized;
    const tick = smooth ? (yield* Time).tick : 0;
    const frame = smooth ? yield* Frame : undefined;
    let held: Objects<O> | undefined;
    if (from === undefined) {
      held = kept._kept.get(name) as Objects<O> | undefined;
      if (held === undefined) {
        held = new Objects(
          kept.scene,
          options,
          undefined,
          new Holdings(kept._owned)
        );
        kept._kept.set(name, held);
      }
    } else {
      let sourced = kept._kept.get(name) as FromAssets<Objects<O>> | undefined;
      if (sourced === undefined) {
        const { _owned, scene } = kept;
        sourced = new FromAssets(
          yield* Assets.Store,
          from,
          (assets) => new Objects(scene, options, assets, new Holdings(_owned))
        );
        kept._kept.set(name, sourced);
      }
      held = sourced.now();
      // Its assets are not there: there is nothing to make an object of.
      if (held === undefined) {
        return;
      }
    }
    // Every entity that is one of these is found by the first loop, which
    // makes the objects that are missing; whatever it did not find is let
    // go at the end.
    held.begin(tick, frame?.alpha ?? 0, frame?.count ?? 0);
    const { loops } = held;
    placed.eachChunk(loops.placed);
    turned.eachChunk(loops.turned);
    sized.eachChunk(loops.sized);
    held.finish();
  });
}
