import { describe, expect, it } from "@effect/vitest";
import {
  Action,
  App,
  Assets,
  Commands,
  Component,
  Field,
  Input,
  Plugin,
  Query,
  Singleton,
  System,
  Transform2d,
} from "arcadekit";
import { Effect, Layer, Logger, Schema } from "effect";
import {
  InstancedMesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Texture,
  Vector2,
  Vector3,
} from "three";
import type { Camera, Scene } from "three";

import { Three } from "../src/index.ts";

// --- a top-down game: the player aims at where the pointer is ----------------

const Player = Component.tag("fl/Player", {
  requires: [Transform2d.Position],
});
const Crate = Component.tag("fl/Crate", { requires: [Transform2d.Position] });

/** Where the player last aimed, and at what angle from where it stands. */
const Aimed = Singleton.define(
  "fl/Aimed",
  { x: Field.f64, y: Field.f64, angle: Field.f64 },
  { x: 0, y: 0, angle: 0 }
);
const Aim = Action.define("fl/Aim", {
  payload: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
});
const Step = Action.define("fl/Step", {
  payload: Schema.Struct({ x: Schema.Number }),
});
const PlayerAt = Query.all(Transform2d.Position).pipe(Query.with(Player));

/** The level is 64 by 36, and the player starts in its bottom left corner. */
const level = { left: 0, right: 64, bottom: 0, top: 36 } as const;
const start = { x: 4, y: 3 } as const;
const crates = [
  { x: 6, y: 5 },
  { x: 9, y: 2 },
] as const;

const Rules = Plugin.make("fl/Rules", {
  setup: Effect.gen(function* () {
    const commands = yield* Commands.spawns(
      Player,
      Crate,
      Transform2d.Position
    );
    commands.spawn(Player, Transform2d.Position.of(start));
    for (const at of crates) {
      commands.spawn(Crate, Transform2d.Position.of(at));
    }
  }),
  handlers: [
    Action.handler(Aim, function* ({ x, y }) {
      const aimed = yield* Singleton.Write(Aimed);
      aimed.x = x;
      aimed.y = y;
      (yield* Query.View(PlayerAt)).each((position) => {
        aimed.angle = Math.atan2(y - position.y, x - position.x);
      });
    }),
    Action.handler(Step, function* ({ x }) {
      (yield* Query.View(
        PlayerAt.pipe(Query.writes(Transform2d.Position))
      )).each((position) => {
        position.x = x;
      });
    }),
  ],
});

/** The input stage: a click aims at the place of the plane under it. */
const Click = Input.button("fl/Click", [Input.pointerButton()]);
const Aiming = System.input("fl/Aiming", function* () {
  if ((yield* Input.Read(Click)).pressed) {
    const at = yield* Three.toPlane(yield* Input.Pointer);
    (yield* Action.Actions).enqueue(Aim, at);
  }
});

// --- how it looks: sprites of a bundle's texture, through a flat camera -----

/** A picture twice as wide as it is high, as a page would decode it. */
const face = new Texture({ width: 64, height: 32 });
const Deck = Assets.bundle("fl/Deck", {
  face: Assets.make("/face.png", () => Effect.succeed(face)),
});
const files = Assets.layer(
  Assets.makeMemory({ "/face.png": new Uint8Array([1]) })
);

const lookOf = (height: number, smooth = false) =>
  Plugin.make("fl/Look", {
    plugins: [
      Three.plugin,
      Assets.plugin,
      Rules,
      Input.controls("fl/Controls", [Click]),
    ],
    systems: [
      Assets.during(Deck),
      Three.camera2d("fl/View", {
        height,
        follow: Player,
        within: level,
        smooth,
      }),
      Three.instancesFrom("fl/Crates", {
        of: Crate,
        transform: Transform2d,
        from: Deck,
        look: ({ face: picture }) => Three.sprite(picture),
      }),
      Three.instancesFrom("fl/Players", {
        of: Player,
        transform: Transform2d,
        from: Deck,
        smooth,
        look: ({ face: picture }) => Three.sprite(picture, { height: 2 }),
      }),
      Aiming,
    ],
  });

/** The renderer of a test, which draws nothing, on a canvas whose size the test sets. */
const makeCanvas = (width: number, height: number) => {
  const recorder = Three.makeRecorder({ width, height });
  return {
    size: recorder.canvas,
    layer: Three.layer(recorder),
    /** The scene and the camera it was last asked to render. */
    get scene(): Scene | undefined {
      return recorder.rendered.at(-1)?.scene;
    },
    get camera(): Camera | undefined {
      return recorder.rendered.at(-1)?.camera;
    },
  };
};

const play = Effect.fnUntraced(function* (
  height: number,
  canvas: ReturnType<typeof makeCanvas>,
  smooth = false
) {
  const source = Input.makeManualSource();
  const app = yield* App.make(
    App.define({ plugins: [lookOf(height, smooth)] }),
    {
      hashEvery: 0,
    }
  ).pipe(
    Effect.provide(
      Layer.mergeAll(canvas.layer, files, Input.layer(source), Logger.layer([]))
    )
  );
  // The deck loads in the background: frames until its sprites are drawn.
  for (
    let i = 0;
    i < 20 && meshOf(canvas.scene, "fl/Crates") === undefined;
    i++
  ) {
    yield* app.frame();
    yield* Effect.yieldNow;
  }
  return {
    app,
    /** A click at a point of the canvas, and the tick that reads it. */
    click: Effect.fnUntraced(function* (x: number, y: number) {
      source.move(Input.pointerX, x);
      source.move(Input.pointerY, y);
      source.tap(Input.pointerButton());
      yield* app.input();
      yield* app.tick(1 / 60);
      return yield* app.read(Singleton.Read(Aimed));
    }),
  };
});

/** An input-stage system that notes the place of the plane under a point of the canvas. */
const probe = (point: { readonly x: number; readonly y: number }) => {
  const seen: { readonly x: number; readonly y: number }[] = [];
  const Probe = System.input("fl/Probe", function* () {
    seen.push(yield* Three.toPlane(point));
  });
  return { Probe, seen };
};

const meshOf = (
  scene: Scene | undefined,
  name: string
): InstancedMesh | undefined =>
  scene?.children.find(
    (child): child is InstancedMesh =>
      child instanceof InstancedMesh && child.name === name
  );

/** Where a view of `half` either side of `at` stays inside `from` to `to`. */
const held = (at: number, half: number, from: number, to: number) =>
  Math.min(Math.max(at, from + half), to - half);

/** The pixel of the canvas a place of the plane is drawn at, as Three.js projects it. */
const pixelOf = (
  camera: Camera,
  size: { readonly width: number; readonly height: number },
  at: { readonly x: number; readonly y: number }
) => {
  const projected = new Vector3(at.x, at.y, 0).project(camera);
  return {
    x: ((projected.x + 1) / 2) * size.width,
    y: ((1 - projected.y) / 2) * size.height,
  };
};

describe("a flat game", () => {
  for (const height of [10, 20]) {
    for (const [width, tall] of [
      [800, 600],
      [400, 800],
    ] as const) {
      it.effect(
        `turns a click into the place under it, with a view ${height} high on a ${width} by ${tall} canvas that is not centred on the player`,
        () =>
          Effect.gen(function* () {
            const canvas = makeCanvas(width, tall);
            const { app, click } = yield* play(height, canvas);
            const camera = canvas.camera;
            if (!(camera instanceof OrthographicCamera)) {
              throw new Error("The scene was not drawn through a flat camera");
            }
            // The view is `height` of the game's units high, as wide as the
            // canvas's shape, and held inside the level: the player is in
            // its bottom left, off the middle.
            const halfHeight = height / 2;
            const halfWidth = (halfHeight * width) / tall;
            expect(camera.top - camera.bottom).toBeCloseTo(height, 6);
            expect(camera.right - camera.left).toBeCloseTo(2 * halfWidth, 6);
            const centre = {
              x: held(start.x, halfWidth, level.left, level.right),
              y: held(start.y, halfHeight, level.bottom, level.top),
            };
            expect(camera.position.x).toBeCloseTo(centre.x, 6);
            expect(camera.position.y).toBeCloseTo(centre.y, 6);
            expect(centre).not.toEqual(start);

            // Each corner of the canvas, its middle, and a point between, as
            // the view puts them on the plane, with y up.
            for (const [x, y] of [
              [0, 0],
              [width, tall],
              [width / 2, tall / 2],
              [width / 4, (3 * tall) / 4],
            ] as const) {
              const aimed = yield* click(x, y);
              const want = {
                x: centre.x - halfWidth + (x / width) * 2 * halfWidth,
                y: centre.y + halfHeight - (y / tall) * 2 * halfHeight,
              };
              expect(aimed.x, `x at ${x}, ${y}`).toBeCloseTo(want.x, 4);
              expect(aimed.y, `y at ${x}, ${y}`).toBeCloseTo(want.y, 4);
              expect(aimed.angle).toBeCloseTo(
                Math.atan2(want.y - start.y, want.x - start.x),
                6
              );
            }

            // A click on a crate, where Three.js draws it, aims at the crate.
            for (const at of crates) {
              const pixel = pixelOf(camera, canvas.size, at);
              const aimed = yield* click(pixel.x, pixel.y);
              expect(aimed.x).toBeCloseTo(at.x, 4);
              expect(aimed.y).toBeCloseTo(at.y, 4);
            }
            yield* app.close;
          })
      );
    }
  }

  it.effect(
    "draws a bundle's texture as sprites, each as wide as its picture makes it",
    () =>
      Effect.gen(function* () {
        const canvas = makeCanvas(800, 600);
        const { app } = yield* play(10, canvas);
        const drawn = meshOf(canvas.scene, "fl/Crates")!;
        expect(drawn.geometry).toBeInstanceOf(PlaneGeometry);
        const plane = drawn.geometry as PlaneGeometry;
        // The picture is twice as wide as it is high.
        expect(plane.parameters).toMatchObject({ width: 2, height: 1 });
        expect(
          (meshOf(canvas.scene, "fl/Players")!.geometry as PlaneGeometry)
            .parameters
        ).toMatchObject({ width: 4, height: 2 });
        expect(drawn.material).toBeInstanceOf(MeshBasicMaterial);
        const paint = drawn.material as MeshBasicMaterial;
        expect(paint.map).toBe(face);
        expect(paint.transparent).toBe(true);
        expect(
          Array.from({ length: drawn.count }, (_, i) => [
            drawn.instanceMatrix.array[i * 16 + 12],
            drawn.instanceMatrix.array[i * 16 + 13],
          ])
        ).toEqual(crates.map(({ x, y }) => [x, y]));
        yield* app.close;
      })
  );

  it.effect(
    "fits the view to the canvas in the frame its size changes, and a click after reads the new size",
    () =>
      Effect.gen(function* () {
        const canvas = makeCanvas(800, 600);
        const { app, click } = yield* play(10, canvas);
        canvas.size.width = 300;
        yield* app.frame();
        const camera = canvas.camera as OrthographicCamera;
        expect(camera.right - camera.left).toBeCloseTo(5, 6);
        // The view is 5 across and 10 high, on the player across and held
        // inside the level up: its top right corner is at 6.5 and 10.
        const aimed = yield* click(300, 0);
        expect(aimed.x).toBeCloseTo(6.5, 4);
        expect(aimed.y).toBeCloseTo(10, 4);
        yield* app.close;
      })
  );

  it.effect(
    "follows the player between two ticks as its sprite is drawn, so the player doesn't shake against the view",
    () =>
      Effect.gen(function* () {
        const canvas = makeCanvas(800, 600);
        const { app } = yield* play(10, canvas, true);
        // In the middle of the level, where the view is on the player.
        yield* app.dispatch(Step, { x: 30 });
        yield* app.tick(1 / 60);
        yield* app.frame(1);
        yield* app.dispatch(Step, { x: 31 });
        yield* app.tick(1 / 60);
        for (const alpha of [0, 0.25, 0.5, 1]) {
          yield* app.frame(alpha);
          const player = meshOf(canvas.scene, "fl/Players")!;
          const x = player.instanceMatrix.array[12]!;
          expect(x).toBeCloseTo(30 + alpha, 4);
          expect(canvas.camera!.position.x).toBeCloseTo(x, 4);
        }
        yield* app.close;
      })
  );

  it.effect(
    "reads the player where its sprite is drawn, from the same store, at every alpha, however many ticks ran",
    () =>
      Effect.gen(function* () {
        const canvas = makeCanvas(800, 600);
        const { app } = yield* play(10, canvas, true);
        const drawn = () =>
          meshOf(canvas.scene, "fl/Players")!.instanceMatrix.array[12]!;
        yield* app.dispatch(Step, { x: 30 });
        yield* app.tick(1 / 60);
        yield* app.frame(1);
        // Three ticks since the last frame, then frames between two ticks.
        for (const x of [31, 33, 36]) {
          yield* app.dispatch(Step, { x });
          yield* app.tick(1 / 60);
        }
        for (const alpha of [0.1, 0.4, 0.75]) {
          yield* app.frame(alpha);
          // Exactly where the sprite is: one value, not two that are close.
          expect(canvas.camera!.position.x).toBe(drawn());
          expect(drawn()).not.toBeCloseTo(36, 2);
        }
        yield* app.dispatch(Step, { x: 40 });
        yield* app.tick(1 / 60);
        yield* app.frame(0.5);
        expect(canvas.camera!.position.x).toBe(drawn());
        yield* app.close;
      })
  );

  it.effect("stays where it is put when it follows nothing", () =>
    Effect.gen(function* () {
      const canvas = makeCanvas(100, 100);
      const { Probe, seen } = probe({ x: 0, y: 0 });
      const Still = Plugin.make("fl/Still", {
        plugins: [Three.plugin],
        systems: [
          Three.camera2d("fl/Still", { height: 4, at: { x: 7, y: -2 } }),
          Probe,
        ],
      });
      const app = yield* App.make(App.define({ plugins: [Still] })).pipe(
        Effect.provide(canvas.layer)
      );
      yield* app.frame();
      expect(canvas.camera!.position.x).toBe(7);
      expect(canvas.camera!.position.y).toBe(-2);
      // The top left corner of the canvas is the view's.
      yield* app.input();
      expect(seen[0]!.x).toBeCloseTo(5, 6);
      expect(seen[0]!.y).toBeCloseTo(0, 6);
      yield* app.close;
    })
  );

  it("refuses a view of no height, or a level that is no rectangle, and says what to give", () => {
    expect(() => Three.camera2d("fl/Flat", { height: 0 })).toThrow(
      /height of 0\. Give the number of the game's units/
    );
    expect(() =>
      Three.camera2d("fl/Upside", {
        height: 10,
        within: { left: 0, right: 10, bottom: 10, top: 0 },
      })
    ).toThrow(/top is not above its bottom/);
  });

  it("refuses a sprite whose picture has no size yet, unless it is given both sides", () => {
    expect(() => Three.sprite(new Texture())).toThrow(
      /picture has no size yet/
    );
    expect(
      Three.sprite(new Texture(), { width: 3, height: 1 }).geometry.parameters
    ).toMatchObject({ width: 3, height: 1 });
    expect(Three.sprite(face, { width: 3 }).geometry.parameters).toMatchObject({
      width: 3,
      height: 1.5,
    });
  });

  it.effect(
    "is a point of the plane through a perspective camera too, where the line under the pointer crosses it",
    () =>
      Effect.gen(function* () {
        const canvas = makeCanvas(200, 100);
        const camera = new PerspectiveCamera(60, 2, 0.1, 100);
        camera.position.set(3, -1, 12);
        camera.lookAt(1, 1, 0);
        const { Probe, seen } = probe({ x: 50, y: 30 });
        const Tilted = Plugin.make("fl/Tilted", {
          plugins: [Three.plugin],
          systems: [Probe],
          layer: Layer.effectDiscard(
            Effect.map(Three.Scene, (shown) => {
              shown.camera = camera;
            })
          ),
        });
        const app = yield* App.make(App.define({ plugins: [Tilted] })).pipe(
          Effect.provide(canvas.layer)
        );
        yield* app.frame();
        yield* app.input();
        const at = seen[0]!;
        // What Three.js's own ray finds on the plane z = 0.
        const ray = new Raycaster();
        ray.setFromCamera(new Vector2(50 / 100 - 1, 1 - 30 / 50), camera);
        const want = ray.ray.intersectPlane(
          new Plane(new Vector3(0, 0, 1), 0),
          new Vector3()
        )!;
        expect(at.x).toBeCloseTo(want.x, 5);
        expect(at.y).toBeCloseTo(want.y, 5);
        yield* app.close;
      })
  );

  it.effect(
    "reads the canvas's size from a page's renderer, as the page lays it out",
    () => {
      // As much of a Three.js renderer as the layer uses.
      const canvas = { clientWidth: 200, clientHeight: 100 };
      const standIn = {
        domElement: canvas,
        setPixelRatio() {},
        setSize() {},
        render() {},
        dispose() {},
      };
      return Effect.gen(function* () {
        const { Probe, seen } = probe({ x: 200, y: 0 });
        const Page = Plugin.make("fl/Page", {
          plugins: [Three.plugin],
          systems: [Three.camera2d("fl/View", { height: 2 }), Probe],
        });
        const app = yield* App.make(App.define({ plugins: [Page] }));
        yield* app.frame();
        yield* app.input();
        // Twice as wide as high: the top right corner is at 2 and 1.
        expect(seen[0]).toEqual({ x: 2, y: 1 });
        canvas.clientWidth = 100;
        yield* app.frame();
        yield* app.input();
        // Now as wide as high, and the pointer is past its right edge.
        expect(seen[1]!.x).toBeCloseTo(3, 6);
        yield* app.close;
      }).pipe(Effect.provide(Three.layerRenderer(() => standIn)));
    }
  );

  it("can't be read by a tick, which reads where the player aimed from its action", () => {
    const Cheat = System.tick(
      "fl/Cheat",
      // @ts-expect-error A tick cannot read the camera, which is drawing's.
      function* () {
        yield* Three.toPlane({ x: 0, y: 0 });
      }
    );
    expect(Cheat.stage).toBe("update");
  });
});
