/**
 * Draws a game with Three.js. This is the package's `@arcadekit/three/Three`
 * entry.
 *
 *   import * as Transform3d from "arcadekit/Transform3d"
 *   import * as Three from "@arcadekit/three/Three"
 *
 *   // The rules: a rock is somewhere. They know nothing of how it looks.
 *   commands.spawn(Rock, Transform3d.Position.of({ x: 0, y: 4, z: 0 }))
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
 * arcadekit's own `Transform3d.Position`, with `Transform3d.Rotation` and
 * `Transform3d.Scale` for the entities that have them. A flat game's
 * `Transform2d` is drawn the same way, in the plane of x and y:
 *
 * - `Three.instances` draws every entity of a kind as one instance of one
 *   mesh. It reads the columns raw and writes one matrix each into the
 *   mesh's buffer: no object is made per entity, and nothing is allocated
 *   per entity per frame.
 * - `Three.objects` keeps one Object3D per entity, made when the entity
 *   first matches and let go when it no longer does, and copies the
 *   entity's place into it each frame. For the few things that are more
 *   than a copy of a mesh.
 * - Either takes a look that is there from the start, or one made of a
 *   bundle's assets (`from`), which is there while the bundle is loaded.
 *   `Three.texture` is the asset that is a texture.
 * - `Three.Render` then draws the scene, through `Three.Renderer`.
 */
import * as Assets from "arcadekit/Assets";
import { entityIndex } from "arcadekit/ecs";
import type {
  ComponentDef,
  Entity,
  EntityColumn,
  FieldDef,
} from "arcadekit/ecs";
import * as Plugin from "arcadekit/Plugin";
import * as Query from "arcadekit/Query";
import { Frame, Time } from "arcadekit/Services";
import type { World } from "arcadekit/Services";
import * as System from "arcadekit/System";
import * as Transform2d from "arcadekit/Transform2d";
import * as Transform3d from "arcadekit/Transform3d";
import { Context, Effect, Layer } from "effect";
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene as ThreeScene,
  Texture,
  WebGLRenderer,
} from "three";
import type {
  BufferGeometry,
  Camera,
  Material,
  Object3D,
  WebGLRendererParameters,
} from "three";

// --- the scene -------------------------------------------------------------------

/** What a system of this module has made of the game, and lets go with the app. */
interface Kept {
  readonly dispose: () => void;
  /**
   * Asked just before the scene is drawn, of what is made of assets: are
   * they still there? What is not is taken out of the scene now, so that
   * nothing is drawn with what was let go since its system ran.
   */
  readonly settle?: () => void;
}

/**
 * The scene and its camera, as a system gets them from `yield* Three.Scene`.
 *
 * @category Services
 */
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
 * It is what draws the game, not the game: nothing in a tick reads it, and
 * none of it is saved.
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

/**
 * What draws: a renderer of Three.js, or a test's that notes what it was
 * asked to draw.
 *
 * @category Services
 */
export interface RendererShape {
  /** Draws the scene as the camera sees it. Called once per frame. */
  readonly render: (scene: ThreeScene, camera: Camera) => void;
}

/**
 * What draws the scene. It comes from outside the app, since it needs a
 * canvas: `Three.layerWebGL({ canvas })` in a page. A game that installs
 * `Three.plugin` and provides none does not compile. A test provides one
 * that draws nothing, or notes what it was asked, and looks at what was
 * put in the scene, which Three.js makes under Node as in a page:
 *
 *   Layer.succeed(Three.Renderer, { render(scene, camera) {} })
 *
 * @category Services
 */
export class Renderer extends Context.Service<Renderer, RendererShape>()(
  "arcadekit/three/Renderer"
) {}

/**
 * As much of a Three.js renderer as is used. `WebGLRenderer` is one, and so
 * is `WebGPURenderer`.
 *
 * @category Models
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

/**
 * How a page's renderer follows its canvas.
 *
 * @category Options
 */
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
 * A page's renderer: a `WebGLRenderer` on the canvas it is given, with the
 * parameters Three.js takes, fitted to the canvas unless told otherwise.
 *
 * @category Layers
 */
export const layerWebGL = (
  parameters: WebGLRendererParameters & FitOptions = {}
): Layer.Layer<Renderer> =>
  layerRenderer(() => new WebGLRenderer(parameters), parameters);

/**
 * Draws the scene, once per frame. It is a system of the stage after a
 * frame's own, `"postFrame"`, so it runs after every system of the frame
 * stage, wherever each is listed and with nothing said: `Three.instances`
 * and `Three.objects`, and a system of the game's that moves the camera.
 *
 *   System.make("Follow", ...).pipe(System.inStage("frame"))
 *
 * Just before it draws, it asks of every kind that is made of a bundle's
 * assets whether they are still there, and takes out of the scene what is
 * not: nothing is drawn with assets that were let go, whichever of the
 * system that lets a bundle go and the one that draws with it runs first.
 *
 * @category Systems
 */
export const Render = System.make("arcadekit/three/Render", function* () {
  const { _kept, camera, scene } = yield* Scene;
  for (const one of _kept.values()) {
    one.settle?.();
  }
  (yield* Renderer).render(scene, camera);
}).pipe(System.inStage("postFrame"));

/**
 * Gives an app a scene and draws it each frame. The plugin that says how
 * the game looks lists it in `plugins`, and its systems, made with
 * `Three.instances` and `Three.objects`, are drawn.
 *
 * The app then needs a `Three.Renderer` from outside:
 * `Effect.provide(Three.layerWebGL({ canvas }))`.
 *
 * It depends on `Transform3d.plugin` and on `Transform2d.plugin`, which
 * list the components that say where a thing is. This package has none of
 * its own.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/three", {
  plugins: [Transform3d.plugin, Transform2d.plugin],
  layer: sceneLayer,
  systems: [Render],
});

// --- which entities ----------------------------------------------------------------

/** A column of numbers, as a loop reads it. */
interface Numbers {
  readonly [row: number]: number;
}
/** The columns of a component of three numbers, as a loop reads them. */
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
}
interface Xyzw extends Xyz {
  readonly w: { readonly [row: number]: number };
}
/** The columns of a flat game's position, or of its scale. */
interface Xy {
  readonly x: { readonly [row: number]: number };
  readonly y: { readonly [row: number]: number };
}
interface Angle {
  readonly angle: { readonly [row: number]: number };
}

/**
 * Which entities a drawing system draws.
 *
 * @category Models
 */
export interface Which {
  /**
   * The component that says an entity is one of these, or several, all of
   * which it has to have. It is drawn while it has them and a
   * `Transform3d.Position`, or a `Transform2d.Position`.
   */
  readonly of: ComponentDef<any> | readonly ComponentDef<any>[];
  /** Components an entity must not have to be drawn: one that hides it, say. */
  readonly without?: readonly ComponentDef<any>[];
  /**
   * Draws each entity between its last two places, and not where the last
   * tick left it: at `Frame.alpha` of the way from where it was a tick ago
   * to where it is. A game whose ticks and frames do not line up then
   * moves evenly, up to a tick behind. Off unless told: `Three.instances`
   * says what is drawn on the way.
   */
  readonly smooth?: boolean;
  /**
   * With `smooth`, how far an entity may go in one tick and still be drawn
   * on the way. One that went further, off one edge and in at the other,
   * say, is drawn where it is. Any distance, when left out. It is one
   * distance per kind, in the units of the scene.
   */
  readonly snap?: number;
}

const required = (which: Which): readonly ComponentDef<any>[] =>
  "id" in which.of ? [which.of] : which.of;

// --- between two ticks -------------------------------------------------------------
// What a system keeps to draw its entities between their last two places:
// for each component it reads, the value an entity had a tick ago and the
// value it has, by the entity's index. It is the renderer's own, never the
// world's: a game that is drawn smoothly is the same game.

/** What the stores of one system agree on, for the frame that is being drawn. */
interface Clock {
  /**
   * The app's frame, counted from 2: 0 in a store means never seen. It is
   * the app's count and not the system's own, so that an entity is known
   * to have been drawn in the frame before, and not merely the last time
   * the system ran.
   */
  stamp: number;
  /** Whether a tick ran since the frame before: what was current is now a tick old. */
  shift: boolean;
  /** How far the frame is between the last two ticks. */
  alpha: number;
}

/** The two values of one component, per entity, and the columns they are blended into. */
abstract class Blend {
  protected readonly clock: Clock;
  private readonly width: number;
  /** Per entity index: the entity whose values these are, by its id. */
  protected owner = new Float64Array(0);
  /** Per entity index: the frame its entity was last drawn in. */
  protected seen = new Uint32Array(0);
  protected prev = new Float32Array(0);
  protected cur = new Float32Array(0);
  /** How many rows the blended columns have room for. */
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

  /** Makes the blended columns anew, with this many rows. */
  protected abstract widen(rows: number): void;
}

/** A place or a size in three dimensions: each number goes straight from one to the other. */
class Lerp3 extends Blend {
  private readonly out = {
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
  };
  /** The square of how far is too far to have gone in a tick. */
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

  /** As `blend`, of three columns whatever they are called: a colour's, for one. */
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

/** A flat game's place or size. */
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
 * A turn in three dimensions: from one quaternion towards the other by the
 * shorter way. What comes out is not of length 1, and need not be.
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

/** A flat game's turn: from one angle to the other by the shorter way round. */
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

/** Everything one system keeps to draw its entities between two ticks. */
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

  /** A frame begins: which it is, which tick the game is at, and how far towards the next. */
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

/** The assets of a bundle, whatever they are. */
// `any`: an asset is of whatever its `decode` makes.
type Entries = Readonly<Record<string, Assets.Asset<any>>>;

/**
 * What a system makes of a bundle's assets: there while the app holds the
 * bundle loaded, let go when it does not, and made again of what is loaded
 * next.
 */
class FromAssets<T extends Kept> implements Kept {
  private assets: unknown;
  private made: T | undefined;

  constructor(
    private readonly store: Assets.StoreShape,
    private readonly bundle: Assets.Bundle<Entries>,
    private readonly make: (assets: any) => T
  ) {}

  /** The assets the app holds now, if it holds them. */
  private held(): unknown {
    const status = this.store.status(this.bundle);
    return status._tag === "Ready" ? status.assets : undefined;
  }

  /** What is made of the assets the app holds now, if it holds them. */
  now(): T | undefined {
    // Loaded again is loaded anew: other pictures, though of the same files.
    const assets = this.held();
    if (assets !== this.assets) {
      this.dispose();
      this.assets = assets;
      if (assets !== undefined) {
        this.made = this.make(assets);
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
 * What `Three.texture` is told of a picture.
 *
 * @category Options
 */
export interface TextureOptions {
  /**
   * Called once with the texture, before it is ever sent to the renderer:
   * to say it is not colours, or how it repeats and is filtered.
   */
  readonly prepare?: (texture: Texture) => void;
  /**
   * Whether the picture is turned over as it is decoded, so that its
   * first row is at the top of a geometry of Three.js: `true` when left
   * out, as a `TextureLoader` gives it. `false` leaves it as the file has
   * it, which is what a model's own coordinates expect.
   */
  readonly flipY?: boolean;
}

/**
 * An asset that is a picture to draw with: a `Texture` of Three.js, in a
 * bundle with the rest of a level's, and disposed of, with the picture it
 * was made of, when the scope it was loaded in closes.
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
 * - It is a picture of colours, sRGB, unless `prepare`, which is handed
 *   the texture once, says otherwise.
 * - It is the right way up for the geometries of Three.js, unless
 *   `flipY: false` says to leave it as the file has it. That is said
 *   here and not in `prepare`: a bitmap is turned over when it is
 *   decoded, and Three.js does not read `flipY` of one after. Setting it
 *   in `prepare` would do nothing, so it fails the load with an error
 *   that says so.
 * - It is decoded off the page's thread, by `createImageBitmap`, which a
 *   page has and Node does not.
 * - A file that is no picture fails the bundle with `Assets.AssetFailed`,
 *   which names the URL.
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
          if (made.flipY !== flipY) {
            bitmap.close();
            throw new Error(
              `flipY was set to ${made.flipY} in prepare, which does nothing: a texture made of a bitmap is turned over when it is decoded, and Three.js does not read flipY of it after. Say which way up it is where it is made: Three.texture("${url}", { flipY: ${made.flipY} }).`
            );
          }
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
 * How finely a colour is converted: the table has one more entry than
 * this. Sixteen steps to each of a byte's 255, so that a byte is at a step
 * exactly, and a float is within a thirty-second of a byte of one.
 */
const STEPS = 4080;

/**
 * What a number of an sRGB colour is in linear colour, which is what a
 * renderer works in: the curve of the standard, at each of the table's
 * steps from 0 to 1. A raised power per number per instance per frame
 * would cost more than the rest of the instance does.
 */
const LINEAR = /* @__PURE__ */ (() => {
  const table = new Float32Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) {
    const c = i / STEPS;
    table[i] = c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/** Whether a field holds whole numbers: a colour's are then bytes. */
const isWhole = (kind: string): boolean =>
  kind === "u8" || kind === "u16" || kind === "u32" || kind === "i32";

/**
 * A component of the game's that is a colour: three numbers, `r`, `g` and
 * `b`, kept in a table. What else it has is not read.
 *
 * @category Models
 */
export type ColorComponent = ComponentDef<any, "table"> & {
  readonly schema: {
    readonly r: FieldDef<number, any>;
    readonly g: FieldDef<number, any>;
    readonly b: FieldDef<number, any>;
  };
};

/**
 * How an instance looks: the one geometry and the one material of its mesh.
 *
 * @category Models
 */
export interface Look {
  readonly geometry: BufferGeometry;
  readonly material: Material | Material[];
}

/**
 * What `Three.instances` is told, however its look is come by.
 *
 * @category Models
 */
export interface InstancesShared extends Which {
  /**
   * A component of the game's that gives each instance a colour of its
   * own: its `r`, `g` and `b`, from 0 to 1, by which the material's own
   * colour is multiplied. An entity is then one of these only while it has
   * that component too.
   *
   *   const Paint = Component.define("game/Paint", { r: Field.f32, g: Field.f32, b: Field.f32 })
   *   Three.instances("game/Rocks", { of: Rock, geometry, material, color: Paint })
   *
   * The numbers are a colour as a hex code or a style sheet writes it,
   * unless `colorSpace` says otherwise: `#ff6188` is an `r` of
   * `0xff / 255`, a `g` of `0x61 / 255` and a `b` of `0x88 / 255`. Fields
   * of floats hold 0 to 1; fields of whole numbers (`Field.u8`) hold the
   * bytes themselves, 0 to 255. The three are all one or all the other,
   * and a component that is no colour, one that is sparse or lacks a
   * field, throws when the system is made.
   *
   * With `smooth` a colour changes evenly between two ticks, as a place
   * does, however far it goes: `snap` does not apply to it. It changes in
   * the numbers the game has, and is converted then.
   */
  readonly color?: ColorComponent;
  /**
   * The colour space the numbers of `color` are in, by the names Three.js
   * gives them.
   *
   * - `"srgb"`, when left out: what a hex code holds, and what a colour
   *   picker shows. Each number is converted for the renderer, which
   *   works in linear colour, through a table: a byte exactly, and a
   *   float to a sixteenth of a byte, finer than a screen shows. A number that is not from
   *   0 to 1, or from 0 to 255 in a field of whole numbers, is no colour,
   *   and fails the frame with an error that names the entity.
   * - `"srgb-linear"`: the renderer's own working space, what
   *   `new Color("#ff6188")` of Three.js has as its `r`, `g` and `b`. The
   *   numbers are handed over as they are and nothing is checked: a
   *   number over 1 is brighter than white, which a renderer that blooms
   *   can show.
   */
  readonly colorSpace?: "srgb" | "srgb-linear";
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

/**
 * Instances whose look is there when the system is made.
 *
 * @category Options
 */
export interface InstancesOptions extends InstancesShared, Look {}

/**
 * Instances whose look is made of assets that are loaded later, and let go
 * again: a level's.
 *
 * @category Options
 */
export interface InstancesFromOptions<
  B extends Entries,
  L extends Look = Look,
> extends InstancesShared {
  /** The bundle the look is made of. The instances are drawn while it is loaded. */
  readonly from: Assets.Bundle<B>;
  /**
   * Makes the look of the bundle's assets, once each time they are
   * loaded. What it returns beyond a geometry and a material is kept for
   * `free`.
   */
  readonly look: (assets: Assets.Loaded<B>) => L;
  /**
   * Called when the assets are let go, or the app's scope closes, after
   * the mesh was taken out of the scene: to dispose of what `look` made.
   * The assets themselves are the bundle's to let go.
   */
  readonly free?: (look: L) => void;
}

/** The eight loops of a kind: placed, sized, turned or all three, in space or in the plane. */
type Loop =
  | "placed"
  | "sized"
  | "turned"
  | "whole"
  | "placedFlat"
  | "sizedFlat"
  | "turnedFlat"
  | "wholeFlat";

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
  /** What draws the entities between two ticks, when the system was asked to. */
  private readonly smooth: Smooth | undefined;
  /** The instances' colours, three numbers each, for a kind that has them. */
  private colors: Float32Array | undefined;
  private readonly colorRange = { start: 0, count: 0 };
  /** Whether a colour's numbers are converted from sRGB, or handed over. */
  private readonly curved: boolean;
  /** What a colour's number is multiplied by: for one that is from 0 to 1. */
  private readonly gain: number;
  private readonly name: string;
  /**
   * The eight loops as the system gives them to its queries: as they are,
   * or, for a kind with a colour, each followed by the colours of its rows.
   */
  readonly loops: Record<Loop, (...columns: any[]) => void>;

  constructor(scene: ThreeScene, name: string, options: InstancesOptions) {
    this.scene = scene;
    this.name = name;
    this.smooth = smoothOf(options);
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 256));
    this.array = new Float32Array(this.capacity * 16);
    this.curved = options.colorSpace !== "srgb-linear";
    this.gain =
      options.color !== undefined && isWhole(options.color.schema.r.kind)
        ? 1 / 255
        : 1;
    if (options.color === undefined) {
      this.loops = {
        placed: this.placed,
        sized: this.sized,
        turned: this.turned,
        whole: this.whole,
        placedFlat: this.placedFlat,
        sizedFlat: this.sizedFlat,
        turnedFlat: this.turnedFlat,
        wholeFlat: this.wholeFlat,
      };
    } else {
      this.colors = new Float32Array(this.capacity * 3);
      this.loops = {
        placed: this.painted1(this.placed),
        sized: this.painted2(this.sized),
        turned: this.painted2(this.turned),
        whole: this.painted3(this.whole),
        placedFlat: this.painted1(this.placedFlat),
        sizedFlat: this.painted2(this.sizedFlat),
        turnedFlat: this.painted2(this.turnedFlat),
        wholeFlat: this.painted3(this.wholeFlat),
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
    let { r, g, b } = color;
    if (this.smooth !== undefined) {
      ({
        x: r,
        y: g,
        z: b,
      } = this.smooth.color.run(start, end, r, g, b, entities));
    }
    let at = from * 3;
    const { gain } = this;
    if (!this.curved) {
      // The renderer's own numbers: as they are, or bytes over 255.
      for (let i = start; i < end; i++) {
        out[at] = r[i]! * gain;
        out[at + 1] = g[i]! * gain;
        out[at + 2] = b[i]! * gain;
        at += 3;
      }
      return;
    }
    // A hex code's numbers, each looked up in the table at the nearest of
    // its steps. One that is off either end of it is no colour.
    const scale = gain * STEPS;
    for (let i = start; i < end; i++) {
      const u = (r[i]! * scale + 0.5) | 0;
      const v = (g[i]! * scale + 0.5) | 0;
      const w = (b[i]! * scale + 0.5) | 0;
      // Under zero or past the table's end, either of which leaves one of
      // the six below zero: one test for the three numbers.
      if ((u | v | w | (STEPS - u) | (STEPS - v) | (STEPS - w)) < 0) {
        this.refuse(entities[i]!, r[i]!, g[i]!, b[i]!);
      }
      out[at] = LINEAR[u]!;
      out[at + 1] = LINEAR[v]!;
      out[at + 2] = LINEAR[w]!;
      at += 3;
    }
  }

  private refuse(entity: Entity, r: number, g: number, b: number): never {
    const most = this.gain === 1 ? 1 : 255;
    throw new Error(
      `Three.instances("${this.name}") was given the colour (${r}, ${g}, ${b}) by entity ${entity}, which is no colour: each of its numbers is from 0 to ${most}${
        most === 1
          ? ", as a hex code's bytes over 255 are. For the bytes themselves, give the component fields of whole numbers, Field.u8"
          : ""
      }. A colour that is brighter than white is one of the renderer's own, which colorSpace: "srgb-linear" hands over as it is.`
    );
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

  /** Entities with a position alone: drawn upright, at the geometry's size. */
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

  /** Entities with a position and a size. */
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

  /** Entities that are turned: a matrix of the position and the quaternion. */
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

  /** Entities with all three: what `Matrix4.compose` gives, written out. */
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

  // A flat game's entities: in the plane of x and y, turned about the axis
  // that comes out of it. The same four loops, with fewer columns.

  /** Flat entities with a position alone. */
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

  /** Flat entities with a position and a size. */
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

  /** Flat entities that are turned: a sine and a cosine each. */
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

  /** Flat entities with all three. */
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
      const colors = mesh.instanceColor;
      if (colors !== null) {
        this.colorRange.count = count * 3;
        colors.updateRanges.length = 0;
        colors.updateRanges.push(this.colorRange);
        colors.needsUpdate = true;
      }
    }
  }

  /** How many instances there is room for now. */
  get room(): number {
    return this.capacity;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

/** The instances of a look made of assets, while those assets are loaded. */
interface Sourced extends Kept {
  readonly instances: Instances;
}

/** What a system of this module asks of an app, and what one that draws from a bundle asks besides. */
type Needs = Frame | Scene | Time | World;

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
 * `Transform3d.Position`, and is turned and sized by `Transform3d.Rotation`
 * and `Transform3d.Scale` if it has them. One that has a
 * `Transform2d.Position` instead is drawn in the plane of x and y, at 0 of
 * the third axis, turned and sized by its `Transform2d.Rotation` and
 * `Transform2d.Scale`. An entity with both positions is drawn once, from
 * the one of three dimensions.
 *
 * - Each frame it reads the columns raw (`eachChunk`) and writes one matrix
 *   per entity straight into the mesh's instance buffer. Nothing is made
 *   per entity: no object, no matrix, no vector. The buffer is allocated
 *   again only to double when it is full.
 * - A `Rotation` is drawn as the turn it stands for, whatever its length:
 *   it neither skews nor sizes the instance. One whose four fields are 0,
 *   which is what one added with no value is, is no turn at all.
 * - The entities are drawn where the last tick left them, unless `smooth`
 *   says otherwise.
 * - The mesh is made on the first frame, named after the system, added to
 *   the scene, and removed and disposed of with the app. The geometry and
 *   the material are yours: to share between several, and to dispose of.
 * - It needs `Three.plugin`, and its name is one of the app's systems'.
 *
 * With `smooth: true` each entity is drawn between its last two places,
 * at `Frame.alpha` of the way from where it was a tick ago to where it is:
 *
 * - The picture is then up to one tick behind the game: just after a
 *   tick, at an `alpha` of 0, an entity is drawn where it was before the
 *   tick. A game that ticks when it is needed is told an `alpha` of 1
 *   while it rests, and is drawn where it is.
 * - Places, sizes and colours go straight from one to the other. A turn
 *   goes by the shorter way.
 * - An entity that was not drawn in the frame before is drawn where it
 *   is: one that is new, one in a slot that was another's, one that was
 *   hidden, and every entity in the first frame, after a load, or after a
 *   frame the system did not run in. So is one that went further in a
 *   tick than `snap`.
 * - When several ticks ran since the last frame, an entity comes from
 *   where it was last drawn from; when none ran, it is between the same
 *   two places as the frame before. A place changed with no tick is where
 *   the entity goes to from where it was coming from.
 * - What is kept for it, the value each component had a tick ago, is no
 *   part of the world: the game's hash, log and save are the same.
 *
 * A look that is made of assets, a level's texture, say, is given as the
 * bundle it comes `from` and what makes it of them:
 *
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     from: Forest,
 *     look: ({ bark }) => ({
 *       geometry: new IcosahedronGeometry(1),
 *       material: new MeshStandardMaterial({ map: bark }),
 *     }),
 *     free: ({ geometry, material }) => {
 *       geometry.dispose()
 *       material.dispose()
 *     },
 *   })
 *
 * - The entities are drawn while the app holds the bundle loaded, which
 *   `Assets.during` or the game's own system sees to, and not before or
 *   after: no mesh is in the scene then.
 * - `look` is called once each time the bundle is loaded, and `free` with
 *   what it returned when the bundle is let go or the app's scope closes.
 *   A mesh made of a bundle that is loaded again starts with the room the
 *   last one had grown to.
 * - It needs `Assets.plugin` as well, which the type of the system says.
 *
 * @category Systems
 */
export const instances: {
  <B extends Entries, L extends Look = Look>(
    name: string,
    options: InstancesFromOptions<B, L>
  ): System.System<never, Needs | Assets.Store>;
  (name: string, options: InstancesOptions): System.System<never, Needs>;
} = (
  name: string,
  options: InstancesOptions | InstancesFromOptions<Entries>
  // `any`: the system of a look that is there asks for no store of assets,
  // which the two signatures above say and one body cannot.
): System.System<never, any> => {
  const from = "from" in options ? options : undefined;
  const smooth = options.smooth === true;
  const marked = required(options);
  const excluded = options.without ?? [];
  const { color } = options;
  if (
    color !== undefined &&
    (color.storage !== "table" ||
      !["r", "g", "b"].every((field) => color.fields.includes(field)))
  ) {
    throw new Error(
      `Three.instances("${name}") was given "${color.name}" as its colour, which is not one: a colour is a component kept in a table with the fields r, g and b.`
    );
  }
  if (color !== undefined) {
    const kinds = [color.schema.r, color.schema.g, color.schema.b].map(
      (field) => field.kind
    );
    const numbers = ["f32", "f64", "u8", "u16", "u32", "i32"];
    if (
      !kinds.every((kind) => numbers.includes(kind)) ||
      new Set(kinds.map(isWhole)).size > 1
    ) {
      throw new Error(
        `Three.instances("${name}") was given "${color.name}" as its colour, whose r, g and b are fields of ${kinds.join(", ")}: the three are all floats, from 0 to 1, or all whole numbers, the bytes from 0 to 255.`
      );
    }
  }
  // `any`: the terms of a query are a tuple in its type, and a kind with a
  // colour has one more than one without, after the ones its loop reads.
  const kind = (
    own: readonly ComponentDef<any>[],
    absent: readonly ComponentDef<any>[]
  ): Query.Query<any> =>
    Query.all(...own, ...(color === undefined ? [] : [color])).pipe(
      Query.with(...marked),
      Query.without(...excluded, ...absent),
      Query.reads()
    );
  // An entity's table has a rotation or it does not, and a scale or not:
  // four queries, each handed exactly the columns its entities have.
  const Placed = kind(
    [Transform3d.Position],
    [Transform3d.Rotation, Transform3d.Scale]
  );
  const Sized = kind(
    [Transform3d.Position, Transform3d.Scale],
    [Transform3d.Rotation]
  );
  const Turned = kind(
    [Transform3d.Position, Transform3d.Rotation],
    [Transform3d.Scale]
  );
  const Whole = kind(
    [Transform3d.Position, Transform3d.Rotation, Transform3d.Scale],
    []
  );
  // And the same four for a flat game's components, but for the entities
  // that are placed in three dimensions as well, which are drawn above.
  const PlacedFlat = kind(
    [Transform2d.Position],
    [Transform3d.Position, Transform2d.Rotation, Transform2d.Scale]
  );
  const SizedFlat = kind(
    [Transform2d.Position, Transform2d.Scale],
    [Transform3d.Position, Transform2d.Rotation]
  );
  const TurnedFlat = kind(
    [Transform2d.Position, Transform2d.Rotation],
    [Transform3d.Position, Transform2d.Scale]
  );
  const WholeFlat = kind(
    [Transform2d.Position, Transform2d.Rotation, Transform2d.Scale],
    [Transform3d.Position]
  );
  return System.make(name, function* () {
    const kept = yield* Scene;
    const placed = yield* Placed;
    const sized = yield* Sized;
    const turned = yield* Turned;
    const whole = yield* Whole;
    const placedFlat = yield* PlacedFlat;
    const sizedFlat = yield* SizedFlat;
    const turnedFlat = yield* TurnedFlat;
    const wholeFlat = yield* WholeFlat;
    // Which tick the game is at and how far towards the next the frame is:
    // asked only by a system that draws between the two.
    const tick = smooth ? (yield* Time).tick : 0;
    const frame = smooth ? yield* Frame : undefined;
    let drawn: Instances | undefined;
    if (from === undefined) {
      drawn = kept._kept.get(name) as Instances | undefined;
      if (drawn === undefined) {
        drawn = new Instances(kept.scene, name, options as InstancesOptions);
        kept._kept.set(name, drawn);
      }
    } else {
      let sourced = kept._kept.get(name) as FromAssets<Sourced> | undefined;
      if (sourced === undefined) {
        // The room the instances came to need is kept from one loading of
        // the bundle to the next.
        let room = from.capacity ?? 256;
        const { scene } = kept;
        sourced = new FromAssets(
          yield* Assets.Store,
          from.from,
          (assets): Sourced => {
            const look = from.look(assets);
            const made = new Instances(scene, name, {
              ...from,
              geometry: look.geometry,
              material: look.material,
              capacity: room,
            });
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
    const { loops } = drawn;
    placed.eachChunk(loops.placed);
    sized.eachChunk(loops.sized);
    turned.eachChunk(loops.turned);
    whole.eachChunk(loops.whole);
    placedFlat.eachChunk(loops.placedFlat);
    sizedFlat.eachChunk(loops.sizedFlat);
    turnedFlat.eachChunk(loops.turnedFlat);
    wholeFlat.eachChunk(loops.wholeFlat);
    drawn.finish();
  }).pipe(System.inStage("frame"));
};

// --- objects ---------------------------------------------------------------------

/**
 * What `Three.objects` is told, whatever its objects are made of.
 *
 * @category Models
 */
export interface ObjectsShared<O extends Object3D = Object3D> extends Which {
  /**
   * Called when the entity is no longer one of these, or the app's scope
   * closes, after the object was taken out of the scene: to dispose of
   * what `make` made for this one object.
   */
  readonly free?: (object: O, entity: Entity) => void;
}

/**
 * How `Three.objects` makes, updates and frees the object of each entity it
 * draws.
 *
 * @category Options
 */
export interface ObjectsOptions<
  O extends Object3D = Object3D,
> extends ObjectsShared<O> {
  /**
   * Makes the object of an entity, the first frame the entity is one of
   * these. It is added to the scene, and given the entity's place.
   */
  readonly make: (entity: Entity) => O;
}

/**
 * Objects that are made of assets which are loaded later, and let go
 * again: a level's models.
 *
 * @category Options
 */
export interface ObjectsFromOptions<
  B extends Entries,
  O extends Object3D = Object3D,
> extends ObjectsShared<O> {
  /** The bundle the objects are made of. There are objects while it is loaded. */
  readonly from: Assets.Bundle<B>;
  /**
   * Makes the object of an entity of the bundle's assets: the first frame
   * the entity is one of these and the assets are loaded, and again each
   * time they are loaded anew.
   */
  readonly make: (entity: Entity, assets: Assets.Loaded<B>) => O;
}

/** Either of the two, as the class that keeps the objects sees it. */
interface ObjectsOf<O extends Object3D> extends ObjectsShared<O> {
  // `any`: the assets of whichever bundle, or none.
  readonly make: (entity: Entity, assets: any) => O;
}

/** One object per entity, by the entity's index, and the loops that place them. */
class Objects<O extends Object3D> implements Kept {
  private readonly scene: ThreeScene;
  private readonly options: ObjectsOf<O>;
  /** What the objects are made of, for a kind that is made of assets. */
  private readonly assets: unknown;
  private readonly objects: (O | undefined)[] = [];
  /** Per entity index: the entity the object there was made for, by its id. */
  private owner = new Float64Array(0);
  /** Per entity index: the frame its entity was last found in, turned, and sized. */
  private seen = new Uint32Array(0);
  private turnedAt = new Uint32Array(0);
  private sizedAt = new Uint32Array(0);
  /** Per entity index: 1 when its entity is placed by a flat game's components. */
  private flat = new Uint8Array(0);
  /** The entity indexes that have an object, in no order. */
  private readonly live: number[] = [];
  private stamp = 0;
  /** What places the objects between two ticks, when the system was asked to. */
  private readonly smooth: Smooth | undefined;

  constructor(scene: ThreeScene, options: ObjectsOf<O>, assets: unknown) {
    this.scene = scene;
    this.options = options;
    this.assets = assets;
    this.smooth = smoothOf(options);
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
    const flat = new Uint8Array(length);
    flat.set(this.flat);
    this.flat = flat;
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
    const object = this.options.make(entity, this.assets);
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
      this.flat[index] = 0;
    }
  };

  // A flat game's entities. Only what its components say is set: where an
  // object is along the third axis, how it is turned about the other two
  // and how deep it is are as `make` left them, or as the game sets them.

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
      this.flat[index] = 1;
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

  /** Lets go of the objects whose entities were not found this frame. */
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
        if (flat[index] === 1) {
          objects[index]!.rotation.z = 0;
        } else {
          objects[index]!.quaternion.identity();
        }
        turnedAt[index] = 0;
      }
      if (sizedAt[index] !== stamp && sizedAt[index] !== 0) {
        const size = objects[index]!.scale;
        if (flat[index] === 1) {
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
 *   `Transform3d.Position`, and its object is added to the scene. The frame
 *   the entity no longer does, or is gone, the object is taken out, and
 *   `free` is called with it.
 * - Each frame every object is given its entity's `Position`, and its
 *   `Rotation` and `Scale` if the entity has them. A rotation of any
 *   length is given as a quaternion of length 1, and an entity that loses
 *   one of the two is drawn as one that never had it. What else there is
 *   to an object is the game's to set, in `make` or in a system of its
 *   own.
 * - An entity placed by a flat game's `Transform2d` has its object's x and
 *   y set, its turn about the third axis, and its size along x and y.
 *   Where the object is along the third axis, how it is tipped and how
 *   deep it is are left as `make` gave them, which is how one kind is put
 *   in front of another.
 * - An entity that takes a despawned one's slot gets an object of its own.
 * - Nothing is kept in the world. A game that is loaded from a save, or an
 *   app that starts with entities, has its objects made on the first
 *   frame.
 * - With `smooth: true` an object is placed between its entity's last two
 *   places, as `Three.instances` draws an instance.
 * - It needs `Three.plugin`, and its name is one of the app's systems'.
 *
 * Objects that are made of a level's assets name the bundle they come
 * `from`, and `make` is handed what it holds:
 *
 *   const Deer = Three.objects("game/Deer", {
 *     of: Deer,
 *     from: Forest,
 *     make: (entity, { deer }) => clone(deer),
 *   })
 *
 * - There are objects while the app holds the bundle loaded: each is made
 *   the frame it is, and all are let go, through `free`, when it is not,
 *   before the scene is next drawn. Loaded again, each is made again.
 * - It needs `Assets.plugin` as well.
 *
 * @category Systems
 */
// The one made of assets is first, so that the two things its `make` is
// handed are typed from it.
export const objects: {
  <B extends Entries, O extends Object3D = Object3D>(
    name: string,
    options: ObjectsFromOptions<B, O>
  ): System.System<never, Needs | Assets.Store>;
  <O extends Object3D = Object3D>(
    name: string,
    options: ObjectsOptions<O>
  ): System.System<never, Needs>;
} = <O extends Object3D>(
  name: string,
  options: ObjectsOptions<O> | ObjectsFromOptions<Entries, O>
  // `any`: as for `instances`.
): System.System<never, any> => {
  const from = "from" in options ? options.from : undefined;
  const smooth = options.smooth === true;
  const marked = required(options);
  const excluded = options.without ?? [];
  const Placed = Query.all(Transform3d.Position).pipe(
    Query.with(...marked),
    Query.without(...excluded),
    Query.reads()
  );
  const Turned = Query.all(Transform3d.Rotation).pipe(
    Query.with(Transform3d.Position, ...marked),
    Query.without(...excluded),
    Query.reads()
  );
  const Sized = Query.all(Transform3d.Scale).pipe(
    Query.with(Transform3d.Position, ...marked),
    Query.without(...excluded),
    Query.reads()
  );
  // A flat game's, but for the entities placed in three dimensions too.
  const flat = [...excluded, Transform3d.Position];
  const PlacedFlat = Query.all(Transform2d.Position).pipe(
    Query.with(...marked),
    Query.without(...flat),
    Query.reads()
  );
  const TurnedFlat = Query.all(Transform2d.Rotation).pipe(
    Query.with(Transform2d.Position, ...marked),
    Query.without(...flat),
    Query.reads()
  );
  const SizedFlat = Query.all(Transform2d.Scale).pipe(
    Query.with(Transform2d.Position, ...marked),
    Query.without(...flat),
    Query.reads()
  );
  return System.make(name, function* () {
    const kept = yield* Scene;
    const placed = yield* Placed;
    const turned = yield* Turned;
    const sized = yield* Sized;
    const placedFlat = yield* PlacedFlat;
    const turnedFlat = yield* TurnedFlat;
    const sizedFlat = yield* SizedFlat;
    const tick = smooth ? (yield* Time).tick : 0;
    const frame = smooth ? yield* Frame : undefined;
    let held: Objects<O> | undefined;
    if (from === undefined) {
      held = kept._kept.get(name) as Objects<O> | undefined;
      if (held === undefined) {
        held = new Objects(kept.scene, options, undefined);
        kept._kept.set(name, held);
      }
    } else {
      let sourced = kept._kept.get(name) as FromAssets<Objects<O>> | undefined;
      if (sourced === undefined) {
        const { scene } = kept;
        sourced = new FromAssets(
          yield* Assets.Store,
          from,
          (assets) => new Objects(scene, options, assets)
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
    placed.eachChunk(held.placed);
    turned.eachChunk(held.turned);
    sized.eachChunk(held.sized);
    placedFlat.eachChunk(held.placedFlat);
    turnedFlat.eachChunk(held.turnedFlat);
    sizedFlat.eachChunk(held.sizedFlat);
    held.finish();
  }).pipe(System.inStage("frame"));
};
