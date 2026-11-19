/// <reference types="node" />
import {
  Action,
  App,
  Assets,
  Component,
  Field,
  State,
  System,
  Transform3d,
} from "arcadekit";
import type { Entity } from "arcadekit";
import { Cause, Effect, Exit, Layer, Logger, Schema, Scope } from "effect";
import {
  BoxGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  NoColorSpace,
  Object3D,
  SRGBColorSpace,
  Texture,
} from "three";
import type { Scene } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Three } from "../src/index";

const { Position } = Transform3d;

const Tree = Component.tag("ta/Tree");
const Deer = Component.tag("ta/Deer");

const Paint = Component.define("ta/Paint", {
  r: Field.f32,
  g: Field.f32,
  b: Field.f32,
});

const Level = State.define("ta/Level", ["menu", "forest"]);

const Go = Action.define(
  "ta/Go",
  Schema.Struct({ to: Schema.Literals(["menu", "forest"]) })
);

const go = Action.handler(Go, function* ({ to }) {
  (yield* Level).set(to);
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
          loads += 1;
          const bark = { load: loads, size: bytes.length, open: true };
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

const files = Assets.layerMemory({ "/bark.png": new Uint8Array([1, 2, 3]) });

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

  renderer.layer = Layer.succeed(Three.Renderer, {
    render(scene) {
      renderer.scene = scene;
      renderer.drew = scene.children.map((child) => child.name);

      for (const child of scene.children) {
        const { bark } = child.userData as { bark?: Bark };

        if (bark !== undefined && !bark.open) {
          renderer.stale += 1;
        }
      }
    },
  });

  return renderer;
};

/** A game of a menu and a forest, drawn by the systems it is given. */
const play = (
  // `any`: whatever the systems need is provided below, or the test fails.
  systems: readonly System.System<never, any>[],
  loader: Layer.Layer<never> = files
) => {
  const renderer = makeRenderer();
  const scope = Effect.runSync(Scope.make());

  const made = App.make({
    plugins: [Three.plugin, Assets.plugin],
    components: [Tree, Deer, Paint, Level],
    handlers: [go],
    systems,
  });

  const app = Effect.runSync(
    made.pipe(
      Effect.provide(Layer.mergeAll(renderer.layer, loader, Logger.layer([]))),
      Scope.provide(scope)
    ) as typeof made extends Effect.Effect<infer A, infer E, any>
      ? Effect.Effect<A, E>
      : never
  );

  return {
    app,
    renderer,
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
    /** The game goes to a level, and a frame is drawn. */
    enter: (to: "menu" | "forest") => {
      app.dispatch(Go, { to });
      app.tick(1);
      app.frame(0);
    },
    mesh: (): InstancedMesh | undefined =>
      renderer.scene?.children.find(
        (child): child is InstancedMesh => child instanceof InstancedMesh
      ),
  };
};

/**
 * Keeps the forest's assets while the game is in the forest. It runs
 * before a frame's own systems, wherever it is listed, so the frame the
 * bundle comes or goes in is the frame the system that draws sees it.
 */
const during = (Forest: Forest) =>
  Assets.during(State.is(Level, "forest"), Forest);

/**
 * A system of a game's own that keeps the forest's assets as
 * `Assets.during` would, but late: in the frame's own stage, after the
 * systems that draw with them have looked. The worst way round.
 */
const keepLate = (
  Forest: Forest,
  ...drawing: readonly System.System<never, any>[]
) => {
  let keep = System.make("ta/KeepLate", function* () {
    const store = yield* Assets.Store;

    if ((yield* Level).value === "forest") {
      store.hold(Forest, "ta/KeepLate");
    } else {
      store.drop(Forest, "ta/KeepLate");
    }
  }).pipe(System.inStage("frame"));

  for (const system of drawing) {
    keep = keep.pipe(System.after(system));
  }

  return keep;
};

const at = (x: number) => Position.of({ x, y: 0, z: 0 });

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
  more: { readonly smooth?: boolean; readonly color?: typeof Paint } = {}
) => {
  const looks: { readonly bark: Bark; readonly material: MeshBasicMaterial }[] =
    [];

  const freed: unknown[] = [];
  const meshes: InstancedMesh[] = [];

  const Trees = Three.instances("ta/Trees", {
    of: Tree,
    from: Forest,
    capacity: 2,
    // The renderer's own numbers, as they are.
    colorSpace: "srgb-linear",
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
  it("are drawn while the app holds the bundle loaded, in a look made of it once", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees, looks } = makeTrees(Forest, log);
    const { app, enter, mesh, renderer } = play([during(Forest), Trees]);
    app.world.spawn(Tree, at(1));
    app.world.spawn(Tree, at(2));
    app.world.spawn(Deer, at(9));
    // In the menu the forest is not loaded: there is nothing to draw with.
    app.tick(1);
    app.frame(0);
    app.frame(0);
    expect(renderer.drew).toStrictEqual([]);
    expect(log).toStrictEqual([]);

    enter("forest");
    expect(log).toStrictEqual(["open 1", "look 1", "prepare ta/Trees"]);
    expect(renderer.drew).toStrictEqual(["ta/Trees"]);
    const drawn = mesh()!;
    expect(drawn.geometry).toBe(geometry);
    expect(drawn.material).toBe(looks[0]!.material);
    expect(xs(drawn)).toStrictEqual([1, 2]);
    // It is the mesh of any instances: not culled, its buffer its own.
    expect(drawn.frustumCulled).toBe(false);

    // The look is made once, however long the level lasts, and the trees
    // that come and go are drawn as any are.
    const more = app.world.spawn(Tree, at(3));
    app.tick(1);
    app.frame(0);
    expect(xs(mesh()!)).toStrictEqual([1, 2, 3]);
    app.world.despawn(more);
    app.frame(0);
    expect(xs(mesh()!)).toStrictEqual([1, 2]);
    expect(mesh()).toBe(drawn);
    expect(log).toStrictEqual(["open 1", "look 1", "prepare ta/Trees"]);
    expect(renderer.stale).toBe(0);
  });

  it("are taken out of the scene when the bundle is let go, and what look made is handed to free", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees, freed, looks } = makeTrees(Forest, log);
    const { app, enter, mesh, renderer } = play([during(Forest), Trees]);
    app.world.spawn(Tree, at(1));
    enter("forest");
    const drawn = mesh()!;
    let disposed = 0;
    drawn.addEventListener("dispose", () => {
      disposed += 1;
    });
    log.length = 0;

    enter("menu");
    // The bark first, which is the bundle's, then what was made of it.
    expect(log).toStrictEqual(["close 1", "free 1"]);
    expect(freed).toStrictEqual([looks[0]]);
    expect(freed[0]).toBe(looks[0]);
    expect(renderer.drew).toStrictEqual([]);
    expect(drawn.parent).toBeNull();
    expect(disposed).toBe(1);
    // And it stays away, with nothing made or freed again.
    app.tick(1);
    app.frame(0);
    app.frame(0);
    expect(renderer.drew).toStrictEqual([]);
    expect(log).toStrictEqual(["close 1", "free 1"]);
    expect(renderer.stale).toBe(0);
  });

  it("are made again of what is loaded next, with the room the last had come to need", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees, looks } = makeTrees(Forest, log);
    const { app, enter, mesh } = play([during(Forest), Trees]);
    const trees = [1, 2, 3, 4, 5].map((x) => app.world.spawn(Tree, at(x)));
    enter("forest");
    const first = mesh()!;
    // Room for two was asked for, and five were drawn.
    expect(first.instanceMatrix.array).toHaveLength(8 * 16);
    enter("menu");

    // While it is away most of them go, and one comes.
    for (const tree of trees.slice(1)) {
      app.world.despawn(tree);
    }

    app.world.spawn(Tree, at(6));
    log.length = 0;

    enter("forest");
    expect(log).toStrictEqual(["open 2", "look 2", "prepare ta/Trees"]);
    const second = mesh()!;
    expect(second).not.toBe(first);
    expect(second.material).toBe(looks[1]!.material);
    expect(second.material).not.toBe(first.material);
    expect(looks[1]!.bark).toMatchObject({ load: 2, open: true, size: 3 });
    expect(xs(second)).toStrictEqual([1, 6]);
    // The room the first had grown to, though two would do for these: a
    // level that is entered again does not grow its way up again.
    expect(second.instanceMatrix.array).toHaveLength(8 * 16);
    expect(first.parent).toBeNull();
  });

  it("are never drawn with what was let go, whichever of the two systems runs first", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees } = makeTrees(Forest, log);

    // Listed after what draws, and nothing more said: `Assets.during` is
    // of the stage before a frame's own, so the trees find their bark in
    // the frame it is loaded, and find it gone in the frame it goes.
    const listed = play([
      Trees,
      Assets.during(State.is(Level, "forest"), Forest),
    ]);

    listed.app.world.spawn(Tree, at(1));
    listed.enter("forest");
    expect(log).toStrictEqual(["open 1", "look 1", "prepare ta/Trees"]);
    expect(listed.renderer.drew).toStrictEqual(["ta/Trees"]);
    listed.enter("menu");
    expect(listed.renderer.drew).toStrictEqual([]);
    expect(log.slice(-2)).toStrictEqual(["close 1", "free 1"]);
    expect(listed.renderer.stale).toBe(0);
    expect(listed.app.frameOrder.slice(-3)).toStrictEqual([
      "Assets.during(ta/Forest)",
      "ta/Trees",
      "arcadekit/three/Render",
    ]);

    // The worst way round, which a system of the game's own can still be:
    // the trees look, then the level lets its assets go, then the scene
    // is drawn.
    log.length = 0;
    const { app, enter, renderer } = play([Trees, keepLate(Forest, Trees)]);
    app.world.spawn(Tree, at(1));
    enter("forest");
    expect(renderer.drew).toStrictEqual([]);
    app.frame(0);
    expect(renderer.drew).toStrictEqual(["ta/Trees"]);
    log.length = 0;
    // The frame the level is left in, the trees saw their bark, and then
    // it was let go: they are gone all the same by the time it is drawn.
    enter("menu");
    expect(log).toStrictEqual(["close 2", "free 2"]);
    expect(renderer.drew).toStrictEqual([]);
    expect(renderer.stale).toBe(0);
    app.frame(0);
    expect(log).toStrictEqual(["close 2", "free 2"]);

    // In again, and out again.
    enter("forest");
    app.frame(0);
    expect(renderer.drew).toStrictEqual(["ta/Trees"]);
    enter("menu");
    expect(renderer.drew).toStrictEqual([]);
    expect(renderer.stale).toBe(0);
    expect(log.slice(-2)).toStrictEqual(["close 3", "free 3"]);
  });

  it("are made anew in the frame a bundle is found loaded again, though it was never seen gone", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees, looks } = makeTrees(Forest, log);
    // A system of the game's own keeps the forest, and can load it afresh.
    let afresh = false;

    const Keep = System.make("ta/Keep", function* () {
      const store = yield* Assets.Store;

      if (afresh) {
        afresh = false;
        store.drop(Forest, "ta/Keep");
      }

      store.hold(Forest, "ta/Keep");
    }).pipe(System.inStage("frame"), System.before(Trees));

    const { app, mesh, renderer } = play([Keep, Trees]);
    app.world.spawn(Tree, at(1));
    app.frame(0);
    const first = mesh()!;
    expect(log).toStrictEqual(["open 1", "look 1", "prepare ta/Trees"]);
    log.length = 0;

    afresh = true;
    app.frame(0);
    // Between one look and the next the bark became other bark: the old
    // look is freed and the new made, and the trees are drawn all the while.
    expect(log).toStrictEqual([
      "close 1",
      "open 2",
      "free 1",
      "look 2",
      "prepare ta/Trees",
    ]);
    expect(renderer.drew).toStrictEqual(["ta/Trees"]);
    expect(mesh()).not.toBe(first);
    expect(mesh()!.material).toBe(looks[1]!.material);
    expect(xs(mesh()!)).toStrictEqual([1]);
    expect(renderer.stale).toBe(0);
  });

  it("wait for a bundle that takes its time, and draw nothing of one that could not be loaded", async () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees } = makeTrees(Forest, log);

    const waiting: ((
      exit: Exit.Exit<Uint8Array, Assets.AssetFailed>
    ) => void)[] = [];

    const slow = Layer.succeed(Assets.Loader, {
      bytes: () =>
        Effect.callback<Uint8Array, Assets.AssetFailed>((resume) => {
          waiting.push((exit) => resume(exit));
        }),
    }) as Layer.Layer<never>;

    const { app, enter, renderer } = play([during(Forest), Trees], slow);
    app.world.spawn(Tree, at(1));
    enter("forest");
    app.frame(0);
    expect(renderer.drew).toStrictEqual([]);
    expect(log).toStrictEqual([]);
    // The file arrives.
    waiting[0]!(Exit.succeed(new Uint8Array([7])));
    await settle();
    expect(renderer.drew).toStrictEqual([]);
    app.frame(0);
    expect(renderer.drew).toStrictEqual(["ta/Trees"]);
    expect(log).toStrictEqual(["open 1", "look 1", "prepare ta/Trees"]);

    // Left and entered again, and this time it is not there.
    enter("menu");
    enter("forest");
    waiting[1]!(
      Exit.fail(new Assets.AssetFailed({ url: "/bark.png", message: "gone" }))
    );
    await settle();
    log.length = 0;
    app.frame(0);
    app.frame(0);
    expect(renderer.drew).toStrictEqual([]);
    expect(log).toStrictEqual([]);
    expect(renderer.stale).toBe(0);
  });

  it("go with the app's scope: what look made is freed once if it was there, and never if it was not", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees, freed } = makeTrees(Forest, log);
    const systems = [during(Forest), Trees];
    const loaded = play(systems);
    loaded.app.world.spawn(Tree, at(1));
    loaded.enter("forest");
    const drawn = loaded.mesh()!;
    loaded.close();
    expect(log.filter((line) => line === "free 1")).toStrictEqual(["free 1"]);
    expect(freed).toHaveLength(1);
    expect(drawn.parent).toBeNull();

    // An app that left the forest has nothing of it to free when it closes.
    log.length = 0;
    const left = play(systems);
    left.enter("forest");
    left.enter("menu");
    expect(log).toStrictEqual([
      "open 2",
      "look 2",
      "prepare ta/Trees",
      "close 2",
      "free 2",
    ]);
    left.close();
    expect(log).toHaveLength(5);

    // And one that never entered it made nothing.
    log.length = 0;
    const never = play(systems);
    never.app.tick(1);
    never.app.frame(0);
    never.close();
    expect(log).toStrictEqual([]);
  });

  it("are drawn between two ticks, and each in its colour, as any instances are", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const { Trees } = makeTrees(Forest, log, { smooth: true, color: Paint });
    const { app, enter, mesh } = play([during(Forest), Trees]);

    const tree = app.world.spawn(
      Tree,
      at(0),
      Paint.of({ r: 0.25, g: 0.5, b: 0.75 })
    );

    // Not painted: not one of these.
    app.world.spawn(Tree, at(99));
    enter("forest");
    expect(xs(mesh()!)).toStrictEqual([0]);
    expect([...mesh()!.instanceColor!.array.subarray(0, 3)]).toStrictEqual([
      0.25, 0.5, 0.75,
    ]);
    app.world.set(tree, Position, { x: 10 });
    app.tick(1);
    app.frame(0.5);
    expect(xs(mesh()!)).toStrictEqual([5]);

    // Away, it moves on; back, it is drawn where it is, and not on the way
    // from where it was last seen.
    enter("menu");
    app.world.set(tree, Position, { x: 30 });
    app.tick(1);
    app.frame(0.5);
    app.dispatch(Go, { to: "forest" });
    app.tick(1);
    app.frame(0.5);
    expect(xs(mesh()!)).toStrictEqual([30]);
  });

  it("say in their types what the look is made of, and that they need the app's assets", () => {
    const Forest = makeForest([]);
    const material = new MeshBasicMaterial();
    const Plain = Three.instances("ta/Plain", { of: Tree, geometry, material });

    const From = Three.instances("ta/From", {
      of: Tree,
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

    Three.instances("ta/Wrong", {
      of: Tree,
      from: Forest,
      // @ts-expect-error the forest has no leaves
      look: ({ leaves }) => ({ geometry, material, leaves }),
    });
    // @ts-expect-error a look that is there is not also made of a bundle
    Three.instances("ta/Both", { of: Tree, geometry, material, from: Forest });
    // @ts-expect-error a bundle is not a look until something makes one of it
    Three.instances("ta/Half", { of: Tree, from: Forest });
    // One that draws from a bundle needs the store of assets, which
    // `Assets.plugin` gives; one whose look is there does not.
    const plain: typeof Plain = Plain;
    // @ts-expect-error the store of assets is one thing more to need
    const also: typeof Plain = From;
    expect([plain.name, also.name]).toStrictEqual(["ta/Plain", "ta/From"]);
    expect(From.stage).toBe("frame");
  });

  it("ask nothing of an app's assets when their look is there: such an app needs no Assets.plugin", () => {
    const renderer = makeRenderer();
    const scope = Effect.runSync(Scope.make());
    const material = new MeshBasicMaterial();

    const app = Effect.runSync(
      App.make({
        plugins: [Three.plugin],
        components: [Tree],
        systems: [
          Three.instances("ta/Plain", { of: Tree, geometry, material }),
          Three.objects("ta/Things", { of: Deer, make: () => new Object3D() }),
        ],
      }).pipe(Effect.provide(renderer.layer), Scope.provide(scope))
    );

    app.world.spawn(Tree, at(1));
    app.frame(0);
    expect(renderer.drew).toStrictEqual(["ta/Plain"]);
    Effect.runSync(Scope.close(scope, Exit.void));
  });
});

describe("objects made of assets", () => {
  /** Deer, each an object made of the forest's bark. */
  const makeDeer = (Forest: Forest, log: string[]) =>
    Three.objects("ta/Deer", {
      of: Deer,
      from: Forest,
      make: (entity, { bark }) => {
        const object = new Object3D();
        object.name = `deer ${entity} of ${bark.load}`;
        object.userData = { bark };
        log.push(`make ${entity} of ${bark.load}`);

        return object;
      },
      free: (object, entity) => {
        log.push(
          `free ${entity} of ${(object.userData as { bark: Bark }).bark.load}`
        );
      },
    });

  it("are made while the app holds the bundle loaded, of what it holds, and all let go when it does not", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const Herd = makeDeer(Forest, log);
    const { app, enter, renderer } = play([during(Forest), Herd]);
    const one = app.world.spawn(Deer, at(1));
    const two = app.world.spawn(Deer, at(2));
    app.world.spawn(Tree, at(9));
    app.tick(1);
    app.frame(0);
    // No bark, no deer.
    expect(log).toStrictEqual([]);
    expect(renderer.drew).toStrictEqual([]);

    enter("forest");
    expect(log).toStrictEqual([
      "open 1",
      `make ${one} of 1`,
      `make ${two} of 1`,
    ]);
    expect(renderer.drew).toStrictEqual([
      `deer ${one} of 1`,
      `deer ${two} of 1`,
    ]);
    expect(
      renderer.scene!.children.map((child) => child.position.x)
    ).toStrictEqual([1, 2]);
    // While it lasts they are objects as any: made once, placed each
    // frame, and one whose entity goes is let go alone.
    app.world.set(one, Position, { x: 5 });
    app.world.despawn(two);
    const three = app.world.spawn(Deer, at(3));
    app.frame(0);
    expect(log.slice(3)).toStrictEqual([
      `free ${two} of 1`,
      `make ${three} of 1`,
    ]);
    expect(
      renderer.scene!.children.map((child) => child.position.x)
    ).toStrictEqual([5, 3]);
    log.length = 0;

    // The level is left: every deer goes, once.
    enter("menu");
    expect(log.toSorted()).toStrictEqual(
      ["close 1", `free ${one} of 1`, `free ${three} of 1`].toSorted()
    );
    expect(log[0]).toBe("close 1");
    expect(renderer.drew).toStrictEqual([]);
    const four = app.world.spawn(Deer, at(4));
    app.frame(0);
    expect(renderer.drew).toStrictEqual([]);
    log.length = 0;

    // And entered again: each is made anew, of the bark loaded now.
    enter("forest");
    expect(log.toSorted()).toStrictEqual(
      [
        "open 2",
        `make ${one} of 2`,
        `make ${three} of 2`,
        `make ${four} of 2`,
      ].toSorted()
    );
    expect(renderer.drew).toHaveLength(3);
    expect(renderer.stale).toBe(0);
  });

  it("are out of the scene before it is drawn in the frame their assets go, whichever system runs first, and freed with the app", () => {
    const log: string[] = [];
    const Forest = makeForest(log);
    const Herd = makeDeer(Forest, log);
    // The worst way round: the deer are looked at, then the level lets its
    // assets go, then the scene is drawn.
    // And trees beside them, of the same bark: every kind is asked.
    const { Trees } = makeTrees(Forest, []);

    const { app, close, enter, renderer } = play([
      Trees,
      Herd,
      keepLate(Forest, Trees, Herd),
    ]);

    const one = app.world.spawn(Deer, at(1));
    app.world.spawn(Tree, at(2));
    enter("forest");
    app.frame(0);
    expect(renderer.drew).toStrictEqual(["ta/Trees", `deer ${one} of 1`]);
    enter("menu");
    expect(renderer.drew).toStrictEqual([]);
    expect(renderer.stale).toBe(0);
    expect(log.slice(-2)).toStrictEqual(["close 1", `free ${one} of 1`]);

    enter("forest");
    app.frame(0);
    expect(renderer.drew).toStrictEqual(["ta/Trees", `deer ${one} of 2`]);
    const made = renderer.scene!.children[1]!;
    log.length = 0;
    close();
    expect(log.filter((line) => line.startsWith("free"))).toStrictEqual([
      `free ${one} of 2`,
    ]);
    expect(made.parent).toBeNull();
  });

  it("say in their types what an object is made of", () => {
    const Forest = makeForest([]);

    const Made = Three.objects("ta/Made", {
      of: Deer,
      from: Forest,
      make: (_entity: Entity, { bark }) => {
        const size: number = bark.size;
        void size;

        return new InstancedMesh(geometry, new MeshBasicMaterial(), 1);
      },
      // The object is the one `make` gives.
      free: (object) => object.dispose(),
    });

    Three.objects("ta/Wrong", {
      of: Deer,
      from: Forest,
      // @ts-expect-error the forest has no leaves
      make: (_entity, { leaves }) => new Object3D().add(leaves),
    });

    const Plain = Three.objects("ta/Plain", {
      of: Deer,
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
      const bytes = [...new Uint8Array(await blob.arrayBuffer())];
      asked.push({ bytes, options });

      if (bytes[0] === 0) {
        throw new Error("The source image could not be decoded.");
      }

      const bitmap = {
        width: 2,
        height: 2,
        closed: 0,
        close() {
          bitmap.closed += 1;
        },
      };

      bitmaps.push(bitmap);

      return bitmap;
    });

    return { asked, bitmaps };
  };

  it("is a picture decoded for Three.js, the right way up, and let go with the scope it was loaded in", async () => {
    const { asked, bitmaps } = stubBitmaps();
    const prepared: { readonly version: number; readonly space: string }[] = [];

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

    const scope = Effect.runSync(Scope.make());

    const { bark, normals } = await Effect.runPromise(
      Assets.load(Forest).pipe(
        Scope.provide(scope),
        Effect.provide(
          Assets.layerMemory({
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
    expect(prepared).toStrictEqual([{ version: 0, space: SRGBColorSpace }]);
    // It is to be sent to the renderer, once.
    expect(bark.version).toBe(1);
    expect(normals.version).toBe(1);
    // A bitmap is flipped when it is made, or never.
    expect(asked).toStrictEqual([
      { bytes: [9, 8, 7], options: { imageOrientation: "flipY" } },
      { bytes: [110, 110], options: { imageOrientation: "flipY" } },
    ]);
    let disposed = 0;
    bark.addEventListener("dispose", () => {
      disposed += 1;
    });
    expect(bitmaps.map((bitmap) => bitmap.closed)).toStrictEqual([0, 0]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(disposed).toBe(1);
    expect(bitmaps.map((bitmap) => bitmap.closed)).toStrictEqual([1, 1]);
  });

  it("is left as its file has it when it is told so where it is made, and refuses to be told in prepare", async () => {
    const { asked, bitmaps } = stubBitmaps();
    const files = Assets.layerMemory({ "/skin.png": new Uint8Array([1, 2]) });

    const load = (asset: Assets.Asset<Texture>) =>
      Effect.runPromise(
        Effect.exit(
          Effect.scoped(
            Effect.map(
              Assets.load(Assets.bundle("ta/Skin", { skin: asset })),
              ({ skin }) => ({ flipY: skin.flipY, image: skin.image })
            )
          )
        ).pipe(Effect.provide(files))
      );

    // A model's own picture, say: as the file has it.
    const seen: boolean[] = [];

    const plain = await load(
      Three.texture("/skin.png", {
        flipY: false,
        // Said again as it is, it is not a change.
        prepare: (texture) => {
          seen.push(texture.flipY);
          texture.flipY = false;
        },
      })
    );

    expect(plain).toStrictEqual(
      Exit.succeed({ flipY: false, image: bitmaps[0] })
    );
    expect(seen).toStrictEqual([false]);
    // And turned over, which is what it is when nothing says: the texture
    // says of itself how it was decoded.
    const flipped = await load(Three.texture("/skin.png", { flipY: true }));

    expect(flipped).toStrictEqual(
      Exit.succeed({ flipY: true, image: bitmaps[1] })
    );
    expect(asked.map((one) => one.options)).toStrictEqual([
      { imageOrientation: "from-image" },
      { imageOrientation: "flipY" },
    ]);

    // Three.js does not read flipY of a bitmap, so setting it in prepare
    // would do nothing, either way: the load fails and says where to.
    for (const [made, set] of [
      [undefined, false],
      [true, false],
      [false, true],
    ] as const) {
      const exit = await load(
        Three.texture("/skin.png", {
          ...(made === undefined ? {} : { flipY: made }),
          prepare: (texture) => {
            texture.flipY = set;
          },
        })
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        Cause.squash((exit as Exit.Failure<never, unknown>).cause)
      ).toStrictEqual(
        new Assets.AssetFailed({
          url: "/skin.png",
          message: `It could not be made a texture: flipY was set to ${set} in prepare, which does nothing: a texture made of a bitmap is turned over when it is decoded, and Three.js does not read flipY of it after. Say which way up it is where it is made: Three.texture("/skin.png", { flipY: ${set} }).`,
        })
      );
    }

    // How it is told is an object, as a model is: a function alone is not.
    // @ts-expect-error prepare is named
    Three.texture("/skin.png", () => {});
    // What was decoded for a load that failed is not kept.
    expect(bitmaps.map((bitmap) => bitmap.closed)).toStrictEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it("fails as an asset that could not be loaded when the file is no picture", async () => {
    stubBitmaps();

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Assets.load(
            Assets.bundle("ta/Broken", { bark: Three.texture("/bark.png") })
          )
        )
      ).pipe(
        Effect.provide(Assets.layerMemory({ "/bark.png": new Uint8Array([0]) }))
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const error = Cause.squash((exit as Exit.Failure<never, unknown>).cause);
    expect(error).toBeInstanceOf(Assets.AssetFailed);
    expect(error).toStrictEqual(
      new Assets.AssetFailed({
        url: "/bark.png",
        message:
          "It could not be made a texture: The source image could not be decoded.",
      })
    );
  });

  it("is what a level's instances are drawn with, for as long as the level", async () => {
    const { bitmaps } = stubBitmaps();

    const Forest = Assets.bundle("ta/Forest", {
      bark: Three.texture("/bark.png"),
    });

    const Trees = Three.instances("ta/Trees", {
      of: Tree,
      from: Forest,
      look: ({ bark }) => ({
        geometry,
        material: new MeshBasicMaterial({ map: bark }),
      }),
      free: ({ material }) => material.dispose(),
    });

    const { app, enter, mesh, renderer } = play([
      Trees,
      Assets.during(State.is(Level, "forest"), Forest),
    ]);

    app.world.spawn(Tree, at(1));
    enter("forest");
    // A picture is decoded in its own time.
    expect(renderer.drew).toStrictEqual([]);
    await settle();
    app.frame(0);
    expect(renderer.drew).toStrictEqual(["ta/Trees"]);
    const material = mesh()!.material as MeshBasicMaterial;
    expect(material.map).toBeInstanceOf(Texture);
    expect(material.map!.image).toBe(bitmaps[0]);
    const events: string[] = [];
    material.map!.addEventListener("dispose", () => events.push("texture"));
    material.addEventListener("dispose", () => events.push("material"));
    enter("menu");
    expect(events).toStrictEqual(["texture", "material"]);
    expect(bitmaps[0]!.closed).toBe(1);
    expect(renderer.drew).toStrictEqual([]);
  });
});
