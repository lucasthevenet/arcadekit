/// <reference types="node" />
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Action,
  App,
  Color,
  Commands,
  Component,
  Driver,
  EntityId,
  Field,
  Plugin,
  Query,
  System,
  Time,
  Transform2d,
  Transform3d,
  World,
} from "arcadekit";
import type { Entity } from "arcadekit";
import { entityGeneration, entityIndex } from "arcadekit/ecs";
import type { ComponentDef, ComponentInput, ValueOf } from "arcadekit/ecs";
import type { BuiltIn, ReadingWorld } from "arcadekit/Services";
import { Cause, Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Color as ThreeColor,
  Vector3,
} from "three";
import type { Camera, Scene } from "three";

import { Three } from "../src/index.ts";
import { thrown } from "./checks.ts";

const { Position, Rotation, Scale } = Transform3d;

const Rock = Component.tag("th/Rock", { requires: [Transform3d.Position] });
const Ship = Component.tag("th/Ship", { requires: [Transform3d.Position] });
const FlatRock = Component.tag("th/FlatRock", {
  requires: [Transform2d.Position],
});
const FlatShip = Component.tag("th/FlatShip", {
  requires: [Transform2d.Position],
});
const Hidden = Component.tag("th/Hidden", { storage: "sparse" });
const Heavy = Component.tag("th/Heavy");
const Velocity = Component.define("th/Velocity", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

// --- the hand of these tests, which changes a game from outside it ----------------
/** Every component a test puts on an entity, by its name. */
const components: readonly ComponentDef[] = [
  Position,
  Rotation,
  Scale,
  Transform2d.Position,
  Transform2d.Rotation,
  Transform2d.Scale,
  Rock,
  Ship,
  FlatRock,
  FlatShip,
  Hidden,
  Heavy,
  Color.Rgb,
  Velocity,
];
const named = new Map(components.map((def) => [def.name, def]));
const defOf = (name: string): ComponentDef => {
  const def = named.get(name);
  if (def === undefined) {
    throw new Error(
      `These tests know no component named "${name}". Add it to components.`
    );
  }
  return def;
};

/** A component as an action carries it: its name, and its value if it has one. */
const Part = Schema.Struct({
  component: Schema.String,
  value: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});
const partOf = (input: ComponentInput) =>
  "def" in input
    ? { component: input.def.name, value: input.value }
    : { component: input.name };
const inputOf = ({ component, value }: typeof Part.Type): ComponentInput => {
  const def = defOf(component);
  return value === undefined ? def : def.of(value);
};

const Spawn = Action.define(
  "th/Spawn",
  Schema.Struct({ parts: Schema.Array(Part) })
);
const Add = Action.define(
  "th/Add",
  Schema.Struct({ entity: EntityId, part: Part })
);
const Remove = Action.define(
  "th/Remove",
  Schema.Struct({ entity: EntityId, component: Schema.String })
);
const Change = Action.define(
  "th/Change",
  Schema.Struct({
    entity: EntityId,
    component: Schema.String,
    value: Schema.Record(Schema.String, Schema.Number),
  })
);
const Despawn = Action.define(
  "th/Despawn",
  Schema.Struct({ entity: EntityId })
);

/** The actions a test changes its game with between frames. */
const Hand = Plugin.make("th/Hand", {
  handlers: [
    Action.handler(Spawn, function* ({ parts }) {
      return (yield* Commands.spawns(...components)).spawn(
        ...parts.map(inputOf)
      );
    }),
    Action.handler(Add, function* ({ entity, part }) {
      (yield* Commands.spawns(...components)).add(entity, inputOf(part));
    }),
    Action.handler(Remove, function* ({ component, entity }) {
      (yield* Commands).remove(entity, defOf(component));
    }),
    Action.handler(Change, function* ({ component, entity, value }) {
      (yield* World.writes(...components)).set(entity, defOf(component), value);
    }),
    Action.handler(Despawn, function* ({ entity }) {
      (yield* Commands).despawn(entity);
    }),
  ],
});

/** Changes an app's game with the actions of `Hand`, each applied at once. */
const handOf = <E>(app: {
  readonly dispatchByName: (
    name: string,
    payload: unknown
  ) => Effect.Effect<unknown, E>;
}) => {
  const dispatch = Effect.fnUntraced(function* (
    name: string,
    payload: unknown
  ) {
    const exit = yield* Effect.exit(app.dispatchByName(name, payload));
    if (Exit.isFailure(exit)) {
      throw new Error(`${name} was refused: ${Cause.pretty(exit.cause)}`);
    }
    return exit.value;
  });
  return {
    spawn: Effect.fnUntraced(function* (...inputs: readonly ComponentInput[]) {
      const entity = yield* dispatch(Spawn.name, {
        parts: inputs.map(partOf),
      });
      if (!Schema.is(EntityId)(entity)) {
        throw new Error(
          `${Spawn.name} gave ${String(entity)}, which is no entity`
        );
      }
      return entity;
    }),
    add: (entity: Entity, input: ComponentInput) =>
      Effect.asVoid(dispatch(Add.name, { entity, part: partOf(input) })),
    remove: (entity: Entity, def: ComponentDef) =>
      Effect.asVoid(dispatch(Remove.name, { entity, component: def.name })),
    set: <S extends ComponentDef["schema"]>(
      entity: Entity,
      def: ComponentDef<S>,
      value: Partial<ValueOf<S>>
    ) =>
      Effect.asVoid(
        dispatch(Change.name, { entity, component: def.name, value })
      ),
    despawn: (entity: Entity) =>
      Effect.asVoid(dispatch(Despawn.name, { entity })),
  };
};

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
    /** Draws a scene, as the renderer the layer provides does. */
    render(scene: Scene, camera: Camera): void {
      renderer.frames++;
      renderer.scene = scene;
      renderer.camera = camera;
      renderer.counts = scene.children
        .filter((child) => child instanceof InstancedMesh)
        .map((mesh) => mesh.count);
    },
  };
  renderer.layer = Three.layer({
    render: (scene, camera) => renderer.render(scene, camera),
  });
  return renderer;
};

/**
 * An app, which the test closes when it likes, with the world it reads and
 * the hand it changes the game with.
 */
const start = Effect.fnUntraced(function* <E, HU, E2>(
  make: Effect.Effect<App.App<E, HU>, E2, Three.Renderer>,
  renderer: { readonly layer: Layer.Layer<Three.Renderer> }
) {
  const app = yield* make.pipe(Effect.provide(renderer.layer));
  return {
    app,
    world: yield* app.read(World),
    hand: handOf(app),
    close: app.close,
  };
});

/** Which module places the entities of a kind. */
type Transform = typeof Transform3d | typeof Transform2d;

const Rocks = Three.instances("th/Rocks", {
  of: Rock,
  transform: Transform3d,
  geometry,
  material,
});
const Look = Plugin.make("th/Look", {
  plugins: [Three.plugin, Hand],
  systems: [Rocks],
});
/** A flat game's rocks, placed as it places them. */
const FlatRocks = Three.instances("th/FlatRocks", {
  of: FlatRock,
  transform: Transform2d,
  geometry,
  material,
});
const FlatLook = Plugin.make("th/FlatLook", {
  plugins: [Three.plugin, Hand],
  systems: [FlatRocks],
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

/** The sixteen numbers of each instance a mesh draws, in the order it draws them. */
const rowsOf = (mesh: InstancedMesh): number[][] =>
  Array.from({ length: mesh.count }, (_, i) =>
    Array.from(mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16))
  );

/** What Three.js itself makes of an entity's place: the matrix it should be drawn with. */
const matrixOf = (world: ReadingWorld, entity: Entity): string => {
  const position = world.get(entity, Position)!;
  const rotation = world.get(entity, Rotation);
  const scale = world.get(entity, Scale);
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
 * The sixteen numbers an entity should be drawn with by a kind of this
 * transform, as Three.js composes them. A flat one is in the plane of x
 * and y, turned about the axis that comes out of it.
 */
const placeOf = (
  world: ReadingWorld,
  entity: Entity,
  transform: Transform
): number[] => {
  if (transform === Transform3d) {
    return matrixOf(world, entity)
      .split(" ")
      .map((text) => Number(text));
  }
  const position = world.get(entity, Transform2d.Position)!;
  const rotation = world.get(entity, Transform2d.Rotation);
  const scale = world.get(entity, Transform2d.Scale);
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
 * Checks that a mesh of a kind of this transform draws exactly these
 * entities, each where it is. To six decimals: a turn in the plane is a
 * sine and a cosine here and a quaternion in Three.js, which agree to the
 * last bit but one.
 */
const expectDrawn = (
  mesh: InstancedMesh,
  world: ReadingWorld,
  entities: readonly Entity[],
  transform: Transform
): void => {
  expect(mesh.count).toBe(entities.length);
  const drawnRows = byPlace(rowsOf(mesh));
  const wanted = byPlace(
    entities.map((entity) => placeOf(world, entity, transform))
  );
  for (let i = 0; i < wanted.length; i++) {
    for (let k = 0; k < 16; k++) {
      expect(drawnRows[i]![k], `instance ${i}, element ${k}`).toBeCloseTo(
        wanted[i]![k]!,
        5
      );
    }
  }
};

const expected = (world: ReadingWorld, entities: readonly Entity[]): string[] =>
  entities.map((entity) => matrixOf(world, entity)).toSorted();

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
  it.effect(
    "draws every entity of a kind as one instance of one mesh, where the entity is",
    () =>
      Effect.gen(function* () {
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(App.define({ plugins: [Look] })),
          renderer
        );
        const turn = Transform3d.axisAngle(0, 0, 1, Math.PI / 3);
        const rocks = [
          yield* hand.spawn(Rock, Position.of({ x: 1, y: 2, z: 3 })),
          yield* hand.spawn(
            Rock,
            Position.of({ x: -4, y: 0.5, z: 9 }),
            Scale.of({ x: 2, y: 3, z: 0.5 })
          ),
          yield* hand.spawn(
            Rock,
            Position.of({ x: 7, y: 7, z: 7 }),
            Rotation.of(turn)
          ),
          yield* hand.spawn(
            Rock,
            Position.of({ x: 0, y: -1, z: 0 }),
            Rotation.of(Transform3d.axisAngle(1, 0, 0, 2)),
            Scale.of({ x: 0.25, y: 4, z: 1.5 })
          ),
        ];
        // Not rocks: the same four of another kind, and one that is nowhere.
        yield* hand.spawn(Ship, Position.of({ x: 5, y: 5, z: 5 }));
        yield* hand.spawn(Ship, Position.of({ x: 5, y: 5, z: 5 }), Scale);
        yield* hand.spawn(Ship, Position.of({ x: 5, y: 5, z: 5 }), Rotation);
        yield* hand.spawn(
          Ship,
          Position.of({ x: 5, y: 5, z: 5 }),
          Rotation,
          Scale
        );
        yield* hand.remove(yield* hand.spawn(Rock), Position);
        yield* app.frame();

        const mesh = meshOf(renderer.scene, "th/Rocks");
        expect(mesh.geometry).toBe(geometry);
        expect(mesh.material).toBe(material);
        expect(mesh.count).toBe(4);
        expectDrawn(mesh, world, rocks, Transform3d);
        // One by hand, so that the test does not only agree with Three.js: a
        // rock that is only somewhere is drawn there, upright.
        expect(drawn(mesh)).toContain("1 0 0 0 0 1 0 0 0 0 1 0 1 2 3 1");
        // It is the one mesh of the scene, and it is not culled.
        expect(renderer.scene?.children).toEqual([mesh]);
        expect(mesh.frustumCulled).toBe(false);
      })
  );

  it("does not compile unless it is told which transform places its entities, one of the two modules, whose Position its components require", () => {
    const make = () => new Object3D();
    // A position of a flat game's and a turn in three dimensions.
    const mixed = { ...Transform2d, Rotation: Transform3d.Rotation };
    const kinds = (): void => {
      // @ts-expect-error which transform is not said
      Three.instances("th/Unsaid", { of: Rock, geometry, material });
      // @ts-expect-error nor for objects
      Three.objects("th/UnsaidObjects", { of: Ship, make });
      Three.instances("th/Mixed", {
        of: [Rock, FlatRock],
        // @ts-expect-error a mix of the two is neither
        transform: mixed,
        geometry,
        material,
      });
      const transforms: readonly Transform[] = [Transform3d, Transform2d];
      const either = transforms[0]!;
      Three.instances("th/Either", {
        of: Rock,
        // @ts-expect-error a transform that may be either needs both positions
        transform: either,
        geometry,
        material,
      });
      // @ts-expect-error a component of one is not the module
      Three.objects("th/Part", { of: Ship, transform: Position, make });
      Three.instances("th/Nowhere", {
        of: Heavy,
        // @ts-expect-error a component that requires no Position
        transform: Transform3d,
        geometry,
        material,
      });
      Three.objects("th/NowhereObjects", {
        of: Heavy,
        // @ts-expect-error nor for objects
        transform: Transform2d,
        make,
      });
      Three.instances("th/Lifted", {
        of: Rock,
        // @ts-expect-error a rock requires the Position of Transform3d
        transform: Transform2d,
        geometry,
        material,
      });
      Three.objects("th/LiftedObjects", {
        of: [Ship, Heavy],
        // @ts-expect-error nor for objects, of several components
        transform: Transform2d,
        make,
      });
      // A kind of the Position itself, or of a list with it, has that Position.
      Three.instances("th/Positions", {
        of: Position,
        transform: Transform3d,
        geometry,
        material,
      });
      Three.objects("th/HeavyPositions", {
        of: [Heavy, Transform2d.Position],
        transform: Transform2d,
        make,
      });
      Three.instances("th/OtherPosition", {
        of: [Heavy, Transform2d.Position],
        // @ts-expect-error the Position of the other module
        transform: Transform3d,
        geometry,
        material,
      });
      const bare: ComponentDef = Heavy;
      Three.instances("th/Bare", {
        of: bare,
        // @ts-expect-error a component whose names the compiler doesn't read
        transform: Transform3d,
        geometry,
        material,
      });
      const bares: readonly ComponentDef[] = [Heavy];
      Three.objects("th/Bares", {
        of: bares,
        // @ts-expect-error nor for objects, of several components
        transform: Transform2d,
        make,
      });
      const loose = (of: typeof Rock | typeof FlatRock, transform: Transform) =>
        Three.instances("th/Loose", {
          of,
          // @ts-expect-error a helper that may pair a rock with Transform2d
          transform,
          geometry,
          material,
        });
      const tied = <const O extends Three.KindOptions["of"]>(
        of: O,
        transform: Three.TransformOf<O>
      ) => Three.instances("th/Tied", { of, transform, geometry, material });
      tied(Rock, Transform3d);
      tied(Transform3d.Position, Transform3d);
      tied([Rock, bare], Transform3d);
      tied([Rock, FlatRock], either);
      // @ts-expect-error the Position of the other module
      tied(Transform3d.Position, Transform2d);
      // @ts-expect-error a rock beside a component the compiler doesn't read
      tied([Rock, bare], Transform2d);
      // @ts-expect-error a helper of one type for both pairs them too
      tied(Rock, Transform2d);
      // @ts-expect-error nor of either rock
      tied(Math.random() < 0.5 ? Rock : FlatRock, Transform2d);
      void loose;
    };
    void kinds;
    expect(
      [
        Three.instances("th/Flat", {
          of: FlatRock,
          transform: Transform2d,
          geometry,
          material,
        }),
        Three.objects("th/Solid", { of: Ship, transform: Transform3d, make }),
      ].map((system) => system.name)
    ).toEqual(["th/Flat", "th/Solid"]);
  });

  it("refuses an of that requires no Position, or that the compiler can't read, with the whole reason, first, for either transform and each system", () => {
    const repo = realpathSync(
      fileURLToPath(new URL("../../..", import.meta.url))
    );
    const dir = mkdtempSync(join(tmpdir(), "three-of-"));
    symlinkSync(
      join(repo, "packages/three/node_modules"),
      join(dir, "node_modules")
    );
    const three = relative(dir, join(repo, "packages/three/src/index.ts"));
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    writeFileSync(
      join(dir, "game.ts"),
      `import { Assets, Component, Transform2d, Transform3d } from "arcadekit";
import type { ComponentDef } from "arcadekit/ecs";
import { BoxGeometry, MeshBasicMaterial, Object3D } from "three";

import { Gltf, Three } from "${three}";

const geometry = new BoxGeometry();
const material = new MeshBasicMaterial();
const make = () => new Object3D();
const Heavy = Component.tag("game/Heavy");

Three.instances("game/Rocks", { of: Heavy, transform: Transform3d, geometry, material });
Three.instances("game/Cards", { of: Heavy, transform: Transform2d, geometry, material });
Three.objects("game/Ships", { of: Heavy, transform: Transform3d, make });
Three.objects("game/Pieces", { of: Heavy, transform: Transform2d, make });

const Forest = Assets.bundle("game/Forest", { notes: Assets.text("/notes.txt") });
Gltf.instances("game/Trees", { of: Heavy, transform: Transform3d, from: Forest, look: () => ({ geometry, material }) });
Gltf.objects("game/Deer", { of: Heavy, transform: Transform2d, from: Forest, make });

const Rock = Component.tag("game/Rock", { requires: [Transform3d.Position] });
const bare: ComponentDef = Rock;
const bares: readonly ComponentDef[] = [Rock];
Three.instances("game/Bare", { of: bare, transform: Transform3d, geometry, material });
Gltf.objects("game/Bares", { of: bares, transform: Transform3d, from: Forest, make });
`
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(repo, "tsconfig.base.json"),
        compilerOptions: { lib: ["ES2023", "DOM"], types: [] },
        files: ["game.ts"],
      })
    );
    const { stdout } = spawnSync(
      join(repo, "node_modules/.bin/tsc"),
      ["-p", ".", "--pretty", "false"],
      { cwd: dir, encoding: "utf-8" }
    );
    rmSync(dir, { recursive: true });
    const reason = `"The kind's \\"of\\" doesn't require one transform's Position, whichever of its components it is, so an entity spawned with it alone may never be drawn. Add the kind's transform's Position to its component's requires, and type it as that component itself."`;
    const refused = (line: number, column: number, dimensions: 2 | 3) =>
      `game.ts(${line},${column}): error TS2322: Type 'typeof import("${repo}/packages/arcadekit/src/Transform${dimensions}d")' is not assignable to type '{ readonly Position: { readonly name: ${reason}; }; }'.
  The types of 'Position.name' are incompatible between these types.
    Type '"arcadekit/Transform${dimensions}d.Position"' is not assignable to type '${reason}'.`;
    expect(stdout.trimEnd().split(/\n(?=game\.ts)/)).toEqual([
      refused(12, 44, 3),
      refused(13, 44, 2),
      refused(14, 42, 3),
      refused(15, 43, 2),
      refused(18, 43, 3),
      refused(19, 40, 2),
      refused(24, 42, 3),
      refused(25, 41, 3),
    ]);
  });

  it.effect("draws a rotation left at zero as no turn at all", () =>
    Effect.gen(function* () {
      const renderer = makeRenderer();
      const { app, hand } = yield* start(
        App.make(App.define({ plugins: [Look] })),
        renderer
      );
      yield* hand.spawn(Rock, Position.of({ x: 1, y: 2, z: 3 }), Rotation);
      yield* hand.spawn(
        Rock,
        Position.of({ x: 4, y: 5, z: 6 }),
        Rotation,
        Scale.of({ x: 2, y: 2, z: 2 })
      );
      yield* app.frame();
      expect(drawn(meshOf(renderer.scene, "th/Rocks"))).toEqual([
        "1 0 0 0 0 1 0 0 0 0 1 0 1 2 3 1",
        "2 0 0 0 0 2 0 0 0 0 2 0 4 5 6 1",
      ]);
    })
  );

  it.effect(
    "draws a rotation of any length as the turn it stands for, neither skewed nor sized by it",
    () =>
      Effect.gen(function* () {
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(App.define({ plugins: [Look] })),
          renderer
        );
        const quarter = Transform3d.axisAngle(0, 0, 1, Math.PI / 2);
        const rocks = [
          // Three times too long, and a hundredth of what it should be.
          yield* hand.spawn(
            Rock,
            Position.of({ x: 1, y: 0, z: 0 }),
            Rotation.of(stretched(quarter, 3))
          ),
          yield* hand.spawn(
            Rock,
            Position.of({ x: 2, y: 0, z: 0 }),
            Rotation.of(stretched(quarter, 0.01)),
            Scale.of({ x: 2, y: 3, z: 4 })
          ),
          yield* hand.spawn(
            Rock,
            Position.of({ x: 3, y: 0, z: 0 }),
            Rotation.of(stretched(Transform3d.axisAngle(0.6, 0, 0.8, 1.2), 40)),
            Scale.of({ x: 0.5, y: 1, z: 6 })
          ),
        ];
        yield* app.frame();
        const mesh = meshOf(renderer.scene, "th/Rocks");
        // As Three.js draws the same turns made of length 1.
        expectDrawn(mesh, world, rocks, Transform3d);
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
          for (let k = 0; k < 16; k++) {
            expect(rows[i]![k], `rock ${i}, element ${k}`).toBeCloseTo(
              row[k]!,
              5
            );
          }
        }
      })
  );

  it.effect(
    "follows the entities as they move, come and go, and gain and lose a rotation or a scale",
    () =>
      Effect.gen(function* () {
        const random = makeRandom(20_261_116);
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(App.define({ plugins: [Look] })),
          renderer
        );
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
              alive.push(yield* hand.spawn(...parts));
            } else if (roll === 3) {
              yield* hand.despawn(one);
              alive.splice(alive.indexOf(one), 1);
            } else if (roll === 4) {
              yield* hand.add(one, turn());
            } else if (roll === 5) {
              yield* hand.remove(one, Rotation);
            } else if (roll === 6) {
              yield* hand.add(one, size());
            } else if (roll === 7) {
              yield* hand.remove(one, Scale);
            } else {
              yield* hand.add(one, place());
            }
          }
          yield* app.frame();
          const mesh = meshOf(renderer.scene, "th/Rocks");
          expect(mesh.count).toBe(alive.length);
          expectDrawn(mesh, world, alive, Transform3d);
        }
        // All four kinds of table were drawn from along the way.
        expect(
          alive.some((one) => world.has(one, Rotation) && world.has(one, Scale))
        ).toBe(true);
        expect(
          alive.some(
            (one) => world.has(one, Rotation) && !world.has(one, Scale)
          )
        ).toBe(true);
        expect(
          alive.some(
            (one) => !world.has(one, Rotation) && world.has(one, Scale)
          )
        ).toBe(true);
        expect(
          alive.some(
            (one) => !world.has(one, Rotation) && !world.has(one, Scale)
          )
        ).toBe(true);
      })
  );

  it.effect(
    "draws only the entities that have every component it was given and none of those it was told to leave out",
    () =>
      Effect.gen(function* () {
        const Heavies = Three.instances("th/Heavies", {
          of: [Rock, Heavy],
          transform: Transform3d,
          without: [Hidden],
          geometry,
          material,
        });
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(
            App.define({ plugins: [Three.plugin, Hand], systems: [Heavies] })
          ),
          renderer
        );
        const at = (x: number) => Position.of({ x, y: 0, z: 0 });
        const turn = Rotation.of(Transform3d.axisAngle(0, 1, 0, 1));
        const size = Scale.of({ x: 2, y: 3, z: 4 });
        // One of each kind of table, shown and hidden.
        const shown = [
          yield* hand.spawn(Rock, Heavy, at(1)),
          yield* hand.spawn(Rock, Heavy, at(2), size),
          yield* hand.spawn(Rock, Heavy, at(3), turn),
          yield* hand.spawn(Rock, Heavy, at(4), turn, size),
        ];
        const hidden = [
          yield* hand.spawn(Rock, Heavy, Hidden, at(5)),
          yield* hand.spawn(Rock, Heavy, Hidden, at(6), size),
          yield* hand.spawn(Rock, Heavy, Hidden, at(7), turn),
          yield* hand.spawn(Rock, Heavy, Hidden, at(8), turn, size),
        ];
        // With one of the two components only, of each kind too.
        for (const only of [Rock, Heavy]) {
          yield* hand.spawn(only, at(9));
          yield* hand.spawn(only, at(9), size);
          yield* hand.spawn(only, at(9), turn);
          yield* hand.spawn(only, at(9), turn, size);
        }
        yield* app.frame();
        const mesh = meshOf(renderer.scene, "th/Heavies");
        expect(mesh.count).toBe(4);
        expect(drawn(mesh)).toEqual(expected(world, shown));
        // Shown again, and hidden.
        for (const one of hidden) {
          yield* hand.remove(one, Hidden);
        }
        for (const one of shown) {
          yield* hand.add(one, Hidden);
        }
        yield* app.frame();
        expect(mesh.count).toBe(4);
        expect(drawn(mesh)).toEqual(expected(world, hidden));
      })
  );

  it.effect(
    "makes its mesh once, names it, and hands it over once to be prepared",
    () =>
      Effect.gen(function* () {
        const prepared: InstancedMesh[] = [];
        const Shadows = Three.instances("th/Shadows", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
          prepare: (mesh) => {
            prepared.push(mesh);
            mesh.castShadow = true;
            mesh.frustumCulled = true;
          },
        });
        const renderer = makeRenderer();
        const { app, hand } = yield* start(
          App.make(
            App.define({ plugins: [Three.plugin, Hand], systems: [Shadows] })
          ),
          renderer
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 0, z: 0 }));
        yield* app.frame();
        yield* app.frame();
        yield* app.tick(1 / 60);
        yield* app.frame();
        const mesh = meshOf(renderer.scene, "th/Shadows");
        expect(prepared).toEqual([mesh]);
        expect(mesh.castShadow).toBe(true);
        // What `prepare` says stands: it is asked last.
        expect(mesh.frustumCulled).toBe(true);
        expect(renderer.scene?.children.length).toBe(1);
      })
  );

  it.effect(
    "doubles its room when it runs out, lets the renderer drop the old buffer, and keeps what it drew",
    () =>
      Effect.gen(function* () {
        const Few = Three.instances("th/Few", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
          capacity: 4,
        });
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(
            App.define({ plugins: [Three.plugin, Hand], systems: [Few] })
          ),
          renderer
        );
        const rocks: Entity[] = [];
        const more = Effect.fnUntraced(function* (count: number) {
          for (let i = 0; i < count; i++) {
            rocks.push(
              yield* hand.spawn(
                Rock,
                Position.of({ x: rocks.length, y: 1, z: 2 })
              )
            );
          }
        });
        yield* more(4);
        yield* app.frame();
        const mesh = meshOf(renderer.scene, "th/Few");
        const first = mesh.instanceMatrix;
        expect(first.array.length).toBe(4 * 16);
        let dropped = 0;
        mesh.addEventListener("dispose", () => {
          dropped++;
        });
        // Full, and not over: nothing is allocated.
        yield* app.frame();
        expect(mesh.instanceMatrix).toBe(first);
        expect(dropped).toBe(0);
        yield* more(1);
        yield* app.frame();
        expect(mesh.instanceMatrix).not.toBe(first);
        expect(mesh.instanceMatrix.array.length).toBe(8 * 16);
        expect(dropped).toBe(1);
        expect(drawn(mesh)).toEqual(expected(world, rocks));
        // Far over, in one frame and across two kinds of table.
        yield* more(40);
        rocks.push(
          yield* hand.spawn(
            Rock,
            Position.of({ x: -1, y: -1, z: -1 }),
            Scale.of({ x: 3, y: 3, z: 3 })
          )
        );
        yield* app.frame();
        expect(mesh.instanceMatrix.array.length).toBe(64 * 16);
        expect(dropped).toBe(2);
        expect(mesh.count).toBe(46);
        expect(drawn(mesh)).toEqual(expected(world, rocks));
        // The room is kept when the entities go.
        const full = mesh.instanceMatrix;
        for (const rock of rocks.splice(2)) {
          yield* hand.despawn(rock);
        }
        yield* app.frame();
        expect(mesh.instanceMatrix).toBe(full);
        expect(mesh.count).toBe(2);
        expect(drawn(mesh)).toEqual(expected(world, rocks));
      })
  );

  it.effect(
    "tells the renderer to send what is drawn and no more, each frame something is",
    () =>
      Effect.gen(function* () {
        const renderer = makeRenderer();
        const { app, hand } = yield* start(
          App.make(App.define({ plugins: [Look] })),
          renderer
        );
        const rocks = yield* Effect.forEach([0, 1, 2], (x) =>
          hand.spawn(Rock, Position.of({ x, y: 0, z: 0 }))
        );
        yield* app.frame();
        const attribute = meshOf(renderer.scene, "th/Rocks").instanceMatrix;
        expect(attribute.updateRanges).toEqual([{ start: 0, count: 48 }]);
        const sent = attribute.version;
        expect(sent).toBeGreaterThan(0);
        // The renderer empties the list once it has sent it.
        attribute.clearUpdateRanges();
        yield* hand.despawn(rocks[0]!);
        yield* app.frame();
        expect(attribute.updateRanges).toEqual([{ start: 0, count: 32 }]);
        expect(attribute.version).toBe(sent + 1);
        // A renderer that sent nothing in between is not told twice.
        yield* app.frame();
        expect(attribute.updateRanges).toEqual([{ start: 0, count: 32 }]);
        // Nothing to draw: nothing to send.
        yield* hand.despawn(rocks[1]!);
        yield* hand.despawn(rocks[2]!);
        attribute.clearUpdateRanges();
        const before = attribute.version;
        yield* app.frame();
        expect(meshOf(renderer.scene, "th/Rocks").count).toBe(0);
        expect(attribute.updateRanges).toEqual([]);
        expect(attribute.version).toBe(before);
      })
  );

  // Where the last tick left them, and between their last two places.
  it.effect.each([
    [false, false],
    [true, false],
    [true, true],
  ] as const)(
    "draws ten thousand moving objects without one allocation per object per frame (smooth: %s, each of a colour of its own: %s)",
    ([smooth, colored]) =>
      Effect.gen(function* () {
        const Moving = Query.all(Position, Velocity).pipe(
          Query.writes(Position)
        );
        const MovingFlat = Query.all(Transform2d.Position, Velocity).pipe(
          Query.writes(Transform2d.Position)
        );
        const Move = System.tick("th/Move", function* () {
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
        // Half of them in three dimensions, and half in the plane: a kind of
        // each transform.
        const crowd = <const O extends Three.KindOptions["of"]>(
          name: string,
          of: O,
          transform: Three.TransformOf<O>
        ) =>
          Three.instances(name, {
            of,
            transform,
            geometry,
            material,
            capacity: 8192,
            smooth,
            ...(colored ? { color: Color.Rgb } : {}),
          });
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(
            App.define({
              plugins: [Three.plugin, Hand],
              systems: [
                Move,
                crowd("th/Crowd", Rock, Transform3d),
                crowd("th/FlatCrowd", FlatRock, Transform2d),
              ],
            })
          ),
          renderer
        );
        const random = makeRandom(5);
        const count = 10_000;
        const rocks: Entity[] = [];
        const flatRocks: Entity[] = [];
        for (let i = 0; i < count; i++) {
          // Of every kind: an eighth each only placed, sized, turned, and
          // both, in three dimensions and in two.
          const flat = i % 8 >= 4;
          const parts = [
            flat ? FlatRock : Rock,
            flat
              ? Transform2d.Position.of({ x: random.next(), y: random.next() })
              : Position.of({
                  x: random.next(),
                  y: random.next(),
                  z: random.next(),
                }),
            Velocity.of({
              x: random.next(),
              y: random.next(),
              z: random.next(),
            }),
          ] as ComponentInput[];
          if (colored) {
            parts.push(
              Color.Rgb.of({
                r: random.next(),
                g: random.next(),
                b: random.next(),
                space: Color.Srgb,
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
          (flat ? flatRocks : rocks).push(yield* hand.spawn(...parts));
        }
        const step = Effect.fnUntraced(function* () {
          yield* app.tick(1 / 60);
          yield* app.frame(0.5);
        });
        const startedAt = [
          world.get(rocks[0]!, Position)!.x,
          world.get(flatRocks[0]!, Transform2d.Position)!.x,
        ];
        // Until the loops are compiled, and whatever is made once is made.
        for (let i = 0; i < 200; i++) {
          yield* step();
        }
        const meshes = ["th/Crowd", "th/FlatCrowd"].map((name) =>
          meshOf(renderer.scene, name)
        );
        const attributes = meshes.map((mesh) => mesh.instanceMatrix);
        const buffers = attributes.map((attribute) => attribute.array);
        const ranges = attributes.map((attribute) => attribute.updateRanges[0]);
        // How much the heap grew over one tick and one frame, many times: the
        // middle one, since now and then the collector runs in between.
        const grown: number[] = [];
        for (let i = 0; i < 101; i++) {
          const before = process.memoryUsage().heapUsed;
          yield* step();
          grown.push(process.memoryUsage().heapUsed - before);
        }
        const typical = grown.toSorted((a, b) => a - b)[50]!;
        // The smallest thing that can be allocated, a number, is 12 bytes or
        // more. One of those per object would be 120,000 bytes a frame.
        expect(typical).toBeLessThan(count * 4);
        // And what each draws into is what it drew into: the same buffer, the
        // same attribute, the same range.
        for (const [k, mesh] of meshes.entries()) {
          expect(mesh.instanceMatrix).toBe(attributes[k]);
          expect(mesh.instanceMatrix.array).toBe(buffers[k]);
          expect(mesh.instanceMatrix.updateRanges[0]).toBe(ranges[k]);
        }
        // They did move, and they were drawn where they are.
        expect(renderer.frames).toBe(301);
        expect(renderer.counts).toEqual([count / 2, count / 2]);
        // All the way to the tick they are at, which is where both draw them.
        yield* app.frame(1);
        expect(world.get(rocks[0]!, Position)!.x).toBeGreaterThan(
          startedAt[0]! + 0.01
        );
        expect(
          world.get(flatRocks[0]!, Transform2d.Position)!.x
        ).toBeGreaterThan(startedAt[1]! + 0.01);
        expectDrawn(meshes[0]!, world, rocks, Transform3d);
        expectDrawn(meshes[1]!, world, flatRocks, Transform2d);
      })
  );

  it.effect(
    "takes its mesh out of the scene and disposes of it, with its geometry and material, when the app's scope closes",
    () =>
      Effect.gen(function* () {
        const renderer = makeRenderer();
        const { app, close, hand } = yield* start(
          App.make(App.define({ plugins: [Look] })),
          renderer
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 0, z: 0 }));
        yield* app.frame();
        const mesh = meshOf(renderer.scene, "th/Rocks");
        const disposed: string[] = [];
        mesh.addEventListener("dispose", () => disposed.push("mesh"));
        geometry.addEventListener("dispose", () => disposed.push("geometry"));
        material.addEventListener("dispose", () => disposed.push("material"));
        yield* close;
        expect(disposed).toEqual(["mesh", "geometry", "material"]);
        expect(mesh.parent).toBeNull();
        expect(renderer.scene?.children).toEqual([]);
      })
  );
});

describe("a flat game's Transform2d", () => {
  const Flat = Transform2d;
  const at = (x: number, y: number) => Flat.Position.of({ x, y });

  it.effect(
    "is drawn by a kind of Three.instances that names it in the plane of x and y, turned about the axis that comes out of it",
    () =>
      Effect.gen(function* () {
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(App.define({ plugins: [FlatLook] })),
          renderer
        );
        const rocks = [
          yield* hand.spawn(FlatRock, at(3, 4)),
          yield* hand.spawn(FlatRock, at(-1, 2), Flat.Scale.of({ x: 2, y: 5 })),
          yield* hand.spawn(
            FlatRock,
            at(6, -7),
            Flat.Rotation.of({ angle: Math.PI / 2 })
          ),
          yield* hand.spawn(
            FlatRock,
            at(0.5, 9),
            Flat.Rotation.of({ angle: 0.7 }),
            Flat.Scale.of({ x: 3, y: 0.5 })
          ),
        ];
        // Not rocks, and one that is nowhere.
        yield* hand.spawn(FlatShip, at(8, 8));
        yield* hand.spawn(FlatShip, at(8, 8), Flat.Rotation, Flat.Scale);
        yield* hand.remove(
          yield* hand.spawn(FlatRock, Flat.Rotation.of({ angle: 1 })),
          Flat.Position
        );
        yield* app.frame();
        const mesh = meshOf(renderer.scene, "th/FlatRocks");
        expectDrawn(mesh, world, rocks, Transform2d);
        // By hand, so that the test does not only agree with Three.js. Only
        // somewhere; sized; and a quarter turn, which takes x to y.
        expect(drawn(mesh)).toContain("1 0 0 0 0 1 0 0 0 0 1 0 3 4 0 1");
        expect(drawn(mesh)).toContain("2 0 0 0 0 5 0 0 0 0 1 0 -1 2 0 1");
        const quarter = byPlace(rowsOf(mesh)).find((row) => row[12] === 6)!;
        expect(quarter[0]).toBeCloseTo(0, 6);
        expect(quarter[1]).toBeCloseTo(1, 6);
        expect(quarter[4]).toBeCloseTo(-1, 6);
        expect(quarter[5]).toBeCloseTo(0, 6);
        expect(quarter.slice(8)).toEqual([0, 0, 1, 0, 6, -7, 0, 1]);
      })
  );

  it.effect(
    "is all that a kind of it reads of an entity with both positions, and none of what a kind of Transform3d reads",
    () =>
      Effect.gen(function* () {
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(
            App.define({
              plugins: [Three.plugin, Hand],
              systems: [Rocks, FlatRocks],
            })
          ),
          renderer
        );
        // Both positions, and a turn and a size of each module.
        const both = yield* hand.spawn(
          Rock,
          FlatRock,
          Position.of({ x: 1, y: 2, z: 3 }),
          Rotation.of(Transform3d.axisAngle(1, 0, 0, Math.PI / 2)),
          Scale.of({ x: 4, y: 4, z: 4 }),
          at(10, 20),
          Flat.Rotation.of({ angle: Math.PI / 2 }),
          Flat.Scale.of({ x: 2, y: 3 })
        );
        const solid = yield* hand.spawn(
          Rock,
          Position.of({ x: 5, y: 6, z: 7 })
        );
        const flat = yield* hand.spawn(FlatRock, at(30, 40));
        yield* app.frame();
        const rocks = meshOf(renderer.scene, "th/Rocks");
        const flatRocks = meshOf(renderer.scene, "th/FlatRocks");
        expectDrawn(rocks, world, [both, solid], Transform3d);
        expectDrawn(flatRocks, world, [both, flat], Transform2d);
        // By hand, so that the test does not only agree with Three.js: in the
        // plane, a quarter turn about the axis out of it, at its flat size, and
        // nothing of its place, turn or size in three dimensions.
        const inPlane = byPlace(rowsOf(flatRocks))[0]!;
        const wanted = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1];
        for (let k = 0; k < 16; k++) {
          expect(inPlane[k], `element ${k}`).toBeCloseTo(wanted[k]!, 6);
        }
        // A change to either is drawn by its own kind and by no other.
        yield* hand.set(both, Flat.Position, { x: 11 });
        yield* hand.set(both, Position, { z: 9 });
        yield* app.frame();
        expect(byPlace(rowsOf(flatRocks))[0]!.slice(12)).toEqual([
          11, 20, 0, 1,
        ]);
        expect(byPlace(rowsOf(rocks))[0]!.slice(12)).toEqual([1, 2, 9, 1]);
      })
  );

  it.effect(
    "is drawn by a kind of its own beside a kind of Transform3d, each from its own, whatever an entity has of the other",
    () =>
      Effect.gen(function* () {
        const random = makeRandom(404);
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(
            App.define({
              plugins: [Three.plugin, Hand],
              systems: [Rocks, FlatRocks],
            })
          ),
          renderer
        );
        const alive: Entity[] = [];
        const place = () =>
          at(random.next() * 100 - 50, random.next() * 100 - 50);
        const turn = () => Flat.Rotation.of({ angle: random.next() * 7 - 3.5 });
        const size = () =>
          Flat.Scale.of({ x: 0.5 + random.next(), y: 0.5 + random.next() });
        for (let frame = 0; frame < 100; frame++) {
          for (let step = 0; step < 12; step++) {
            const roll = random.int(10);
            const one = alive[random.int(alive.length)];
            if (roll < 3 || one === undefined) {
              const parts: ComponentInput[] = [];
              // Most are flat; some are in three dimensions; a few are both.
              const kind = random.int(6);
              if (kind !== 0) {
                parts.push(FlatRock, place());
              }
              if (kind === 0 || kind === 1) {
                parts.push(
                  Rock,
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
              if (random.next() < 0.2) {
                parts.push(Scale.of({ x: 2, y: 3, z: 4 }));
              }
              alive.push(yield* hand.spawn(...parts));
            } else if (roll === 3) {
              yield* hand.despawn(one);
              alive.splice(alive.indexOf(one), 1);
            } else if (roll === 4) {
              yield* hand.add(one, turn());
            } else if (roll === 5) {
              yield* hand.remove(one, Flat.Rotation);
            } else if (roll === 6) {
              yield* hand.add(one, size());
            } else if (roll === 7) {
              yield* hand.remove(one, Flat.Scale);
            } else if (roll === 8 && world.has(one, Flat.Position)) {
              yield* hand.add(one, place());
            } else if (world.has(one, Flat.Position)) {
              // Lifted out of the plane, or put back in it.
              if (world.has(one, Position)) {
                yield* hand.remove(one, Position);
              } else {
                yield* hand.add(
                  one,
                  Position.of({ x: frame, y: step, z: -frame })
                );
                yield* hand.add(one, Rock);
              }
            }
          }
          yield* app.frame();
          expectDrawn(
            meshOf(renderer.scene, "th/Rocks"),
            world,
            alive.filter(
              (one) => world.has(one, Rock) && world.has(one, Position)
            ),
            Transform3d
          );
          expectDrawn(
            meshOf(renderer.scene, "th/FlatRocks"),
            world,
            alive.filter(
              (one) => world.has(one, FlatRock) && world.has(one, Flat.Position)
            ),
            Transform2d
          );
        }
        // All of it was drawn from along the way.
        const has = (...parts: Parameters<typeof world.has>[1][]) =>
          alive.some((one) => parts.every((part) => world.has(one, part)));
        expect(has(FlatRock, Flat.Position, Flat.Rotation, Flat.Scale)).toBe(
          true
        );
        expect(has(FlatRock, Flat.Position, Rock, Position)).toBe(true);
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
      })
  );

  it.effect(
    "is drawn only for the entities that have every component it was given and none of those it was told to leave out",
    () =>
      Effect.gen(function* () {
        const Heavies = Three.instances("th/FlatHeavies", {
          of: [FlatRock, Heavy],
          transform: Transform2d,
          without: [Hidden],
          geometry,
          material,
        });
        const renderer = makeRenderer();
        const { app, hand, world } = yield* start(
          App.make(
            App.define({ plugins: [Three.plugin, Hand], systems: [Heavies] })
          ),
          renderer
        );
        const turn = Flat.Rotation.of({ angle: 1 });
        const size = Flat.Scale.of({ x: 2, y: 3 });
        // One of each kind of table, shown and hidden.
        const shown = [
          yield* hand.spawn(FlatRock, Heavy, at(1, 0)),
          yield* hand.spawn(FlatRock, Heavy, at(2, 0), size),
          yield* hand.spawn(FlatRock, Heavy, at(3, 0), turn),
          yield* hand.spawn(FlatRock, Heavy, at(4, 0), turn, size),
        ];
        const hidden = [
          yield* hand.spawn(FlatRock, Heavy, Hidden, at(5, 0)),
          yield* hand.spawn(FlatRock, Heavy, Hidden, at(6, 0), size),
          yield* hand.spawn(FlatRock, Heavy, Hidden, at(7, 0), turn),
          yield* hand.spawn(FlatRock, Heavy, Hidden, at(8, 0), turn, size),
        ];
        for (const only of [FlatRock, Heavy]) {
          yield* hand.spawn(only, at(9, 0));
          yield* hand.spawn(only, at(9, 0), size);
          yield* hand.spawn(only, at(9, 0), turn);
          yield* hand.spawn(only, at(9, 0), turn, size);
        }
        yield* app.frame();
        const mesh = meshOf(renderer.scene, "th/FlatHeavies");
        expectDrawn(mesh, world, shown, Transform2d);
        for (const one of hidden) {
          yield* hand.remove(one, Hidden);
        }
        for (const one of shown) {
          yield* hand.add(one, Hidden);
        }
        yield* app.frame();
        expectDrawn(mesh, world, hidden, Transform2d);
      })
  );

  it.effect(
    "places an object of Three.objects in the plane, and leaves the rest of it as it was made",
    () =>
      Effect.gen(function* () {
        const made: { readonly object: Object3D; readonly entity: Entity }[] =
          [];
        const freed: Entity[] = [];
        const Cards = Three.objects("th/Cards", {
          of: FlatShip,
          transform: Transform2d,
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
        const { app, hand } = yield* start(
          App.make(
            App.define({ plugins: [Three.plugin, Hand], systems: [Cards] })
          ),
          renderer
        );
        const objectOf = (entity: Entity): Object3D =>
          made.findLast((one) => one.entity === entity)!.object;
        const plain = yield* hand.spawn(FlatShip, at(1, 2));
        const whole = yield* hand.spawn(
          FlatShip,
          at(-3, -4),
          Flat.Rotation.of({ angle: 0.5 }),
          Flat.Scale.of({ x: 2, y: 3 })
        );
        // Turned and sized, and nowhere; and hidden.
        yield* hand.remove(
          yield* hand.spawn(FlatShip, Flat.Rotation, Flat.Scale),
          Flat.Position
        );
        yield* hand.spawn(
          FlatShip,
          Hidden,
          at(9, 9),
          Flat.Rotation,
          Flat.Scale
        );
        yield* app.frame();
        expect(
          made
            .map((one) => one.entity)
            .toSorted((a, b) => entityIndex(a) - entityIndex(b))
        ).toEqual([plain, whole]);
        expect(objectOf(plain).position.toArray()).toEqual([1, 2, 5]);
        expect(objectOf(plain).rotation.z).toBe(0);
        expect(objectOf(plain).scale.toArray()).toEqual([1, 1, 4]);
        expect(objectOf(whole).position.toArray()).toEqual([-3, -4, 5]);
        expect(objectOf(whole).rotation.x).toBe(0.25);
        expect(objectOf(whole).rotation.z).toBe(0.5);
        expect(objectOf(whole).scale.toArray()).toEqual([2, 3, 4]);
        // It follows its entity, and is not made again.
        yield* hand.set(whole, Flat.Position, { x: 10, y: 20 });
        yield* hand.set(whole, Flat.Rotation, { angle: 1.5 });
        yield* hand.set(whole, Flat.Scale, { x: 5, y: 6 });
        yield* app.frame();
        expect(made.length).toBe(2);
        expect(objectOf(whole).position.toArray()).toEqual([10, 20, 5]);
        expect(objectOf(whole).rotation.z).toBe(1.5);
        expect(objectOf(whole).scale.toArray()).toEqual([5, 6, 4]);
        // One that is no longer turned, or sized, is as one that never was:
        // in the plane only, the rest as it was made.
        yield* hand.remove(whole, Flat.Rotation);
        yield* app.frame();
        expect(objectOf(whole).rotation.z).toBe(0);
        expect(objectOf(whole).rotation.x).toBe(0.25);
        expect(objectOf(whole).scale.toArray()).toEqual([5, 6, 4]);
        yield* hand.remove(whole, Flat.Scale);
        yield* app.frame();
        expect(objectOf(whole).scale.toArray()).toEqual([1, 1, 4]);
        // What the game then sets is left alone.
        objectOf(whole).rotation.z = 2;
        objectOf(whole).scale.x = 7;
        yield* app.frame();
        expect(objectOf(whole).rotation.z).toBe(2);
        expect(objectOf(whole).scale.x).toBe(7);
        // Given a place in three dimensions as well, it stays where its flat
        // one puts it: its kind reads nothing of Transform3d.
        yield* hand.add(plain, Position.of({ x: 7, y: 8, z: 9 }));
        yield* hand.add(plain, Rotation.of(Transform3d.axisAngle(1, 0, 0, 1)));
        yield* hand.add(plain, Scale.of({ x: 6, y: 6, z: 6 }));
        yield* app.frame();
        expect(objectOf(plain).position.toArray()).toEqual([1, 2, 5]);
        expect(objectOf(plain).rotation.toArray()).toEqual([0.25, 0, 0, "XYZ"]);
        expect(objectOf(plain).scale.toArray()).toEqual([1, 1, 4]);
        expect(made.length).toBe(2);
        // And it goes with its entity like any other.
        yield* hand.despawn(plain);
        yield* hand.add(whole, Hidden);
        yield* app.frame();
        expect(
          freed.toSorted((a, b) => entityIndex(a) - entityIndex(b))
        ).toEqual(
          [plain, whole].toSorted((a, b) => entityIndex(a) - entityIndex(b))
        );
        expect(renderer.scene?.children).toEqual([]);
      })
  );

  it.effect(
    "keeps what it knows of its objects when a frame brings so many more that its room has to grow",
    () =>
      Effect.gen(function* () {
        const made = new Map<Entity, Object3D>();
        const Cards = Three.objects("th/ManyCards", {
          of: FlatShip,
          transform: Transform2d,
          make: (entity) => {
            const object = new Group();
            object.rotation.x = 0.25;
            made.set(entity, object);
            return object;
          },
        });
        const { app, hand } = yield* start(
          App.make(
            App.define({ plugins: [Three.plugin, Hand], systems: [Cards] })
          ),
          makeRenderer()
        );
        const first = yield* hand.spawn(
          FlatShip,
          at(1, 1),
          Flat.Rotation.of({ angle: 2 })
        );
        yield* app.frame();
        expect(made.get(first)!.rotation.z).toBe(2);
        // In one frame: the first is no longer turned, and a crowd arrives
        // after it, more than there was room for.
        yield* hand.remove(first, Flat.Rotation);
        for (let i = 0; i < 200; i++) {
          yield* hand.spawn(FlatShip, at(i, 2));
        }
        yield* app.frame();
        expect(made.size).toBe(201);
        // Its turn in the plane is gone, and the turn it was made with is not.
        expect(made.get(first)!.rotation.z).toBe(0);
        expect(made.get(first)!.rotation.x).toBe(0.25);
      })
  );

  it.effect(
    "is listed by Three.plugin, so that a flat game that is drawn saves and loads",
    () =>
      Effect.gen(function* () {
        const Flatland = Plugin.make("th/Flatland", {
          plugins: [Three.plugin, Hand],
          systems: [FlatRocks],
        });
        const first = yield* start(
          App.make(App.define({ plugins: [Flatland] })),
          makeRenderer()
        );
        const rock = yield* first.hand.spawn(
          FlatRock,
          at(4, 5),
          Flat.Rotation.of({ angle: 1 }),
          Flat.Scale.of({ x: 2, y: 2 })
        );
        const save = yield* Effect.exit(first.app.save());
        if (Exit.isFailure(save)) {
          throw new Error("The game could not be saved");
        }
        const renderer = makeRenderer();
        const { app, world } = yield* start(
          App.make(App.define({ plugins: [Flatland] }), { save: save.value }),
          renderer
        );
        expect(world.hash()).toBe(first.world.hash());
        yield* app.frame();
        expectDrawn(
          meshOf(renderer.scene, "th/FlatRocks"),
          world,
          [rock],
          Transform2d
        );
      })
  );
});

describe("an entity drawn between two ticks", () => {
  const Flat = Transform2d;
  /** Moves every rock ten along x a tick, and every flat one too. */
  const Slide = System.tick("th/Slide", function* () {
    (yield* Query.all(Position).pipe(Query.writes(Position))).each(
      (position) => {
        position.x += 10;
      }
    );
    (yield* Query.all(Flat.Position).pipe(Query.writes(Flat.Position))).each(
      (position) => {
        position.x += 10;
      }
    );
  });
  const smoothed = <const O extends Three.KindOptions["of"]>(
    name: string,
    of: O,
    transform: Three.TransformOf<O>
  ) =>
    Three.instances(name, {
      of,
      transform,
      without: [Hidden],
      geometry,
      material,
      smooth: true,
    });
  const Smoothed = smoothed("th/Smoothed", Rock, Transform3d);
  /** A flat game's rocks, drawn so. */
  const SmoothedFlat = smoothed("th/SmoothedFlat", FlatRock, Transform2d);
  const plugins = [Three.plugin, Hand] as const;
  /** A game whose rocks slide, and the systems that draw them. */
  const play = Effect.fnUntraced(function* (
    game: App.Game<
      readonly System.System<never, BuiltIn | Three.Scene>[],
      readonly [],
      typeof plugins
    >
  ) {
    const renderer = makeRenderer();
    const { app, hand, world } = yield* start(App.make(game), renderer);
    return {
      app,
      hand,
      world,
      renderer,
      mesh: () => meshOf(renderer.scene, "th/Smoothed"),
      flatMesh: () => meshOf(renderer.scene, "th/SmoothedFlat"),
    };
  });
  /** The sixteen numbers of the instance that is at this height: no two of a test share one. */
  const rowAt = (mesh: InstancedMesh, y: number): number[] => {
    for (let i = 0; i < mesh.count; i++) {
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

  it.effect(
    "is where it is the first frame it is seen, and from then on between where it was a tick ago and where it is",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed] })
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        // Never drawn before: there is nowhere to come from, whatever the frame.
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(0);
        yield* app.tick(1);
        // Just after the tick it is still where it was, and then on its way.
        yield* app.frame(0);
        expect(xAt(mesh(), 1)).toBe(0);
        yield* app.frame(0.25);
        expect(xAt(mesh(), 1)).toBe(2.5);
        yield* app.frame(0.75);
        expect(xAt(mesh(), 1)).toBe(7.5);
        // A tick later the place it has come to is the one it comes from.
        yield* app.tick(1);
        yield* app.frame(0);
        expect(xAt(mesh(), 1)).toBe(10);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(15);
        // No further than where it is, and no further back than where it was.
        yield* app.frame(1);
        expect(xAt(mesh(), 1)).toBe(20);
        yield* app.frame(3);
        expect(xAt(mesh(), 1)).toBe(20);
        yield* app.frame(-2);
        expect(xAt(mesh(), 1)).toBe(10);
      })
  );

  it.effect(
    "is where the last tick left it in a frame run by hand without an alpha",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed] })
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        yield* app.frame();
        yield* app.tick(1);
        yield* app.frame();
        expect(xAt(mesh(), 1)).toBe(10);
        yield* app.tick(1);
        yield* app.frame();
        expect(xAt(mesh(), 1)).toBe(20);
      })
  );

  it.effect(
    "is drawn between its last two places when its id is past what 32 bits hold",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed] })
        );
        // A slot given out 1,100 times: the next entity in it has such an id.
        for (let n = 0; n < 1100; n++) {
          yield* hand.despawn(yield* hand.spawn(Rock));
        }
        const rock = yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        expect(rock).toBeGreaterThan(2 ** 32);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(0);
        yield* app.tick(1);
        // It is known for the entity it was a frame ago, and is on its way.
        yield* app.frame(0.25);
        expect(xAt(mesh(), 1)).toBe(2.5);
        yield* app.frame(0.75);
        expect(xAt(mesh(), 1)).toBe(7.5);
      })
  );

  it.effect(
    "comes from where it was last drawn when several ticks ran since, and stays between the two when none did",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed] })
        );
        const rock = yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        yield* app.frame();
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(5);
        // Three ticks and then a frame: from 10, where it was, to 40.
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(25);
        // Frames with no tick between them: the same two places.
        yield* app.frame(0.1);
        expect(xAt(mesh(), 1)).toBe(13);
        yield* app.frame(0.9);
        expect(xAt(mesh(), 1)).toBe(37);
        // Moved with no tick, by an action: it goes there from
        // where it was coming from.
        yield* hand.set(rock, Position, { x: 110 });
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(60);
      })
  );

  it.effect(
    "draws an entity it has not been drawing where it is: a new one, one in a slot that was another's, one that was hidden",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed] })
        );
        const old = yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        const hidden = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 2, z: 0 })
        );
        yield* app.frame();
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(5);
        // Gone, and its slot taken by another, far away: not drawn on the way
        // from where the old one was.
        yield* hand.despawn(old);
        const fresh = yield* hand.spawn(
          Rock,
          Position.of({ x: 500, y: 3, z: 0 })
        );
        expect(entityIndex(fresh)).toBe(entityIndex(old));
        yield* hand.add(hidden, Hidden);
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(mesh().count).toBe(1);
        expect(xAt(mesh(), 3)).toBe(510);
        // From its second frame on it is on its way like any other.
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 3)).toBe(515);
        // Shown again after frames in which it was not drawn: where it is.
        yield* hand.remove(hidden, Hidden);
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 2)).toBe(40);
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 2)).toBe(45);
      })
  );

  it.effect("starts over when its system did not run for a frame", () =>
    Effect.gen(function* () {
      const Phase = { on: true };
      const Gated = Smoothed.pipe(System.runIf(Effect.sync(() => Phase.on)));
      const { app, hand, mesh } = yield* play(
        App.define({ plugins, systems: [Slide, Gated] })
      );
      yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
      yield* app.frame();
      yield* app.tick(1);
      yield* app.frame(0.5);
      expect(xAt(mesh(), 1)).toBe(5);
      Phase.on = false;
      yield* app.tick(1);
      yield* app.frame(0.5);
      Phase.on = true;
      yield* app.tick(1);
      yield* app.frame(0.5);
      // Not from 10, where it was last drawn from, two frames ago.
      expect(xAt(mesh(), 1)).toBe(30);
    })
  );

  it.effect(
    "is drawn where it is when it went further in a tick than it was told an entity can",
    () =>
      Effect.gen(function* () {
        const wrapping = <const O extends Three.KindOptions["of"]>(
          name: string,
          of: O,
          transform: Three.TransformOf<O>
        ) =>
          Three.instances(name, {
            of,
            transform,
            geometry,
            material,
            smooth: true,
            snap: 50,
          });
        const { app, flatMesh, hand, mesh } = yield* play(
          App.define({
            plugins,
            systems: [
              Slide,
              wrapping("th/Smoothed", Rock, Transform3d),
              wrapping("th/SmoothedFlat", FlatRock, Transform2d),
            ],
          })
        );
        const rock = yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        const card = yield* hand.spawn(
          FlatRock,
          Flat.Position.of({ x: 0, y: 2 })
        );
        yield* app.frame();
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(5);
        expect(xAt(flatMesh(), 2)).toBe(5);
        // Off one edge and in at the other: not drawn crossing the screen.
        yield* hand.set(rock, Position, { x: -400 });
        yield* hand.set(card, Flat.Position, { x: 300 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(-390);
        expect(xAt(flatMesh(), 2)).toBe(310);
        // And on its way again from there.
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(-385);
        expect(xAt(flatMesh(), 2)).toBe(315);
        // Wherever it went: up and away as well as along.
        yield* hand.set(rock, Position, { x: -380, y: 91, z: 60 });
        yield* hand.set(card, Flat.Position, { x: 320, y: 92 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(rowAt(mesh(), 91).slice(12, 15)).toEqual([-370, 91, 60]);
        expect(rowAt(flatMesh(), 92).slice(12, 15)).toEqual([330, 92, 0]);
        yield* hand.set(rock, Position, { y: 1, z: 0 });
        yield* app.tick(1);
        yield* app.frame(1);
        // Exactly as far as it may go is not too far.
        // (It is at -360 now, and goes ten more with the tick.)
        yield* hand.set(rock, Position, { x: -320 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(-335);
        // And a hair further is.
        yield* hand.set(rock, Position, { x: -269.5 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(xAt(mesh(), 1)).toBe(-259.5);
      })
  );

  it.effect(
    "draws an entity in a slot that was another's turned and sized as it is, not on the way from the other's",
    () =>
      Effect.gen(function* () {
        const { app, flatMesh, hand, mesh, world } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed, SmoothedFlat] })
        );
        const olds = [
          yield* hand.spawn(
            Rock,
            Position.of({ x: 0, y: 1, z: 0 }),
            Rotation.of(Transform3d.axisAngle(0, 0, 1, 0.2)),
            Scale.of({ x: 1, y: 1, z: 1 })
          ),
          yield* hand.spawn(
            FlatRock,
            Flat.Position.of({ x: 0, y: 2 }),
            Flat.Rotation.of({ angle: 0.2 }),
            Flat.Scale.of({ x: 1, y: 1 })
          ),
        ];
        yield* app.frame();
        yield* app.tick(1);
        yield* app.frame(0.5);
        // Both gone, and their slots taken at once, the second's first.
        yield* hand.despawn(olds[0]!);
        yield* hand.despawn(olds[1]!);
        const flat = yield* hand.spawn(
          FlatRock,
          Flat.Position.of({ x: 100, y: 4 }),
          Flat.Rotation.of({ angle: 2.5 }),
          Flat.Scale.of({ x: 6, y: 7 })
        );
        const solid = yield* hand.spawn(
          Rock,
          Position.of({ x: 100, y: 3, z: 0 }),
          Rotation.of(Transform3d.axisAngle(0, 0, 1, 2.5)),
          Scale.of({ x: 6, y: 7, z: 8 })
        );
        expect(
          [entityIndex(flat), entityIndex(solid)].toSorted((a, b) => a - b)
        ).toEqual(
          olds.map((one) => entityIndex(one)).toSorted((a, b) => a - b)
        );
        yield* app.tick(1);
        yield* app.frame(0.5);
        expectDrawn(mesh(), world, [solid], Transform3d);
        expectDrawn(flatMesh(), world, [flat], Transform2d);
      })
  );

  it.effect(
    "turns by the shorter way and grows evenly, in three dimensions",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed] })
        );
        // About an axis that leans, so that every number of the turn changes.
        const quarter = Transform3d.axisAngle(0.6, 0, 0.8, Math.PI / 2);
        const rock = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          Rotation.of({ x: 0, y: 0, z: 0, w: 1 }),
          Scale.of({ x: 1, y: 1, z: 1 })
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 2, z: 0 }), Rotation);
        yield* app.frame();
        yield* hand.set(rock, Rotation, quarter);
        yield* hand.set(rock, Scale, { x: 3, y: 5, z: 7 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        // Half of a quarter turn, at twice, three and four times the size.
        const eighth = new Matrix4().compose(
          new Vector3(5, 1, 0),
          new Quaternion().setFromAxisAngle(
            new Vector3(0.6, 0, 0.8),
            Math.PI / 4
          ),
          new Vector3(2, 3, 4)
        ).elements;
        // And again in a frame with no tick before it: the same two turns.
        for (let frame = 0; frame < 2; frame++) {
          const drawnRow = rowAt(mesh(), 1);
          for (let k = 0; k < 16; k++) {
            expect(drawnRow[k], `element ${k}`).toBeCloseTo(eighth[k]!, 5);
          }
          yield* app.frame(0.5);
        }
        // One that is not turned at all stays so.
        expect(rowAt(mesh(), 2).slice(0, 11)).toEqual([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]);
        // The opposite quaternion is the same turn: it does not swing round
        // to get there.
        yield* app.frame(1);
        const there = rowAt(mesh(), 1);
        yield* hand.set(rock, Rotation, {
          x: -quarter.x,
          y: -quarter.y,
          z: -quarter.z,
          w: -quarter.w,
        });
        yield* hand.set(rock, Scale, { x: 3, y: 5, z: 7 });
        yield* app.tick(1);
        for (const alpha of [0, 0.3, 0.5, 0.9, 1]) {
          yield* app.frame(alpha);
          const now = rowAt(mesh(), 1);
          for (let k = 0; k < 11; k++) {
            expect(now[k], `alpha ${alpha}, element ${k}`).toBeCloseTo(
              there[k]!,
              5
            );
          }
        }
      })
  );

  it.effect(
    "turns by the shorter way round and grows evenly, in the plane",
    () =>
      Effect.gen(function* () {
        const {
          app,
          flatMesh: mesh,
          hand,
        } = yield* play(
          App.define({ plugins, systems: [Slide, SmoothedFlat] })
        );
        const card = yield* hand.spawn(
          FlatRock,
          Flat.Position.of({ x: 0, y: 1 }),
          Flat.Rotation.of({ angle: 0.2 }),
          Flat.Scale.of({ x: 1, y: 1 })
        );
        yield* app.frame();
        yield* hand.set(card, Flat.Rotation, { angle: 1 });
        yield* hand.set(card, Flat.Scale, { x: 3, y: 5 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        const half = new Matrix4().compose(
          new Vector3(5, 1, 0),
          new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.6),
          new Vector3(2, 3, 1)
        ).elements;
        for (let frame = 0; frame < 2; frame++) {
          const drawnRow = rowAt(mesh(), 1);
          for (let k = 0; k < 16; k++) {
            expect(drawnRow[k], `element ${k}`).toBeCloseTo(half[k]!, 5);
          }
          yield* app.frame(0.5);
        }
        // From a little past nothing to a little short of a whole turn is a
        // little way back, through nothing, not nearly all the way round.
        yield* app.frame(1);
        yield* hand.set(card, Flat.Rotation, { angle: 0.25 });
        yield* app.tick(1);
        yield* app.frame(1);
        yield* hand.set(card, Flat.Rotation, { angle: Math.PI * 2 - 0.25 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        const through = rowAt(mesh(), 1);
        expect(through[0]! / 3).toBeCloseTo(1, 5);
        expect(through[1]! / 3).toBeCloseTo(0, 5);
        yield* app.frame(1);
        const end = rowAt(mesh(), 1);
        expect(end[0]! / 3).toBeCloseTo(Math.cos(0.25), 5);
        expect(end[1]! / 3).toBeCloseTo(-Math.sin(0.25), 5);
      })
  );

  it.effect(
    "agrees, over a long run of ticks and frames that do not line up, with a model of what was last drawn",
    () =>
      Effect.gen(function* () {
        const random = makeRandom(1612);
        const { app, flatMesh, hand, mesh, world } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed, SmoothedFlat] })
        );
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
        for (let frame = 1; frame <= 300; frame++) {
          const ticks = random.int(4);
          for (let i = 0; i < ticks; i++) {
            yield* app.tick(1);
          }
          for (let step = 0; step < 3; step++) {
            const roll = random.int(6);
            const one = alive[random.int(alive.length)];
            if (roll < 2 || one === undefined) {
              const y = ++heights;
              const flat = random.next() < 0.5;
              const x = random.int(1000);
              alive.push({
                entity: flat
                  ? yield* hand.spawn(FlatRock, Flat.Position.of({ x, y }))
                  : yield* hand.spawn(Rock, Position.of({ x, y, z: 0 })),
                y,
                flat,
              });
            } else if (roll === 2) {
              yield* hand.despawn(one.entity);
              alive.splice(alive.indexOf(one), 1);
            } else if (roll === 3) {
              // Hidden for a while, or shown again.
              if (world.has(one.entity, Hidden)) {
                yield* hand.remove(one.entity, Hidden);
              } else {
                yield* hand.add(one.entity, Hidden);
              }
            }
          }
          const alpha = random.next();
          yield* app.frame(alpha);
          const shown = alive.filter((one) => !world.has(one.entity, Hidden));
          expect(mesh().count).toBe(shown.filter((one) => !one.flat).length);
          expect(flatMesh().count).toBe(shown.filter((one) => one.flat).length);
          for (const one of shown) {
            const x = xOf(one);
            const last = model.get(one.entity);
            let from = x;
            if (last !== undefined && last.frame === frame - 1) {
              from = ticks > 0 ? last.to : last.from;
            }
            model.set(one.entity, { from, to: x, frame });
            expect(
              xAt(one.flat ? flatMesh() : mesh(), one.y),
              `frame ${frame}`
            ).toBeCloseTo(from + (x - from) * alpha, 2);
          }
        }
        // More of them than the room it started with, and of both kinds.
        expect(heights).toBeGreaterThan(150);
        expect(alive.some((one) => one.flat)).toBe(true);
        expect(alive.some((one) => !one.flat)).toBe(true);
      })
  );

  it.effect(
    "blends two rotations of any length into a turn, drawn neither skewed nor sized by them",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Smoothed] })
        );
        const quarter = Transform3d.axisAngle(0.6, 0, 0.8, Math.PI / 2);
        const rock = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          Rotation.of({ x: 0, y: 0, z: 0, w: 3 }),
          Scale.of({ x: 2, y: 3, z: 4 })
        );
        const bare = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 2, z: 0 }),
          Rotation.of({ x: 0, y: 0, z: 0, w: 0.2 })
        );
        yield* app.frame();
        yield* hand.set(rock, Rotation, stretched(quarter, 3));
        yield* hand.set(bare, Rotation, stretched(quarter, 0.2));
        yield* app.tick(1);
        yield* app.frame(0.5);
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
        for (let k = 0; k < 16; k++) {
          expect(rowAt(mesh(), 1)[k], `element ${k}`).toBeCloseTo(
            eighth[k]!,
            5
          );
          expect(rowAt(mesh(), 2)[k], `element ${k}`).toBeCloseTo(
            eighthBare[k]!,
            5
          );
        }
        // From one length to another, it is still a turn about that axis:
        // each column is as long as the entity is large along it.
        yield* hand.set(bare, Rotation, stretched(quarter, 5));
        yield* hand.set(bare, Rotation, { x: 0, y: 0, z: 0, w: 5 });
        yield* hand.set(rock, Rotation, { x: 0, y: 0, z: 0, w: 0.1 });
        yield* app.tick(1);
        yield* app.frame(0.25);
        for (const [y, sizes] of [
          [1, [2, 3, 4]],
          [2, [1, 1, 1]],
        ] as const) {
          const row = rowAt(mesh(), y);
          for (let column = 0; column < 3; column++) {
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
      })
  );

  it.effect("places an object of Three.objects the same way", () =>
    Effect.gen(function* () {
      const made = new Map<Entity, Object3D>();
      const ships = <const O extends Three.KindOptions["of"]>(
        name: string,
        of: O,
        transform: Three.TransformOf<O>
      ) =>
        Three.objects(name, {
          of,
          transform,
          make: (entity) => {
            const object = new Group();
            object.position.z = 9;
            made.set(entity, object);
            return object;
          },
          smooth: true,
          snap: 200,
        });
      const { app, hand } = yield* play(
        App.define({
          plugins,
          systems: [
            Slide,
            ships("th/SmoothShips", Ship, Transform3d),
            ships("th/SmoothCards", FlatShip, Transform2d),
          ],
        })
      );
      const ship = yield* hand.spawn(
        Ship,
        Position.of({ x: 0, y: 1, z: 2 }),
        Rotation.of({ x: 0, y: 0, z: 0, w: 1 }),
        Scale.of({ x: 1, y: 1, z: 1 })
      );
      const card = yield* hand.spawn(
        FlatShip,
        Flat.Position.of({ x: 0, y: 4 }),
        Flat.Rotation.of({ angle: 0.5 }),
        Flat.Scale.of({ x: 1, y: 1 })
      );
      yield* app.frame(0.5);
      expect(made.get(ship)!.position.toArray()).toEqual([0, 1, 2]);
      expect(made.get(card)!.position.toArray()).toEqual([0, 4, 9]);
      yield* hand.set(
        ship,
        Rotation,
        Transform3d.axisAngle(0, 0, 1, Math.PI / 2)
      );
      yield* hand.set(ship, Scale, { x: 3, y: 3, z: 3 });
      yield* hand.set(card, Flat.Rotation, { angle: 1.5 });
      yield* hand.set(card, Flat.Scale, { x: 5, y: 7 });
      yield* app.tick(1);
      yield* app.frame(0.5);
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
      yield* hand.set(ship, Position, { x: 1000 });
      yield* app.tick(1);
      yield* app.frame(0.5);
      expect(made.get(ship)!.position.x).toBe(1010);
      expect(made.size).toBe(2);
      // Between two rotations of any length an object is turned, and its
      // quaternion is of length 1, as Three.js needs it.
      const quarter = Transform3d.axisAngle(0, 0, 1, Math.PI / 2);
      yield* hand.set(ship, Rotation, { x: 0, y: 0, z: 0, w: 6 });
      yield* app.tick(1);
      yield* app.frame(1);
      yield* hand.set(ship, Rotation, stretched(quarter, 6));
      yield* app.tick(1);
      yield* app.frame(0.5);
      expect(made.get(ship)!.quaternion.x).toBeCloseTo(half.x, 6);
      expect(made.get(ship)!.quaternion.y).toBeCloseTo(half.y, 6);
      expect(made.get(ship)!.quaternion.z).toBeCloseTo(half.z, 6);
      expect(made.get(ship)!.quaternion.w).toBeCloseTo(half.w, 6);
    })
  );

  it.effect(
    "is drawn where it is once a game that ticks when it is needed has come to rest",
    () =>
      Effect.gen(function* () {
        // A piece that goes ten along x when it is told to, and not otherwise.
        const Go = Action.define("th/Go", Schema.Struct({}));
        const renderer = makeRenderer();
        const made = yield* start(
          App.make(
            App.define({
              plugins: [Three.plugin, Hand],
              systems: [Smoothed],
              handlers: [
                Action.handler(Go, function* () {
                  (yield* Query.all(Position).pipe(
                    Query.writes(Position)
                  )).each((position) => {
                    position.x += 10;
                  });
                }),
              ],
            })
          ),
          renderer
        );
        const { app, hand, mesh } = {
          app: made.app,
          hand: made.hand,
          mesh: () => meshOf(renderer.scene, "th/Smoothed"),
        };
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        const advance = Driver.fixedStep(app, { hz: 60, ticks: "whenNeeded" });
        for (let i = 0; i < 10; i++) {
          yield* advance(1 / 120);
        }
        // At rest, after the tick a new game runs.
        expect(app.time.tick).toBe(1);
        expect(xAt(mesh(), 1)).toBe(0);
        // Told to go: the tick runs in that frame, and it is on its way.
        yield* app.enqueue(Go, {});
        yield* advance(1 / 120);
        expect(app.time.tick).toBe(2);
        expect(xAt(mesh(), 1)).toBe(0);
        yield* advance(1 / 120);
        expect(xAt(mesh(), 1)).toBe(5);
        // The game comes to rest, and the piece is where the game has it: not
        // a tick behind, waiting for a tick that is not coming.
        for (let i = 0; i < 10; i++) {
          yield* advance(1 / 120);
        }
        expect(app.time.tick).toBe(3);
        expect(xAt(mesh(), 1)).toBe(10);
      })
  );

  it.effect(
    "is not done unless it is asked for: an entity is drawn where the last tick left it",
    () =>
      Effect.gen(function* () {
        const Plain = Three.instances("th/Smoothed", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
        });
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Slide, Plain] })
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        yield* app.frame();
        yield* app.tick(1);
        for (const alpha of [0, 0.5, 0.99]) {
          yield* app.frame(alpha);
          expect(xAt(mesh(), 1)).toBe(10);
        }
      })
  );

  it.effect(
    "keeps the place before to itself: a game drawn between its ticks is the same game",
    () =>
      Effect.gen(function* () {
        const Rules = Plugin.make("th/SlideRules", {
          plugins: [Hand],
          systems: [Slide],
        });
        const Ships = Three.objects("th/SmoothShips", {
          of: Ship,
          transform: Transform3d,
          make: () => new Object3D(),
          smooth: true,
        });
        const Drawn = Plugin.make("th/SmoothDrawn", {
          plugins: [Three.plugin, Rules],
          systems: [Smoothed, SmoothedFlat, Ships],
        });
        const drawnGame = yield* start(
          App.make(App.define({ plugins: [Drawn] }), {
            checkpointEvery: 1,
            verifyFrames: true,
          }),
          makeRenderer()
        );
        const bareApp = yield* App.make(App.define({ plugins: [Rules] }), {
          checkpointEvery: 1,
        });
        const bare = {
          app: bareApp,
          world: yield* bareApp.read(World),
          hand: handOf(bareApp),
        };
        for (const { hand } of [drawnGame, bare]) {
          yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }), Rotation);
          yield* hand.spawn(
            FlatRock,
            Flat.Position.of({ x: 0, y: 2 }),
            Flat.Rotation
          );
          yield* hand.spawn(Ship, Position.of({ x: 0, y: 3, z: 0 }), Scale);
        }
        for (let tick = 0; tick < 40; tick++) {
          yield* drawnGame.app.tick(1);
          yield* drawnGame.app.frame(0.2);
          yield* drawnGame.app.frame(0.7);
          yield* bare.app.tick(1);
          expect(drawnGame.world.hash()).toBe(bare.world.hash());
        }
        expect(drawnGame.app.actionLog).toEqual(bare.app.actionLog);
        const saves = [
          yield* Effect.exit(drawnGame.app.save()),
          yield* Effect.exit(bare.app.save()),
        ].map((save) => (Exit.isSuccess(save) ? save.value : undefined));
        expect(saves[0]).toBeDefined();
        expect(saves[0]).toEqual(saves[1]);
      })
  );
});

describe("a colour per instance", () => {
  const Flat = Transform2d;
  const painted = <const O extends Three.KindOptions["of"]>(
    name: string,
    of: O,
    transform: Three.TransformOf<O>
  ) =>
    Three.instances(name, {
      of,
      transform,
      without: [Hidden],
      geometry,
      material,
      // The renderer's own numbers, handed over as they are: what these
      // tests follow is which instance has which.
      color: Color.Rgb,
      capacity: 4,
    });
  const Painted = painted("th/Painted", Rock, Transform3d);
  /** The same of a flat game's rocks. */
  const PaintedFlat = painted("th/PaintedFlat", FlatRock, Transform2d);
  const plugins = [Three.plugin, Hand] as const;
  /** A game whose rocks are painted, and the systems that draw them. */
  const play = Effect.fnUntraced(function* (
    game: App.Game<
      readonly ReturnType<typeof Three.instances>[],
      readonly [],
      typeof plugins
    > = App.define({ plugins, systems: [Painted] })
  ) {
    const renderer = makeRenderer();
    const { app, close, hand, world } = yield* start(App.make(game), renderer);
    return {
      app,
      close,
      hand,
      world,
      mesh: () => meshOf(renderer.scene, "th/Painted"),
      flatMesh: () => meshOf(renderer.scene, "th/PaintedFlat"),
    };
  });
  const paint = (r: number, g: number, b: number) =>
    Color.Rgb.of({ r, g, b, space: Color.Linear });
  /** A colour as a hex code writes it, which is converted. */
  const srgb = (r: number, g: number, b: number) =>
    Color.Rgb.of({ r, g, b, space: Color.Srgb });
  /** The colour of the instance that is drawn at this height. */
  const colorAt = (mesh: InstancedMesh, y: number): number[] => {
    for (let i = 0; i < mesh.count; i++) {
      if (Math.abs(mesh.instanceMatrix.array[i * 16 + 13]! - y) < 1e-4) {
        return Array.from(mesh.instanceColor!.array.subarray(i * 3, i * 3 + 3));
      }
    }
    throw new Error(`Nothing is drawn at height ${y}`);
  };

  it.effect(
    "is the colour its entity has, or white, for every kind of entity, beside the matrix of the same entity",
    () =>
      Effect.gen(function* () {
        const { app, flatMesh, hand, mesh, world } = yield* play(
          App.define({ plugins, systems: [Painted, PaintedFlat] })
        );
        const turn = Rotation.of(Transform3d.axisAngle(0, 1, 0, 1));
        const size = Scale.of({ x: 2, y: 2, z: 2 });
        const flatTurn = Flat.Rotation.of({ angle: 1 });
        const flatSize = Flat.Scale.of({ x: 2, y: 2 });
        const at = (y: number) => Position.of({ x: 0, y, z: 0 });
        const flat = (y: number) => Flat.Position.of({ x: 0, y });
        // One of each of the four of either transform, each of a colour of its own.
        const rocks = [
          yield* hand.spawn(Rock, at(1), paint(0.125, 0, 0)),
          yield* hand.spawn(Rock, at(2), size, paint(0.25, 0, 0)),
          yield* hand.spawn(Rock, at(3), turn, paint(0.375, 0, 0)),
          yield* hand.spawn(Rock, at(4), turn, size, paint(0.5, 0, 0)),
          yield* hand.spawn(FlatRock, flat(5), paint(0, 0.125, 0.75)),
          yield* hand.spawn(FlatRock, flat(6), flatSize, paint(0, 0.25, 0.75)),
          yield* hand.spawn(FlatRock, flat(7), flatTurn, paint(0, 0.375, 0.75)),
          yield* hand.spawn(
            FlatRock,
            flat(8),
            flatTurn,
            flatSize,
            paint(0, 0.5, 0.75)
          ),
        ];
        // Not painted, of every kind: drawn in the material's own colour.
        const bare = [
          yield* hand.spawn(Rock, at(9)),
          yield* hand.spawn(Rock, at(10), size),
          yield* hand.spawn(Rock, at(11), turn),
          yield* hand.spawn(Rock, at(12), turn, size),
          yield* hand.spawn(FlatRock, flat(13)),
          yield* hand.spawn(FlatRock, flat(14), flatSize),
          yield* hand.spawn(FlatRock, flat(15), flatTurn),
          yield* hand.spawn(FlatRock, flat(16), flatTurn, flatSize),
        ];
        // Painted and not a rock; and hidden.
        yield* hand.spawn(Ship, at(20), paint(1, 1, 1));
        yield* hand.spawn(Rock, Hidden, at(20), paint(1, 1, 1));
        yield* app.frame();
        expectDrawn(
          mesh(),
          world,
          [...rocks.slice(0, 4), ...bare.slice(0, 4)],
          Transform3d
        );
        expectDrawn(
          flatMesh(),
          world,
          [...rocks.slice(4), ...bare.slice(4)],
          Transform2d
        );
        for (let y = 1; y <= 4; y++) {
          expect(colorAt(mesh(), y)).toEqual([y / 8, 0, 0]);
        }
        for (let y = 5; y <= 8; y++) {
          expect(colorAt(flatMesh(), y)).toEqual([0, (y - 4) / 8, 0.75]);
        }
        for (let y = 9; y <= 12; y++) {
          expect(colorAt(mesh(), y)).toEqual([1, 1, 1]);
        }
        for (let y = 13; y <= 16; y++) {
          expect(colorAt(flatMesh(), y)).toEqual([1, 1, 1]);
        }
        // Three numbers an instance, in a buffer of its own that changes often.
        const colors = mesh().instanceColor!;
        expect(colors.itemSize).toBe(3);
        expect(colors.usage).toBe(mesh().instanceMatrix.usage);
        // It follows the entity: repainted, and gone.
        yield* hand.set(rocks[0]!, Color.Rgb, { r: 0, g: 1, b: 0.5 });
        yield* hand.despawn(rocks[1]!);
        // Painted, and no longer.
        yield* hand.add(bare[0]!, paint(0.5, 0.5, 0.5));
        yield* hand.remove(rocks[2]!, Color.Rgb);
        yield* app.frame();
        expect(mesh().count).toBe(7);
        expect(flatMesh().count).toBe(8);
        expect(colorAt(mesh(), 1)).toEqual([0, 1, 0.5]);
        expect(colorAt(mesh(), 3)).toEqual([1, 1, 1]);
        expect(colorAt(mesh(), 9)).toEqual([0.5, 0.5, 0.5]);
      })
  );

  it.effect(
    "keeps each colour with its instance while they come, go and change, and the room for them grows",
    () =>
      Effect.gen(function* () {
        const random = makeRandom(88);
        const { app, flatMesh, hand, mesh, world } = yield* play(
          App.define({ plugins, systems: [Painted, PaintedFlat] })
        );
        let heights = 0;
        const alive: {
          readonly entity: Entity;
          readonly y: number;
          readonly flat: boolean;
        }[] = [];
        /** How many times each kind's mesh let go of its buffers, to grow them. */
        const dropped = [0, 0];
        for (let frame = 0; frame < 120; frame++) {
          for (let step = 0; step < 6; step++) {
            const roll = random.int(8);
            const one = alive[random.int(alive.length)];
            if (roll < 4 || one === undefined) {
              const y = ++heights;
              const flat = random.next() < 0.5;
              const parts = [
                flat ? FlatRock : Rock,
                flat
                  ? Flat.Position.of({ x: random.int(50), y })
                  : Position.of({ x: random.int(50), y, z: 0 }),
                paint(random.next(), random.next(), random.next()),
              ] as ComponentInput[];
              if (random.next() < 0.3) {
                parts.push(
                  Scale.of({ x: 2, y: 2, z: 2 }),
                  Flat.Scale.of({ x: 2, y: 2 })
                );
              }
              alive.push({ entity: yield* hand.spawn(...parts), y, flat });
            } else if (roll === 4) {
              yield* hand.despawn(one.entity);
              alive.splice(alive.indexOf(one), 1);
            } else if (roll === 5) {
              yield* hand.set(one.entity, Color.Rgb, {
                r: random.next(),
                g: random.next(),
              });
            } else if (world.has(one.entity, Color.Rgb)) {
              // Unpainted for a while, and painted again.
              yield* hand.remove(one.entity, Color.Rgb);
            } else {
              yield* hand.add(one.entity, paint(random.next(), 0, 0));
            }
          }
          yield* app.frame();
          if (frame === 0) {
            for (const [k, kind] of [mesh(), flatMesh()].entries()) {
              kind.addEventListener("dispose", () => {
                dropped[k] = dropped[k]! + 1;
              });
            }
          }
          // Each in its colour, or white while it has none.
          expect(mesh().count).toBe(alive.filter((one) => !one.flat).length);
          expect(flatMesh().count).toBe(alive.filter((one) => one.flat).length);
          for (const one of alive) {
            const { b, g, r } = world.get(one.entity, Color.Rgb) ?? {
              r: 1,
              g: 1,
              b: 1,
            };
            expect(
              colorAt(one.flat ? flatMesh() : mesh(), one.y),
              `frame ${frame}`
            ).toEqual([r, g, b]);
          }
        }
        // Each started with room for four, and outgrew it several times over:
        // both buffers together, each time.
        for (const [k, kind] of [mesh(), flatMesh()].entries()) {
          expect(kind.count).toBeGreaterThan(32);
          expect(dropped[k]).toBeGreaterThanOrEqual(4);
          expect(kind.instanceColor!.array.length).toBe(
            (kind.instanceMatrix.array.length / 16) * 3
          );
        }
      })
  );

  it.effect(
    "tells the renderer to send the colours that are drawn and no more, each frame something is",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play();
        const rocks = yield* Effect.forEach([1, 2, 3], (y) =>
          hand.spawn(Rock, Position.of({ x: 0, y, z: 0 }), paint(1, 1, 1))
        );
        yield* app.frame();
        const colors = mesh().instanceColor!;
        expect(colors.updateRanges).toEqual([{ start: 0, count: 9 }]);
        const [range] = colors.updateRanges;
        const sent = colors.version;
        expect(sent).toBeGreaterThan(0);
        colors.clearUpdateRanges();
        yield* hand.despawn(rocks[0]!);
        yield* app.frame();
        expect(colors.updateRanges).toEqual([{ start: 0, count: 6 }]);
        expect(colors.updateRanges[0]).toBe(range);
        expect(colors.version).toBe(sent + 1);
        // A renderer that sent nothing in between is not told twice.
        yield* app.frame();
        expect(colors.updateRanges.length).toBe(1);
        // Nothing to draw: nothing to send.
        yield* hand.despawn(rocks[1]!);
        yield* hand.despawn(rocks[2]!);
        colors.clearUpdateRanges();
        const before = colors.version;
        yield* app.frame();
        expect(colors.updateRanges).toEqual([]);
        expect(colors.version).toBe(before);
        expect(mesh().instanceColor).toBe(colors);
      })
  );

  it.effect(
    "changes evenly between two ticks when the kind is drawn so, however far it changes",
    () =>
      Effect.gen(function* () {
        const Fading = Three.instances("th/Painted", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
          color: Color.Rgb,
          smooth: true,
          // How far an entity may go: a colour is not a place, and is never too far.
          snap: 0.1,
        });
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Fading] })
        );
        const rock = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          paint(0, 0.5, 1)
        );
        yield* app.frame(0.5);
        expect(colorAt(mesh(), 1)).toEqual([0, 0.5, 1]);
        yield* hand.set(rock, Color.Rgb, { r: 1, g: 0.5, b: 0 });
        yield* app.tick(1);
        yield* app.frame(0);
        expect(colorAt(mesh(), 1)).toEqual([0, 0.5, 1]);
        yield* app.frame(0.25);
        expect(colorAt(mesh(), 1)).toEqual([0.25, 0.5, 0.75]);
        yield* app.frame(1);
        expect(colorAt(mesh(), 1)).toEqual([1, 0.5, 0]);
      })
  );

  it.effect(
    "is a hex code's numbers in Color.Srgb, converted for the renderer as Three.js converts them",
    () =>
      Effect.gen(function* () {
        const Coded = Three.instances("th/Painted", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
          color: Color.Rgb,
        });
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Coded] })
        );
        const codes = ["#ff6188", "#000000", "#ffffff", "#0a141e", "#7f8081"];
        // The same colours with no byte behind them, a little off each one.
        const between = [0.003, 0.0401, 0.0409, 0.2, 0.5173, 0.9999];
        for (const [i, code] of codes.entries()) {
          const hex = Number.parseInt(code.slice(1), 16);
          yield* hand.spawn(
            Rock,
            Position.of({ x: 0, y: i + 1, z: 0 }),
            srgb((hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255)
          );
        }
        for (const [i, c] of between.entries()) {
          // Of every kind of entity: the conversion is one, whatever the loop.
          yield* hand.spawn(
            Rock,
            Position.of({ x: 0, y: i + 11, z: 0 }),
            ...(i % 2 === 0 ? [] : [Rotation, Scale.of({ x: 1, y: 1, z: 1 })]),
            srgb(c, 1 - c, c)
          );
        }
        yield* app.frame();
        for (const [i, code] of codes.entries()) {
          // What Three.js itself holds of the code, in the space it works in.
          const { b, g, r } = new ThreeColor(code);
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
          const { b, g, r } = new ThreeColor().setRGB(
            c,
            1 - c,
            c,
            SRGBColorSpace
          );
          const [ours, ourGreen, ourBlue] = colorAt(mesh(), i + 11);
          // To a sixteenth of a byte, where the curve is steepest.
          expect(Math.abs(ours! - r)).toBeLessThan(3e-4);
          expect(Math.abs(ourGreen! - g)).toBeLessThan(3e-4);
          expect(Math.abs(ourBlue! - b)).toBeLessThan(3e-4);
        }
      })
  );

  it.effect(
    "takes every colour there is: any three numbers from 0 to 1, together",
    () =>
      Effect.gen(function* () {
        const Coded = Three.instances("th/Painted", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
          color: Color.Rgb,
        });
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Coded] })
        );
        const random = makeRandom(20_261_117);
        const colours: (readonly [number, number, number])[] = [
          // One that a benchmark came across, and the corners.
          [
            0.358_980_268_239_975, 0.315_995_723_009_109_5,
            0.970_885_157_585_144,
          ],
          [1, 1, 1],
          [0, 0, 0],
          [1, 0, 1],
          [0.999, 0.501, 0.251],
        ];
        for (let i = 0; i < 3000; i++) {
          colours.push([random.next(), random.next(), random.next()]);
        }
        for (const [i, [r, g, b]] of colours.entries()) {
          yield* hand.spawn(
            Rock,
            Position.of({ x: 0, y: i + 1, z: 0 }),
            srgb(r, g, b)
          );
        }
        yield* app.frame();
        const drawnColours = mesh().instanceColor!.array;
        const heights = mesh().instanceMatrix.array;
        const want = new ThreeColor();
        for (let i = 0; i < colours.length; i++) {
          const [r, g, b] = colours[Math.round(heights[i * 16 + 13]!) - 1]!;
          want.setRGB(r, g, b, SRGBColorSpace);
          expect(Math.abs(drawnColours[i * 3]! - want.r)).toBeLessThan(3e-4);
          expect(Math.abs(drawnColours[i * 3 + 1]! - want.g)).toBeLessThan(
            3e-4
          );
          expect(Math.abs(drawnColours[i * 3 + 2]! - want.b)).toBeLessThan(
            3e-4
          );
        }
      })
  );

  it.effect(
    "draws a number below 0 in Color.Srgb as 0, and one over 1 as 1, as CSS does",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play();
        const given = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          srgb(0, 0, 0)
        );
        const clamped = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 2, z: 0 }),
          srgb(0, 0, 0)
        );
        // Each channel is clamped apart from the others.
        for (const [r, g, b, same] of [
          [255, 0, 0, [1, 0, 0]],
          [0, 97, 0, [0, 1, 0]],
          [0, 0, 1.00001, [0, 0, 1]],
          [-0.01, 0.5, 0.5, [0, 0.5, 0.5]],
          [0.5, -3, 0.5, [0.5, 0, 0.5]],
          [0.5, 0.5, -200, [0.5, 0.5, 0]],
          // Past what a 32-bit integer holds, which would wrap back into range.
          [1052689, 0.5, 0.5, [1, 0.5, 0.5]],
        ] as const) {
          yield* hand.set(given, Color.Rgb, { r, g, b });
          yield* hand.set(clamped, Color.Rgb, {
            r: same[0],
            g: same[1],
            b: same[2],
          });
          yield* app.frame();
          expect(colorAt(mesh(), 1)).toEqual(colorAt(mesh(), 2));
        }
      })
  );

  it.effect(
    "refuses a colour that is no number, as a division by zero leaves it",
    () =>
      Effect.gen(function* () {
        const Painting = Query.all(Rock, Color.Rgb).pipe(
          Query.writes(Color.Rgb)
        );
        const Spoil = System.tick("th/Spoil", function* () {
          (yield* Painting).eachChunk((from, to, _rock, color) => {
            for (let i = from; i < to; i++) {
              color.r[i] = color.r[i]! / 0;
            }
          });
        });
        const renderer = makeRenderer();
        const { app, hand } = yield* start(
          App.make(
            App.define({
              plugins: [Three.plugin, Hand],
              systems: [
                Spoil,
                Three.instances("th/Painted", {
                  of: Rock,
                  transform: Transform3d,
                  geometry,
                  material,
                  color: Color.Rgb,
                }),
              ],
            })
          ),
          renderer
        );
        const rock = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          srgb(1, 1, 1)
        );
        for (const [r, spoilt] of [
          [0, Number.NaN],
          [1, Number.POSITIVE_INFINITY],
        ] as const) {
          yield* hand.set(rock, Color.Rgb, { r, g: 0.5, b: 0.5 });
          yield* app.tick(1);
          expect(yield* thrown(app.frame())).toThrow(
            `Three.instances("th/Painted") was given the colour (${spoilt}, 0.5, 0.5) by the entity of slot ${entityIndex(rock)}, generation ${entityGeneration(rock)}, which is no colour: each number of a colour in Color.Srgb is finite. One below 0 is drawn as 0 and one over 1 as 1, but NaN and an infinity, such as a division by zero leaves, have no colour to be drawn as.`
          );
        }
      })
  );

  it.effect(
    "takes any number in Color.Linear, the renderer's own, brighter than white or below black",
    () =>
      Effect.gen(function* () {
        const { app, hand, mesh } = yield* play();
        yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          paint(4, 0, -1)
        );
        yield* app.frame();
        expect(colorAt(mesh(), 1)).toEqual([4, 0, -1]);
      })
  );

  it.effect(
    "changes evenly between two ticks in the numbers the game has, and is converted then",
    () =>
      Effect.gen(function* () {
        const Fading = Three.instances("th/Painted", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
          color: Color.Rgb,
          smooth: true,
        });
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Fading] })
        );
        const rock = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          srgb(0, 0.2, 1)
        );
        yield* app.frame(0.5);
        yield* hand.set(rock, Color.Rgb, { r: 1, g: 0.2, b: 0 });
        yield* app.tick(1);
        yield* app.frame(0.25);
        // A quarter of the way between the two codes, as a code.
        const there = new ThreeColor().setRGB(0.25, 0.2, 0.75, SRGBColorSpace);
        expect(colorAt(mesh(), 1)[0]).toBeCloseTo(there.r, 3);
        expect(colorAt(mesh(), 1)[1]).toBeCloseTo(there.g, 3);
        expect(colorAt(mesh(), 1)[2]).toBeCloseTo(there.b, 3);
        yield* app.frame(1);
        expect(colorAt(mesh(), 1)[0]).toBe(1);
        expect(colorAt(mesh(), 1)[2]).toBe(0);
      })
  );

  it.effect(
    "is not there unless it is asked for: the mesh has no colours, and an entity needs none to be drawn",
    () =>
      Effect.gen(function* () {
        const Plain = Three.instances("th/Painted", {
          of: Rock,
          transform: Transform3d,
          geometry,
          material,
        });
        const { app, hand, mesh } = yield* play(
          App.define({ plugins, systems: [Plain] })
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 1, z: 0 }));
        yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 2, z: 0 }),
          paint(1, 0, 0)
        );
        yield* app.frame();
        expect(mesh().count).toBe(2);
        expect(mesh().instanceColor).toBeNull();
      })
  );

  it.effect(
    "is arcadekit's one colour, drawn by each entity's own space: a component of the game's own does not compile as one",
    () =>
      Effect.gen(function* () {
        const base = { of: Rock, transform: Transform3d, geometry, material };
        const Paint = Component.define("th/Paint", {
          r: Field.f32,
          g: Field.f32,
          b: Field.f32,
        });
        const Bytes = Component.define("th/Bytes", {
          r: Field.u8,
          g: Field.u8,
          b: Field.u8,
        });
        const Hue = Component.define("th/Hue", { degrees: Field.f32 });
        Three.instances("th/Own", {
          ...base,
          // @ts-expect-error the game's own colour, of the same fields as Color.Rgb's
          color: Paint,
        });
        Three.instances("th/Bytes", {
          ...base,
          // @ts-expect-error bytes are no colour of arcadekit's
          color: Bytes,
        });
        Three.instances("th/Hue", {
          ...base,
          // @ts-expect-error a hue is one number, not three
          color: Hue,
        });
        // Nor does `colorSpace`: the space is each entity's colour's.
        Three.instances("th/Space", {
          ...base,
          color: Color.Rgb,
          // @ts-expect-error the space is the colour's
          colorSpace: "srgb-linear",
        });
        // One kind draws each entity by the space of its own colour, and keeps a
        // linear one brighter than white.
        const { app, hand, mesh } = yield* play();
        const half = new ThreeColor().setRGB(0.5, 0.5, 0.5, SRGBColorSpace).r;
        yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 1, z: 0 }),
          srgb(1, 0.5, 0)
        );
        yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 2, z: 0 }),
          paint(4, 0.5, 0)
        );
        const turned = yield* hand.spawn(
          Rock,
          Position.of({ x: 0, y: 3, z: 0 }),
          paint(0, 0, 1)
        );
        yield* app.frame();
        expect(colorAt(mesh(), 1)[0]).toBe(1);
        expect(colorAt(mesh(), 1)[1]).toBeCloseTo(half, 6);
        expect(colorAt(mesh(), 2)).toEqual([4, 0.5, 0]);
        expect(colorAt(mesh(), 3)).toEqual([0, 0, 1]);
        // The same numbers in the other space are another colour.
        yield* hand.set(turned, Color.Rgb, { b: 0.5, space: Color.Srgb });
        yield* app.frame();
        expect(colorAt(mesh(), 3)[2]).toBeCloseTo(half, 6);
        // @ts-expect-error a space is Color.Srgb or Color.Linear
        yield* hand.set(turned, Color.Rgb, { space: 2 });
        expect(yield* thrown(app.frame())).toThrow(
          `Three.instances("th/Painted") was given the colour (0, 0, 0.5) by the entity of slot ${entityIndex(turned)}, generation ${entityGeneration(turned)}, which is no colour: its space is 2, and a colour's space is Color.Srgb (0) or Color.Linear (1).`
        );
      })
  );

  it.effect("goes with the mesh when the app's scope closes", () =>
    Effect.gen(function* () {
      const { app, close, hand, mesh } = yield* play();
      yield* hand.spawn(
        Rock,
        Position.of({ x: 0, y: 1, z: 0 }),
        paint(1, 1, 1)
      );
      yield* app.frame();
      const kept = mesh();
      let disposed = 0;
      kept.instanceColor!.addEventListener("dispose", () => {
        disposed++;
      });
      yield* close;
      expect(disposed).toBe(1);
      expect(kept.parent).toBeNull();
    })
  );
});

describe("Three.objects", () => {
  const made: { readonly object: Object3D; readonly entity: Entity }[] = [];
  const freed: { readonly object: Object3D; readonly entity: Entity }[] = [];
  /** Whether `make` gives the objects a turn and a size of its own. */
  let tilted = false;
  const Ships = Three.objects("th/Ships", {
    of: Ship,
    transform: Transform3d,
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
    plugins: [Three.plugin, Hand],
    systems: [Ships],
  });
  const fresh = Effect.fnUntraced(function* () {
    made.length = 0;
    freed.length = 0;
    tilted = false;
    const renderer = makeRenderer();
    return {
      renderer,
      ...(yield* start(App.make(App.define({ plugins: [Fleet] })), renderer)),
    };
  });
  const objectOf = (entity: Entity): Object3D | undefined =>
    made.findLast((one) => one.entity === entity)?.object;

  it.effect(
    "turns an object by the turn a rotation of any length stands for, with a quaternion of length 1",
    () =>
      Effect.gen(function* () {
        const { app, hand } = yield* fresh();
        const quarter = Transform3d.axisAngle(0, 0, 1, Math.PI / 2);
        const long = yield* hand.spawn(
          Ship,
          Position.of({ x: 1, y: 0, z: 0 }),
          Rotation.of(stretched(quarter, 7)),
          Scale.of({ x: 2, y: 3, z: 4 })
        );
        const short = yield* hand.spawn(
          Ship,
          Position.of({ x: 2, y: 0, z: 0 }),
          Rotation.of(stretched(quarter, 0.001))
        );
        // All zeros is not turned at all.
        const still = yield* hand.spawn(
          Ship,
          Position.of({ x: 3, y: 0, z: 0 }),
          Rotation
        );
        yield* app.frame();
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
        for (let k = 0; k < 16; k++) {
          expect(
            objectOf(long)!.matrix.elements[k],
            `element ${k}`
          ).toBeCloseTo(wanted[k]!, 5);
        }
      })
  );

  it.effect(
    "makes one object per entity, once, adds it to the scene and puts it where the entity is",
    () =>
      Effect.gen(function* () {
        const { app, hand, renderer } = yield* fresh();
        const turn = Transform3d.axisAngle(0, 1, 0, 0.75);
        const plain = yield* hand.spawn(
          Ship,
          Position.of({ x: 1, y: 2, z: 3 })
        );
        const whole = yield* hand.spawn(
          Ship,
          Position.of({ x: -1, y: -2, z: -3 }),
          Rotation.of(turn),
          Scale.of({ x: 2, y: 3, z: 4 })
        );
        yield* hand.spawn(Rock, Position.of({ x: 9, y: 9, z: 9 }));
        // One that is turned and sized, and nowhere.
        yield* hand.remove(yield* hand.spawn(Ship, Rotation, Scale), Position);
        yield* app.frame();
        expect(
          made
            .map((one) => one.entity)
            .toSorted((a, b) => entityIndex(a) - entityIndex(b))
        ).toEqual([plain, whole]);
        expect(
          renderer.scene?.children.toSorted((a, b) => a.id - b.id)
        ).toEqual(
          made.map((one) => one.object).toSorted((a, b) => a.id - b.id)
        );
        expect(objectOf(plain)!.position.toArray()).toEqual([1, 2, 3]);
        expect(objectOf(plain)!.quaternion.toArray()).toEqual([0, 0, 0, 1]);
        expect(objectOf(plain)!.scale.toArray()).toEqual([1, 1, 1]);
        expect(objectOf(whole)!.position.toArray()).toEqual([-1, -2, -3]);
        expectTurned(objectOf(whole)!, turn);
        expect(objectOf(whole)!.scale.toArray()).toEqual([2, 3, 4]);
        // It moves with its entity, and is not made again.
        yield* hand.set(plain, Position, { x: 10, y: 20, z: 30 });
        yield* hand.set(whole, Scale, { x: 5, y: 5, z: 5 });
        yield* hand.set(whole, Rotation, { x: 0, y: 0, z: 1, w: 0 });
        yield* app.frame();
        expect(made.length).toBe(2);
        expect(freed).toEqual([]);
        expect(objectOf(plain)!.position.toArray()).toEqual([10, 20, 30]);
        expect(objectOf(whole)!.scale.toArray()).toEqual([5, 5, 5]);
        expect(objectOf(whole)!.quaternion.toArray()).toEqual([0, 0, 1, 0]);
      })
  );

  it.effect(
    "keeps the one object of an entity whose id is past what 32 bits hold",
    () =>
      Effect.gen(function* () {
        const { app, hand } = yield* fresh();
        // A slot given out 1,100 times: the next entity in it has such an id.
        for (let n = 0; n < 1100; n++) {
          yield* hand.despawn(yield* hand.spawn(Ship));
        }
        const ship = yield* hand.spawn(Ship, Position.of({ x: 1, y: 2, z: 3 }));
        expect(ship).toBeGreaterThan(2 ** 32);
        yield* app.frame();
        yield* hand.set(ship, Position, { x: 4, y: 5, z: 6 });
        yield* app.frame();
        yield* app.frame();
        // Made once, for this entity, and not again for every frame that
        // finds it.
        expect(made.map((one) => one.entity)).toEqual([ship]);
        expect(freed).toEqual([]);
        expect(objectOf(ship)!.position.toArray()).toEqual([4, 5, 6]);
      })
  );

  it.effect(
    "takes the object out and frees it when its entity is gone, or is no longer one of these",
    () =>
      Effect.gen(function* () {
        const { app, hand, renderer } = yield* fresh();
        const at = (x: number) => Position.of({ x, y: 0, z: 0 });
        const [gone, unmarked, hidden, nowhere, stays] = (yield* Effect.forEach(
          [1, 2, 3, 4, 5],
          (x) => hand.spawn(Ship, at(x))
        )) as [Entity, Entity, Entity, Entity, Entity];
        yield* app.frame();
        expect(made.length).toBe(5);
        const objects = new Map(made.map((one) => [one.entity, one.object]));
        yield* hand.despawn(gone);
        yield* hand.remove(unmarked, Ship);
        yield* hand.add(hidden, Hidden);
        yield* hand.remove(nowhere, Position);
        yield* app.frame();
        expect(
          freed
            .map((one) => one.entity)
            .toSorted((a, b) => entityIndex(a) - entityIndex(b))
        ).toEqual(
          [gone, unmarked, hidden, nowhere].toSorted(
            (a, b) => entityIndex(a) - entityIndex(b)
          )
        );
        for (const one of freed) {
          expect(one.object).toBe(objects.get(one.entity));
          expect(one.object.parent).toBeNull();
        }
        expect(renderer.scene?.children).toEqual([objects.get(stays)]);
        // Each was freed once.
        yield* app.frame();
        expect(freed.length).toBe(4);
        // One that is one of these again gets a new object.
        yield* hand.remove(hidden, Hidden);
        yield* app.frame();
        expect(made.length).toBe(6);
        expect(objectOf(hidden)).not.toBe(objects.get(hidden));
        expect(objectOf(hidden)!.position.x).toBe(3);
        expect(renderer.scene?.children.length).toBe(2);
      })
  );

  it.effect(
    "gives an entity that takes a despawned one's slot an object of its own",
    () =>
      Effect.gen(function* () {
        const { app, hand } = yield* fresh();
        const first = yield* hand.spawn(
          Ship,
          Position.of({ x: 1, y: 1, z: 1 }),
          Rotation.of({ x: 0, y: 0, z: 1, w: 0 }),
          Scale.of({ x: 3, y: 3, z: 3 })
        );
        yield* app.frame();
        const old = objectOf(first)!;
        yield* hand.despawn(first);
        tilted = true;
        const second = yield* hand.spawn(
          Ship,
          Position.of({ x: 2, y: 2, z: 2 })
        );
        // The same slot, and another entity.
        expect(entityIndex(second)).toBe(entityIndex(first));
        expect(second).not.toBe(first);
        yield* app.frame();
        expect(freed).toEqual([{ object: old, entity: first }]);
        expect(objectOf(second)).not.toBe(old);
        expect(objectOf(second)!.position.toArray()).toEqual([2, 2, 2]);
        // The new one was never turned or sized: what `make` gave it stands,
        // this frame and the next.
        yield* app.frame();
        expect(objectOf(second)!.quaternion.toArray()).toEqual([0, 1, 0, 0]);
        expect(objectOf(second)!.scale.toArray()).toEqual([2, 2, 2]);
        expect(old.parent).toBeNull();
        expect(objectOf(second)!.parent).not.toBeNull();
        expect(made.length).toBe(2);
      })
  );

  it.effect(
    "draws an entity that lost its rotation or its scale as one that never had one",
    () =>
      Effect.gen(function* () {
        const { app, hand } = yield* fresh();
        const ship = yield* hand.spawn(
          Ship,
          Position.of({ x: 0, y: 0, z: 0 }),
          Rotation.of({ x: 1, y: 0, z: 0, w: 0 }),
          Scale.of({ x: 3, y: 3, z: 3 })
        );
        yield* app.frame();
        const object = objectOf(ship)!;
        expect(object.quaternion.toArray()).toEqual([1, 0, 0, 0]);
        yield* hand.remove(ship, Rotation);
        yield* app.frame();
        expect(object.quaternion.toArray()).toEqual([0, 0, 0, 1]);
        expect(object.scale.toArray()).toEqual([3, 3, 3]);
        yield* hand.remove(ship, Scale);
        yield* app.frame();
        expect(object.scale.toArray()).toEqual([1, 1, 1]);
        // What the game itself then sets on the object is left alone.
        object.scale.set(7, 7, 7);
        object.quaternion.set(0, 1, 0, 0);
        yield* app.frame();
        expect(object.scale.toArray()).toEqual([7, 7, 7]);
        expect(object.quaternion.toArray()).toEqual([0, 1, 0, 0]);
        expect(made.length).toBe(1);
      })
  );

  it.effect(
    "keeps exactly one object for each entity that is one of these, whatever happens to them",
    () =>
      Effect.gen(function* () {
        const random = makeRandom(77);
        const { app, hand, renderer, world } = yield* fresh();
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
              all.push(yield* hand.spawn(...parts));
            } else if (roll === 3) {
              yield* hand.despawn(one);
              all.splice(all.indexOf(one), 1);
            } else if (roll === 4) {
              yield* hand.add(one, Hidden);
            } else if (roll === 5) {
              yield* hand.remove(one, Hidden);
            } else if (roll === 6) {
              yield* hand.remove(one, Ship);
            } else if (roll === 7) {
              yield* hand.add(one, Ship);
            } else if (roll === 8) {
              yield* hand.remove(one, Rotation);
            } else {
              yield* hand.add(
                one,
                Position.of({
                  x: random.int(100),
                  y: random.int(100),
                  z: random.int(100),
                })
              );
            }
          }
          yield* app.frame();
          const shown = all.filter(
            (one) => world.has(one, Ship) && !world.has(one, Hidden)
          );
          // What is in the scene is the objects made and not freed, one each.
          const kept = made.filter(
            (one) => !freed.some((other) => other.object === one.object)
          );
          expect(
            kept
              .map((one) => one.entity)
              .toSorted((a, b) => entityIndex(a) - entityIndex(b))
          ).toEqual(shown.toSorted((a, b) => entityIndex(a) - entityIndex(b)));
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
      })
  );

  it.effect(
    "makes the objects of a loaded game on its first frame: none of them is in the save",
    () =>
      Effect.gen(function* () {
        const first = yield* fresh();
        const ship = yield* first.hand.spawn(
          Ship,
          Position.of({ x: 4, y: 5, z: 6 })
        );
        yield* first.app.frame();
        yield* first.app.tick(1 / 60);
        const hash = first.world.hash();
        const save = yield* Effect.exit(first.app.save());
        if (Exit.isFailure(save)) {
          throw new Error("The game could not be saved");
        }
        made.length = 0;
        const renderer = makeRenderer();
        const { app, world } = yield* start(
          App.make(App.define({ plugins: [Fleet] }), { save: save.value }),
          renderer
        );
        expect(world.hash()).toBe(hash);
        expect(made).toEqual([]);
        yield* app.frame();
        expect(made.map((one) => one.entity)).toEqual([ship]);
        expect(objectOf(ship)!.position.toArray()).toEqual([4, 5, 6]);
        expect(renderer.scene?.children).toEqual([objectOf(ship)]);
      })
  );

  it.effect("frees every object it still has when the app's scope closes", () =>
    Effect.gen(function* () {
      const { app, close, hand, renderer } = yield* fresh();
      const ships = yield* Effect.forEach([1, 2, 3], (x) =>
        hand.spawn(Ship, Position.of({ x, y: 0, z: 0 }))
      );
      yield* app.frame();
      yield* hand.despawn(ships[0]!);
      yield* app.frame();
      expect(freed.length).toBe(1);
      yield* close;
      expect(
        freed
          .map((one) => one.entity)
          .toSorted((a, b) => entityIndex(a) - entityIndex(b))
      ).toEqual(ships.toSorted((a, b) => entityIndex(a) - entityIndex(b)));
      expect(renderer.scene?.children).toEqual([]);
    })
  );
});

describe("Three.plugin", () => {
  it.effect(
    "draws the scene once per frame, after everything that fills it, through the camera the game left it",
    () =>
      Effect.gen(function* () {
        const camera = new OrthographicCamera(-1, 1, 1, -1);
        const order: string[] = [];
        const Aim = System.frame("th/Aim", function* () {
          const three = yield* Three.Scene;
          order.push("aim");
          three.camera = camera;
          // Nothing said of when: what draws the scene is of a later stage.
        });
        const Ships = Three.objects("th/Flagships", {
          of: Ship,
          transform: Transform3d,
          make: () => {
            order.push("make");
            return new Object3D();
          },
        });
        const renderer = makeRenderer();
        const layer = Three.layer({
          render(scene, seen) {
            order.push("render");
            renderer.render(scene, seen);
          },
        });
        // Listed after the plugin that draws, and still drawn before it does.
        const { app, hand } = yield* start(
          App.make(
            App.define({
              plugins: [Three.plugin, Hand],
              systems: [Rocks, Ships, Aim],
            })
          ),
          { layer }
        );
        expect(app.frameOrder.at(-1)).toBe("arcadekit/three/Render");
        for (let i = 0; i < 3; i++) {
          yield* hand.spawn(Rock, Position.of({ x: i, y: 0, z: 0 }));
        }
        yield* hand.spawn(Ship, Position.of({ x: 0, y: 0, z: 0 }));
        // Nothing is drawn by a tick.
        yield* app.tick(1 / 60);
        expect(renderer.frames).toBe(0);
        yield* app.frame();
        expect(order).toEqual(["make", "aim", "render"]);
        expect(renderer.frames).toBe(1);
        expect(renderer.camera).toBe(camera);
        // The instances were counted before the scene was drawn.
        expect(renderer.counts).toEqual([3]);
        yield* app.frame(0.5);
        yield* app.frame(0.9);
        expect(renderer.frames).toBe(3);
      })
  );

  it.effect(
    "gives a scene with a perspective camera ten units back, for a plugin that depends on it to set up",
    () =>
      Effect.gen(function* () {
        let seen: Three.SceneShape | undefined;
        const light = new Object3D();
        const Stage = Plugin.make("th/Stage", {
          plugins: [Three.plugin, Hand],
          layer: Layer.effectDiscard(
            Effect.map(Three.Scene, (three) => {
              seen = three;
              three.scene.add(light);
            })
          ),
        });
        const renderer = makeRenderer();
        const { app } = yield* start(
          App.make(App.define({ plugins: [Stage] })),
          renderer
        );
        expect(seen?.camera).toBeInstanceOf(PerspectiveCamera);
        expect(seen?.camera.position.toArray()).toEqual([0, 0, 10]);
        yield* app.frame();
        expect(renderer.scene).toBe(seen?.scene);
        expect(renderer.camera).toBe(seen?.camera);
        expect(renderer.scene?.children).toEqual([light]);
      })
  );

  it.effect(
    "leaves the game as it found it: a game that is drawn is the same game as one that is not",
    () =>
      Effect.gen(function* () {
        const Spin = System.tick("th/Spin", function* () {
          const { delta, tick } = yield* Time;
          const commands = yield* Commands.spawns(
            Rock,
            Position,
            Ship,
            Rotation
          );
          (yield* Query.all(Position).pipe(Query.writes(Position))).each(
            (position) => {
              position.x += delta * 3;
            }
          );
          if (tick % 7 === 0) {
            commands.spawn(Rock, Position.of({ x: tick, y: 0, z: 0 }));
            commands.spawn(
              Ship,
              Position.of({ x: 0, y: tick, z: 0 }),
              Rotation
            );
          }
        });
        const Rules = Plugin.make("th/SpinRules", {
          systems: [Spin],
        });
        const Flagships = Three.objects("th/Flagships", {
          of: Ship,
          transform: Transform3d,
          make: () => new Object3D(),
        });
        const Drawn = Plugin.make("th/Drawn", {
          plugins: [Three.plugin, Rules],
          systems: [Rocks, Flagships],
        });
        const renderer = makeRenderer();
        // Checked after every system of every frame.
        const { app: drawnGame, world: drawnWorld } = yield* start(
          App.make(App.define({ plugins: [Drawn] }), {
            seed: 3,
            checkpointEvery: 1,
            verifyFrames: true,
          }),
          renderer
        );
        const bare = yield* App.make(App.define({ plugins: [Rules] }), {
          seed: 3,
          checkpointEvery: 1,
        });
        const bareWorld = yield* bare.read(World);
        for (let tick = 0; tick < 60; tick++) {
          yield* drawnGame.tick(1 / 60);
          yield* drawnGame.frame(0.3);
          yield* drawnGame.frame(0.8);
          yield* bare.tick(1 / 60);
          expect(drawnWorld.hash()).toBe(bareWorld.hash());
        }
        expect(drawnGame.actionLog).toEqual(bare.actionLog);
        expect(renderer.counts).toEqual([8]);
        expect(renderer.frames).toBe(120);
      })
  );

  it("does not compile without a renderer", () => {
    const made = App.make(App.define({ plugins: [Look] }));
    // Three.Renderer is still needed, and nothing else.
    expectTypeOf(made).not.toExtend<Effect.Effect<unknown, never, never>>();
    expectTypeOf(made.pipe(Effect.provide(makeRenderer().layer))).toExtend<
      Effect.Effect<unknown, never, never>
    >();
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
  const use = Effect.fnUntraced(function* (
    standIn: ReturnType<typeof makeStandIn>,
    options?: Three.FitOptions
  ) {
    const scope = Scope.makeUnsafe();
    let makes = 0;
    // Built into a scope of the test's, as a program's layers are built
    // into the program's.
    const renderer = Context.get(
      yield* Layer.build(
        Three.layerRenderer(() => {
          makes++;
          return standIn;
        }, options)
      ).pipe(Scope.provide(scope)),
      Three.Renderer
    );
    return {
      renderer,
      makes: () => makes,
      close: Scope.close(scope, Exit.void),
    };
  });
  const scene = new Object3D() as Scene;

  it.effect(
    "fits the picture to the size the canvas has on the page, when that changes, and a perspective camera with it",
    () =>
      Effect.gen(function* () {
        const size = { clientWidth: 800, clientHeight: 400 };
        const standIn = makeStandIn(size);
        const { makes, renderer } = yield* use(standIn, { pixelRatio: 2 });
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
      })
  );

  it.effect(
    "takes the page's own pixel ratio, up to 2, unless it is given one",
    () =>
      Effect.gen(function* () {
        const standIn = makeStandIn({ clientWidth: 100, clientHeight: 100 });
        const { renderer } = yield* use(standIn);
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
      })
  );

  it.effect(
    "fits nothing when told not to, or when the canvas has no size on a page",
    () =>
      Effect.gen(function* () {
        const camera = new PerspectiveCamera(50, 1.25, 0.1, 100);
        const told = makeStandIn({ clientWidth: 800, clientHeight: 400 });
        (yield* use(told, { fit: false })).renderer.render(scene, camera);
        expect(told.asked).toEqual(["render 1.25"]);
        for (const size of [
          {},
          { clientWidth: 0, clientHeight: 0 },
          { clientWidth: 300, clientHeight: 0 },
        ]) {
          const standIn = makeStandIn(size);
          (yield* use(standIn)).renderer.render(scene, camera);
          expect(standIn.asked).toEqual(["render 1.25"]);
        }
      })
  );

  it.effect(
    "disposes of the renderer when the scope it was provided to closes, and not before",
    () =>
      Effect.gen(function* () {
        const standIn = makeStandIn({});
        const { close, renderer } = yield* use(standIn);
        renderer.render(scene, new PerspectiveCamera());
        expect(standIn.asked).not.toContain("dispose");
        yield* close;
        expect(standIn.asked.at(-1)).toBe("dispose");
        expect(standIn.asked.filter((one) => one === "dispose").length).toBe(1);
      })
  );
});

describe("the geometries and materials a system draws with", () => {
  const disposals = (
    ...things: readonly {
      addEventListener: (type: "dispose", listener: () => void) => void;
    }[]
  ) => {
    const seen: number[] = [];
    things.forEach((thing, i) =>
      thing.addEventListener("dispose", () => seen.push(i))
    );
    return seen;
  };

  it.effect(
    "is disposed of once, when the last system that draws with it lets go",
    () =>
      Effect.gen(function* () {
        const shared = new BoxGeometry(1, 1, 1);
        const own = new MeshBasicMaterial();
        const other = new MeshBasicMaterial();
        const Rocks = Plugin.make("th/Rocks", {
          plugins: [Three.plugin, Hand],
          systems: [
            Three.instances("th/Boulders", {
              of: Rock,
              transform: Transform3d,
              geometry: shared,
              material: own,
            }),
            Three.instances("th/Pebbles", {
              of: Rock,
              transform: Transform3d,
              geometry: shared,
              material: other,
            }),
          ],
        });
        const renderer = makeRenderer();
        const { app, close, hand } = yield* start(
          App.make(App.define({ plugins: [Rocks] })),
          renderer
        );
        yield* hand.spawn(Rock, Position.of({ x: 0, y: 0, z: 0 }));
        yield* app.frame();
        const seen = disposals(shared, own, other);
        yield* close;
        expect(seen.toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
      })
  );

  it.effect(
    "is, for Three.objects, whatever make built, unless free disposed of it already",
    () =>
      Effect.gen(function* () {
        const hull = new BoxGeometry(1, 1, 1);
        const paints: MeshBasicMaterial[] = [];
        const Ships = Plugin.make("th/Fleet", {
          plugins: [Three.plugin, Hand],
          systems: [
            Three.objects("th/Fleet", {
              of: Ship,
              transform: Transform3d,
              make: () => {
                const paint = new MeshBasicMaterial();
                paints.push(paint);
                const group = new Group();
                group.add(new Mesh(hull, paint));
                return group;
              },
              // Each ship's own paint goes with it; the hull is shared.
              free: (group) => {
                for (const part of group.children) {
                  if (part instanceof Mesh) {
                    (part.material as MeshBasicMaterial).dispose();
                  }
                }
              },
            }),
          ],
        });
        const renderer = makeRenderer();
        const { app, close, hand } = yield* start(
          App.make(App.define({ plugins: [Ships] })),
          renderer
        );
        const first = yield* hand.spawn(
          Ship,
          Position.of({ x: 0, y: 0, z: 0 })
        );
        yield* hand.spawn(Ship, Position.of({ x: 1, y: 0, z: 0 }));
        yield* app.frame();
        const seen = disposals(hull, ...paints);
        yield* hand.despawn(first);
        yield* app.frame();
        expect(seen).toEqual([1]);
        yield* close;
        expect(seen.toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
      })
  );
});
