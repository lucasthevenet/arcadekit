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
import { App, Component, Plugin } from "arcadekit";
import type { ComponentInput } from "arcadekit/ecs";
import { Effect, Layer, Scope } from "effect";
import { BoxGeometry, InstancedMesh, MeshBasicMaterial, Object3D } from "three";

import { Three, Transform } from "../src/index";

const N = 10_000;
const { Position, Rotation, Scale } = Transform;
const Thing = Component.tag("bench/Thing");
const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();

const noRenderer = Layer.succeed(Three.Renderer, { render() {} });

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
  system: ReturnType<typeof Three.instances>
): void => {
  const scope = Effect.runSync(Scope.make());
  const app = Effect.runSync(
    App.make({ plugins: [Three.plugin], systems: [system] }).pipe(
      Effect.provide(noRenderer),
      Scope.provide(scope)
    )
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
const turn = () => Rotation.of(Transform.axisAngle(0, 1, 0, Math.random()));
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
variant(
  "objects: an Object3D each, all three copied",
  () => [place(), turn(), size()],
  Three.objects("e", { of: Thing, make: () => new Object3D() })
);

// What the loops above replace: an Object3D per entity, its matrix worked
// out by Three.js and copied into the mesh, as its documentation shows.
{
  const scope = Effect.runSync(Scope.make());
  const app = Effect.runSync(
    App.make({
      plugins: [Plugin.make("bench/Bare", { plugins: [Transform.plugin] })],
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
