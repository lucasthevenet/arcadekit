/**
 * Draws a game with Three.js. This is the package's `@arcadekit/three/Three`
 * entry.
 *
 *   import * as Three from "@arcadekit/three/Three"
 *   import * as Transform from "@arcadekit/three/Transform"
 *
 *   // The rules: a rock is somewhere. They know nothing of how it looks.
 *   commands.spawn(Rock, Transform.Position.of({ x: 0, y: 4, z: 0 }))
 *
 *   // The page: every rock is one instance of one mesh.
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     geometry: new IcosahedronGeometry(1),
 *     material: new MeshStandardMaterial({ color: "#8a8f98" }),
 *   })
 *   const Look = Plugin.make("game/Look", {
 *     plugins: [Three.plugin],
 *     systems: [Rocks],
 *   })
 *
 *   Browser.runMain(
 *     App.run({ plugins: [Rules, Look] }, { hz: 60 }).pipe(
 *       Effect.provide(Three.layerWebGL({ canvas }))
 *     )
 *   )
 *
 * Everything here is a system of the frame stage: it runs between ticks,
 * with the world frozen, and reads it. A game that is drawn is the same
 * game as one that is not, and a server or a replay installs none of this.
 *
 * What is drawn is told from the components an entity has, and where from
 * `Transform.Position`, with `Transform.Rotation` and `Transform.Scale` for
 * the entities that have them:
 *
 * - `Three.instances` draws every entity of a kind as one instance of one
 *   mesh. It reads the columns raw and writes one matrix each into the
 *   mesh's buffer: no object is made per entity, and nothing is allocated
 *   per entity per frame.
 * - `Three.objects` keeps one Object3D per entity, made when the entity
 *   first matches and let go when it no longer does, and copies the
 *   entity's place into it each frame. For the few things that are more
 *   than a copy of a mesh.
 * - `Three.Render` then draws the scene, through `Three.Renderer`.
 */
import { entityIndex } from "arcadekit/ecs";
import type { ComponentDef, Entity, EntityColumn } from "arcadekit/ecs";
import * as Plugin from "arcadekit/Plugin";
import * as Query from "arcadekit/Query";
import * as System from "arcadekit/System";
import { Context, Effect, Layer } from "effect";
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  PerspectiveCamera,
  Scene as ThreeScene,
  WebGLRenderer,
} from "three";
import type {
  BufferGeometry,
  Camera,
  Material,
  Object3D,
  WebGLRendererParameters,
} from "three";

import * as Transform from "./Transform";

// --- the scene -------------------------------------------------------------------

/** What a system of this module has made of the game, and lets go with the app. */
interface Kept {
  readonly dispose: () => void;
}

export interface SceneShape {
  /** The scene everything is drawn into. Lights and the rest are added to it. */
  readonly scene: ThreeScene;
  /**
   * What the scene is seen through. A perspective camera at (0, 0, 10)
   * looking at the origin, until it is moved or replaced.
   */
  camera: Camera;
  /**
   * The meshes and objects the systems of this module keep, by the name of
   * the system that keeps them.
   * @internal
   */
  readonly _kept: Map<string, Kept>;
}

/**
 * An app's scene and its camera. `Three.plugin` provides it; a plugin that
 * depends on that one sets the scene up in its `layer`, and a system of the
 * frame stage moves the camera:
 *
 *   const Lights = Layer.effectDiscard(
 *     Effect.map(Three.Scene, ({ scene, camera }) => {
 *       scene.add(new AmbientLight("#ffffff", 1))
 *       camera.position.set(0, 20, 40)
 *       camera.lookAt(0, 0, 0)
 *     })
 *   )
 *
 * It is what draws the game, not the game: nothing in a tick reads it.
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
      return { scene: new ThreeScene(), camera, _kept: new Map() };
    }),
    // What the systems made goes with the app. Geometries and materials
    // are whoever made them's to dispose of.
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

export interface RendererShape {
  /** Draws the scene as the camera sees it. Called once per frame. */
  readonly render: (scene: ThreeScene, camera: Camera) => void;
}

/**
 * What draws the scene. It comes from outside the app, since it needs a
 * canvas: `Three.layerWebGL({ canvas })` in a page. A test provides one
 * that draws nothing and notes what it was asked.
 */
export class Renderer extends Context.Service<Renderer, RendererShape>()(
  "arcadekit/three/Renderer"
) {}

/**
 * As much of a Three.js renderer as is used. `WebGLRenderer` is one, and so
 * is `WebGPURenderer`.
 */
export interface RendererLike {
  /** The canvas. Its size on the page is what the picture is fitted to. */
  readonly domElement: {
    readonly clientWidth?: number;
    readonly clientHeight?: number;
  };
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: ThreeScene, camera: Camera): void;
  dispose(): void;
}

export interface FitOptions {
  /**
   * Whether the picture follows the size the canvas has on the page: when
   * that changes, the renderer is resized, without touching the canvas's
   * style, and a perspective camera is given the new aspect. On unless
   * told otherwise. A camera of another kind is the game's to fit.
   */
  readonly fit?: boolean;
  /**
   * How many pixels are drawn per CSS pixel. The page's own
   * (`devicePixelRatio`), up to 2, when left out.
   */
  readonly pixelRatio?: number;
}

const isPerspective = (camera: Camera): camera is PerspectiveCamera =>
  (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;

/**
 * A layer of a renderer of your own making, which is disposed of when the
 * scope it is provided to closes:
 *
 *   Three.layerRenderer(() => new WebGPURenderer({ canvas }))
 *
 * Provide it to the whole program, as `Browser.runMain` is given the page.
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
 * A page's renderer: a `WebGLRenderer` on the canvas it is given, with the
 * parameters Three.js takes, fitted to the canvas unless told otherwise.
 */
export const layerWebGL = (
  parameters: WebGLRendererParameters & FitOptions = {}
): Layer.Layer<Renderer> =>
  layerRenderer(() => new WebGLRenderer(parameters), parameters);

/**
 * Draws the scene, once per frame. It is the last thing this module does
 * in a frame: `Three.instances` and `Three.objects` run before it, and a
 * system of the game's that moves the camera says so too:
 *
 *   System.make("Follow", ...).pipe(
 *     System.inStage("frame"),
 *     System.before(Three.Render)
 *   )
 */
export const Render = System.make("arcadekit/three/Render", function* () {
  const { camera, scene } = yield* Scene;
  (yield* Renderer).render(scene, camera);
}).pipe(System.inStage("frame"));

/**
 * Gives an app a scene and draws it each frame. The plugin that says how
 * the game looks lists it in `plugins`, and its systems, made with
 * `Three.instances` and `Three.objects`, are drawn.
 *
 * The app then needs a `Three.Renderer` from outside:
 * `Effect.provide(Three.layerWebGL({ canvas }))`.
 */
export const plugin = Plugin.make("arcadekit/three", {
  plugins: [Transform.plugin],
  layer: sceneLayer,
  systems: [Render],
});

// --- which entities ----------------------------------------------------------------

/** The columns of a component of three numbers, as a loop reads them. */
interface Xyz {
  readonly x: { readonly [row: number]: number };
  readonly y: { readonly [row: number]: number };
  readonly z: { readonly [row: number]: number };
}
interface Xyzw extends Xyz {
  readonly w: { readonly [row: number]: number };
}

export interface Which {
  /**
   * The component that says an entity is one of these, or several, all of
   * which it has to have. It is drawn while it has them and a
   * `Transform.Position`.
   */
  readonly of: ComponentDef<any> | readonly ComponentDef<any>[];
  /** Components an entity must not have to be drawn: one that hides it, say. */
  readonly without?: readonly ComponentDef<any>[];
}

const required = (which: Which): readonly ComponentDef<any>[] =>
  "id" in which.of ? [which.of] : which.of;

// --- instances -------------------------------------------------------------------

export interface InstancesOptions extends Which {
  readonly geometry: BufferGeometry;
  readonly material: Material | Material[];
  /**
   * How many instances there is room for at first: 256 when left out. The
   * room doubles when it runs out, which is the one time the system
   * allocates.
   */
  readonly capacity?: number;
  /**
   * Called once with the mesh, when it is made: to have it cast a shadow,
   * or to put it on a layer. The mesh is not culled, since its instances
   * are anywhere; a game that knows where they are can say otherwise here.
   */
  readonly prepare?: (mesh: InstancedMesh) => void;
}

/** One instanced mesh, and the loops that fill its buffer from columns. */
class Instances implements Kept {
  readonly mesh: InstancedMesh;
  private readonly scene: ThreeScene;
  /** The instances' matrices, sixteen numbers each: the mesh's own buffer. */
  private array: Float32Array;
  private capacity: number;
  private count = 0;
  /** The part of the buffer that is sent to the renderer: reused every frame. */
  private readonly range = { start: 0, count: 0 };

  constructor(scene: ThreeScene, name: string, options: InstancesOptions) {
    this.scene = scene;
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 256));
    this.array = new Float32Array(this.capacity * 16);
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
  }

  /** Makes room for `rows` more instances, and says where the first goes. */
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
      // A buffer cannot grow where it is: the renderer lets go of the one
      // it made for the old attribute, and makes one for the new.
      this.mesh.dispose();
      this.array = array;
      this.capacity = capacity;
      this.attach();
    }
    this.count = needed;
    return at * 16;
  }

  begin(): void {
    this.count = 0;
  }

  /** Entities with a position alone: drawn upright, at the geometry's size. */
  readonly placed = (start: number, end: number, position: Xyz): void => {
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

  /** Entities with a position and a size. */
  readonly sized = (
    start: number,
    end: number,
    position: Xyz,
    scale: Xyz
  ): void => {
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

  /** Entities that are turned: a matrix of the position and the quaternion. */
  readonly turned = (
    start: number,
    end: number,
    position: Xyz,
    rotation: Xyzw
  ): void => {
    let at = this.reserve(end - start);
    const out = this.array;
    const { x, y, z } = position;
    const { x: qx, y: qy, z: qz, w: qw } = rotation;
    for (let i = start; i < end; i++) {
      const a = qx[i]!;
      const b = qy[i]!;
      const c = qz[i]!;
      const d = qw[i]!;
      const a2 = a + a;
      const b2 = b + b;
      const c2 = c + c;
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

  /** Entities with all three: what `Matrix4.compose` gives, written out. */
  readonly whole = (
    start: number,
    end: number,
    position: Xyz,
    rotation: Xyzw,
    scale: Xyz
  ): void => {
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
      const a2 = a + a;
      const b2 = b + b;
      const c2 = c + c;
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

  /** Tells the mesh how many instances it has, and the renderer what to send. */
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
    }
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

/**
 * Draws every entity of a kind as one instance of one mesh: a system of
 * the frame stage.
 *
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     geometry: new IcosahedronGeometry(1),
 *     material: new MeshStandardMaterial({ color: "#8a8f98" }),
 *   })
 *
 * An entity is drawn while it has what `of` says and a
 * `Transform.Position`, and is turned and sized by `Transform.Rotation`
 * and `Transform.Scale` if it has them.
 *
 * - Each frame it reads the columns raw (`eachChunk`) and writes one matrix
 *   per entity straight into the mesh's instance buffer. Nothing is made
 *   per entity: no object, no matrix, no vector. The buffer is allocated
 *   again only to double when it is full.
 * - The entities are drawn where the last tick left them.
 * - The mesh is made on the first frame, added to the scene, and removed
 *   and disposed of with the app. The geometry and the material are yours:
 *   to share between several, and to dispose of.
 * - It needs `Three.plugin`, and its name is one of the app's systems'.
 */
export const instances = (name: string, options: InstancesOptions) => {
  const marked = required(options);
  const excluded = options.without ?? [];
  // An entity's table has a rotation or it does not, and a scale or not:
  // four queries, each handed exactly the columns its entities have.
  const Placed = Query.all(Transform.Position).pipe(
    Query.with(...marked),
    Query.without(...excluded, Transform.Rotation, Transform.Scale),
    Query.reads()
  );
  const Sized = Query.all(Transform.Position, Transform.Scale).pipe(
    Query.with(...marked),
    Query.without(...excluded, Transform.Rotation),
    Query.reads()
  );
  const Turned = Query.all(Transform.Position, Transform.Rotation).pipe(
    Query.with(...marked),
    Query.without(...excluded, Transform.Scale),
    Query.reads()
  );
  const Whole = Query.all(
    Transform.Position,
    Transform.Rotation,
    Transform.Scale
  ).pipe(Query.with(...marked), Query.without(...excluded), Query.reads());
  return System.make(name, function* () {
    const kept = yield* Scene;
    const placed = yield* Placed;
    const sized = yield* Sized;
    const turned = yield* Turned;
    const whole = yield* Whole;
    let drawn = kept._kept.get(name) as Instances | undefined;
    if (drawn === undefined) {
      drawn = new Instances(kept.scene, name, options);
      kept._kept.set(name, drawn);
    }
    // Plain loops from here on: one pass over the columns of each kind.
    drawn.begin();
    placed.eachChunk(drawn.placed);
    sized.eachChunk(drawn.sized);
    turned.eachChunk(drawn.turned);
    whole.eachChunk(drawn.whole);
    drawn.finish();
  }).pipe(System.inStage("frame"), System.before(Render));
};

// --- objects ---------------------------------------------------------------------

export interface ObjectsOptions<O extends Object3D = Object3D> extends Which {
  /**
   * Makes the object of an entity, the first frame the entity is one of
   * these. It is added to the scene, and given the entity's place.
   */
  readonly make: (entity: Entity) => O;
  /**
   * Called when the entity is no longer one of these, or the app's scope
   * closes, after the object was taken out of the scene: to dispose of
   * what `make` made for this one object.
   */
  readonly free?: (object: O, entity: Entity) => void;
}

/** One object per entity, by the entity's index, and the loops that place them. */
class Objects<O extends Object3D> implements Kept {
  private readonly scene: ThreeScene;
  private readonly options: ObjectsOptions<O>;
  private readonly objects: (O | undefined)[] = [];
  /** Per entity index: the entity the object there was made for. */
  private owner = new Uint32Array(0);
  /** Per entity index: the frame its entity was last found in, turned, and sized. */
  private seen = new Uint32Array(0);
  private turnedAt = new Uint32Array(0);
  private sizedAt = new Uint32Array(0);
  /** The entity indexes that have an object, in no order. */
  private readonly live: number[] = [];
  private stamp = 0;

  constructor(scene: ThreeScene, options: ObjectsOptions<O>) {
    this.scene = scene;
    this.options = options;
  }

  private grow(size: number): void {
    let length = Math.max(64, this.seen.length);
    while (length < size) {
      length *= 2;
    }
    for (const name of ["owner", "seen", "turnedAt", "sizedAt"] as const) {
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

  /** Makes the object of an entity that has none, or whose slot held another's. */
  private adopt(index: number, entity: Entity): O {
    if (this.objects[index] === undefined) {
      this.live.push(index);
    } else {
      this.release(index);
    }
    const object = this.options.make(entity);
    this.objects[index] = object;
    this.owner[index] = entity;
    this.turnedAt[index] = 0;
    this.sizedAt[index] = 0;
    this.scene.add(object);
    return object;
  }

  begin(): void {
    this.stamp++;
  }

  readonly placed = (
    start: number,
    end: number,
    position: Xyz,
    entities: EntityColumn
  ): void => {
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

  readonly turned = (
    start: number,
    end: number,
    rotation: Xyzw,
    entities: EntityColumn
  ): void => {
    const { x, y, z, w } = rotation;
    const { objects, stamp, turnedAt } = this;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      objects[index]!.quaternion.set(x[i]!, y[i]!, z[i]!, w[i]!);
      turnedAt[index] = stamp;
    }
  };

  readonly sized = (
    start: number,
    end: number,
    scale: Xyz,
    entities: EntityColumn
  ): void => {
    const { x, y, z } = scale;
    const { objects, sizedAt, stamp } = this;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      objects[index]!.scale.set(x[i]!, y[i]!, z[i]!);
      sizedAt[index] = stamp;
    }
  };

  /** Lets go of the objects whose entities were not found this frame. */
  finish(): void {
    const { live, objects, seen, sizedAt, stamp, turnedAt } = this;
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
        objects[index]!.quaternion.identity();
        turnedAt[index] = 0;
      }
      if (sizedAt[index] !== stamp && sizedAt[index] !== 0) {
        objects[index]!.scale.set(1, 1, 1);
        sizedAt[index] = 0;
      }
    }
  }

  dispose(): void {
    for (const index of this.live) {
      this.release(index);
    }
    this.live.length = 0;
  }
}

/**
 * Keeps one Object3D per entity of a kind, where the entity is: a system
 * of the frame stage.
 *
 *   const Ships = Three.objects("game/Ships", {
 *     of: Ship,
 *     make: () => new Mesh(hull, paint),
 *   })
 *
 * For the few things that are more than a copy of one mesh: a model with
 * parts, a light, something that carries the camera. A crowd is
 * `Three.instances`.
 *
 * - `make` is called the first frame an entity has what `of` says and a
 *   `Transform.Position`, and its object is added to the scene. The frame
 *   the entity no longer does, or is gone, the object is taken out, and
 *   `free` is called with it.
 * - Each frame every object is given its entity's `Position`, and its
 *   `Rotation` and `Scale` if the entity has them. What else there is to
 *   an object is the game's to set, in `make` or in a system of its own.
 * - Nothing is kept in the world. A game that is loaded from a save, or an
 *   app that starts with entities, has its objects made on the first
 *   frame.
 * - It needs `Three.plugin`, and its name is one of the app's systems'.
 */
export const objects = <O extends Object3D = Object3D>(
  name: string,
  options: ObjectsOptions<O>
) => {
  const marked = required(options);
  const excluded = options.without ?? [];
  const Placed = Query.all(Transform.Position).pipe(
    Query.with(...marked),
    Query.without(...excluded),
    Query.reads()
  );
  const Turned = Query.all(Transform.Rotation).pipe(
    Query.with(Transform.Position, ...marked),
    Query.without(...excluded),
    Query.reads()
  );
  const Sized = Query.all(Transform.Scale).pipe(
    Query.with(Transform.Position, ...marked),
    Query.without(...excluded),
    Query.reads()
  );
  return System.make(name, function* () {
    const kept = yield* Scene;
    const placed = yield* Placed;
    const turned = yield* Turned;
    const sized = yield* Sized;
    let held = kept._kept.get(name) as Objects<O> | undefined;
    if (held === undefined) {
      held = new Objects(kept.scene, options);
      kept._kept.set(name, held);
    }
    // Every entity that is one of these is found by the first loop, which
    // makes the objects that are missing; whatever it did not find is let
    // go at the end.
    held.begin();
    placed.eachChunk(held.placed);
    turned.eachChunk(held.turned);
    sized.eachChunk(held.sized);
    held.finish();
  }).pipe(System.inStage("frame"), System.before(Render));
};
