/// <reference types="node" />
import {
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  System,
  Time,
  Transform,
  Transform2d,
} from "arcadekit";
import type { Entity } from "arcadekit";
import type { ComponentInput } from "arcadekit/ecs";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import type { Camera, Scene } from "three";
import { describe, expect, it } from "vitest";

import { Three } from "../src/index";

const { Position, Rotation, Scale } = Transform;

const Rock = Component.tag("th/Rock");
const Ship = Component.tag("th/Ship");
const Hidden = Component.tag("th/Hidden", { storage: "sparse" });
const Heavy = Component.tag("th/Heavy");
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
      renderer.frames++;
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
  for (let i = 0; i < mesh.count; i++) {
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
    rotation === undefined
      ? new Quaternion()
      : new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    scale === undefined
      ? new Vector3(1, 1, 1)
      : new Vector3(scale.x, scale.y, scale.z)
  );
  return Array.from(new Float32Array(matrix.elements)).join(" ");
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
  for (let i = 0; i < mesh.count; i++) {
    rows.push(
      Array.from(mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16))
    );
  }
  const drawnRows = byPlace(rows);
  const wanted = byPlace(entities.map((entity) => placeOf(app, entity)));
  for (let i = 0; i < wanted.length; i++) {
    for (let k = 0; k < 16; k++) {
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

describe("arcadekit's Transform, as Three.js reads it", () => {
  it("axisAngle gives the quaternion Three.js gives for the same turn", () => {
    for (const [x, y, z, angle] of [
      [0, 0, 1, Math.PI / 2],
      [0, 1, 0, Math.PI],
      [1, 0, 0, -0.3],
      [0.6, 0, 0.8, 2.5],
      [0, 1, 0, 0],
    ] as const) {
      const ours = Transform.axisAngle(x, y, z, angle);
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
    const turn = Transform.axisAngle(0, 0, 1, Math.PI / 3);
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
        Rotation.of(Transform.axisAngle(1, 0, 0, 2)),
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
    expect(drawn(mesh)).toEqual(expected(app, rocks));
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
    for (let frame = 0; frame < 120; frame++) {
      for (let step = 0; step < 12; step++) {
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
      expect(drawn(mesh)).toEqual(expected(app, alive));
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
    const turn = Rotation.of(Transform.axisAngle(0, 1, 0, 1));
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
      for (let i = 0; i < count; i++) {
        rocks.push(
          app.world.spawn(Rock, Position.of({ x: rocks.length, y: 1, z: 2 }))
        );
      }
    };
    more(4);
    app.frame(0);
    const mesh = meshOf(renderer.scene, "th/Few");
    const first = mesh.instanceMatrix;
    expect(first.array.length).toBe(4 * 16);
    let dropped = 0;
    mesh.addEventListener("dispose", () => {
      dropped++;
    });
    // Full, and not over: nothing is allocated.
    app.frame(0);
    expect(mesh.instanceMatrix).toBe(first);
    expect(dropped).toBe(0);
    more(1);
    app.frame(0);
    expect(mesh.instanceMatrix).not.toBe(first);
    expect(mesh.instanceMatrix.array.length).toBe(8 * 16);
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
    expect(mesh.instanceMatrix.array.length).toBe(64 * 16);
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

  it("draws ten thousand moving objects without one allocation per object per frame", () => {
    const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));
    const MovingFlat = Query.all(Transform2d.Position, Velocity).pipe(
      Query.reads(Velocity)
    );
    const Move = System.make("th/Move", function* () {
      const { delta } = yield* Time;
      (yield* Moving).eachChunk((from, to, position, velocity) => {
        for (let i = from; i < to; i++) {
          position.x[i] = position.x[i]! + velocity.x[i]! * delta;
          position.y[i] = position.y[i]! + velocity.y[i]! * delta;
          position.z[i] = position.z[i]! + velocity.z[i]! * delta;
        }
      });
      (yield* MovingFlat).eachChunk((from, to, position, velocity) => {
        for (let i = from; i < to; i++) {
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
    });
    const renderer = makeRenderer();
    const { app } = start(
      App.make({ plugins: [Three.plugin], systems: [Move, Crowd] }),
      renderer
    );
    const random = makeRandom(5);
    const count = 10_000;
    const rocks: Entity[] = [];
    for (let i = 0; i < count; i++) {
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
      app.frame(0);
    };
    // Until the loops are compiled, and whatever is made once is made.
    for (let i = 0; i < 200; i++) {
      step();
    }
    const mesh = meshOf(renderer.scene, "th/Crowd");
    const attribute = mesh.instanceMatrix;
    const buffer = attribute.array;
    const [range] = attribute.updateRanges;
    // How much the heap grew over one tick and one frame, many times: the
    // middle one, since now and then the collector runs in between.
    const grown: number[] = [];
    for (let i = 0; i < 101; i++) {
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
    expect(app.world.get(rocks[0]!, Position)!.x).toBeGreaterThan(4);
    expect(app.world.get(rocks[4]!, Transform2d.Position)!.x).toBeGreaterThan(
      4
    );
    expectDrawn(mesh, app, rocks);
  });

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
    for (let frame = 0; frame < 100; frame++) {
      for (let step = 0; step < 12; step++) {
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
    expect(made.length).toBe(2);
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
    expect(made.length).toBe(2);
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
    for (let i = 0; i < 200; i++) {
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

  it("makes one object per entity, once, adds it to the scene and puts it where the entity is", () => {
    const { app, renderer } = fresh();
    const turn = Transform.axisAngle(0, 1, 0, 0.75);
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
    expect(objectOf(whole)!.quaternion.toArray()).toEqual(
      Array.from(new Float32Array([turn.x, turn.y, turn.z, turn.w]))
    );
    expect(objectOf(whole)!.scale.toArray()).toEqual([2, 3, 4]);
    // It moves with its entity, and is not made again.
    app.world.set(plain, Position, { x: 10, y: 20, z: 30 });
    app.world.set(whole, Scale, { x: 5, y: 5, z: 5 });
    app.world.set(whole, Rotation, { x: 0, y: 0, z: 1, w: 0 });
    app.frame(0);
    expect(made.length).toBe(2);
    expect(freed).toEqual([]);
    expect(objectOf(plain)!.position.toArray()).toEqual([10, 20, 30]);
    expect(objectOf(whole)!.scale.toArray()).toEqual([5, 5, 5]);
    expect(objectOf(whole)!.quaternion.toArray()).toEqual([0, 0, 1, 0]);
  });

  it("takes the object out and frees it when its entity is gone, or is no longer one of these", () => {
    const { app, renderer } = fresh();
    const at = (x: number) => Position.of({ x, y: 0, z: 0 });
    const [gone, unmarked, hidden, nowhere, stays] = [1, 2, 3, 4, 5].map((x) =>
      app.world.spawn(Ship, at(x))
    ) as [Entity, Entity, Entity, Entity, Entity];
    app.frame(0);
    expect(made.length).toBe(5);
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
    expect(freed.length).toBe(4);
    // One that is one of these again gets a new object.
    app.world.remove(hidden, Hidden);
    app.frame(0);
    expect(made.length).toBe(6);
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
    expect(made.length).toBe(2);
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
    expect(made.length).toBe(1);
  });

  it("keeps exactly one object for each entity that is one of these, whatever happens to them", () => {
    const random = makeRandom(77);
    const { app, renderer } = fresh();
    const { world } = app;
    const all: Entity[] = [];
    for (let frame = 0; frame < 150; frame++) {
      for (let step = 0; step < 8; step++) {
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
        expect(object.quaternion.toArray()).toEqual(
          rotation === undefined
            ? [0, 0, 0, 1]
            : [rotation.x, rotation.y, rotation.z, rotation.w]
        );
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
    expect(freed.length).toBe(1);
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
    }).pipe(System.inStage("frame"), System.before(Three.Render));
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
    for (let i = 0; i < 3; i++) {
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
      plugins: [Transform.plugin],
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
    for (let tick = 0; tick < 60; tick++) {
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
            makes++;
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
      projected++;
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
    expect(standIn.asked.length).toBe(10);
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
    expect(standIn.asked.filter((one) => one === "dispose").length).toBe(1);
  });
});
