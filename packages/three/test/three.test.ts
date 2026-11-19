/// <reference types="node" />
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Field,
  Plugin,
  Query,
  System,
  Time,
  Transform3d,
  Transform2d,
} from "arcadekit";
import type { Entity } from "arcadekit";
import type { ComponentInput } from "arcadekit/ecs";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { Camera, Scene } from "three";
import { describe, expect, it } from "vitest";

import { Three } from "../src/index";

const { Position, Rotation, Scale } = Transform3d;

const Rock = Component.tag("th/Rock");
const Ship = Component.tag("th/Ship");
const Hidden = Component.tag("th/Hidden", { storage: "sparse" });
const Heavy = Component.tag("th/Heavy");

/** A colour of the game's own: three numbers, and one more that is not read. */
const Paint = Component.define("th/Paint", {
  r: Field.f32,
  g: Field.f32,
  b: Field.f32,
  shine: Field.f32,
});

const Velocity = Component.define("th/Velocity", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();

/** A renderer that draws nothing and notes what it was asked to draw. */
const makeRenderer = () => {
  const renderer = {
    frames: 0,
    scene: undefined as Scene | undefined,
    camera: undefined as Camera | undefined,
    /** How many instances each instanced mesh had when the scene was drawn. */
    counts: [] as number[],
    layer: undefined as unknown as Layer.Layer<Three.Renderer>,
  };

  renderer.layer = Layer.succeed(Three.Renderer, {
    render(scene, camera) {
      renderer.frames += 1;
      renderer.scene = scene;
      renderer.camera = camera;
      renderer.counts = scene.children
        .filter((child) => child instanceof InstancedMesh)
        .map((mesh) => mesh.count);
    },
  });

  return renderer;
};

/** An app in a scope of its own, which the test closes when it likes. */
const start = <A, E, R>(
  make: Effect.Effect<A, E, R>,
  renderer: { readonly layer: Layer.Layer<Three.Renderer> }
) => {
  const scope = Effect.runSync(Scope.make());

  const app = Effect.runSync(
    make.pipe(
      Effect.provide(renderer.layer),
      Scope.provide(scope)
    ) as Effect.Effect<A, E>
  );

  return {
    app,
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
  };
};

const Rocks = Three.instances("th/Rocks", { of: Rock, geometry, material });

const Look = Plugin.make("th/Look", {
  plugins: [Three.plugin],
  systems: [Rocks],
});

const meshOf = (scene: Scene | undefined, name: string): InstancedMesh => {
  const found = scene?.children.find((child) => child.name === name);

  if (!(found instanceof InstancedMesh)) {
    throw new Error(`The scene has no instanced mesh named "${name}"`);
  }

  return found;
};

/** The matrices a mesh draws, each as text, in an order that compares. */
const drawn = (mesh: InstancedMesh): string[] => {
  const out: string[] = [];

  for (let i = 0; i < mesh.count; i += 1) {
    out.push(
      Array.from(mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16)).join(
        " "
      )
    );
  }

  return out.toSorted();
};

/** What Three.js itself makes of an entity's place: the matrix it should be drawn with. */
const matrixOf = (app: App.Any, entity: Entity): string => {
  const position = app.world.get(entity, Position)!;
  const rotation = app.world.get(entity, Rotation);
  const scale = app.world.get(entity, Scale);

  const matrix = new Matrix4().compose(
    new Vector3(position.x, position.y, position.z),
    turnOf(rotation),
    scale === undefined
      ? new Vector3(1, 1, 1)
      : new Vector3(scale.x, scale.y, scale.z)
  );

  return Array.from(new Float32Array(matrix.elements)).join(" ");
};

/**
 * The turn a `Rotation` stands for, as Three.js wants it, of length 1:
 * the game's may be of any length, and all zeros is not turned at all.
 */
const turnOf = (
  rotation: { x: number; y: number; z: number; w: number } | undefined
): Quaternion =>
  rotation === undefined
    ? new Quaternion()
    : new Quaternion(
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w
      ).normalize();

/** The same turn, as a quaternion so many times as long. */
const stretched = (
  turn: { x: number; y: number; z: number; w: number },
  by: number
) => ({ x: turn.x * by, y: turn.y * by, z: turn.z * by, w: turn.w * by });

/** Checks that an object is turned as a `Rotation` says, to six decimals. */
const expectTurned = (
  object: Object3D,
  rotation: { x: number; y: number; z: number; w: number } | undefined
): void => {
  const want = turnOf(rotation);
  expect(object.quaternion.x).toBeCloseTo(want.x, 6);
  expect(object.quaternion.y).toBeCloseTo(want.y, 6);
  expect(object.quaternion.z).toBeCloseTo(want.z, 6);
  expect(object.quaternion.w).toBeCloseTo(want.w, 6);
};

/**
 * The sixteen numbers an entity should be drawn with, whichever transform
 * places it, as Three.js composes them. A flat one is in the plane of x
 * and y, turned about the axis that comes out of it.
 */
const placeOf = (app: App.Any, entity: Entity): number[] => {
  if (app.world.has(entity, Position)) {
    return matrixOf(app, entity)
      .split(" ")
      .map((text) => Number(text));
  }

  const position = app.world.get(entity, Transform2d.Position)!;
  const rotation = app.world.get(entity, Transform2d.Rotation);
  const scale = app.world.get(entity, Transform2d.Scale);

  return Array.from(
    new Float32Array(
      new Matrix4().compose(
        new Vector3(position.x, position.y, 0),
        new Quaternion().setFromAxisAngle(
          new Vector3(0, 0, 1),
          rotation?.angle ?? 0
        ),
        scale === undefined
          ? new Vector3(1, 1, 1)
          : new Vector3(scale.x, scale.y, 1)
      ).elements
    )
  );
};

/** In order of where they are, which no two entities of a test share. */
const byPlace = (rows: number[][]): number[][] =>
  rows.toSorted(
    (a, b) => a[12]! - b[12]! || a[13]! - b[13]! || a[14]! - b[14]!
  );

/**
 * Checks that a mesh draws exactly these entities, each where it is. To
 * six decimals: a turn in the plane is a sine and a cosine here and a
 * quaternion in Three.js, which agree to the last bit but one.
 */
const expectDrawn = (
  mesh: InstancedMesh,
  app: App.Any,
  entities: readonly Entity[]
): void => {
  expect(mesh.count).toBe(entities.length);
  const rows: number[][] = [];

  for (let i = 0; i < mesh.count; i += 1) {
    rows.push(
      Array.from(mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16))
    );
  }

  const drawnRows = byPlace(rows);
  const wanted = byPlace(entities.map((entity) => placeOf(app, entity)));

  for (let i = 0; i < wanted.length; i += 1) {
    for (let k = 0; k < 16; k += 1) {
      expect(drawnRows[i]![k], `instance ${i}, element ${k}`).toBeCloseTo(
        wanted[i]![k]!,
        5
      );
    }
  }
};

const expected = (app: App.Any, entities: readonly Entity[]): string[] =>
  entities.map((entity) => matrixOf(app, entity)).toSorted();

/** A small generator of its own, so that a failing run can be run again. */
const makeRandom = (seed: number) => {
  let state = seed >>> 0;

  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

    return state / 4_294_967_296;
  };

  return {
    next,
    int: (below: number) => Math.floor(next() * below),
    quaternion: () =>
      new Quaternion(
        next() - 0.5,
        next() - 0.5,
        next() - 0.5,
        next() - 0.5
      ).normalize(),
  };
};

describe("arcadekit's Transform3d, as Three.js reads it", () => {
  it("axisAngle gives the quaternion Three.js gives for the same turn", () => {
    for (const [x, y, z, angle] of [
      [0, 0, 1, Math.PI / 2],
      [0, 1, 0, Math.PI],
      [1, 0, 0, -0.3],
      [0.6, 0, 0.8, 2.5],
      [0, 1, 0, 0],
    ] as const) {
      const ours = Transform3d.axisAngle(x, y, z, angle);

      const theirs = new Quaternion().setFromAxisAngle(
        new Vector3(x, y, z),
        angle
      );

      expect(ours.x).toBeCloseTo(theirs.x, 12);
      expect(ours.y).toBeCloseTo(theirs.y, 12);
      expect(ours.z).toBeCloseTo(theirs.z, 12);
      expect(ours.w).toBeCloseTo(theirs.w, 12);
    }
  });
});

describe("Three.instances", () => {
  it("draws every entity of a kind as one instance of one mesh, where the entity is", () => {
    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Look] }), renderer);
    const turn = Transform3d.axisAngle(0, 0, 1, Math.PI / 3);

    const rocks = [
      app.world.spawn(Rock, Position.of({ x: 1, y: 2, z: 3 })),
      app.world.spawn(
        Rock,
        Position.of({ x: -4, y: 0.5, z: 9 }),
        Scale.of({ x: 2, y: 3, z: 0.5 })
      ),
      app.world.spawn(
        Rock,
        Position.of({ x: 7, y: 7, z: 7 }),
        Rotation.of(turn)
      ),
      app.world.spawn(
        Rock,
        Position.of({ x: 0, y: -1, z: 0 }),
        Rotation.of(Transform3d.axisAngle(1, 0, 0, 2)),
        Scale.of({ x: 0.25, y: 4, z: 1.5 })
      ),
    ];

    // Not rocks: the same four of another kind, and one that is nowhere.
    app.world.spawn(Ship, Position.of({ x: 5, y: 5, z: 5 }));
    app.world.spawn(Ship, Position.of({ x: 5, y: 5, z: 5 }), Scale);
    app.world.spawn(Ship, Position.of({ x: 5, y: 5, z: 5 }), Rotation);
    app.world.spawn(Ship, Position.of({ x: 5, y: 5, z: 5 }), Rotation, Scale);
    app.world.spawn(Rock);
    app.frame(0);

    const mesh = meshOf(renderer.scene, "th/Rocks");
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(mesh.count).toBe(4);
    expectDrawn(mesh, app, rocks);
    // One by hand, so that the test does not only agree with Three.js: a
    // rock that is only somewhere is drawn there, upright.
    expect(drawn(mesh)).toContain("1 0 0 0 0 1 0 0 0 0 1 0 1 2 3 1");
    // It is the one mesh of the scene, and it is not culled.
    expect(renderer.scene?.children).toEqual([mesh]);
    expect(mesh.frustumCulled).toBe(false);
  });

  it("draws a rotation left at zero as no turn at all", () => {
    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Look] }), renderer);
    app.world.spawn(Rock, Position.of({ x: 1, y: 2, z: 3 }), Rotation);
    app.world.spawn(
      Rock,
      Position.of({ x: 4, y: 5, z: 6 }),
      Rotation,
      Scale.of({ x: 2, y: 2, z: 2 })
    );
    app.frame(0);
    expect(drawn(meshOf(renderer.scene, "th/Rocks"))).toEqual([
      "1 0 0 0 0 1 0 0 0 0 1 0 1 2 3 1",
      "2 0 0 0 0 2 0 0 0 0 2 0 4 5 6 1",
    ]);
  });

  it("draws a rotation of any length as the turn it stands for, neither skewed nor sized by it", () => {
    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Look] }), renderer);
    const quarter = Transform3d.axisAngle(0, 0, 1, Math.PI / 2);

    const rocks = [
      // Three times too long, and a hundredth of what it should be.
      app.world.spawn(
        Rock,
        Position.of({ x: 1, y: 0, z: 0 }),
        Rotation.of(stretched(quarter, 3))
      ),
      app.world.spawn(
        Rock,
        Position.of({ x: 2, y: 0, z: 0 }),
        Rotation.of(stretched(quarter, 0.01)),
        Scale.of({ x: 2, y: 3, z: 4 })
      ),
      app.world.spawn(
        Rock,
        Position.of({ x: 3, y: 0, z: 0 }),
        Rotation.of(stretched(Transform3d.axisAngle(0.6, 0, 0.8, 1.2), 40)),
        Scale.of({ x: 0.5, y: 1, z: 6 })
      ),
    ];

    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/Rocks");
    // As Three.js draws the same turns made of length 1.
    expectDrawn(mesh, app, rocks);

    // And by hand. A quarter turn about z takes x to y and y to the
    // opposite of x, and leaves z: at the size it has, and no other.
    const rows = byPlace(
      [0, 1, 2].map((i) =>
        Array.from(mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16))
      )
    );

    const byHand = [
      [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1],
      [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 2, 0, 0, 1],
    ];

    for (const [i, row] of byHand.entries()) {
      for (let k = 0; k < 16; k += 1) {
        expect(rows[i]![k], `rock ${i}, element ${k}`).toBeCloseTo(row[k]!, 5);
      }
    }
  });

  it("follows the entities as they move, come and go, and gain and lose a rotation or a scale", () => {
    const random = makeRandom(20_261_116);
    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Look] }), renderer);
    const { world } = app;
    const alive: Entity[] = [];

    const place = () =>
      Position.of({
        x: random.next() * 100 - 50,
        y: random.next() * 100 - 50,
        z: random.next() * 100 - 50,
      });

    const turn = () => {
      const { w, x, y, z } = random.quaternion();

      return Rotation.of({ x, y, z, w });
    };

    const size = () =>
      Scale.of({
        x: 0.5 + random.next(),
        y: 0.5 + random.next(),
        z: 0.5 + random.next(),
      });

    for (let frame = 0; frame < 120; frame += 1) {
      for (let step = 0; step < 12; step += 1) {
        const roll = random.int(9);
        const one = alive[random.int(alive.length)];

        if (roll < 3 || one === undefined) {
          const parts = [Rock, place()] as ComponentInput[];

          if (random.next() < 0.5) {
            parts.push(turn());
          }

          if (random.next() < 0.5) {
            parts.push(size());
          }

          alive.push(world.spawn(...parts));
        } else if (roll === 3) {
          world.despawn(one);
          alive.splice(alive.indexOf(one), 1);
        } else if (roll === 4) {
          world.add(one, turn());
        } else if (roll === 5) {
          world.remove(one, Rotation);
        } else if (roll === 6) {
          world.add(one, size());
        } else if (roll === 7) {
          world.remove(one, Scale);
        } else {
          world.add(one, place());
        }
      }

      app.frame(0);
      const mesh = meshOf(renderer.scene, "th/Rocks");
      expect(mesh.count).toBe(alive.length);
      expectDrawn(mesh, app, alive);
    }

    // All four kinds of table were drawn from along the way.
    expect(
      alive.some((one) => world.has(one, Rotation) && world.has(one, Scale))
    ).toBe(true);
    expect(
      alive.some((one) => world.has(one, Rotation) && !world.has(one, Scale))
    ).toBe(true);
    expect(
      alive.some((one) => !world.has(one, Rotation) && world.has(one, Scale))
    ).toBe(true);
    expect(
      alive.some((one) => !world.has(one, Rotation) && !world.has(one, Scale))
    ).toBe(true);
  });

  it("draws only the entities that have every component it was given and none of those it was told to leave out", () => {
    const Heavies = Three.instances("th/Heavies", {
      of: [Rock, Heavy],
      without: [Hidden],
      geometry,
      material,
    });

    const renderer = makeRenderer();

    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Heavies] }),
      renderer
    );

    const { world } = app;
    const at = (x: number) => Position.of({ x, y: 0, z: 0 });
    const turn = Rotation.of(Transform3d.axisAngle(0, 1, 0, 1));
    const size = Scale.of({ x: 2, y: 3, z: 4 });

    // One of each kind of table, shown and hidden.
    const shown = [
      world.spawn(Rock, Heavy, at(1)),
      world.spawn(Rock, Heavy, at(2), size),
      world.spawn(Rock, Heavy, at(3), turn),
      world.spawn(Rock, Heavy, at(4), turn, size),
    ];

    const hidden = [
      world.spawn(Rock, Heavy, Hidden, at(5)),
      world.spawn(Rock, Heavy, Hidden, at(6), size),
      world.spawn(Rock, Heavy, Hidden, at(7), turn),
      world.spawn(Rock, Heavy, Hidden, at(8), turn, size),
    ];

    // With one of the two components only, of each kind too.
    for (const only of [Rock, Heavy]) {
      world.spawn(only, at(9));
      world.spawn(only, at(9), size);
      world.spawn(only, at(9), turn);
      world.spawn(only, at(9), turn, size);
    }

    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/Heavies");
    expect(mesh.count).toBe(4);
    expect(drawn(mesh)).toEqual(expected(app, shown));

    // Shown again, and hidden.
    for (const one of hidden) {
      world.remove(one, Hidden);
    }

    for (const one of shown) {
      world.add(one, Hidden);
    }

    app.frame(0);
    expect(mesh.count).toBe(4);
    expect(drawn(mesh)).toEqual(expected(app, hidden));
  });

  it("makes its mesh once, names it, and hands it over once to be prepared", () => {
    const prepared: InstancedMesh[] = [];

    const Shadows = Three.instances("th/Shadows", {
      of: Rock,
      geometry,
      material,
      prepare: (mesh) => {
        prepared.push(mesh);
        mesh.castShadow = true;
        mesh.frustumCulled = true;
      },
    });

    const renderer = makeRenderer();

    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Shadows] }),
      renderer
    );

    app.world.spawn(Rock, Position.of({ x: 0, y: 0, z: 0 }));
    app.frame(0);
    app.frame(0);
    app.tick(1 / 60);
    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/Shadows");
    expect(prepared).toEqual([mesh]);
    expect(mesh.castShadow).toBe(true);
    // What `prepare` says stands: it is asked last.
    expect(mesh.frustumCulled).toBe(true);
    expect(renderer.scene?.children.length).toBe(1);
  });

  it("doubles its room when it runs out, lets the renderer drop the old buffer, and keeps what it drew", () => {
    const Few = Three.instances("th/Few", {
      of: Rock,
      geometry,
      material,
      capacity: 4,
    });

    const renderer = makeRenderer();

    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Few] }),
      renderer
    );

    const rocks: Entity[] = [];

    const more = (count: number) => {
      for (let i = 0; i < count; i += 1) {
        rocks.push(
          app.world.spawn(Rock, Position.of({ x: rocks.length, y: 1, z: 2 }))
        );
      }
    };

    more(4);
    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/Few");
    const first = mesh.instanceMatrix;
    expect(first.array).toHaveLength(4 * 16);
    let dropped = 0;
    mesh.addEventListener("dispose", () => {
      dropped += 1;
    });
    // Full, and not over: nothing is allocated.
    app.frame(0);
    expect(mesh.instanceMatrix).toBe(first);
    expect(dropped).toBe(0);
    more(1);
    app.frame(0);
    expect(mesh.instanceMatrix).not.toBe(first);
    expect(mesh.instanceMatrix.array).toHaveLength(8 * 16);
    expect(dropped).toBe(1);
    expect(drawn(mesh)).toEqual(expected(app, rocks));
    // Far over, in one frame and across two kinds of table.
    more(40);
    rocks.push(
      app.world.spawn(
        Rock,
        Position.of({ x: -1, y: -1, z: -1 }),
        Scale.of({ x: 3, y: 3, z: 3 })
      )
    );
    app.frame(0);
    expect(mesh.instanceMatrix.array).toHaveLength(64 * 16);
    expect(dropped).toBe(2);
    expect(mesh.count).toBe(46);
    expect(drawn(mesh)).toEqual(expected(app, rocks));
    // The room is kept when the entities go.
    const full = mesh.instanceMatrix;

    for (const rock of rocks.splice(2)) {
      app.world.despawn(rock);
    }

    app.frame(0);
    expect(mesh.instanceMatrix).toBe(full);
    expect(mesh.count).toBe(2);
    expect(drawn(mesh)).toEqual(expected(app, rocks));
  });

  it("tells the renderer to send what is drawn and no more, each frame something is", () => {
    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Look] }), renderer);

    const rocks = [0, 1, 2].map((x) =>
      app.world.spawn(Rock, Position.of({ x, y: 0, z: 0 }))
    );

    app.frame(0);
    const attribute = meshOf(renderer.scene, "th/Rocks").instanceMatrix;
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 48 }]);
    const sent = attribute.version;
    expect(sent).toBeGreaterThan(0);
    // The renderer empties the list once it has sent it.
    attribute.clearUpdateRanges();
    app.world.despawn(rocks[0]!);
    app.frame(0);
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 32 }]);
    expect(attribute.version).toBe(sent + 1);
    // A renderer that sent nothing in between is not told twice.
    app.frame(0);
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 32 }]);
    // Nothing to draw: nothing to send.
    app.world.despawn(rocks[1]!);
    app.world.despawn(rocks[2]!);
    attribute.clearUpdateRanges();
    const before = attribute.version;
    app.frame(0);
    expect(meshOf(renderer.scene, "th/Rocks").count).toBe(0);
    expect(attribute.updateRanges).toEqual([]);
    expect(attribute.version).toBe(before);
  });

  // Where the last tick left them, and between their last two places.
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "draws ten thousand moving objects without one allocation per object per frame (smooth: %s, each of a colour of its own: %s)",
    (smooth, colored) => {
      const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));

      const MovingFlat = Query.all(Transform2d.Position, Velocity).pipe(
        Query.reads(Velocity)
      );

      const Move = System.make("th/Move", function* () {
        const { delta } = yield* Time;
        (yield* Moving).eachChunk((from, to, position, velocity) => {
          for (let i = from; i < to; i += 1) {
            position.x[i] = position.x[i]! + velocity.x[i]! * delta;
            position.y[i] = position.y[i]! + velocity.y[i]! * delta;
            position.z[i] = position.z[i]! + velocity.z[i]! * delta;
          }
        });
        (yield* MovingFlat).eachChunk((from, to, position, velocity) => {
          for (let i = from; i < to; i += 1) {
            position.x[i] = position.x[i]! + velocity.x[i]! * delta;
            position.y[i] = position.y[i]! + velocity.y[i]! * delta;
          }
        });
      });

      const Crowd = Three.instances("th/Crowd", {
        of: Rock,
        geometry,
        material,
        capacity: 16_384,
        smooth,
        ...(colored ? { color: Paint } : {}),
      });

      const renderer = makeRenderer();

      const { app } = start(
        App.make({ plugins: [Three.plugin], systems: [Move, Crowd] }),
        renderer
      );

      const random = makeRandom(5);
      const count = 10_000;
      const rocks: Entity[] = [];

      for (let i = 0; i < count; i += 1) {
        // Of every kind: an eighth each only placed, sized, turned, and
        // both, in three dimensions and in two.
        const flat = i % 8 >= 4;

        const parts = [
          Rock,
          flat
            ? Transform2d.Position.of({ x: random.next(), y: random.next() })
            : Position.of({
                x: random.next(),
                y: random.next(),
                z: random.next(),
              }),
          Velocity.of({ x: random.next(), y: random.next(), z: random.next() }),
        ] as ComponentInput[];

        if (colored) {
          parts.push(
            Paint.of({
              r: random.next(),
              g: random.next(),
              b: random.next(),
              shine: 0,
            })
          );
        }

        if (i % 2 === 1) {
          const { w, x, y, z } = random.quaternion();
          parts.push(
            flat
              ? Transform2d.Rotation.of({ angle: random.next() * 6 })
              : Rotation.of({ x, y, z, w })
          );
        }

        if (i % 4 >= 2) {
          parts.push(
            flat
              ? Transform2d.Scale.of({ x: 2, y: 3 })
              : Scale.of({ x: 2, y: 2, z: 2 })
          );
        }

        rocks.push(app.world.spawn(...parts));
      }

      const step = (): void => {
        app.tick(1 / 60);
        app.frame(0.5);
      };

      const startedAt = [
        app.world.get(rocks[0]!, Position)!.x,
        app.world.get(rocks[4]!, Transform2d.Position)!.x,
      ];

      // Until the loops are compiled, and whatever is made once is made.
      for (let i = 0; i < 200; i += 1) {
        step();
      }

      const mesh = meshOf(renderer.scene, "th/Crowd");
      const attribute = mesh.instanceMatrix;
      const buffer = attribute.array;
      const [range] = attribute.updateRanges;
      // How much the heap grew over one tick and one frame, many times: the
      // middle one, since now and then the collector runs in between.
      const grown: number[] = [];

      for (let i = 0; i < 101; i += 1) {
        const before = process.memoryUsage().heapUsed;
        step();
        grown.push(process.memoryUsage().heapUsed - before);
      }

      const typical = grown.toSorted((a, b) => a - b)[50]!;
      // The smallest thing that can be allocated, a number, is 12 bytes or
      // more. One of those per object would be 120,000 bytes a frame.
      expect(typical).toBeLessThan(count * 4);
      // And what it draws into is what it drew into: the same buffer, the
      // same attribute, the same range.
      expect(mesh.instanceMatrix).toBe(attribute);
      expect(attribute.array).toBe(buffer);
      expect(attribute.updateRanges[0]).toBe(range);
      // They did move, and they were drawn where they are.
      expect(renderer.frames).toBe(301);
      expect(renderer.counts).toEqual([count]);
      // All the way to the tick they are at, which is where both draw them.
      app.frame(1);
      expect(app.world.get(rocks[0]!, Position)!.x).toBeGreaterThan(
        startedAt[0]! + 0.01
      );
      expect(app.world.get(rocks[4]!, Transform2d.Position)!.x).toBeGreaterThan(
        startedAt[1]! + 0.01
      );
      expectDrawn(mesh, app, rocks);
    }
  );

  it("takes its mesh out of the scene and disposes of it when the app's scope closes, and leaves the geometry and the material alone", () => {
    const renderer = makeRenderer();
    const { app, close } = start(App.make({ plugins: [Look] }), renderer);
    app.world.spawn(Rock, Position.of({ x: 0, y: 0, z: 0 }));
    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/Rocks");
    const disposed: string[] = [];
    mesh.addEventListener("dispose", () => disposed.push("mesh"));
    geometry.addEventListener("dispose", () => disposed.push("geometry"));
    material.addEventListener("dispose", () => disposed.push("material"));
    close();
    expect(disposed).toEqual(["mesh"]);
    expect(mesh.parent).toBeNull();
    expect(renderer.scene?.children).toEqual([]);
  });
});

describe("a flat game's Transform2d", () => {
  const Flat = Transform2d;
  const at = (x: number, y: number) => Flat.Position.of({ x, y });

  it("is drawn by Three.instances in the plane of x and y, turned about the axis that comes out of it", () => {
    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Look] }), renderer);

    const rocks = [
      app.world.spawn(Rock, at(3, 4)),
      app.world.spawn(Rock, at(-1, 2), Flat.Scale.of({ x: 2, y: 5 })),
      app.world.spawn(
        Rock,
        at(6, -7),
        Flat.Rotation.of({ angle: Math.PI / 2 })
      ),
      app.world.spawn(
        Rock,
        at(0.5, 9),
        Flat.Rotation.of({ angle: 0.7 }),
        Flat.Scale.of({ x: 3, y: 0.5 })
      ),
    ];

    // Not rocks, and one that is nowhere.
    app.world.spawn(Ship, at(8, 8));
    app.world.spawn(Ship, at(8, 8), Flat.Rotation, Flat.Scale);
    app.world.spawn(Rock, Flat.Rotation.of({ angle: 1 }));
    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/Rocks");
    expectDrawn(mesh, app, rocks);
    // By hand, so that the test does not only agree with Three.js. Only
    // somewhere; sized; and a quarter turn, which takes x to y.
    expect(drawn(mesh)).toContain("1 0 0 0 0 1 0 0 0 0 1 0 3 4 0 1");
    expect(drawn(mesh)).toContain("2 0 0 0 0 5 0 0 0 0 1 0 -1 2 0 1");

    const quarter = byPlace(
      Array.from({ length: 4 }, (_, i) =>
        Array.from(mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16))
      )
    ).find((row) => row[12] === 6)!;

    expect(quarter[0]).toBeCloseTo(0, 6);
    expect(quarter[1]).toBeCloseTo(1, 6);
    expect(quarter[4]).toBeCloseTo(-1, 6);
    expect(quarter[5]).toBeCloseTo(0, 6);
    expect(quarter.slice(8)).toEqual([0, 0, 1, 0, 6, -7, 0, 1]);
  });

  it("is drawn beside entities placed in three dimensions, and an entity with both positions once, from that one", () => {
    const random = makeRandom(404);
    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Look] }), renderer);
    const { world } = app;
    const alive: Entity[] = [];
    const place = () => at(random.next() * 100 - 50, random.next() * 100 - 50);
    const turn = () => Flat.Rotation.of({ angle: random.next() * 7 - 3.5 });

    const size = () =>
      Flat.Scale.of({ x: 0.5 + random.next(), y: 0.5 + random.next() });

    for (let frame = 0; frame < 100; frame += 1) {
      for (let step = 0; step < 12; step += 1) {
        const roll = random.int(10);
        const one = alive[random.int(alive.length)];

        if (roll < 3 || one === undefined) {
          const parts = [Rock] as ComponentInput[];
          // Most are flat; some are in three dimensions; a few are both.
          const kind = random.int(6);

          if (kind !== 0) {
            parts.push(place());
          }

          if (kind === 0 || kind === 1) {
            parts.push(
              Position.of({
                x: random.next() * 100,
                y: random.next() * 100,
                z: random.next() * 100,
              })
            );
          }

          if (random.next() < 0.5) {
            parts.push(turn());
          }

          if (random.next() < 0.5) {
            parts.push(size());
          }

          if (random.next() < 0.2) {
            const { w, x, y, z } = random.quaternion();
            parts.push(Rotation.of({ x, y, z, w }));
          }

          alive.push(world.spawn(...parts));
        } else if (roll === 3) {
          world.despawn(one);
          alive.splice(alive.indexOf(one), 1);
        } else if (roll === 4) {
          world.add(one, turn());
        } else if (roll === 5) {
          world.remove(one, Flat.Rotation);
        } else if (roll === 6) {
          world.add(one, size());
        } else if (roll === 7) {
          world.remove(one, Flat.Scale);
        } else if (roll === 8 && world.has(one, Flat.Position)) {
          world.add(one, place());
        } else if (world.has(one, Flat.Position)) {
          // Lifted out of the plane, or put back in it.
          if (world.has(one, Position)) {
            world.remove(one, Position);
          } else {
            world.add(one, Position.of({ x: frame, y: step, z: -frame }));
          }
        }
      }

      app.frame(0);
      expectDrawn(meshOf(renderer.scene, "th/Rocks"), app, alive);
    }

    // All of it was drawn from along the way.
    const has = (...parts: Parameters<typeof world.has>[1][]) =>
      alive.some((one) => parts.every((part) => world.has(one, part)));

    expect(has(Flat.Position, Flat.Rotation, Flat.Scale)).toBe(true);
    expect(has(Flat.Position, Position)).toBe(true);
    expect(
      alive.some(
        (one) =>
          world.has(one, Flat.Position) &&
          !world.has(one, Position) &&
          !world.has(one, Flat.Rotation) &&
          !world.has(one, Flat.Scale)
      )
    ).toBe(true);
    expect(alive.length).toBeGreaterThan(50);
  });

  it("is drawn only for the entities that have every component it was given and none of those it was told to leave out", () => {
    const Heavies = Three.instances("th/FlatHeavies", {
      of: [Rock, Heavy],
      without: [Hidden],
      geometry,
      material,
    });

    const renderer = makeRenderer();

    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Heavies] }),
      renderer
    );

    const { world } = app;
    const turn = Flat.Rotation.of({ angle: 1 });
    const size = Flat.Scale.of({ x: 2, y: 3 });

    // One of each kind of table, shown and hidden.
    const shown = [
      world.spawn(Rock, Heavy, at(1, 0)),
      world.spawn(Rock, Heavy, at(2, 0), size),
      world.spawn(Rock, Heavy, at(3, 0), turn),
      world.spawn(Rock, Heavy, at(4, 0), turn, size),
    ];

    const hidden = [
      world.spawn(Rock, Heavy, Hidden, at(5, 0)),
      world.spawn(Rock, Heavy, Hidden, at(6, 0), size),
      world.spawn(Rock, Heavy, Hidden, at(7, 0), turn),
      world.spawn(Rock, Heavy, Hidden, at(8, 0), turn, size),
    ];

    for (const only of [Rock, Heavy]) {
      world.spawn(only, at(9, 0));
      world.spawn(only, at(9, 0), size);
      world.spawn(only, at(9, 0), turn);
      world.spawn(only, at(9, 0), turn, size);
    }

    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/FlatHeavies");
    expectDrawn(mesh, app, shown);

    for (const one of hidden) {
      world.remove(one, Hidden);
    }

    for (const one of shown) {
      world.add(one, Hidden);
    }

    app.frame(0);
    expectDrawn(mesh, app, hidden);
  });

  it("places an object of Three.objects in the plane, and leaves the rest of it as it was made", () => {
    const made: { readonly object: Object3D; readonly entity: Entity }[] = [];
    const freed: Entity[] = [];

    const Cards = Three.objects("th/Cards", {
      of: Ship,
      without: [Hidden],
      make: (entity) => {
        const object = new Group();
        // In front of the plane, tipped about x, and deep: the game's own.
        object.position.z = 5;
        object.rotation.x = 0.25;
        object.scale.z = 4;
        made.push({ object, entity });

        return object;
      },
      free: (_, entity) => {
        freed.push(entity);
      },
    });

    const renderer = makeRenderer();

    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Cards] }),
      renderer
    );

    const { world } = app;

    const objectOf = (entity: Entity): Object3D =>
      made.findLast((one) => one.entity === entity)!.object;

    const plain = world.spawn(Ship, at(1, 2));

    const whole = world.spawn(
      Ship,
      at(-3, -4),
      Flat.Rotation.of({ angle: 0.5 }),
      Flat.Scale.of({ x: 2, y: 3 })
    );

    // Turned and sized, and nowhere; and hidden.
    world.spawn(Ship, Flat.Rotation, Flat.Scale);
    world.spawn(Ship, Hidden, at(9, 9), Flat.Rotation, Flat.Scale);
    app.frame(0);
    expect(made.map((one) => one.entity).toSorted()).toEqual([plain, whole]);
    expect(objectOf(plain).position.toArray()).toEqual([1, 2, 5]);
    expect(objectOf(plain).rotation.z).toBe(0);
    expect(objectOf(plain).scale.toArray()).toEqual([1, 1, 4]);
    expect(objectOf(whole).position.toArray()).toEqual([-3, -4, 5]);
    expect(objectOf(whole).rotation.x).toBe(0.25);
    expect(objectOf(whole).rotation.z).toBe(0.5);
    expect(objectOf(whole).scale.toArray()).toEqual([2, 3, 4]);
    // It follows its entity, and is not made again.
    world.set(whole, Flat.Position, { x: 10, y: 20 });
    world.set(whole, Flat.Rotation, { angle: 1.5 });
    world.set(whole, Flat.Scale, { x: 5, y: 6 });
    app.frame(0);
    expect(made).toHaveLength(2);
    expect(objectOf(whole).position.toArray()).toEqual([10, 20, 5]);
    expect(objectOf(whole).rotation.z).toBe(1.5);
    expect(objectOf(whole).scale.toArray()).toEqual([5, 6, 4]);
    // One that is no longer turned, or sized, is as one that never was:
    // in the plane only, the rest as it was made.
    world.remove(whole, Flat.Rotation);
    app.frame(0);
    expect(objectOf(whole).rotation.z).toBe(0);
    expect(objectOf(whole).rotation.x).toBe(0.25);
    expect(objectOf(whole).scale.toArray()).toEqual([5, 6, 4]);
    world.remove(whole, Flat.Scale);
    app.frame(0);
    expect(objectOf(whole).scale.toArray()).toEqual([1, 1, 4]);
    // What the game then sets is left alone.
    objectOf(whole).rotation.z = 2;
    objectOf(whole).scale.x = 7;
    app.frame(0);
    expect(objectOf(whole).rotation.z).toBe(2);
    expect(objectOf(whole).scale.x).toBe(7);
    // Lifted out of the plane, it is placed in three dimensions.
    world.add(plain, Position.of({ x: 7, y: 8, z: 9 }));
    app.frame(0);
    expect(objectOf(plain).position.toArray()).toEqual([7, 8, 9]);
    expect(made).toHaveLength(2);
    // And it goes with its entity like any other.
    world.despawn(plain);
    world.add(whole, Hidden);
    app.frame(0);
    expect(freed.toSorted()).toEqual([plain, whole].toSorted());
    expect(renderer.scene?.children).toEqual([]);
  });

  it("keeps what it knows of its objects when a frame brings so many more that its room has to grow", () => {
    const made = new Map<Entity, Object3D>();

    const Cards = Three.objects("th/ManyCards", {
      of: Ship,
      make: (entity) => {
        const object = new Group();
        object.rotation.x = 0.25;
        made.set(entity, object);

        return object;
      },
    });

    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Cards] }),
      makeRenderer()
    );

    const first = app.world.spawn(
      Ship,
      at(1, 1),
      Flat.Rotation.of({ angle: 2 })
    );

    app.frame(0);
    expect(made.get(first)!.rotation.z).toBe(2);
    // In one frame: the first is no longer turned, and a crowd arrives
    // after it, more than there was room for.
    app.world.remove(first, Flat.Rotation);

    for (let i = 0; i < 200; i += 1) {
      app.world.spawn(Ship, at(i, 2));
    }

    app.frame(0);
    expect(made.size).toBe(201);
    // Its turn in the plane is gone, and the turn it was made with is not.
    expect(made.get(first)!.rotation.z).toBe(0);
    expect(made.get(first)!.rotation.x).toBe(0.25);
  });

  it("is listed by Three.plugin, so that a flat game that is drawn saves and loads", () => {
    const Flatland = Plugin.make("th/Flatland", {
      plugins: [Three.plugin],
      components: [Rock],
      systems: [Rocks],
    });

    const first = start(App.make({ plugins: [Flatland] }), makeRenderer());

    const rock = first.app.world.spawn(
      Rock,
      at(4, 5),
      Flat.Rotation.of({ angle: 1 }),
      Flat.Scale.of({ x: 2, y: 2 })
    );

    const save = first.app.save();

    if (Exit.isFailure(save)) {
      throw new Error("The game could not be saved");
    }

    const renderer = makeRenderer();

    const { app } = start(
      App.load(save.value, { plugins: [Flatland] }),
      renderer
    );

    expect(app.world.hash()).toBe(first.app.world.hash());
    app.frame(0);
    expectDrawn(meshOf(renderer.scene, "th/Rocks"), app, [rock]);
  });
});

describe("an entity drawn between two ticks", () => {
  const Flat = Transform2d;

  /** Moves every rock ten along x a tick, and every flat one too. */
  const Slide = System.make("th/Slide", function* () {
    (yield* Query.all(Position)).each((position) => {
      position.x += 10;
    });
    (yield* Query.all(Flat.Position)).each((position) => {
      position.x += 10;
    });
  });

  const Smoothed = Three.instances("th/Smoothed", {
    of: Rock,
    without: [Hidden],
    geometry,
    material,
    smooth: true,
  });

  const play = (...systems: Parameters<typeof App.make>[0]["systems"] & {}) => {
    const renderer = makeRenderer();

    const { app } = start(
      App.make({
        plugins: [Three.plugin],
        components: [Rock, Hidden],
        systems: [Slide, ...systems],
      }),
      renderer
    );

    return { app, renderer, mesh: () => meshOf(renderer.scene, "th/Smoothed") };
  };

  /** The sixteen numbers of the instance that is at this height: no two of a test share one. */
  const rowAt = (mesh: InstancedMesh, y: number): number[] => {
    for (let i = 0; i < mesh.count; i += 1) {
      const row = Array.from(
        mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16)
      );

      if (Math.abs(row[13]! - y) < 1e-4) {
        return row;
      }
    }

    throw new Error(`Nothing is drawn at height ${y}`);
  };

  const xAt = (mesh: InstancedMesh, y: number): number => rowAt(mesh, y)[12]!;

  it("is where it is the first frame it is seen, and from then on between where it was a tick ago and where it is", () => {
    const { app, mesh } = play(Smoothed);
    app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    // Never drawn before: there is nowhere to come from, whatever the frame.
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(0);
    app.tick(1);
    // Just after the tick it is still where it was, and then on its way.
    app.frame(0);
    expect(xAt(mesh(), 1)).toBe(0);
    app.frame(0.25);
    expect(xAt(mesh(), 1)).toBe(2.5);
    app.frame(0.75);
    expect(xAt(mesh(), 1)).toBe(7.5);
    // A tick later the place it has come to is the one it comes from.
    app.tick(1);
    app.frame(0);
    expect(xAt(mesh(), 1)).toBe(10);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(15);
    // No further than where it is, and no further back than where it was.
    app.frame(1);
    expect(xAt(mesh(), 1)).toBe(20);
    app.frame(3);
    expect(xAt(mesh(), 1)).toBe(20);
    app.frame(-2);
    expect(xAt(mesh(), 1)).toBe(10);
  });

  it("is drawn between its last two places when its id is past what 32 bits hold", () => {
    const { app, mesh } = play(Smoothed);

    // A slot given out 1,100 times: the next entity in it has such an id.
    for (let n = 0; n < 1100; n += 1) {
      app.world.despawn(app.world.spawn(Rock));
    }

    const rock = app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    expect(rock).toBeGreaterThan(2 ** 32);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(0);
    app.tick(1);
    // It is known for the entity it was a frame ago, and is on its way.
    app.frame(0.25);
    expect(xAt(mesh(), 1)).toBe(2.5);
    app.frame(0.75);
    expect(xAt(mesh(), 1)).toBe(7.5);
  });

  it("comes from where it was last drawn when several ticks ran since, and stays between the two when none did", () => {
    const { app, mesh } = play(Smoothed);
    const rock = app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    app.frame(0);
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(5);
    // Three ticks and then a frame: from 10, where it was, to 40.
    app.tick(1);
    app.tick(1);
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(25);
    // Frames with no tick between them: the same two places.
    app.frame(0.1);
    expect(xAt(mesh(), 1)).toBe(13);
    app.frame(0.9);
    expect(xAt(mesh(), 1)).toBe(37);
    // Moved with no tick, by an action or by hand: it goes there from
    // where it was coming from.
    app.world.set(rock, Position, { x: 110 });
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(60);
  });

  it("draws an entity it has not been drawing where it is: a new one, one in a slot that was another's, one that was hidden", () => {
    const { app, mesh } = play(Smoothed);
    const { world } = app;
    const old = world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    const hidden = world.spawn(Rock, Position.of({ x: 0, y: 2, z: 0 }));
    app.frame(0);
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(5);
    // Gone, and its slot taken by another, far away: not drawn on the way
    // from where the old one was.
    world.despawn(old);
    const fresh = world.spawn(Rock, Position.of({ x: 500, y: 3, z: 0 }));
    expect(fresh & 0x3f_ff_ff).toBe(old & 0x3f_ff_ff);
    world.add(hidden, Hidden);
    app.tick(1);
    app.frame(0.5);
    expect(mesh().count).toBe(1);
    expect(xAt(mesh(), 3)).toBe(510);
    // From its second frame on it is on its way like any other.
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 3)).toBe(515);
    // Shown again after frames in which it was not drawn: where it is.
    world.remove(hidden, Hidden);
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 2)).toBe(40);
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 2)).toBe(45);
  });

  it("starts over when its system did not run for a frame", () => {
    const Phase = { on: true };
    const Gated = Smoothed.pipe(System.runIf(Effect.sync(() => Phase.on)));
    const { app, mesh } = play(Gated);
    app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    app.frame(0);
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(5);
    Phase.on = false;
    app.tick(1);
    app.frame(0.5);
    Phase.on = true;
    app.tick(1);
    app.frame(0.5);
    // Not from 10, where it was last drawn from, two frames ago.
    expect(xAt(mesh(), 1)).toBe(30);
  });

  it("is drawn where it is when it went further in a tick than it was told an entity can", () => {
    const Wrapping = Three.instances("th/Smoothed", {
      of: Rock,
      geometry,
      material,
      smooth: true,
      snap: 50,
    });

    const { app, mesh } = play(Wrapping);
    const { world } = app;
    const rock = world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    const card = world.spawn(Rock, Flat.Position.of({ x: 0, y: 2 }));
    app.frame(0);
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(5);
    expect(xAt(mesh(), 2)).toBe(5);
    // Off one edge and in at the other: not drawn crossing the screen.
    world.set(rock, Position, { x: -400 });
    world.set(card, Flat.Position, { x: 300 });
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(-390);
    expect(xAt(mesh(), 2)).toBe(310);
    // And on its way again from there.
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(-385);
    expect(xAt(mesh(), 2)).toBe(315);
    // Wherever it went: up and away as well as along.
    world.set(rock, Position, { x: -380, y: 91, z: 60 });
    world.set(card, Flat.Position, { x: 320, y: 92 });
    app.tick(1);
    app.frame(0.5);
    expect(rowAt(mesh(), 91).slice(12, 15)).toEqual([-370, 91, 60]);
    expect(rowAt(mesh(), 92).slice(12, 15)).toEqual([330, 92, 0]);
    world.set(rock, Position, { y: 1, z: 0 });
    app.tick(1);
    app.frame(1);
    // Exactly as far as it may go is not too far.
    // (It is at -360 now, and goes ten more with the tick.)
    world.set(rock, Position, { x: -320 });
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(-335);
    // And a hair further is.
    world.set(rock, Position, { x: -269.5 });
    app.tick(1);
    app.frame(0.5);
    expect(xAt(mesh(), 1)).toBe(-259.5);
  });

  it("draws an entity in a slot that was another's turned and sized as it is, not on the way from the other's", () => {
    const { app, mesh } = play(Smoothed);
    const { world } = app;

    const olds = [
      world.spawn(
        Rock,
        Position.of({ x: 0, y: 1, z: 0 }),
        Rotation.of(Transform3d.axisAngle(0, 0, 1, 0.2)),
        Scale.of({ x: 1, y: 1, z: 1 })
      ),
      world.spawn(
        Rock,
        Flat.Position.of({ x: 0, y: 2 }),
        Flat.Rotation.of({ angle: 0.2 }),
        Flat.Scale.of({ x: 1, y: 1 })
      ),
    ];

    app.frame(0);
    app.tick(1);
    app.frame(0.5);
    // Both gone, and their slots taken at once, the second's first.
    world.despawn(olds[0]!);
    world.despawn(olds[1]!);

    const flat = world.spawn(
      Rock,
      Flat.Position.of({ x: 100, y: 4 }),
      Flat.Rotation.of({ angle: 2.5 }),
      Flat.Scale.of({ x: 6, y: 7 })
    );

    const solid = world.spawn(
      Rock,
      Position.of({ x: 100, y: 3, z: 0 }),
      Rotation.of(Transform3d.axisAngle(0, 0, 1, 2.5)),
      Scale.of({ x: 6, y: 7, z: 8 })
    );

    expect([flat & 0x3f_ff_ff, solid & 0x3f_ff_ff].toSorted()).toEqual(
      olds.map((one) => one & 0x3f_ff_ff).toSorted()
    );
    app.tick(1);
    app.frame(0.5);
    expectDrawn(mesh(), app, [flat, solid]);
  });

  it("turns by the shorter way and grows evenly, in three dimensions", () => {
    const { app, mesh } = play(Smoothed);
    const { world } = app;
    // About an axis that leans, so that every number of the turn changes.
    const quarter = Transform3d.axisAngle(0.6, 0, 0.8, Math.PI / 2);

    const rock = world.spawn(
      Rock,
      Position.of({ x: 0, y: 1, z: 0 }),
      Rotation.of({ x: 0, y: 0, z: 0, w: 1 }),
      Scale.of({ x: 1, y: 1, z: 1 })
    );

    world.spawn(Rock, Position.of({ x: 0, y: 2, z: 0 }), Rotation);
    app.frame(0);
    world.set(rock, Rotation, quarter);
    world.set(rock, Scale, { x: 3, y: 5, z: 7 });
    app.tick(1);
    app.frame(0.5);

    // Half of a quarter turn, at twice, three and four times the size.
    const eighth = new Matrix4().compose(
      new Vector3(5, 1, 0),
      new Quaternion().setFromAxisAngle(new Vector3(0.6, 0, 0.8), Math.PI / 4),
      new Vector3(2, 3, 4)
    ).elements;

    // And again in a frame with no tick before it: the same two turns.
    for (let frame = 0; frame < 2; frame += 1) {
      const drawnRow = rowAt(mesh(), 1);

      for (let k = 0; k < 16; k += 1) {
        expect(drawnRow[k], `element ${k}`).toBeCloseTo(eighth[k]!, 5);
      }

      app.frame(0.5);
    }

    // One that is not turned at all stays so.
    expect(rowAt(mesh(), 2).slice(0, 11)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    // The opposite quaternion is the same turn: it does not swing round
    // to get there.
    app.frame(1);
    const there = rowAt(mesh(), 1);
    world.set(rock, Rotation, {
      x: -quarter.x,
      y: -quarter.y,
      z: -quarter.z,
      w: -quarter.w,
    });
    world.set(rock, Scale, { x: 3, y: 5, z: 7 });
    app.tick(1);

    for (const alpha of [0, 0.3, 0.5, 0.9, 1]) {
      app.frame(alpha);
      const now = rowAt(mesh(), 1);

      for (let k = 0; k < 11; k += 1) {
        expect(now[k], `alpha ${alpha}, element ${k}`).toBeCloseTo(
          there[k]!,
          5
        );
      }
    }
  });

  it("turns by the shorter way round and grows evenly, in the plane", () => {
    const { app, mesh } = play(Smoothed);
    const { world } = app;

    const card = world.spawn(
      Rock,
      Flat.Position.of({ x: 0, y: 1 }),
      Flat.Rotation.of({ angle: 0.2 }),
      Flat.Scale.of({ x: 1, y: 1 })
    );

    app.frame(0);
    world.set(card, Flat.Rotation, { angle: 1 });
    world.set(card, Flat.Scale, { x: 3, y: 5 });
    app.tick(1);
    app.frame(0.5);

    const half = new Matrix4().compose(
      new Vector3(5, 1, 0),
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.6),
      new Vector3(2, 3, 1)
    ).elements;

    for (let frame = 0; frame < 2; frame += 1) {
      const drawnRow = rowAt(mesh(), 1);

      for (let k = 0; k < 16; k += 1) {
        expect(drawnRow[k], `element ${k}`).toBeCloseTo(half[k]!, 5);
      }

      app.frame(0.5);
    }

    // From a little past nothing to a little short of a whole turn is a
    // little way back, through nothing, not nearly all the way round.
    app.frame(1);
    world.set(card, Flat.Rotation, { angle: 0.25 });
    app.tick(1);
    app.frame(1);
    world.set(card, Flat.Rotation, { angle: Math.PI * 2 - 0.25 });
    app.tick(1);
    app.frame(0.5);
    const through = rowAt(mesh(), 1);
    expect(through[0]! / 3).toBeCloseTo(1, 5);
    expect(through[1]! / 3).toBeCloseTo(0, 5);
    app.frame(1);
    const end = rowAt(mesh(), 1);
    expect(end[0]! / 3).toBeCloseTo(Math.cos(0.25), 5);
    expect(end[1]! / 3).toBeCloseTo(-Math.sin(0.25), 5);
  });

  it("agrees, over a long run of ticks and frames that do not line up, with a model of what was last drawn", () => {
    const random = makeRandom(1612);
    const { app, mesh } = play(Smoothed);
    const { world } = app;
    // Each entity at a height of its own, by which its instance is found.
    let heights = 0;

    const alive: {
      readonly entity: Entity;
      readonly y: number;
      readonly flat: boolean;
    }[] = [];

    /** Per entity: where it was coming from and going to when last drawn, and in which frame. */
    const model = new Map<
      Entity,
      { from: number; to: number; frame: number }
    >();

    const xOf = (one: (typeof alive)[number]): number =>
      one.flat
        ? world.get(one.entity, Flat.Position)!.x
        : world.get(one.entity, Position)!.x;

    for (let frame = 1; frame <= 300; frame += 1) {
      const ticks = random.int(4);

      for (let i = 0; i < ticks; i += 1) {
        app.tick(1);
      }

      for (let step = 0; step < 3; step += 1) {
        const roll = random.int(6);
        const one = alive[random.int(alive.length)];

        if (roll < 2 || one === undefined) {
          heights += 1;
          const y = heights;
          const flat = random.next() < 0.5;
          const x = random.int(1000);
          alive.push({
            entity: flat
              ? world.spawn(Rock, Flat.Position.of({ x, y }))
              : world.spawn(Rock, Position.of({ x, y, z: 0 })),
            y,
            flat,
          });
        } else if (roll === 2) {
          world.despawn(one.entity);
          alive.splice(alive.indexOf(one), 1);
        } else if (roll === 3) {
          // Hidden for a while, or shown again.
          if (world.has(one.entity, Hidden)) {
            world.remove(one.entity, Hidden);
          } else {
            world.add(one.entity, Hidden);
          }
        }
      }

      const alpha = random.next();
      app.frame(alpha);
      const shown = alive.filter((one) => !world.has(one.entity, Hidden));
      expect(mesh().count).toBe(shown.length);

      for (const one of shown) {
        const x = xOf(one);
        const last = model.get(one.entity);
        let from = x;

        if (last !== undefined && last.frame === frame - 1) {
          from = ticks > 0 ? last.to : last.from;
        }

        model.set(one.entity, { from, to: x, frame });
        expect(xAt(mesh(), one.y), `frame ${frame}`).toBeCloseTo(
          from + (x - from) * alpha,
          2
        );
      }
    }

    // More of them than the room it started with, and of both kinds.
    expect(heights).toBeGreaterThan(150);
    expect(alive.some((one) => one.flat)).toBe(true);
    expect(alive.some((one) => !one.flat)).toBe(true);
  });

  it("blends two rotations of any length into a turn, drawn neither skewed nor sized by them", () => {
    const { app, mesh } = play(Smoothed);
    const { world } = app;
    const quarter = Transform3d.axisAngle(0.6, 0, 0.8, Math.PI / 2);

    const rock = world.spawn(
      Rock,
      Position.of({ x: 0, y: 1, z: 0 }),
      Rotation.of({ x: 0, y: 0, z: 0, w: 3 }),
      Scale.of({ x: 2, y: 3, z: 4 })
    );

    const bare = world.spawn(
      Rock,
      Position.of({ x: 0, y: 2, z: 0 }),
      Rotation.of({ x: 0, y: 0, z: 0, w: 0.2 })
    );

    app.frame(0);
    world.set(rock, Rotation, stretched(quarter, 3));
    world.set(bare, Rotation, stretched(quarter, 0.2));
    app.tick(1);
    app.frame(0.5);

    // Half of the quarter turn, at the size the entity has and no other.
    const turn = new Quaternion().setFromAxisAngle(
      new Vector3(0.6, 0, 0.8),
      Math.PI / 4
    );

    const eighth = new Matrix4().compose(
      new Vector3(5, 1, 0),
      turn,
      new Vector3(2, 3, 4)
    ).elements;

    const eighthBare = new Matrix4().compose(
      new Vector3(5, 2, 0),
      turn,
      new Vector3(1, 1, 1)
    ).elements;

    for (let k = 0; k < 16; k += 1) {
      expect(rowAt(mesh(), 1)[k], `element ${k}`).toBeCloseTo(eighth[k]!, 5);
      expect(rowAt(mesh(), 2)[k], `element ${k}`).toBeCloseTo(
        eighthBare[k]!,
        5
      );
    }

    // From one length to another, it is still a turn about that axis:
    // each column is as long as the entity is large along it.
    world.set(bare, Rotation, stretched(quarter, 5));
    world.set(bare, Rotation, { x: 0, y: 0, z: 0, w: 5 });
    world.set(rock, Rotation, { x: 0, y: 0, z: 0, w: 0.1 });
    app.tick(1);
    app.frame(0.25);

    for (const [y, sizes] of [
      [1, [2, 3, 4]],
      [2, [1, 1, 1]],
    ] as const) {
      const row = rowAt(mesh(), y);

      for (let column = 0; column < 3; column += 1) {
        expect(
          Math.hypot(
            row[column * 4]!,
            row[column * 4 + 1]!,
            row[column * 4 + 2]!
          ),
          `height ${y}, column ${column}`
        ).toBeCloseTo(sizes[column]!, 5);
      }

      // The axis of the turn stays where it is.
      const axis = new Vector3(0.6, 0, 0.8).applyMatrix4(
        new Matrix4()
          .fromArray(row)
          .setPosition(0, 0, 0)
          .scale(new Vector3(1 / sizes[0], 1 / sizes[1], 1 / sizes[2]))
      );

      expect(axis.x).toBeCloseTo(0.6, 5);
      expect(axis.y).toBeCloseTo(0, 5);
      expect(axis.z).toBeCloseTo(0.8, 5);
    }
  });

  it("places an object of Three.objects the same way", () => {
    const made = new Map<Entity, Object3D>();

    const Ships = Three.objects("th/SmoothShips", {
      of: Ship,
      make: (entity) => {
        const object = new Group();
        object.position.z = 9;
        made.set(entity, object);

        return object;
      },
      smooth: true,
      snap: 200,
    });

    const { app } = play(Ships);
    const { world } = app;

    const ship = world.spawn(
      Ship,
      Position.of({ x: 0, y: 1, z: 2 }),
      Rotation.of({ x: 0, y: 0, z: 0, w: 1 }),
      Scale.of({ x: 1, y: 1, z: 1 })
    );

    const card = world.spawn(
      Ship,
      Flat.Position.of({ x: 0, y: 4 }),
      Flat.Rotation.of({ angle: 0.5 }),
      Flat.Scale.of({ x: 1, y: 1 })
    );

    app.frame(0.5);
    expect(made.get(ship)!.position.toArray()).toEqual([0, 1, 2]);
    expect(made.get(card)!.position.toArray()).toEqual([0, 4, 9]);
    world.set(ship, Rotation, Transform3d.axisAngle(0, 0, 1, Math.PI / 2));
    world.set(ship, Scale, { x: 3, y: 3, z: 3 });
    world.set(card, Flat.Rotation, { angle: 1.5 });
    world.set(card, Flat.Scale, { x: 5, y: 7 });
    app.tick(1);
    app.frame(0.5);
    expect(made.get(ship)!.position.toArray()).toEqual([5, 1, 2]);
    expect(made.get(ship)!.scale.toArray()).toEqual([2, 2, 2]);

    const half = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      Math.PI / 4
    );

    expect(made.get(ship)!.quaternion.x).toBeCloseTo(half.x, 6);
    expect(made.get(ship)!.quaternion.y).toBeCloseTo(half.y, 6);
    expect(made.get(ship)!.quaternion.z).toBeCloseTo(half.z, 6);
    expect(made.get(ship)!.quaternion.w).toBeCloseTo(half.w, 6);
    expect(made.get(card)!.position.toArray()).toEqual([5, 4, 9]);
    expect(made.get(card)!.rotation.z).toBeCloseTo(1, 6);
    expect(made.get(card)!.scale.toArray()).toEqual([3, 4, 1]);
    // Too far to have gone in a tick: it is where it is.
    world.set(ship, Position, { x: 1000 });
    app.tick(1);
    app.frame(0.5);
    expect(made.get(ship)!.position.x).toBe(1010);
    expect(made.size).toBe(2);
    // Between two rotations of any length an object is turned, and its
    // quaternion is of length 1, as Three.js needs it.
    const quarter = Transform3d.axisAngle(0, 0, 1, Math.PI / 2);
    world.set(ship, Rotation, { x: 0, y: 0, z: 0, w: 6 });
    app.tick(1);
    app.frame(1);
    world.set(ship, Rotation, stretched(quarter, 6));
    app.tick(1);
    app.frame(0.5);
    expect(made.get(ship)!.quaternion.x).toBeCloseTo(half.x, 6);
    expect(made.get(ship)!.quaternion.y).toBeCloseTo(half.y, 6);
    expect(made.get(ship)!.quaternion.z).toBeCloseTo(half.z, 6);
    expect(made.get(ship)!.quaternion.w).toBeCloseTo(half.w, 6);
  });

  it("is drawn where it is once a game that ticks when it is needed has come to rest", () => {
    // A piece that goes ten along x when it is told to, and not otherwise.
    const Go = Action.define("th/Go", Schema.Struct({}));

    const { app, mesh } = (() => {
      const renderer = makeRenderer();

      const made = start(
        App.make({
          plugins: [Three.plugin],
          components: [Rock],
          systems: [Smoothed],
          handlers: [
            Action.handler(Go, function* () {
              (yield* Query.all(Position)).each((position) => {
                position.x += 10;
              });
            }),
          ],
        }),
        renderer
      );

      return {
        app: made.app,
        mesh: () => meshOf(renderer.scene, "th/Smoothed"),
      };
    })();

    app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    const advance = Driver.fixedStep(app, { hz: 60, ticks: "whenNeeded" });

    for (let i = 0; i < 10; i += 1) {
      advance(1 / 120);
    }

    // At rest, after the two ticks a new game runs.
    expect(app.time.tick).toBe(2);
    expect(xAt(mesh(), 1)).toBe(0);
    // Told to go: the tick runs in that frame, and it is on its way.
    app.enqueue(Go, {});
    advance(1 / 120);
    expect(app.time.tick).toBe(3);
    expect(xAt(mesh(), 1)).toBe(0);
    advance(1 / 120);
    expect(xAt(mesh(), 1)).toBe(5);

    // The game comes to rest, and the piece is where the game has it: not
    // a tick behind, waiting for a tick that is not coming.
    for (let i = 0; i < 10; i += 1) {
      advance(1 / 120);
    }

    expect(app.time.tick).toBe(4);
    expect(xAt(mesh(), 1)).toBe(10);
  });

  it("is not done unless it is asked for: an entity is drawn where the last tick left it", () => {
    const Plain = Three.instances("th/Smoothed", {
      of: Rock,
      geometry,
      material,
    });

    const { app, mesh } = play(Plain);
    app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    app.frame(0);
    app.tick(1);

    for (const alpha of [0, 0.5, 0.99]) {
      app.frame(alpha);
      expect(xAt(mesh(), 1)).toBe(10);
    }
  });

  it("keeps the place before to itself: a game drawn between its ticks is the same game", () => {
    const Rules = Plugin.make("th/SlideRules", {
      plugins: [Transform3d.plugin, Transform2d.plugin],
      components: [Rock, Ship, Hidden],
      systems: [Slide],
    });

    const Ships = Three.objects("th/SmoothShips", {
      of: Ship,
      make: () => new Object3D(),
      smooth: true,
    });

    const Drawn = Plugin.make("th/SmoothDrawn", {
      plugins: [Three.plugin, Rules],
      systems: [Smoothed, Ships],
    });

    const drawnGame = start(
      App.make({ plugins: [Drawn], checkpointEvery: 1, verifyFrames: true }),
      makeRenderer()
    ).app;

    const scope = Effect.runSync(Scope.make());

    const bare = Effect.runSync(
      App.make({ plugins: [Rules], checkpointEvery: 1 }).pipe(
        Scope.provide(scope)
      )
    );

    for (const app of [drawnGame, bare]) {
      app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }), Rotation);
      app.world.spawn(Rock, Flat.Position.of({ x: 0, y: 2 }), Flat.Rotation);
      app.world.spawn(Ship, Position.of({ x: 0, y: 3, z: 0 }), Scale);
    }

    for (let tick = 0; tick < 40; tick += 1) {
      drawnGame.tick(1);
      drawnGame.frame(0.2);
      drawnGame.frame(0.7);
      bare.tick(1);
      expect(drawnGame.world.hash()).toBe(bare.world.hash());
    }

    expect(drawnGame.actionLog).toEqual(bare.actionLog);

    const saves = [drawnGame.save(), bare.save()].map((save) =>
      Exit.isSuccess(save) ? save.value : undefined
    );

    expect(saves[0]).toBeDefined();
    expect(saves[0]).toEqual(saves[1]);
  });
});

describe("a colour per instance", () => {
  const Flat = Transform2d;

  const Painted = Three.instances("th/Painted", {
    of: Rock,
    without: [Hidden],
    geometry,
    material,
    color: Paint,
    // The renderer's own numbers, handed over as they are: what these
    // tests follow is which instance has which.
    colorSpace: "srgb-linear",
    capacity: 4,
  });

  const play = (system: ReturnType<typeof Three.instances> = Painted) => {
    const renderer = makeRenderer();

    const { app, close } = start(
      App.make({
        plugins: [Three.plugin],
        components: [Rock, Hidden, Paint],
        systems: [system],
      }),
      renderer
    );

    return { app, close, mesh: () => meshOf(renderer.scene, "th/Painted") };
  };

  const paint = (r: number, g: number, b: number) =>
    Paint.of({ r, g, b, shine: 9 });

  /** The colour of the instance that is drawn at this height. */
  const colorAt = (mesh: InstancedMesh, y: number): number[] => {
    for (let i = 0; i < mesh.count; i += 1) {
      if (Math.abs(mesh.instanceMatrix.array[i * 16 + 13]! - y) < 1e-4) {
        return Array.from(mesh.instanceColor!.array.subarray(i * 3, i * 3 + 3));
      }
    }

    throw new Error(`Nothing is drawn at height ${y}`);
  };

  it("is the colour its entity has, for every kind of entity, beside the matrix of the same entity", () => {
    const { app, mesh } = play();
    const { world } = app;
    const turn = Rotation.of(Transform3d.axisAngle(0, 1, 0, 1));
    const size = Scale.of({ x: 2, y: 2, z: 2 });
    const flatTurn = Flat.Rotation.of({ angle: 1 });
    const flatSize = Flat.Scale.of({ x: 2, y: 2 });
    const at = (y: number) => Position.of({ x: 0, y, z: 0 });
    const flat = (y: number) => Flat.Position.of({ x: 0, y });

    // One of each of the eight, each of a colour of its own.
    const rocks = [
      world.spawn(Rock, at(1), paint(0.125, 0, 0)),
      world.spawn(Rock, at(2), size, paint(0.25, 0, 0)),
      world.spawn(Rock, at(3), turn, paint(0.375, 0, 0)),
      world.spawn(Rock, at(4), turn, size, paint(0.5, 0, 0)),
      world.spawn(Rock, flat(5), paint(0, 0.125, 0.75)),
      world.spawn(Rock, flat(6), flatSize, paint(0, 0.25, 0.75)),
      world.spawn(Rock, flat(7), flatTurn, paint(0, 0.375, 0.75)),
      world.spawn(Rock, flat(8), flatTurn, flatSize, paint(0, 0.5, 0.75)),
    ];

    // Not painted, of every kind: a kind with a colour draws what has one.
    world.spawn(Rock, at(9));
    world.spawn(Rock, at(9), turn, size);
    world.spawn(Rock, flat(9));
    world.spawn(Rock, flat(9), flatTurn, flatSize);
    // Painted and not a rock; and hidden.
    world.spawn(Ship, at(9), paint(1, 1, 1));
    world.spawn(Rock, Hidden, at(9), paint(1, 1, 1));
    app.frame(0);
    expectDrawn(mesh(), app, rocks);

    for (let y = 1; y <= 4; y += 1) {
      expect(colorAt(mesh(), y)).toEqual([y / 8, 0, 0]);
    }

    for (let y = 5; y <= 8; y += 1) {
      expect(colorAt(mesh(), y)).toEqual([0, (y - 4) / 8, 0.75]);
    }

    // Three numbers an instance, in a buffer of its own that changes often.
    const colors = mesh().instanceColor!;
    expect(colors.itemSize).toBe(3);
    expect(colors.usage).toBe(mesh().instanceMatrix.usage);
    // It follows the entity: repainted, and gone.
    world.set(rocks[0]!, Paint, { r: 0, g: 1, b: 0.5 });
    world.despawn(rocks[1]!);
    app.frame(0);
    expect(mesh().count).toBe(7);
    expect(colorAt(mesh(), 1)).toEqual([0, 1, 0.5]);
    expect(colorAt(mesh(), 3)).toEqual([0.375, 0, 0]);
  });

  it("keeps each colour with its instance while they come, go and change, and the room for them grows", () => {
    const random = makeRandom(88);
    const { app, mesh } = play();
    const { world } = app;
    let heights = 0;
    const alive: { readonly entity: Entity; readonly y: number }[] = [];
    let dropped = 0;

    for (let frame = 0; frame < 120; frame += 1) {
      for (let step = 0; step < 6; step += 1) {
        const roll = random.int(8);
        const one = alive[random.int(alive.length)];

        if (roll < 4 || one === undefined) {
          heights += 1;
          const y = heights;

          const parts = [
            Rock,
            random.next() < 0.5
              ? Position.of({ x: random.int(50), y, z: 0 })
              : Flat.Position.of({ x: random.int(50), y }),
            paint(random.next(), random.next(), random.next()),
          ] as ComponentInput[];

          if (random.next() < 0.3) {
            parts.push(
              Scale.of({ x: 2, y: 2, z: 2 }),
              Flat.Scale.of({ x: 2, y: 2 })
            );
          }

          alive.push({ entity: world.spawn(...parts), y });
        } else if (roll === 4) {
          world.despawn(one.entity);
          alive.splice(alive.indexOf(one), 1);
        } else if (roll === 5) {
          world.set(one.entity, Paint, { r: random.next(), g: random.next() });
        } else if (world.has(one.entity, Paint)) {
          // Unpainted for a while, and painted again.
          world.remove(one.entity, Paint);
        } else {
          world.add(one.entity, paint(random.next(), 0, 0));
        }
      }

      app.frame(0);

      if (frame === 0) {
        mesh().addEventListener("dispose", () => {
          dropped += 1;
        });
      }

      const shown = alive.filter((one) => world.has(one.entity, Paint));
      expect(mesh().count).toBe(shown.length);

      for (const one of shown) {
        const { b, g, r } = world.get(one.entity, Paint)!;
        expect(colorAt(mesh(), one.y), `frame ${frame}`).toEqual([r, g, b]);
      }
    }

    // It started with room for four, and outgrew it several times over:
    // both buffers together, each time.
    expect(alive.length).toBeGreaterThan(64);
    expect(dropped).toBeGreaterThanOrEqual(5);
    expect(mesh().instanceColor!.array).toHaveLength(
      (mesh().instanceMatrix.array.length / 16) * 3
    );
  });

  it("tells the renderer to send the colours that are drawn and no more, each frame something is", () => {
    const { app, mesh } = play();

    const rocks = [1, 2, 3].map((y) =>
      app.world.spawn(Rock, Position.of({ x: 0, y, z: 0 }), paint(1, 1, 1))
    );

    app.frame(0);
    const colors = mesh().instanceColor!;
    expect(colors.updateRanges).toEqual([{ start: 0, count: 9 }]);
    const [range] = colors.updateRanges;
    const sent = colors.version;
    expect(sent).toBeGreaterThan(0);
    colors.clearUpdateRanges();
    app.world.despawn(rocks[0]!);
    app.frame(0);
    expect(colors.updateRanges).toEqual([{ start: 0, count: 6 }]);
    expect(colors.updateRanges[0]).toBe(range);
    expect(colors.version).toBe(sent + 1);
    // A renderer that sent nothing in between is not told twice.
    app.frame(0);
    expect(colors.updateRanges).toHaveLength(1);
    // Nothing to draw: nothing to send.
    app.world.despawn(rocks[1]!);
    app.world.despawn(rocks[2]!);
    colors.clearUpdateRanges();
    const before = colors.version;
    app.frame(0);
    expect(colors.updateRanges).toEqual([]);
    expect(colors.version).toBe(before);
    expect(mesh().instanceColor).toBe(colors);
  });

  it("changes evenly between two ticks when the kind is drawn so, however far it changes", () => {
    const Fading = Three.instances("th/Painted", {
      of: Rock,
      geometry,
      material,
      color: Paint,
      colorSpace: "srgb-linear",
      smooth: true,
      // How far an entity may go: a colour is not a place, and is never too far.
      snap: 0.1,
    });

    const { app, mesh } = play(Fading);

    const rock = app.world.spawn(
      Rock,
      Position.of({ x: 0, y: 1, z: 0 }),
      paint(0, 0.5, 1)
    );

    app.frame(0.5);
    expect(colorAt(mesh(), 1)).toEqual([0, 0.5, 1]);
    app.world.set(rock, Paint, { r: 1, g: 0.5, b: 0 });
    app.tick(1);
    app.frame(0);
    expect(colorAt(mesh(), 1)).toEqual([0, 0.5, 1]);
    app.frame(0.25);
    expect(colorAt(mesh(), 1)).toEqual([0.25, 0.5, 0.75]);
    app.frame(1);
    expect(colorAt(mesh(), 1)).toEqual([1, 0.5, 0]);
  });

  it("is a hex code's numbers unless told otherwise, converted for the renderer as Three.js converts them", () => {
    const Coded = Three.instances("th/Painted", {
      of: Rock,
      geometry,
      material,
      color: Paint,
    });

    const { app, mesh } = play(Coded);
    const { world } = app;
    const codes = ["#ff6188", "#000000", "#ffffff", "#0a141e", "#7f8081"];
    // The same colours with no byte behind them, a little off each one.
    const between = [0.003, 0.0401, 0.0409, 0.2, 0.5173, 0.9999];

    for (const [i, code] of codes.entries()) {
      const hex = Number.parseInt(code.slice(1), 16);
      world.spawn(
        Rock,
        Position.of({ x: 0, y: i + 1, z: 0 }),
        paint((hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255)
      );
    }

    for (const [i, c] of between.entries()) {
      // Of every kind of entity: the conversion is one, whatever the loop.
      world.spawn(
        Rock,
        Position.of({ x: 0, y: i + 11, z: 0 }),
        ...(i % 2 === 0 ? [] : [Rotation, Scale.of({ x: 1, y: 1, z: 1 })]),
        paint(c, 1 - c, c)
      );
    }

    app.frame(0);

    for (const [i, code] of codes.entries()) {
      // What Three.js itself holds of the code, in the space it works in.
      const { b, g, r } = new Color(code);
      const [ours, ourGreen, ourBlue] = colorAt(mesh(), i + 1);
      // A byte is at a step of the table: as exact as a float holds it.
      expect(ours).toBeCloseTo(r, 6);
      expect(ourGreen).toBeCloseTo(g, 6);
      expect(ourBlue).toBeCloseTo(b, 6);
    }

    // By hand, so that the test does not only agree with Three.js: the
    // middle grey of a screen is a fifth of the light, not a half.
    expect(colorAt(mesh(), 5)[0]).toBeCloseTo(0.2122, 3);

    for (const [i, c] of between.entries()) {
      const { b, g, r } = new Color().setRGB(c, 1 - c, c, SRGBColorSpace);
      const [ours, ourGreen, ourBlue] = colorAt(mesh(), i + 11);
      // To a sixteenth of a byte, where the curve is steepest.
      expect(Math.abs(ours! - r)).toBeLessThan(3e-4);
      expect(Math.abs(ourGreen! - g)).toBeLessThan(3e-4);
      expect(Math.abs(ourBlue! - b)).toBeLessThan(3e-4);
    }
  });

  it("takes every colour there is: any three numbers from 0 to 1, together", () => {
    const Coded = Three.instances("th/Painted", {
      of: Rock,
      geometry,
      material,
      color: Paint,
    });

    const { app, mesh } = play(Coded);
    const random = makeRandom(20_261_117);

    const colours: (readonly [number, number, number])[] = [
      // One that a benchmark came across, and the corners.
      [0.358980268239975, 0.3159957230091095, 0.970885157585144],
      [1, 1, 1],
      [0, 0, 0],
      [1, 0, 1],
      [0.999, 0.501, 0.251],
    ];

    for (let i = 0; i < 3000; i += 1) {
      colours.push([random.next(), random.next(), random.next()]);
    }

    for (const [i, [r, g, b]] of colours.entries()) {
      app.world.spawn(
        Rock,
        Position.of({ x: 0, y: i + 1, z: 0 }),
        paint(r, g, b)
      );
    }

    app.frame(0);
    const drawnColours = mesh().instanceColor!.array;
    const heights = mesh().instanceMatrix.array;
    const want = new Color();

    for (let i = 0; i < colours.length; i += 1) {
      const [r, g, b] = colours[Math.round(heights[i * 16 + 13]!) - 1]!;
      want.setRGB(r, g, b, SRGBColorSpace);
      expect(Math.abs(drawnColours[i * 3]! - want.r)).toBeLessThan(3e-4);
      expect(Math.abs(drawnColours[i * 3 + 1]! - want.g)).toBeLessThan(3e-4);
      expect(Math.abs(drawnColours[i * 3 + 2]! - want.b)).toBeLessThan(3e-4);
    }
  });

  it("holds the bytes themselves in fields of whole numbers, in either space", () => {
    const Bytes = Component.define("th/Bytes", {
      r: Field.u8,
      g: Field.u8,
      b: Field.u8,
    });

    const made = (space: "srgb" | "srgb-linear" | undefined) => {
      const renderer = makeRenderer();

      const { app } = start(
        App.make({
          plugins: [Three.plugin],
          components: [Rock, Bytes],
          systems: [
            Three.instances("th/Painted", {
              of: Rock,
              geometry,
              material,
              color: Bytes,
              ...(space === undefined ? {} : { colorSpace: space }),
            }),
          ],
        }),
        renderer
      );

      app.world.spawn(
        Rock,
        Position.of({ x: 0, y: 1, z: 0 }),
        Bytes.of({ r: 0xff, g: 0x61, b: 0x88 })
      );
      app.world.spawn(
        Rock,
        Position.of({ x: 0, y: 2, z: 0 }),
        Bytes.of({ r: 0, g: 1, b: 254 })
      );
      app.frame(0);

      return meshOf(renderer.scene, "th/Painted");
    };

    for (const space of [undefined, "srgb"] as const) {
      const mesh = made(space);
      const pink = new Color("#ff6188");
      expect(colorAt(mesh, 1)[0]).toBeCloseTo(pink.r, 6);
      expect(colorAt(mesh, 1)[1]).toBeCloseTo(pink.g, 6);
      expect(colorAt(mesh, 1)[2]).toBeCloseTo(pink.b, 6);
      const dark = new Color("#0001fe");
      expect(colorAt(mesh, 2)[0]).toBe(0);
      expect(colorAt(mesh, 2)[1]).toBeCloseTo(dark.g, 8);
      expect(colorAt(mesh, 2)[2]).toBeCloseTo(dark.b, 6);
    }

    // In the renderer's own space a byte is a 255th, and no more is done.
    const linear = made("srgb-linear");
    expect(colorAt(linear, 1)).toEqual(
      Array.from(new Float32Array([1, 0x61 / 255, 0x88 / 255]))
    );
    expect(colorAt(linear, 2)).toEqual(
      Array.from(new Float32Array([0, 1 / 255, 254 / 255]))
    );
  });

  it("refuses a number that is no colour, and says which entity has it", () => {
    const Coded = Three.instances("th/Painted", {
      of: Rock,
      geometry,
      material,
      color: Paint,
    });

    const { app, mesh } = play(Coded);
    const { world } = app;

    const fine = world.spawn(
      Rock,
      Position.of({ x: 0, y: 1, z: 0 }),
      // The ends themselves, and a hair past one as arithmetic leaves it.
      paint(0, 1, 1.00001)
    );

    app.frame(0);
    expect(colorAt(mesh(), 1)).toEqual([0, 1, 1]);

    // A hex code's bytes, not over 255: each channel is told from the others.
    for (const [r, g, b] of [
      [255, 0, 0],
      [0, 97, 0],
      [0, 0, 1.01],
      [-0.01, 0.5, 0.5],
      [0.5, -3, 0.5],
      [0.5, 0.5, -200],
    ] as const) {
      world.set(fine, Paint, { r, g, b });
      expect(() => app.frame(0)).toThrow(
        `Three.instances("th/Painted") was given the colour (${Math.fround(r)}, ${Math.fround(g)}, ${Math.fround(b)}) by entity ${fine}, which is no colour: each of its numbers is from 0 to 1, as a hex code's bytes over 255 are. For the bytes themselves, give the component fields of whole numbers, Field.u8`
      );
    }

    // Put right, it is drawn again.
    world.set(fine, Paint, { r: 1, g: 0, b: 0 });
    app.frame(0);
    expect(colorAt(mesh(), 1)).toEqual([1, 0, 0]);
  });

  it("refuses a whole number that is no byte, and takes any number in the renderer's own space", () => {
    const Wide = Component.define("th/Wide", {
      r: Field.u16,
      g: Field.i32,
      b: Field.u32,
    });

    const renderer = makeRenderer();

    const { app } = start(
      App.make({
        plugins: [Three.plugin],
        components: [Rock, Wide],
        systems: [
          Three.instances("th/Painted", {
            of: Rock,
            geometry,
            material,
            color: Wide,
          }),
        ],
      }),
      renderer
    );

    const rock = app.world.spawn(
      Rock,
      Position.of({ x: 0, y: 1, z: 0 }),
      Wide.of({ r: 255, g: 255, b: 255 })
    );

    app.frame(0);
    expect(colorAt(meshOf(renderer.scene, "th/Painted"), 1)).toEqual([1, 1, 1]);

    for (const [r, g, b] of [
      [256, 0, 0],
      [0, -1, 0],
      [0, 0, 65_535],
    ] as const) {
      app.world.set(rock, Wide, { r, g, b });
      expect(() => app.frame(0)).toThrow(
        `was given the colour (${r}, ${g}, ${b}) by entity ${rock}, which is no colour: each of its numbers is from 0 to 255. A colour that is brighter than white`
      );
    }

    // Brighter than white is a colour of the renderer's own, and is not
    // one of a hex code.
    const { app: bright, mesh } = play();
    bright.world.spawn(
      Rock,
      Position.of({ x: 0, y: 1, z: 0 }),
      paint(4, 0, -1)
    );
    bright.frame(0);
    expect(colorAt(mesh(), 1)).toEqual([4, 0, -1]);
  });

  it("changes evenly between two ticks in the numbers the game has, and is converted then", () => {
    const Fading = Three.instances("th/Painted", {
      of: Rock,
      geometry,
      material,
      color: Paint,
      smooth: true,
    });

    const { app, mesh } = play(Fading);

    const rock = app.world.spawn(
      Rock,
      Position.of({ x: 0, y: 1, z: 0 }),
      paint(0, 0.2, 1)
    );

    app.frame(0.5);
    app.world.set(rock, Paint, { r: 1, g: 0.2, b: 0 });
    app.tick(1);
    app.frame(0.25);
    // A quarter of the way between the two codes, as a code.
    const there = new Color().setRGB(0.25, 0.2, 0.75, SRGBColorSpace);
    expect(colorAt(mesh(), 1)[0]).toBeCloseTo(there.r, 3);
    expect(colorAt(mesh(), 1)[1]).toBeCloseTo(there.g, 3);
    expect(colorAt(mesh(), 1)[2]).toBeCloseTo(there.b, 3);
    app.frame(1);
    expect(colorAt(mesh(), 1)[0]).toBe(1);
    expect(colorAt(mesh(), 1)[2]).toBe(0);
  });

  it("is not there unless it is asked for: the mesh has no colours, and an entity needs none to be drawn", () => {
    const Plain = Three.instances("th/Painted", {
      of: Rock,
      geometry,
      material,
    });

    const { app, mesh } = play(Plain);
    app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
    app.world.spawn(Rock, Position.of({ x: 0, y: 2, z: 0 }), paint(1, 0, 0));
    app.frame(0);
    expect(mesh().count).toBe(2);
    expect(mesh().instanceColor).toBeNull();
  });

  it("has to be a colour: a component of r, g and b kept in a table", () => {
    const Hue = Component.define("th/Hue", { degrees: Field.f32 });

    const Glow = Component.define(
      "th/Glow",
      { r: Field.f32, g: Field.f32, b: Field.f32 },
      { storage: "sparse" }
    );

    const base = { of: Rock, geometry, material };
    // @ts-expect-error a hue is one number, not three
    const wrong: Three.InstancesOptions = { ...base, color: Hue };
    // @ts-expect-error its rows are not the rows of the table that is drawn
    const sparse: Three.InstancesOptions = { ...base, color: Glow };
    expect(() => Three.instances("th/Wrong", wrong)).toThrow(
      'Three.instances("th/Wrong") was given "th/Hue" as its colour, which is not one'
    );
    expect(() => Three.instances("th/Sparse", sparse)).toThrow(
      'was given "th/Glow" as its colour'
    );
    // Two of the three are not a colour either.
    const Rg = Component.define("th/Rg", { r: Field.f32, g: Field.f32 });
    expect(() =>
      Three.instances("th/Rg", { ...base, color: Rg as never })
    ).toThrow('was given "th/Rg" as its colour');

    // Nor are three that are not all floats or all whole numbers, or not
    // numbers at all.
    const Mixed = Component.define("th/Mixed", {
      r: Field.f32,
      g: Field.u8,
      b: Field.f32,
    });

    expect(() =>
      Three.instances("th/Mixed", { ...base, color: Mixed })
    ).toThrow(
      'Three.instances("th/Mixed") was given "th/Mixed" as its colour, whose r, g and b are fields of f32, u8, f32: the three are all floats, from 0 to 1, or all whole numbers, the bytes from 0 to 255.'
    );

    const Loose = Component.define("th/Loose", {
      r: Field.json<number>(),
      g: Field.json<number>(),
      b: Field.json<number>(),
    });

    expect(() =>
      Three.instances("th/Loose", { ...base, color: Loose })
    ).toThrow("whose r, g and b are fields of json, json, json");

    // Floats of either width are floats.
    const Fine64 = Component.define("th/Fine64", {
      r: Field.f64,
      g: Field.f32,
      b: Field.f64,
    });

    expect(Three.instances("th/Fine64", { ...base, color: Fine64 }).name).toBe(
      "th/Fine64"
    );
    // One with more than a colour in it is one all the same.
    expect(Three.instances("th/Fine", { ...base, color: Paint }).name).toBe(
      "th/Fine"
    );
  });

  it("goes with the mesh when the app's scope closes", () => {
    const { app, close, mesh } = play();
    app.world.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }), paint(1, 1, 1));
    app.frame(0);
    const kept = mesh();
    let disposed = 0;
    kept.instanceColor!.addEventListener("dispose", () => {
      disposed += 1;
    });
    close();
    expect(disposed).toBe(1);
    expect(kept.parent).toBeNull();
  });
});

describe("Three.objects", () => {
  const made: { readonly object: Object3D; readonly entity: Entity }[] = [];
  const freed: { readonly object: Object3D; readonly entity: Entity }[] = [];
  /** Whether `make` gives the objects a turn and a size of its own. */
  let tilted = false;

  const Ships = Three.objects("th/Ships", {
    of: Ship,
    without: [Hidden],
    make: (entity) => {
      const object = new Group();

      if (tilted) {
        object.quaternion.set(0, 1, 0, 0);
        object.scale.set(2, 2, 2);
      }

      made.push({ object, entity });

      return object;
    },
    free: (object, entity) => {
      freed.push({ object, entity });
    },
  });

  const Fleet = Plugin.make("th/Fleet", {
    plugins: [Three.plugin],
    components: [Ship, Rock, Hidden],
    systems: [Ships],
  });

  const fresh = () => {
    made.length = 0;
    freed.length = 0;
    tilted = false;
    const renderer = makeRenderer();

    return { renderer, ...start(App.make({ plugins: [Fleet] }), renderer) };
  };

  const objectOf = (entity: Entity): Object3D | undefined =>
    made.findLast((one) => one.entity === entity)?.object;

  it("turns an object by the turn a rotation of any length stands for, with a quaternion of length 1", () => {
    const { app } = fresh();
    const quarter = Transform3d.axisAngle(0, 0, 1, Math.PI / 2);

    const long = app.world.spawn(
      Ship,
      Position.of({ x: 1, y: 0, z: 0 }),
      Rotation.of(stretched(quarter, 7)),
      Scale.of({ x: 2, y: 3, z: 4 })
    );

    const short = app.world.spawn(
      Ship,
      Position.of({ x: 2, y: 0, z: 0 }),
      Rotation.of(stretched(quarter, 0.001))
    );

    // All zeros is not turned at all.
    const still = app.world.spawn(
      Ship,
      Position.of({ x: 3, y: 0, z: 0 }),
      Rotation
    );

    app.frame(0);

    for (const ship of [long, short]) {
      const object = objectOf(ship)!;
      expect(object.quaternion.length()).toBeCloseTo(1, 6);
      expect(object.quaternion.x).toBeCloseTo(0, 6);
      expect(object.quaternion.y).toBeCloseTo(0, 6);
      expect(object.quaternion.z).toBeCloseTo(Math.SQRT1_2, 6);
      expect(object.quaternion.w).toBeCloseTo(Math.SQRT1_2, 6);
    }

    expect(objectOf(still)!.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    // So what Three.js draws of it is turned and sized, and not skewed.
    objectOf(long)!.updateMatrix();
    const wanted = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 1, 0, 0, 1];

    for (let k = 0; k < 16; k += 1) {
      expect(objectOf(long)!.matrix.elements[k], `element ${k}`).toBeCloseTo(
        wanted[k]!,
        5
      );
    }
  });

  it("makes one object per entity, once, adds it to the scene and puts it where the entity is", () => {
    const { app, renderer } = fresh();
    const turn = Transform3d.axisAngle(0, 1, 0, 0.75);
    const plain = app.world.spawn(Ship, Position.of({ x: 1, y: 2, z: 3 }));

    const whole = app.world.spawn(
      Ship,
      Position.of({ x: -1, y: -2, z: -3 }),
      Rotation.of(turn),
      Scale.of({ x: 2, y: 3, z: 4 })
    );

    app.world.spawn(Rock, Position.of({ x: 9, y: 9, z: 9 }));
    // One that is turned and sized, and nowhere.
    app.world.spawn(Ship, Rotation, Scale);
    app.frame(0);
    expect(made.map((one) => one.entity).toSorted()).toEqual([plain, whole]);
    expect(renderer.scene?.children.toSorted((a, b) => a.id - b.id)).toEqual(
      made.map((one) => one.object).toSorted((a, b) => a.id - b.id)
    );
    expect(objectOf(plain)!.position.toArray()).toEqual([1, 2, 3]);
    expect(objectOf(plain)!.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(objectOf(plain)!.scale.toArray()).toEqual([1, 1, 1]);
    expect(objectOf(whole)!.position.toArray()).toEqual([-1, -2, -3]);
    expectTurned(objectOf(whole)!, turn);
    expect(objectOf(whole)!.scale.toArray()).toEqual([2, 3, 4]);
    // It moves with its entity, and is not made again.
    app.world.set(plain, Position, { x: 10, y: 20, z: 30 });
    app.world.set(whole, Scale, { x: 5, y: 5, z: 5 });
    app.world.set(whole, Rotation, { x: 0, y: 0, z: 1, w: 0 });
    app.frame(0);
    expect(made).toHaveLength(2);
    expect(freed).toEqual([]);
    expect(objectOf(plain)!.position.toArray()).toEqual([10, 20, 30]);
    expect(objectOf(whole)!.scale.toArray()).toEqual([5, 5, 5]);
    expect(objectOf(whole)!.quaternion.toArray()).toEqual([0, 0, 1, 0]);
  });

  it("keeps the one object of an entity whose id is past what 32 bits hold", () => {
    const { app } = fresh();

    // A slot given out 1,100 times: the next entity in it has such an id.
    for (let n = 0; n < 1100; n += 1) {
      app.world.despawn(app.world.spawn(Ship));
    }

    const ship = app.world.spawn(Ship, Position.of({ x: 1, y: 2, z: 3 }));
    expect(ship).toBeGreaterThan(2 ** 32);
    app.frame(0);
    app.world.set(ship, Position, { x: 4, y: 5, z: 6 });
    app.frame(0);
    app.frame(0);
    // Made once, for this entity, and not again for every frame that
    // finds it.
    expect(made.map((one) => one.entity)).toEqual([ship]);
    expect(freed).toEqual([]);
    expect(objectOf(ship)!.position.toArray()).toEqual([4, 5, 6]);
  });

  it("takes the object out and frees it when its entity is gone, or is no longer one of these", () => {
    const { app, renderer } = fresh();
    const at = (x: number) => Position.of({ x, y: 0, z: 0 });

    const [gone, unmarked, hidden, nowhere, stays] = [1, 2, 3, 4, 5].map((x) =>
      app.world.spawn(Ship, at(x))
    ) as [Entity, Entity, Entity, Entity, Entity];

    app.frame(0);
    expect(made).toHaveLength(5);
    const objects = new Map(made.map((one) => [one.entity, one.object]));
    app.world.despawn(gone);
    app.world.remove(unmarked, Ship);
    app.world.add(hidden, Hidden);
    app.world.remove(nowhere, Position);
    app.frame(0);
    expect(freed.map((one) => one.entity).toSorted()).toEqual(
      [gone, unmarked, hidden, nowhere].toSorted()
    );

    for (const one of freed) {
      expect(one.object).toBe(objects.get(one.entity));
      expect(one.object.parent).toBeNull();
    }

    expect(renderer.scene?.children).toEqual([objects.get(stays)]);
    // Each was freed once.
    app.frame(0);
    expect(freed).toHaveLength(4);
    // One that is one of these again gets a new object.
    app.world.remove(hidden, Hidden);
    app.frame(0);
    expect(made).toHaveLength(6);
    expect(objectOf(hidden)).not.toBe(objects.get(hidden));
    expect(objectOf(hidden)!.position.x).toBe(3);
    expect(renderer.scene?.children.length).toBe(2);
  });

  it("gives an entity that takes a despawned one's slot an object of its own", () => {
    const { app } = fresh();

    const first = app.world.spawn(
      Ship,
      Position.of({ x: 1, y: 1, z: 1 }),
      Rotation.of({ x: 0, y: 0, z: 1, w: 0 }),
      Scale.of({ x: 3, y: 3, z: 3 })
    );

    app.frame(0);
    const old = objectOf(first)!;
    app.world.despawn(first);
    tilted = true;
    const second = app.world.spawn(Ship, Position.of({ x: 2, y: 2, z: 2 }));
    // The same slot, and another entity.
    expect(second & 0x3f_ff_ff).toBe(first & 0x3f_ff_ff);
    expect(second).not.toBe(first);
    app.frame(0);
    expect(freed).toEqual([{ object: old, entity: first }]);
    expect(objectOf(second)).not.toBe(old);
    expect(objectOf(second)!.position.toArray()).toEqual([2, 2, 2]);
    // The new one was never turned or sized: what `make` gave it stands,
    // this frame and the next.
    app.frame(0);
    expect(objectOf(second)!.quaternion.toArray()).toEqual([0, 1, 0, 0]);
    expect(objectOf(second)!.scale.toArray()).toEqual([2, 2, 2]);
    expect(old.parent).toBeNull();
    expect(objectOf(second)!.parent).not.toBeNull();
    expect(made).toHaveLength(2);
  });

  it("draws an entity that lost its rotation or its scale as one that never had one", () => {
    const { app } = fresh();

    const ship = app.world.spawn(
      Ship,
      Position.of({ x: 0, y: 0, z: 0 }),
      Rotation.of({ x: 1, y: 0, z: 0, w: 0 }),
      Scale.of({ x: 3, y: 3, z: 3 })
    );

    app.frame(0);
    const object = objectOf(ship)!;
    expect(object.quaternion.toArray()).toEqual([1, 0, 0, 0]);
    app.world.remove(ship, Rotation);
    app.frame(0);
    expect(object.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(object.scale.toArray()).toEqual([3, 3, 3]);
    app.world.remove(ship, Scale);
    app.frame(0);
    expect(object.scale.toArray()).toEqual([1, 1, 1]);
    // What the game itself then sets on the object is left alone.
    object.scale.set(7, 7, 7);
    object.quaternion.set(0, 1, 0, 0);
    app.frame(0);
    expect(object.scale.toArray()).toEqual([7, 7, 7]);
    expect(object.quaternion.toArray()).toEqual([0, 1, 0, 0]);
    expect(made).toHaveLength(1);
  });

  it("keeps exactly one object for each entity that is one of these, whatever happens to them", () => {
    const random = makeRandom(77);
    const { app, renderer } = fresh();
    const { world } = app;
    const all: Entity[] = [];

    for (let frame = 0; frame < 150; frame += 1) {
      for (let step = 0; step < 8; step += 1) {
        const roll = random.int(10);
        const one = all[random.int(all.length)];

        if (roll < 3 || one === undefined) {
          const parts = [
            Position.of({
              x: random.int(100),
              y: random.int(100),
              z: random.int(100),
            }),
          ] as ComponentInput[];

          if (random.next() < 0.8) {
            parts.push(Ship);
          }

          if (random.next() < 0.3) {
            const { w, x, y, z } = random.quaternion();
            parts.push(Rotation.of({ x, y, z, w }));
          }

          if (random.next() < 0.3) {
            parts.push(Scale.of({ x: 2, y: 2, z: 2 }));
          }

          all.push(world.spawn(...parts));
        } else if (roll === 3) {
          world.despawn(one);
          all.splice(all.indexOf(one), 1);
        } else if (roll === 4) {
          world.add(one, Hidden);
        } else if (roll === 5) {
          world.remove(one, Hidden);
        } else if (roll === 6) {
          world.remove(one, Ship);
        } else if (roll === 7) {
          world.add(one, Ship);
        } else if (roll === 8) {
          world.remove(one, Rotation);
        } else {
          world.add(
            one,
            Position.of({
              x: random.int(100),
              y: random.int(100),
              z: random.int(100),
            })
          );
        }
      }

      app.frame(0);

      const shown = all.filter(
        (one) => world.has(one, Ship) && !world.has(one, Hidden)
      );

      // What is in the scene is the objects made and not freed, one each.
      const kept = made.filter(
        (one) => !freed.some((other) => other.object === one.object)
      );

      expect(kept.map((one) => one.entity).toSorted()).toEqual(
        shown.toSorted()
      );
      expect(new Set(renderer.scene?.children)).toEqual(
        new Set(kept.map((one) => one.object))
      );

      for (const { entity, object } of kept) {
        const position = world.get(entity, Position)!;
        expect(object.position.toArray()).toEqual([
          position.x,
          position.y,
          position.z,
        ]);
        const rotation = world.get(entity, Rotation);
        expectTurned(object, rotation);
        const scale = world.get(entity, Scale);
        expect(object.scale.toArray()).toEqual(
          scale === undefined ? [1, 1, 1] : [scale.x, scale.y, scale.z]
        );
      }
    }

    expect(made.length).toBeGreaterThan(100);
    expect(freed.length).toBeGreaterThan(50);
    // No object was freed twice.
    expect(new Set(freed.map((one) => one.object)).size).toBe(freed.length);
  });

  it("makes the objects of a loaded game on its first frame: none of them is in the save", () => {
    const first = fresh();
    const ship = first.app.world.spawn(Ship, Position.of({ x: 4, y: 5, z: 6 }));
    first.app.frame(0);
    first.app.tick(1 / 60);
    const hash = first.app.world.hash();
    const save = first.app.save();

    if (Exit.isFailure(save)) {
      throw new Error("The game could not be saved");
    }

    made.length = 0;
    const renderer = makeRenderer();
    const { app } = start(App.load(save.value, { plugins: [Fleet] }), renderer);
    expect(app.world.hash()).toBe(hash);
    expect(made).toEqual([]);
    app.frame(0);
    expect(made.map((one) => one.entity)).toEqual([ship]);
    expect(objectOf(ship)!.position.toArray()).toEqual([4, 5, 6]);
    expect(renderer.scene?.children).toEqual([objectOf(ship)]);
  });

  it("frees every object it still has when the app's scope closes", () => {
    const { app, close, renderer } = fresh();

    const ships = [1, 2, 3].map((x) =>
      app.world.spawn(Ship, Position.of({ x, y: 0, z: 0 }))
    );

    app.frame(0);
    app.world.despawn(ships[0]!);
    app.frame(0);
    expect(freed).toHaveLength(1);
    close();
    expect(freed.map((one) => one.entity).toSorted()).toEqual(ships.toSorted());
    expect(renderer.scene?.children).toEqual([]);
  });
});

describe("Three.plugin", () => {
  it("draws the scene once per frame, after everything that fills it, through the camera the game left it", () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1);
    const order: string[] = [];

    const Aim = System.make("th/Aim", function* () {
      const three = yield* Three.Scene;
      order.push("aim");
      three.camera = camera;
      // Nothing said of when: what draws the scene is of a later stage.
    }).pipe(System.inStage("frame"));

    const Ships = Three.objects("th/Flagships", {
      of: Ship,
      make: () => {
        order.push("make");

        return new Object3D();
      },
    });

    const renderer = makeRenderer();

    const layer = Layer.succeed(Three.Renderer, {
      render(scene, seen) {
        order.push("render");
        Effect.runSync(
          Effect.provide(
            Effect.map(Three.Renderer, (inner) => inner.render(scene, seen)),
            renderer.layer
          )
        );
      },
    });

    // Listed after the plugin that draws, and still drawn before it does.
    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Rocks, Ships, Aim] }),
      { layer }
    );

    expect(app.frameOrder.at(-1)).toBe("arcadekit/three/Render");

    for (let i = 0; i < 3; i += 1) {
      app.world.spawn(Rock, Position.of({ x: i, y: 0, z: 0 }));
    }

    app.world.spawn(Ship, Position.of({ x: 0, y: 0, z: 0 }));
    // Nothing is drawn by a tick.
    app.tick(1 / 60);
    expect(renderer.frames).toBe(0);
    app.frame(0);
    expect(order).toEqual(["make", "aim", "render"]);
    expect(renderer.frames).toBe(1);
    expect(renderer.camera).toBe(camera);
    // The instances were counted before the scene was drawn.
    expect(renderer.counts).toEqual([3]);
    app.frame(0.5);
    app.frame(0.9);
    expect(renderer.frames).toBe(3);
  });

  it("gives a scene with a perspective camera ten units back, for a plugin that depends on it to set up", () => {
    let seen: Three.SceneShape | undefined;
    const light = new Object3D();

    const Stage = Plugin.make("th/Stage", {
      plugins: [Three.plugin],
      layer: Layer.effectDiscard(
        Effect.map(Three.Scene, (three) => {
          seen = three;
          three.scene.add(light);
        })
      ),
    });

    const renderer = makeRenderer();
    const { app } = start(App.make({ plugins: [Stage] }), renderer);
    expect(seen?.camera).toBeInstanceOf(PerspectiveCamera);
    expect(seen?.camera.position.toArray()).toEqual([0, 0, 10]);
    app.frame(0);
    expect(renderer.scene).toBe(seen?.scene);
    expect(renderer.camera).toBe(seen?.camera);
    expect(renderer.scene?.children).toEqual([light]);
  });

  it("leaves the game as it found it: a game that is drawn is the same game as one that is not", () => {
    const Spin = System.make("th/Spin", function* () {
      const { delta, tick } = yield* Time;
      const commands = yield* Commands;
      (yield* Query.all(Position)).each((position) => {
        position.x += delta * 3;
      });

      if (tick % 7 === 0) {
        commands.spawn(Rock, Position.of({ x: tick, y: 0, z: 0 }));
        commands.spawn(Ship, Position.of({ x: 0, y: tick, z: 0 }), Rotation);
      }
    });

    const Rules = Plugin.make("th/SpinRules", {
      plugins: [Transform3d.plugin],
      components: [Rock, Ship],
      systems: [Spin],
    });

    const Flagships = Three.objects("th/Flagships", {
      of: Ship,
      make: () => new Object3D(),
    });

    const Drawn = Plugin.make("th/Drawn", {
      plugins: [Three.plugin, Rules],
      systems: [Rocks, Flagships],
    });

    const renderer = makeRenderer();

    // Checked after every system of every frame.
    const drawnGame = start(
      App.make({
        plugins: [Drawn],
        seed: 3,
        checkpointEvery: 1,
        verifyFrames: true,
      }),
      renderer
    ).app;

    const scope = Effect.runSync(Scope.make());

    const bare = Effect.runSync(
      App.make({ plugins: [Rules], seed: 3, checkpointEvery: 1 }).pipe(
        Scope.provide(scope)
      )
    );

    for (let tick = 0; tick < 60; tick += 1) {
      drawnGame.tick(1 / 60);
      drawnGame.frame(0.3);
      drawnGame.frame(0.8);
      bare.tick(1 / 60);
      expect(drawnGame.world.hash()).toBe(bare.world.hash());
    }

    expect(drawnGame.actionLog).toEqual(bare.actionLog);
    expect(renderer.counts).toEqual([8]);
    expect(renderer.frames).toBe(120);
  });

  it("does not compile without a renderer", () => {
    const made = App.make({ plugins: [Look] });
    // @ts-expect-error Three.Renderer is still needed
    const complete: Effect.Effect<unknown, never, Scope.Scope> = made;

    const provided: Effect.Effect<unknown, never, Scope.Scope> = made.pipe(
      Effect.provide(makeRenderer().layer)
    );

    expect(complete).toBe(made);
    expect(provided).not.toBe(made);
  });
});

describe("Three.layerRenderer", () => {
  /** As much of a Three.js renderer as the layer uses, noting what it is asked. */
  const makeStandIn = (size: {
    clientWidth?: number;
    clientHeight?: number;
  }) => {
    const asked: string[] = [];

    return {
      asked,
      domElement: size,
      setPixelRatio(ratio: number) {
        asked.push(`ratio ${ratio}`);
      },
      setSize(width: number, height: number, updateStyle?: boolean) {
        asked.push(`size ${width}x${height} ${updateStyle}`);
      },
      render(_scene: Scene, camera: Camera) {
        asked.push(`render ${(camera as PerspectiveCamera).aspect}`);
      },
      dispose() {
        asked.push("dispose");
      },
    };
  };

  const use = (
    standIn: ReturnType<typeof makeStandIn>,
    options?: Three.FitOptions
  ) => {
    const scope = Effect.runSync(Scope.make());
    let makes = 0;

    // Built into a scope of the test's, as a program's layers are built
    // into the program's.
    const renderer = Context.get(
      Effect.runSync(
        Layer.build(
          Three.layerRenderer(() => {
            makes += 1;

            return standIn;
          }, options)
        ).pipe(Scope.provide(scope))
      ),
      Three.Renderer
    );

    return {
      renderer,
      makes: () => makes,
      close: () => Effect.runSync(Scope.close(scope, Exit.void)),
    };
  };

  const scene = new Object3D() as Scene;

  it("fits the picture to the size the canvas has on the page, when that changes, and a perspective camera with it", () => {
    const size = { clientWidth: 800, clientHeight: 400 };
    const standIn = makeStandIn(size);
    const { makes, renderer } = use(standIn, { pixelRatio: 2 });
    expect(makes()).toBe(1);
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    let projected = 0;
    const project = camera.updateProjectionMatrix.bind(camera);
    camera.updateProjectionMatrix = () => {
      projected += 1;
      project();
    };

    renderer.render(scene, camera);
    // Without touching the canvas's style: the page decides its size.
    expect(standIn.asked).toEqual([
      "ratio 2",
      "size 800x400 false",
      "render 2",
    ]);
    expect(projected).toBe(1);
    // The same size again costs a comparison.
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    expect(standIn.asked.slice(3)).toEqual(["render 2", "render 2"]);
    expect(projected).toBe(1);
    size.clientHeight = 200;
    renderer.render(scene, camera);
    expect(standIn.asked.slice(5)).toEqual([
      "ratio 2",
      "size 800x200 false",
      "render 4",
    ]);
    expect(projected).toBe(2);
    // A camera the game swapped in is fitted too, with nothing resized.
    const other = new PerspectiveCamera(50, 1, 0.1, 100);
    renderer.render(scene, other);
    expect(standIn.asked.slice(8)).toEqual(["render 4"]);
    expect(other.aspect).toBe(4);
    // One of another kind is the game's to fit.
    const flat = new OrthographicCamera(-1, 1, 1, -1);
    renderer.render(scene, flat);
    expect(flat.left).toBe(-1);
    expect(standIn.asked).toHaveLength(10);
  });

  it("takes the page's own pixel ratio, up to 2, unless it is given one", () => {
    const standIn = makeStandIn({ clientWidth: 100, clientHeight: 100 });
    const { renderer } = use(standIn);
    const camera = new PerspectiveCamera();
    const page = globalThis as { devicePixelRatio?: number };

    try {
      renderer.render(scene, camera);
      expect(standIn.asked[0]).toBe("ratio 1");
      page.devicePixelRatio = 1.5;
      renderer.render(scene, camera);
      expect(standIn.asked.slice(3, 5)).toEqual([
        "ratio 1.5",
        "size 100x100 false",
      ]);
      page.devicePixelRatio = 3;
      renderer.render(scene, camera);
      expect(standIn.asked.slice(6, 8)).toEqual([
        "ratio 2",
        "size 100x100 false",
      ]);
    } finally {
      delete page.devicePixelRatio;
    }
  });

  it("fits nothing when told not to, or when the canvas has no size on a page", () => {
    const camera = new PerspectiveCamera(50, 1.25, 0.1, 100);
    const told = makeStandIn({ clientWidth: 800, clientHeight: 400 });
    use(told, { fit: false }).renderer.render(scene, camera);
    expect(told.asked).toEqual(["render 1.25"]);

    for (const size of [
      {},
      { clientWidth: 0, clientHeight: 0 },
      { clientWidth: 300, clientHeight: 0 },
    ]) {
      const standIn = makeStandIn(size);
      use(standIn).renderer.render(scene, camera);
      expect(standIn.asked).toEqual(["render 1.25"]);
    }
  });

  it("disposes of the renderer when the scope it was provided to closes, and not before", () => {
    const standIn = makeStandIn({});
    const { close, renderer } = use(standIn);
    renderer.render(scene, new PerspectiveCamera());
    expect(standIn.asked).not.toContain("dispose");
    close();
    expect(standIn.asked.at(-1)).toBe("dispose");
    expect(standIn.asked.filter((one) => one === "dispose")).toHaveLength(1);
  });
});
