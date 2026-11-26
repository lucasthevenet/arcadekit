import { afterEach, describe, expect, it, vi } from "@effect/vitest";
/// <reference types="node" />
import {
  Action,
  App,
  Assets,
  Color,
  Commands,
  Component,
  EntityId,
  Plugin,
  State,
  System,
  Transform3d,
  World,
} from "arcadekit";
import type { Entity } from "arcadekit";
import { entityGeneration, entityIndex } from "arcadekit/ecs";
import type { BuiltIn } from "arcadekit/Services";
import { Cause, Effect, Exit, Layer, Logger, Schema, Scope } from "effect";
import {
  BoxGeometry,
  FileLoader,
  InstancedMesh,
  MeshBasicMaterial,
  MirroredRepeatWrapping,
  NearestFilter,
  NoColorSpace,
  Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from "three";
import type { LoadingManager, Scene } from "three";

import { Three } from "../src/index.ts";

/** An entity as a log names it: its slot and generation. */
const named = (entity: Entity): string =>
  `${entityIndex(entity)}/${entityGeneration(entity)}`;

const { Position } = Transform3d;

const Tree = Component.tag("ta/Tree", { requires: [Transform3d.Position] });
const Deer = Component.tag("ta/Deer", { requires: [Transform3d.Position] });
const Level = State.define("ta/Level", ["menu", "forest"]);
const Go = Action.define(
  "ta/Go",
  Schema.Struct({ to: Schema.Literals(["menu", "forest"]) })
);
const go = Action.handler(Go, function* ({ to }) {
  (yield* Level.sets).set(to);
});
const at = (x: number) => Position.of({ x, y: 0, z: 0 });
/** A tree or a deer comes to stand at x, of a colour if it is given one. */
const Arrive = Action.define(
  "ta/Arrive",
  Schema.Struct({
    kind: Schema.Literals(["tree", "deer"]),
    x: Schema.Number,
    paint: Schema.optional(
      Schema.Struct({ r: Schema.Number, g: Schema.Number, b: Schema.Number })
    ),
  })
);
const arrive = Action.handler(Arrive, function* ({ kind, paint, x }) {
  return (yield* Commands.spawns(Tree, Deer, Position, Color.Rgb)).spawn(
    kind === "tree" ? Tree : Deer,
    at(x),
    ...(paint === undefined
      ? []
      : [Color.Rgb.of({ ...paint, space: Color.Linear })])
  );
});
const Move = Action.define(
  "ta/Move",
  Schema.Struct({ entity: EntityId, x: Schema.Number })
);
const move = Action.handler(Move, function* ({ entity, x }) {
  (yield* World.writes(Position)).set(entity, Position, { x });
});
const Leave = Action.define("ta/Leave", Schema.Struct({ entity: EntityId }));
const leave = Action.handler(Leave, function* ({ entity }) {
  (yield* Commands).despawn(entity);
});
/** Lets what is waiting on a promise or a timer run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** What a level's bark is, to a test: which loading it is of, and whether it was let go. */
interface Bark {
  readonly load: number;
  readonly size: number;
  open: boolean;
}

/** A level's assets, which say when they are made and when they are let go. */
const makeForest = (log: string[]) => {
  let loads = 0;
  return Assets.bundle("ta/Forest", {
    bark: Assets.make("/bark.png", (bytes) =>
      Effect.acquireRelease(
        Effect.sync((): Bark => {
          const bark = { load: ++loads, size: bytes.length, open: true };
          log.push(`open ${bark.load}`);
          return bark;
        }),
        (bark) =>
          Effect.sync(() => {
            bark.open = false;
            log.push(`close ${bark.load}`);
          })
      )
    ),
  });
};
type Forest = ReturnType<typeof makeForest>;

const files = Assets.layer(
  Assets.makeMemory({ "/bark.png": new Uint8Array([1, 2, 3]) })
);

/**
 * A renderer that draws nothing, and notes what was in the scene when it
 * was asked to draw, and whether any of it was made of bark that had been
 * let go.
 */
const makeRenderer = () => {
  const renderer = {
    scene: undefined as Scene | undefined,
    /** The names of what was in the scene at the last draw. */
    drew: [] as string[],
    /** How many things, over all draws, were drawn with what had been let go. */
    stale: 0,
    layer: undefined as unknown as Layer.Layer<Three.Renderer>,
  };
  renderer.layer = Three.layer({
    render(scene) {
      renderer.scene = scene;
      renderer.drew = scene.children.map((child) => child.name);
      for (const child of scene.children) {
        const bark = (child.userData as { bark?: Bark }).bark;
        if (bark !== undefined && !bark.open) {
          renderer.stale++;
        }
      }
    },
  });
  return renderer;
};

/** What the systems that draw the game need, which the game provides. */
type Drawing = BuiltIn | Assets.Store | Three.Scene;

/** A game of a menu and a forest, without the systems that draw it. */
const forest = {
  plugins: [Three.plugin, Assets.plugin],
  handlers: [go, arrive, move, leave],
} as const;

/** A game of a menu and a forest, drawn by its systems. */
const play = Effect.fnUntraced(function* (
  game: App.Game<
    readonly System.System<never, Drawing>[],
    typeof forest.handlers,
    typeof forest.plugins
  >,
  loader: Layer.Layer<never> = files
) {
  const renderer = makeRenderer();
  const made = App.make(game);
  const app = yield* made.pipe(
    Effect.provide(Layer.mergeAll(renderer.layer, loader, Logger.layer([])))
  );
  return {
    app,
    renderer,
    close: app.close,
    /** The game goes to a level, and a frame is drawn. */
    enter: Effect.fnUntraced(function* (to: "menu" | "forest") {
      yield* app.dispatch(Go, { to });
      yield* app.tick(1);
      yield* app.frame();
    }),
    /** A tree or a deer arrives, at once. */
    spawn: (
      kind: "tree" | "deer",
      x: number,
      paint?: { readonly r: number; readonly g: number; readonly b: number }
    ) =>
      app.dispatch(Arrive, {
        kind,
        x,
        ...(paint === undefined ? {} : { paint }),
      }),
    moveTo: (entity: Entity, x: number) => app.dispatch(Move, { entity, x }),
    despawn: (entity: Entity) => app.dispatch(Leave, { entity }),
    mesh: (): InstancedMesh | undefined =>
      renderer.scene?.children.find(
        (child): child is InstancedMesh => child instanceof InstancedMesh
      ),
  };
});

/**
 * Keeps the forest's assets while the game is in the forest. It runs
 * before a frame's own systems, wherever it is listed, so the frame the
 * bundle comes or goes in is the frame the system that draws sees it.
 */
const during = (Forest: Forest) =>
  Assets.during(State.is(Level, "forest"), Forest);

/**
 * A system of a game's own that keeps the forest's assets as
 * `Assets.during` would, but late: in the frame's own stage, listed after the
 * systems that draw with them, which have looked by then. The worst way round.
 */
const keepLate = (Forest: Forest) =>
  System.frame("ta/KeepLate", function* () {
    const store = yield* Assets.Store;
    if ((yield* Level).value === "forest") {
      store.hold(Forest, "ta/KeepLate");
    } else {
      store.drop(Forest, "ta/KeepLate");
    }
  });

/** Where the instances of a mesh are along x, in order. */
const xs = (mesh: InstancedMesh): number[] =>
  Array.from(
    { length: mesh.count },
    (_, i) => mesh.instanceMatrix.array[i * 16 + 12]!
  ).toSorted((a, b) => a - b);

const geometry = new BoxGeometry(1, 1, 1);

/** Trees whose look is made of the forest's bark. */
const makeTrees = (
  Forest: Forest,
  log: string[],
  more: { readonly smooth?: boolean; readonly color?: typeof Color.Rgb } = {}
) => {
  const looks: { readonly bark: Bark; readonly material: MeshBasicMaterial }[] =
    [];
  const freed: unknown[] = [];
  const meshes: InstancedMesh[] = [];
  const Trees = Three.instancesFrom("ta/Trees", {
    of: Tree,
    transform: Transform3d,
    from: Forest,
    capacity: 2,
    ...more,
    look: ({ bark }) => {
      log.push(`look ${bark.load}`);
      const look = { geometry, material: new MeshBasicMaterial(), bark };
      looks.push(look);
      return look;
    },
    free: (look) => {
      // By now the mesh is out of the scene.
      log.push(
        `free ${look.bark.load}${meshes.at(-1)!.parent === null ? "" : ", still drawn"}`
      );
      freed.push(look);
    },
    prepare: (mesh) => {
      log.push(`prepare ${mesh.name}`);
      meshes.push(mesh);
      // The renderer of these tests looks here for what a thing is made of.
      mesh.userData = { bark: looks.at(-1)!.bark };
    },
  });
  return { Trees, freed, looks };
};

describe("instances whose look is made of assets", () => {
  it.effect(
    "are drawn while the app holds the bundle loaded, in a look made of it once",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees, looks } = makeTrees(Forest, log);
        const { app, despawn, enter, mesh, renderer, spawn } = yield* play(
          App.define({ ...forest, systems: [during(Forest), Trees] })
        );
        yield* spawn("tree", 1);
        yield* spawn("tree", 2);
        yield* spawn("deer", 9);
        // In the menu the forest is not loaded: there is nothing to draw with.
        yield* app.tick(1);
        yield* app.frame();
        yield* app.frame();
        expect(renderer.drew).toEqual([]);
        expect(log).toEqual([]);

        yield* enter("forest");
        expect(log).toEqual(["open 1", "look 1", "prepare ta/Trees"]);
        expect(renderer.drew).toEqual(["ta/Trees"]);
        const drawn = mesh()!;
        expect(drawn.geometry).toBe(geometry);
        expect(drawn.material).toBe(looks[0]!.material);
        expect(xs(drawn)).toEqual([1, 2]);
        // It is the mesh of any instances: not culled, its buffer its own.
        expect(drawn.frustumCulled).toBe(false);

        // The look is made once, however long the level lasts, and the trees
        // that come and go are drawn as any are.
        const more = yield* spawn("tree", 3);
        yield* app.tick(1);
        yield* app.frame();
        expect(xs(mesh()!)).toEqual([1, 2, 3]);
        yield* despawn(more);
        yield* app.frame();
        expect(xs(mesh()!)).toEqual([1, 2]);
        expect(mesh()).toBe(drawn);
        expect(log).toEqual(["open 1", "look 1", "prepare ta/Trees"]);
        expect(renderer.stale).toBe(0);
      })
  );

  it.effect(
    "are taken out of the scene when the bundle is let go, and what look made is handed to free",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees, freed, looks } = makeTrees(Forest, log);
        const { app, enter, mesh, renderer, spawn } = yield* play(
          App.define({ ...forest, systems: [during(Forest), Trees] })
        );
        yield* spawn("tree", 1);
        yield* enter("forest");
        const drawn = mesh()!;
        let disposed = 0;
        drawn.addEventListener("dispose", () => {
          disposed++;
        });
        log.length = 0;

        yield* enter("menu");
        // The bark first, which is the bundle's, then what was made of it.
        expect(log).toEqual(["close 1", "free 1"]);
        expect(freed).toEqual([looks[0]]);
        expect(freed[0]).toBe(looks[0]);
        expect(renderer.drew).toEqual([]);
        expect(drawn.parent).toBeNull();
        expect(disposed).toBe(1);
        // And it stays away, with nothing made or freed again.
        yield* app.tick(1);
        yield* app.frame();
        yield* app.frame();
        expect(renderer.drew).toEqual([]);
        expect(log).toEqual(["close 1", "free 1"]);
        expect(renderer.stale).toBe(0);
      })
  );

  it.effect(
    "are made again of what is loaded next, with the room the last had come to need",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees, looks } = makeTrees(Forest, log);
        const { despawn, enter, mesh, spawn } = yield* play(
          App.define({ ...forest, systems: [during(Forest), Trees] })
        );
        const trees = yield* Effect.forEach([1, 2, 3, 4, 5], (x) =>
          spawn("tree", x)
        );
        yield* enter("forest");
        const first = mesh()!;
        // Room for two was asked for, and five were drawn.
        expect(first.instanceMatrix.array.length).toBe(8 * 16);
        yield* enter("menu");
        // While it is away most of them go, and one comes.
        for (const tree of trees.slice(1)) {
          yield* despawn(tree);
        }
        yield* spawn("tree", 6);
        log.length = 0;

        yield* enter("forest");
        expect(log).toEqual(["open 2", "look 2", "prepare ta/Trees"]);
        const second = mesh()!;
        expect(second).not.toBe(first);
        expect(second.material).toBe(looks[1]!.material);
        expect(second.material).not.toBe(first.material);
        expect(looks[1]!.bark).toMatchObject({ load: 2, open: true, size: 3 });
        expect(xs(second)).toEqual([1, 6]);
        // The room the first had grown to, though two would do for these: a
        // level that is entered again does not grow its way up again.
        expect(second.instanceMatrix.array.length).toBe(8 * 16);
        expect(first.parent).toBeNull();
      })
  );

  it.effect(
    "are never drawn with what was let go, whichever of the two systems runs first",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees } = makeTrees(Forest, log);
        // Listed after what draws, and nothing more said: `Assets.during` is
        // of the stage before a frame's own, so the trees find their bark in
        // the frame it is loaded, and find it gone in the frame it goes.
        const listed = yield* play(
          App.define({
            ...forest,
            systems: [Trees, Assets.during(State.is(Level, "forest"), Forest)],
          })
        );
        yield* listed.spawn("tree", 1);
        yield* listed.enter("forest");
        expect(log).toEqual(["open 1", "look 1", "prepare ta/Trees"]);
        expect(listed.renderer.drew).toEqual(["ta/Trees"]);
        yield* listed.enter("menu");
        expect(listed.renderer.drew).toEqual([]);
        expect(log.slice(-2)).toEqual(["close 1", "free 1"]);
        expect(listed.renderer.stale).toBe(0);
        expect(listed.app.frameOrder.slice(-3)).toEqual([
          "Assets.during(ta/Forest)",
          "ta/Trees",
          "arcadekit/three/Render",
        ]);

        // The worst way round, which a system of the game's own can still be:
        // the trees look, then the level lets its assets go, then the scene
        // is drawn.
        log.length = 0;
        const { app, enter, renderer, spawn } = yield* play(
          App.define({ ...forest, systems: [Trees, keepLate(Forest)] })
        );
        yield* spawn("tree", 1);
        yield* enter("forest");
        expect(renderer.drew).toEqual([]);
        yield* app.frame();
        expect(renderer.drew).toEqual(["ta/Trees"]);
        log.length = 0;
        // The frame the level is left in, the trees saw their bark, and then
        // it was let go: they are gone all the same by the time it is drawn.
        yield* enter("menu");
        expect(log).toEqual(["close 2", "free 2"]);
        expect(renderer.drew).toEqual([]);
        expect(renderer.stale).toBe(0);
        yield* app.frame();
        expect(log).toEqual(["close 2", "free 2"]);

        // In again, and out again.
        yield* enter("forest");
        yield* app.frame();
        expect(renderer.drew).toEqual(["ta/Trees"]);
        yield* enter("menu");
        expect(renderer.drew).toEqual([]);
        expect(renderer.stale).toBe(0);
        expect(log.slice(-2)).toEqual(["close 3", "free 3"]);
      })
  );

  it.effect(
    "are made anew in the frame a bundle is found loaded again, though it was never seen gone",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees, looks } = makeTrees(Forest, log);
        // A system of the game's own keeps the forest, and can load it afresh.
        let afresh = false;
        const Keep = System.frame("ta/Keep", function* () {
          const store = yield* Assets.Store;
          if (afresh) {
            afresh = false;
            store.drop(Forest, "ta/Keep");
          }
          store.hold(Forest, "ta/Keep");
        });
        const { app, mesh, renderer, spawn } = yield* play(
          App.define({ ...forest, systems: [Keep, Trees] })
        );
        yield* spawn("tree", 1);
        yield* app.frame();
        const first = mesh()!;
        expect(log).toEqual(["open 1", "look 1", "prepare ta/Trees"]);
        log.length = 0;

        afresh = true;
        yield* app.frame();
        // Between one look and the next the bark became other bark: the old
        // look is freed and the new made, and the trees are drawn all the while.
        expect(log).toEqual([
          "close 1",
          "open 2",
          "free 1",
          "look 2",
          "prepare ta/Trees",
        ]);
        expect(renderer.drew).toEqual(["ta/Trees"]);
        expect(mesh()).not.toBe(first);
        expect(mesh()!.material).toBe(looks[1]!.material);
        expect(xs(mesh()!)).toEqual([1]);
        expect(renderer.stale).toBe(0);
      })
  );

  it.effect(
    "wait for a bundle that takes its time, and draw nothing of one that could not be loaded",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees } = makeTrees(Forest, log);
        const waiting: ((
          exit: Exit.Exit<Uint8Array, Assets.Failed>
        ) => void)[] = [];
        const slow = Layer.succeed(Assets.Loader, {
          bytes: () =>
            Effect.callback<Uint8Array, Assets.Failed>((resume) => {
              waiting.push((exit) => resume(exit));
            }),
        }) as Layer.Layer<never>;
        const { app, enter, renderer, spawn } = yield* play(
          App.define({ ...forest, systems: [during(Forest), Trees] }),
          slow
        );
        yield* spawn("tree", 1);
        yield* enter("forest");
        yield* app.frame();
        expect(renderer.drew).toEqual([]);
        expect(log).toEqual([]);
        // The file arrives.
        waiting[0]!(Exit.succeed(new Uint8Array([7])));
        yield* Effect.promise(() => settle());
        expect(renderer.drew).toEqual([]);
        yield* app.frame();
        expect(renderer.drew).toEqual(["ta/Trees"]);
        expect(log).toEqual(["open 1", "look 1", "prepare ta/Trees"]);

        // Left and entered again, and this time it is not there.
        yield* enter("menu");
        yield* enter("forest");
        waiting[1]!(
          Exit.fail(new Assets.Failed({ url: "/bark.png", message: "gone" }))
        );
        yield* Effect.promise(() => settle());
        log.length = 0;
        yield* app.frame();
        yield* app.frame();
        expect(renderer.drew).toEqual([]);
        expect(log).toEqual([]);
        expect(renderer.stale).toBe(0);
      })
  );

  it.effect(
    "go with the app's scope: what look made is freed once if it was there, and never if it was not",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees, freed } = makeTrees(Forest, log);
        const game = App.define({
          ...forest,
          systems: [during(Forest), Trees],
        });
        const loaded = yield* play(game);
        yield* loaded.spawn("tree", 1);
        yield* loaded.enter("forest");
        const drawn = loaded.mesh()!;
        yield* loaded.close;
        expect(log.filter((line) => line === "free 1")).toEqual(["free 1"]);
        expect(freed.length).toBe(1);
        expect(drawn.parent).toBeNull();

        // An app that left the forest has nothing of it to free when it closes.
        log.length = 0;
        const left = yield* play(game);
        yield* left.enter("forest");
        yield* left.enter("menu");
        expect(log).toEqual([
          "open 2",
          "look 2",
          "prepare ta/Trees",
          "close 2",
          "free 2",
        ]);
        yield* left.close;
        expect(log.length).toBe(5);

        // And one that never entered it made nothing.
        log.length = 0;
        const never = yield* play(game);
        yield* never.app.tick(1);
        yield* never.app.frame();
        yield* never.close;
        expect(log).toEqual([]);
      })
  );

  it.effect(
    "are drawn between two ticks, and each in its colour, as any instances are",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const { Trees } = makeTrees(Forest, log, {
          smooth: true,
          color: Color.Rgb,
        });
        const { app, enter, mesh, moveTo, spawn } = yield* play(
          App.define({ ...forest, systems: [during(Forest), Trees] })
        );
        const tree = yield* spawn("tree", 0, { r: 0.25, g: 0.5, b: 0.75 });
        // Not painted: drawn white, after the painted ones.
        yield* spawn("tree", 99);
        yield* enter("forest");
        expect(xs(mesh()!)).toEqual([0, 99]);
        expect(Array.from(mesh()!.instanceColor!.array.subarray(0, 6))).toEqual(
          [0.25, 0.5, 0.75, 1, 1, 1]
        );
        yield* moveTo(tree, 10);
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xs(mesh()!)).toEqual([5, 99]);

        // Away, it moves on; back, it is drawn where it is, and not on the way
        // from where it was last seen.
        yield* enter("menu");
        yield* moveTo(tree, 30);
        yield* app.tick(1);
        yield* app.frame(0.5);
        yield* app.dispatch(Go, { to: "forest" });
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xs(mesh()!)).toEqual([30, 99]);
      })
  );

  it("say in their types what the look is made of, and that they need the app's assets", () => {
    const Forest = makeForest([]);
    const material = new MeshBasicMaterial();
    const Plain = Three.instances("ta/Plain", {
      of: Tree,
      transform: Transform3d,
      geometry,
      material,
    });
    const From = Three.instancesFrom("ta/From", {
      of: Tree,
      transform: Transform3d,
      from: Forest,
      look: ({ bark }) => {
        // A level's bark, as the bundle says, and nothing it does not hold.
        const size: number = bark.size;
        return { geometry, material, size };
      },
      free: (look) => {
        const size: number = look.size;
        void size;
      },
    });
    Three.instancesFrom("ta/Wrong", {
      of: Tree,
      transform: Transform3d,
      from: Forest,
      // @ts-expect-error the forest has no leaves
      look: ({ leaves }) => ({ geometry, material, leaves }),
    });
    Three.instances("ta/Both", {
      of: Tree,
      transform: Transform3d,
      geometry,
      material,
      // @ts-expect-error a look that is there is not also made of a bundle
      from: Forest,
    });
    // @ts-expect-error a bundle is not a look until something makes one of it
    Three.instancesFrom("ta/Half", {
      of: Tree,
      transform: Transform3d,
      from: Forest,
    });
    // One that draws from a bundle needs the store of assets, which
    // `Assets.plugin` gives; one whose look is there does not.
    const plain: typeof Plain = Plain;
    // @ts-expect-error the store of assets is one thing more to need
    const also: typeof Plain = From;
    expect([plain.name, also.name]).toEqual(["ta/Plain", "ta/From"]);
    expect(From.stage).toBe("frame");
  });

  it.effect(
    "ask nothing of an app's assets when their look is there: such an app needs no Assets.plugin",
    () =>
      Effect.gen(function* () {
        const renderer = makeRenderer();
        const material = new MeshBasicMaterial();
        const Grove = Plugin.make("ta/Grove", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Tree, Position)).spawn(Tree, at(1));
          }),
        });
        const app = yield* App.make(
          App.define({
            plugins: [Three.plugin, Grove],
            systems: [
              Three.instances("ta/Plain", {
                of: Tree,
                transform: Transform3d,
                geometry,
                material,
              }),
              Three.objects("ta/Things", {
                of: Deer,
                transform: Transform3d,
                make: () => new Object3D(),
              }),
            ],
          })
        ).pipe(Effect.provide(renderer.layer));
        yield* app.frame();
        expect(renderer.drew).toEqual(["ta/Plain"]);
        yield* app.close;
      })
  );
});

describe("objects made of assets", () => {
  /** Deer, each an object made of the forest's bark. */
  const makeDeer = (Forest: Forest, log: string[]) =>
    Three.objectsFrom("ta/Deer", {
      of: Deer,
      transform: Transform3d,
      from: Forest,
      make: (entity, { bark }) => {
        const object = new Object3D();
        object.name = `deer ${named(entity)} of ${bark.load}`;
        object.userData = { bark };
        log.push(`make ${named(entity)} of ${bark.load}`);
        return object;
      },
      free: (object, entity) => {
        log.push(
          `free ${named(entity)} of ${(object.userData as { bark: Bark }).bark.load}`
        );
      },
    });

  it.effect(
    "are made while the app holds the bundle loaded, of what it holds, and all let go when it does not",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const Herd = makeDeer(Forest, log);
        const { app, despawn, enter, moveTo, renderer, spawn } = yield* play(
          App.define({ ...forest, systems: [during(Forest), Herd] })
        );
        const one = yield* spawn("deer", 1);
        const two = yield* spawn("deer", 2);
        yield* spawn("tree", 9);
        yield* app.tick(1);
        yield* app.frame();
        // No bark, no deer.
        expect(log).toEqual([]);
        expect(renderer.drew).toEqual([]);

        yield* enter("forest");
        expect(log).toEqual([
          "open 1",
          `make ${named(one)} of 1`,
          `make ${named(two)} of 1`,
        ]);
        expect(renderer.drew).toEqual([
          `deer ${named(one)} of 1`,
          `deer ${named(two)} of 1`,
        ]);
        expect(
          renderer.scene!.children.map((child) => child.position.x)
        ).toEqual([1, 2]);
        // While it lasts they are objects as any: made once, placed each
        // frame, and one whose entity goes is let go alone.
        yield* moveTo(one, 5);
        yield* despawn(two);
        const three = yield* spawn("deer", 3);
        yield* app.frame();
        expect(log.slice(3)).toEqual([
          `free ${named(two)} of 1`,
          `make ${named(three)} of 1`,
        ]);
        expect(
          renderer.scene!.children.map((child) => child.position.x)
        ).toEqual([5, 3]);
        log.length = 0;

        // The level is left: every deer goes, once.
        yield* enter("menu");
        expect(log.toSorted()).toEqual(
          [
            "close 1",
            `free ${named(one)} of 1`,
            `free ${named(three)} of 1`,
          ].toSorted()
        );
        expect(log[0]).toBe("close 1");
        expect(renderer.drew).toEqual([]);
        const four = yield* spawn("deer", 4);
        yield* app.frame();
        expect(renderer.drew).toEqual([]);
        log.length = 0;

        // And entered again: each is made anew, of the bark loaded now.
        yield* enter("forest");
        expect(log.toSorted()).toEqual(
          [
            "open 2",
            `make ${named(one)} of 2`,
            `make ${named(three)} of 2`,
            `make ${named(four)} of 2`,
          ].toSorted()
        );
        expect(renderer.drew.length).toBe(3);
        expect(renderer.stale).toBe(0);
      })
  );

  it.effect(
    "are out of the scene before it is drawn in the frame their assets go, whichever system runs first, and freed with the app",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Forest = makeForest(log);
        const Herd = makeDeer(Forest, log);
        // The worst way round: the deer are looked at, then the level lets its
        // assets go, then the scene is drawn.
        // And trees beside them, of the same bark: every kind is asked.
        const { Trees } = makeTrees(Forest, []);
        const { app, close, enter, renderer, spawn } = yield* play(
          App.define({ ...forest, systems: [Trees, Herd, keepLate(Forest)] })
        );
        const one = yield* spawn("deer", 1);
        yield* spawn("tree", 2);
        yield* enter("forest");
        yield* app.frame();
        expect(renderer.drew).toEqual(["ta/Trees", `deer ${named(one)} of 1`]);
        yield* enter("menu");
        expect(renderer.drew).toEqual([]);
        expect(renderer.stale).toBe(0);
        expect(log.slice(-2)).toEqual(["close 1", `free ${named(one)} of 1`]);

        yield* enter("forest");
        yield* app.frame();
        expect(renderer.drew).toEqual(["ta/Trees", `deer ${named(one)} of 2`]);
        const made = renderer.scene!.children[1]!;
        log.length = 0;
        yield* close;
        expect(log.filter((line) => line.startsWith("free"))).toEqual([
          `free ${named(one)} of 2`,
        ]);
        expect(made.parent).toBeNull();
      })
  );

  it("say in their types what an object is made of", () => {
    const Forest = makeForest([]);
    const Made = Three.objectsFrom("ta/Made", {
      of: Deer,
      transform: Transform3d,
      from: Forest,
      make: (_entity: Entity, { bark }) => {
        const size: number = bark.size;
        void size;
        return new InstancedMesh(geometry, new MeshBasicMaterial(), 1);
      },
      // The object is the one `make` gives.
      free: (object) => object.dispose(),
    });
    Three.objectsFrom("ta/Wrong", {
      of: Deer,
      transform: Transform3d,
      from: Forest,
      // @ts-expect-error the forest has no leaves
      make: (_entity, { leaves }) => new Object3D().add(leaves),
    });
    const Plain = Three.objects("ta/Plain", {
      of: Deer,
      transform: Transform3d,
      make: () => new Object3D(),
    });
    // @ts-expect-error the store of assets is one thing more to need
    const also: typeof Plain = Made;
    expect(also.name).toBe("ta/Made");
  });
});

describe("a texture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** What a page's `createImageBitmap` is, to a test: it notes what it was asked. */
  const stubBitmaps = () => {
    const asked: { readonly bytes: number[]; readonly options: unknown }[] = [];
    const bitmaps: { width: number; height: number; closed: number }[] = [];
    vi.stubGlobal("createImageBitmap", async (blob: Blob, options: unknown) => {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      asked.push({ bytes, options });
      if (bytes[0] === 0) {
        throw new Error("The source image could not be decoded.");
      }
      const bitmap = {
        width: 2,
        height: 2,
        closed: 0,
        close() {
          bitmap.closed++;
        },
      };
      bitmaps.push(bitmap);
      return bitmap;
    });
    return { asked, bitmaps };
  };

  it.effect(
    "is a picture decoded for Three.js, the right way up, and let go with the scope it was loaded in",
    () =>
      Effect.gen(function* () {
        const { asked, bitmaps } = stubBitmaps();
        const prepared: { readonly version: number; readonly space: string }[] =
          [];
        const Forest = Assets.bundle("ta/Textures", {
          bark: Three.texture("/bark.png"),
          normals: Three.texture("/normals.png", {
            prepare: (texture) => {
              prepared.push({
                version: texture.version,
                space: texture.colorSpace,
              });
              texture.colorSpace = NoColorSpace;
            },
          }),
        });
        const scope = Scope.makeUnsafe();
        const { bark, normals } = yield* Assets.load(Forest).pipe(
          Scope.provide(scope),
          Effect.provide(
            Assets.layer(
              Assets.makeMemory({
                "/bark.png": new Uint8Array([9, 8, 7]),
                "/normals.png": "nn",
              })
            )
          )
        );
        expect(bark).toBeInstanceOf(Texture);
        expect(bark.image).toBe(bitmaps[0]);
        // Colours, unless told otherwise; and told before it is ever sent.
        expect(bark.colorSpace).toBe(SRGBColorSpace);
        expect(normals.colorSpace).toBe(NoColorSpace);
        expect(prepared).toEqual([{ version: 0, space: SRGBColorSpace }]);
        // It is to be sent to the renderer, once.
        expect(bark.version).toBe(1);
        expect(normals.version).toBe(1);
        // A bitmap is flipped when it is made, or never.
        expect(asked).toEqual([
          { bytes: [9, 8, 7], options: { imageOrientation: "flipY" } },
          { bytes: [110, 110], options: { imageOrientation: "flipY" } },
        ]);
        let disposed = 0;
        bark.addEventListener("dispose", () => {
          disposed++;
        });
        expect(bitmaps.map((bitmap) => bitmap.closed)).toEqual([0, 0]);
        yield* Scope.close(scope, Exit.void);
        expect(disposed).toBe(1);
        expect(bitmaps.map((bitmap) => bitmap.closed)).toEqual([1, 1]);
      })
  );

  it.effect(
    "is left as its file has it when it is told so where it is made, and cannot be told in prepare",
    () =>
      Effect.gen(function* () {
        const { asked, bitmaps } = stubBitmaps();
        const files = Assets.layer(
          Assets.makeMemory({
            "/skin.png": new Uint8Array([1, 2]),
          })
        );
        const load = (asset: Assets.Asset<Texture>) =>
          Effect.scoped(
            Effect.map(
              Assets.load(Assets.bundle("ta/Skin", { skin: asset })),
              ({ skin }) => ({ flipY: skin.flipY, image: skin.image })
            )
          ).pipe(Effect.provide(files));
        // A model's own picture, say: as the file has it.
        expect(
          yield* load(Three.texture("/skin.png", { flipY: false }))
        ).toEqual({
          flipY: false,
          image: bitmaps[0],
        });
        // And turned over, which is what it is when nothing says: the texture
        // says of itself how it was decoded.
        expect(
          yield* load(Three.texture("/skin.png", { flipY: true }))
        ).toEqual({
          flipY: true,
          image: bitmaps[1],
        });
        expect(asked.map((one) => one.options)).toEqual([
          { imageOrientation: "from-image" },
          { imageOrientation: "flipY" },
        ]);
        // Three.js does not read flipY of a bitmap, so prepare is handed a
        // texture without it, and with everything else a game sets.
        Three.texture("/skin.png", {
          prepare: (texture) => {
            texture.colorSpace = NoColorSpace;
            texture.wrapS = RepeatWrapping;
            texture.wrapT = MirroredRepeatWrapping;
            texture.magFilter = NearestFilter;
            texture.minFilter = NearestFilter;
            texture.generateMipmaps = false;
            texture.anisotropy = 4;
            texture.premultiplyAlpha = true;
            texture.repeat.set(2, 2);
            texture.offset.set(0.5, 0);
            texture.center.set(0.5, 0.5);
            texture.rotation = Math.PI / 2;
            // @ts-expect-error flipY is said where the texture is made
            texture.flipY = false;
          },
        });
        Three.texture("/skin.png", {
          // @ts-expect-error nor by a function that takes a whole texture
          prepare: (texture: Texture) => {
            texture.flipY = false;
          },
        });
        // How it is told is an object, as a model is: a function alone is not.
        // @ts-expect-error prepare is named
        Three.texture("/skin.png", () => {});
      })
  );

  it.effect(
    "fails as an asset that could not be loaded when the file is no picture",
    () =>
      Effect.gen(function* () {
        stubBitmaps();
        const exit = yield* Effect.exit(
          Effect.scoped(
            Assets.load(
              Assets.bundle("ta/Broken", { bark: Three.texture("/bark.png") })
            )
          )
        ).pipe(
          Effect.provide(
            Assets.layer(
              Assets.makeMemory({ "/bark.png": new Uint8Array([0]) })
            )
          )
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Cause.squash(
          (exit as Exit.Failure<never, unknown>).cause
        );
        expect(error).toBeInstanceOf(Assets.Failed);
        expect(error).toEqual(
          new Assets.Failed({
            url: "/bark.png",
            message:
              "It could not be made a texture: The source image could not be decoded.",
          })
        );
      })
  );

  it.effect(
    "is what a level's instances are drawn with, for as long as the level",
    () =>
      Effect.gen(function* () {
        const { bitmaps } = stubBitmaps();
        const Forest = Assets.bundle("ta/Forest", {
          bark: Three.texture("/bark.png"),
        });
        const Trees = Three.instancesFrom("ta/Trees", {
          of: Tree,
          transform: Transform3d,
          from: Forest,
          look: ({ bark }) => ({
            geometry,
            material: new MeshBasicMaterial({ map: bark }),
          }),
        });
        const { app, enter, mesh, renderer, spawn } = yield* play(
          App.define({
            ...forest,
            systems: [Trees, Assets.during(State.is(Level, "forest"), Forest)],
          })
        );
        yield* spawn("tree", 1);
        yield* enter("forest");
        // A picture is decoded in its own time.
        expect(renderer.drew).toEqual([]);
        yield* Effect.promise(() => settle());
        yield* app.frame();
        expect(renderer.drew).toEqual(["ta/Trees"]);
        const material = mesh()!.material as MeshBasicMaterial;
        expect(material.map).toBeInstanceOf(Texture);
        expect(material.map!.image).toBe(bitmaps[0]);
        const events: string[] = [];
        material.map!.addEventListener("dispose", () => events.push("texture"));
        material.addEventListener("dispose", () => events.push("material"));
        yield* enter("menu");
        expect(events).toEqual(["texture", "material"]);
        expect(bitmaps[0]!.closed).toBe(1);
        expect(renderer.drew).toEqual([]);
      })
  );
});

describe("a manager of Three.js's requests", () => {
  /** Makes a manager of `served` under in-memory files, in a scope of the test's. */
  const make = Effect.fnUntraced(function* (
    files: Readonly<Record<string, string>>,
    served: ReadonlyArray<string>
  ) {
    const scope = Scope.makeUnsafe();
    const exit = yield* Effect.exit(Three.manager(served)).pipe(
      Scope.provide(scope),
      Effect.provide(Assets.layer(Assets.makeMemory(files)))
    );
    return {
      exit,
      close: Scope.close(scope, Exit.void),
    };
  });
  const text = (manager: LoadingManager, path: string, url: string) =>
    new FileLoader(manager).setPath(path).loadAsync(url);

  it.effect(
    "serves a loader made with it the files it was given, fetched through Assets.Loader, until its scope closes",
    () =>
      Effect.gen(function* () {
        // Node has no ProgressEvent, which a FileLoader reports progress with.
        vi.stubGlobal("ProgressEvent", Event);
        const { close, exit } = yield* make(
          { "/draco/decoder.js": "decode()", "/other.js": "other()" },
          ["/draco/decoder.js"]
        );
        const manager = Exit.isSuccess(exit) ? exit.value : undefined;
        expect(
          yield* Effect.promise(() => text(manager!, "/draco/", "decoder.js"))
        ).toBe("decode()");
        yield* Effect.promise(() =>
          expect(text(manager!, "", "/other.js")).rejects.toThrow(
            'A Three.js loader asked for "/other.js", which is not one of the files its manager serves.'
          )
        );
        const blob = URL.createObjectURL(new Blob(["held()"]));
        expect(yield* Effect.promise(() => text(manager!, "", blob))).toBe(
          "held()"
        );
        yield* close;
        yield* Effect.promise(() =>
          expect(text(manager!, "/draco/", "decoder.js")).rejects.toThrow(
            "fetch failed"
          )
        );
      })
  );

  it.effect("fails with the file that is missing", () =>
    Effect.gen(function* () {
      const { exit } = yield* make({}, ["/draco/decoder.js"]);
      const failure = Exit.isFailure(exit)
        ? Cause.squash(exit.cause)
        : undefined;
      expect(failure).toBeInstanceOf(Assets.Failed);
      expect(failure).toMatchObject({ url: "/draco/decoder.js" });
    })
  );
});
