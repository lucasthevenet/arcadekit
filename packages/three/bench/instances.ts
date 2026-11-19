/**
 * What does it cost to draw a crowd?
 *
 * Every variant puts the same 10,000 entities where they are, once per
 * frame, with a renderer that draws nothing: what is measured is the work
 * this package does before Three.js takes over. Reported as nanoseconds per
 * entity (the median of many frames, after warm-up), and as the bytes the
 * heap grew by per frame.
 *
 *   pnpm --filter @arcadekit/three bench
 */
import {
  App,
  Assets,
  Component,
  Field,
  Plugin,
  Transform2d,
  Transform3d,
} from "arcadekit";
import { System } from "arcadekit";
import type { Frame, Time, World } from "arcadekit";
import type { ComponentInput } from "arcadekit/ecs";
import { Effect, Layer, Scope } from "effect";
import { BoxGeometry, InstancedMesh, MeshBasicMaterial, Object3D } from "three";

import { Three } from "../src/index";

const N = 10_000;
const { Position, Rotation, Scale } = Transform3d;
const Thing = Component.tag("bench/Thing");
const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();

const noRenderer = Layer.mergeAll(
  Layer.succeed(Three.Renderer, { render() {} }),
  Assets.layerMemory({ "/bark.png": "" })
);

const median = (values: number[]): number =>
  values.toSorted((a, b) => a - b)[values.length >> 1]!;

const measure = (frame: () => void): { ns: number; bytes: number } => {
  for (let i = 0; i < 300; i++) {
    frame();
  }
  const times: number[] = [];
  const grown: number[] = [];
  for (let i = 0; i < 301; i++) {
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    frame();
    times.push(performance.now() - started);
    grown.push(process.memoryUsage().heapUsed - heap);
  }
  return { ns: (median(times) * 1e6) / N, bytes: median(grown) };
};

const variant = (
  name: string,
  parts: () => ComponentInput[],
  system: System.System<
    never,
    Frame | Three.Scene | Time | World | Assets.Store
  >,
  // What else the frame runs, for a variant that needs it.
  also: readonly System.System<never, Assets.Store>[] = []
): void => {
  const scope = Scope.makeUnsafe();
  const app = Effect.runSync(
    App.make({
      plugins: [Three.plugin, Assets.plugin],
      systems: [...also, system],
    }).pipe(Effect.provide(noRenderer), Scope.provide(scope))
  );
  for (let i = 0; i < N; i++) {
    app.world.spawn(Thing, ...parts());
  }
  const { bytes, ns } = measure(() => app.frame(0));
  console.log(
    `${name.padEnd(58)} ${ns.toFixed(1).padStart(6)} ns/entity ${String(bytes).padStart(8)} bytes/frame`
  );
};

const place = () =>
  Position.of({ x: Math.random(), y: Math.random(), z: Math.random() });
const turn = () => Rotation.of(Transform3d.axisAngle(0, 1, 0, Math.random()));
const size = () => Scale.of({ x: 2, y: 2, z: 2 });
const instanced = (name: string) =>
  Three.instances(name, { of: Thing, geometry, material, capacity: N });

console.log(`${N} entities, one frame:`);
variant("instances: a position", () => [place()], instanced("a"));
variant(
  "instances: a position and a scale",
  () => [place(), size()],
  instanced("b")
);
variant(
  "instances: a position and a rotation",
  () => [place(), turn()],
  instanced("c")
);
variant(
  "instances: all three",
  () => [place(), turn(), size()],
  instanced("d")
);
// A flat game's entities: fewer columns, and a sine and a cosine for a turn.
const placeFlat = () =>
  Transform2d.Position.of({ x: Math.random(), y: Math.random() });
const turnFlat = () => Transform2d.Rotation.of({ angle: Math.random() * 6 });
const sizeFlat = () => Transform2d.Scale.of({ x: 2, y: 2 });
variant("instances, flat: a position", () => [placeFlat()], instanced("f"));
variant(
  "instances, flat: a position and a scale",
  () => [placeFlat(), sizeFlat()],
  instanced("g")
);
variant(
  "instances, flat: a position and a rotation",
  () => [placeFlat(), turnFlat()],
  instanced("h")
);
variant(
  "instances, flat: all three",
  () => [placeFlat(), turnFlat(), sizeFlat()],
  instanced("i")
);
variant(
  "objects: an Object3D each, all three copied",
  () => [place(), turn(), size()],
  Three.objects("e", { of: Thing, make: () => new Object3D() })
);

variant(
  "objects, flat: an Object3D each, all three copied",
  () => [placeFlat(), turnFlat(), sizeFlat()],
  Three.objects("j", { of: Thing, make: () => new Object3D() })
);

// Drawn between two ticks: each value on its way from the one a tick ago,
// kept per entity by the renderer. No tick runs between these frames; a
// frame that follows one does the same work.
const smoothed = (name: string) =>
  Three.instances(name, {
    of: Thing,
    geometry,
    material,
    capacity: N,
    smooth: true,
  });
variant("instances, smooth: a position", () => [place()], smoothed("k"));
variant(
  "instances, smooth: all three",
  () => [place(), turn(), size()],
  smoothed("l")
);
variant(
  "instances, smooth, flat: a position",
  () => [placeFlat()],
  smoothed("m")
);
variant(
  "instances, smooth, flat: all three",
  () => [placeFlat(), turnFlat(), sizeFlat()],
  smoothed("n")
);

// A colour of its own for each: three more numbers, beside the matrix.
const Paint = Component.define("bench/Paint", {
  r: Field.f32,
  g: Field.f32,
  b: Field.f32,
});
const paint = () =>
  Paint.of({ r: Math.random(), g: Math.random(), b: Math.random() });
variant(
  "instances, a colour each: a position",
  () => [place(), paint()],
  Three.instances("o", {
    of: Thing,
    geometry,
    material,
    capacity: N,
    color: Paint,
  })
);
variant(
  "instances, a colour each, as the renderer has it: a position",
  () => [place(), paint()],
  Three.instances("o2", {
    of: Thing,
    geometry,
    material,
    capacity: N,
    color: Paint,
    colorSpace: "srgb-linear",
  })
);
variant(
  "instances, a colour each, smooth: a position",
  () => [place(), paint()],
  Three.instances("p", {
    of: Thing,
    geometry,
    material,
    capacity: N,
    color: Paint,
    smooth: true,
  })
);

// A look that is made of a bundle's assets, and asked each frame whether
// they are still there: once by the system, and once before the scene is
// drawn.
const Level = Assets.bundle("bench/Level", {
  // An asset that needs no file, since none is fetched here.
  bark: Assets.make("/bark.png", () => Effect.succeed(material)),
});
const Sourced = Three.instances("q", {
  of: Thing,
  from: Level,
  look: ({ bark }) => ({ geometry, material: bark }),
  capacity: N,
});
variant(
  "instances, a look made of assets: a position",
  () => [place()],
  Sourced,
  [Assets.during(Effect.succeed(true), Level)]
);

// What the loops above replace: an Object3D per entity, its matrix worked
// out by Three.js and copied into the mesh, as its documentation shows.
{
  const scope = Scope.makeUnsafe();
  const app = Effect.runSync(
    App.make({
      plugins: [Plugin.make("bench/Bare", { plugins: [Transform3d.plugin] })],
    }).pipe(Scope.provide(scope))
  );
  const entities = Array.from({ length: N }, () =>
    app.world.spawn(Thing, place(), turn(), size())
  );
  const mesh = new InstancedMesh(geometry, material, N);
  const dummy = new Object3D();
  const { bytes, ns } = measure(() => {
    for (let i = 0; i < N; i++) {
      const entity = entities[i]!;
      const position = app.world.get(entity, Position)!;
      const rotation = app.world.get(entity, Rotation)!;
      const scale = app.world.get(entity, Scale)!;
      dummy.position.set(position.x, position.y, position.z);
      dummy.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      dummy.scale.set(scale.x, scale.y, scale.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
  console.log(
    `${"by hand: world.get and setMatrixAt, per entity".padEnd(58)} ${ns.toFixed(1).padStart(6)} ns/entity ${String(bytes).padStart(8)} bytes/frame`
  );
}
