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
 *
 * `bench/compare.ts` runs them for two checkouts, turn and turn about, to
 * say whether a change made any of them slower. A variant is run on its own
 * as
 *
 *   node --import tsx --conditions=source bench/instances.ts <name>
 *
 * which prints `{"ns":…,"bytes":…}`. A variant makes what it draws when it
 * runs, so that a checkout whose source lacks what one variant uses still
 * runs the others. Run whole, every variant runs in one process, after the
 * ones before it, and may measure apart from how it measures alone: the
 * smooth variants of a position measured 3% to 5% faster so, on a shared
 * 4-core VM.
 */
import { pathToFileURL } from "node:url";

import {
  App,
  Assets,
  Color,
  Commands,
  Component,
  Plugin,
  Query,
  Transform2d,
  Transform3d,
  World,
} from "arcadekit";
import { System } from "arcadekit";
import type { Frame, Time } from "arcadekit";
import type { ComponentDef, ComponentInput } from "arcadekit/ecs";
import { Effect, Layer } from "effect";
import { BoxGeometry, InstancedMesh, MeshBasicMaterial, Object3D } from "three";

import { Three } from "../src/index.ts";

const N = 10_000;
const { Position, Rotation, Scale } = Transform3d;
const Thing = Component.tag("bench/Thing", {
  requires: [Transform3d.Position],
});
const FlatThing = Component.tag("bench/FlatThing", {
  requires: [Transform2d.Position],
});
const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();

/** What a frame costs: nanoseconds per entity, and bytes. */
export interface Measured {
  readonly ns: number;
  readonly bytes: number;
}

export interface Variant {
  readonly label: string;
  readonly run: () => Measured;
}

const median = (values: number[]): number =>
  values.toSorted((a, b) => a - b)[values.length >> 1]!;

/** A plugin whose setup spawns the crowd, each entity of `parts`. */
const crowd = (parts: () => ComponentInput[]) => {
  const defs: ComponentDef[] = [];
  for (const part of parts()) {
    defs.push("def" in part ? part.def : part);
  }
  return Plugin.make("bench/Crowd", {
    setup: Effect.gen(function* () {
      const commands = yield* Commands.spawns(...defs);
      for (let i = 0; i < N; i++) {
        commands.spawn(...parts());
      }
    }),
  });
};

const measure = (frame: () => void): Measured => {
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

/**
 * `measure` for an app's frame stage: each frame yielded in one fiber, as a
 * driver yields it.
 */
const measureFrames = (frame: () => Effect.Effect<void>): Measured =>
  Effect.runSync(
    Effect.gen(function* () {
      for (let i = 0; i < 300; i++) {
        yield* frame();
      }
      const times: number[] = [];
      const grown: number[] = [];
      for (let i = 0; i < 301; i++) {
        const heap = process.memoryUsage().heapUsed;
        const started = performance.now();
        yield* frame();
        times.push(performance.now() - started);
        grown.push(process.memoryUsage().heapUsed - heap);
      }
      return { ns: (median(times) * 1e6) / N, bytes: median(grown) };
    })
  );

/** The frames of an app that draws the crowd of `parts` with `system`. */
const drawn =
  (
    parts: () => ComponentInput[],
    system: () => System.System<
      never,
      Frame | Three.Scene | Time | World | Assets.Store
    >,
    // What else the frame runs, for a variant that needs it.
    also?: () => System.System<never, Assets.Store>
  ) =>
  (): Measured => {
    const plugins = [Three.plugin, Assets.plugin, crowd(parts)] as const;
    const made =
      also === undefined
        ? App.make(App.define({ plugins, systems: [system()] }))
        : App.make(App.define({ plugins, systems: [also(), system()] }));
    const noRenderer = Layer.mergeAll(
      Three.layer({ render() {} }),
      Assets.layer(Assets.makeMemory({ "/bark.png": "" }))
    );
    const app = Effect.runSync(Effect.provide(made, noRenderer));
    return measureFrames(() => app.frame());
  };

const place = () =>
  Position.of({ x: Math.random(), y: Math.random(), z: Math.random() });
const turn = () => Rotation.of(Transform3d.axisAngle(0, 1, 0, Math.random()));
const size = () => Scale.of({ x: 2, y: 2, z: 2 });
const instanced =
  <const O extends Three.KindOptions["of"]>(
    name: string,
    of: O,
    transform: Three.TransformOf<O>,
    more: { readonly smooth?: boolean; readonly color?: typeof Color.Rgb } = {}
  ) =>
  () =>
    Three.instances(name, {
      of,
      transform,
      geometry,
      material,
      capacity: N,
      ...more,
    });

// A flat game's entities: fewer columns, and a sine and a cosine for a turn.
const placeFlat = () =>
  Transform2d.Position.of({ x: Math.random(), y: Math.random() });
const turnFlat = () => Transform2d.Rotation.of({ angle: Math.random() * 6 });
const sizeFlat = () => Transform2d.Scale.of({ x: 2, y: 2 });

// A colour of its own for each: three more numbers, beside the matrix.
const paint = () =>
  Color.Rgb.of({
    r: Math.random(),
    g: Math.random(),
    b: Math.random(),
    space: Color.Srgb,
  });
const glow = () =>
  Color.Rgb.of({
    r: Math.random(),
    g: Math.random(),
    b: Math.random(),
    space: Color.Linear,
  });

// A look that is made of a bundle's assets, and asked each frame whether
// they are still there: once by the system, and once before the scene is
// drawn.
const Level = Assets.bundle("bench/Level", {
  // An asset that needs no file, since none is fetched here.
  bark: Assets.make("/bark.png", () => Effect.succeed(material)),
});

// What the loops replace: an Object3D per entity, its matrix worked out by
// Three.js and copied into the mesh, as its documentation shows.
const byHand = (): Measured => {
  const { entities, world } = Effect.runSync(
    Effect.gen(function* () {
      const app = yield* App.make(
        App.define({
          plugins: [crowd(() => [Thing, place(), turn(), size()])],
        })
      );
      return {
        entities: (yield* app.read(
          Query.View(Query.all().pipe(Query.with(Thing)))
        )).entities(),
        world: yield* app.read(World),
      };
    })
  );
  const mesh = new InstancedMesh(geometry, material, N);
  const dummy = new Object3D();
  return measure(() => {
    for (let i = 0; i < N; i++) {
      const entity = entities[i]!;
      const position = world.get(entity, Position)!;
      const rotation = world.get(entity, Rotation)!;
      const scale = world.get(entity, Scale)!;
      dummy.position.set(position.x, position.y, position.z);
      dummy.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      dummy.scale.set(scale.x, scale.y, scale.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
};

export const variants: Record<string, Variant> = {
  position: {
    label: "instances: a position",
    run: drawn(() => [Thing, place()], instanced("a", Thing, Transform3d)),
  },
  positionScale: {
    label: "instances: a position and a scale",
    run: drawn(
      () => [Thing, place(), size()],
      instanced("b", Thing, Transform3d)
    ),
  },
  positionRotation: {
    label: "instances: a position and a rotation",
    run: drawn(
      () => [Thing, place(), turn()],
      instanced("c", Thing, Transform3d)
    ),
  },
  all: {
    label: "instances: all three",
    run: drawn(
      () => [Thing, place(), turn(), size()],
      instanced("d", Thing, Transform3d)
    ),
  },
  flat: {
    label: "instances, flat: a position",
    run: drawn(
      () => [FlatThing, placeFlat()],
      instanced("f", FlatThing, Transform2d)
    ),
  },
  flatScale: {
    label: "instances, flat: a position and a scale",
    run: drawn(
      () => [FlatThing, placeFlat(), sizeFlat()],
      instanced("g", FlatThing, Transform2d)
    ),
  },
  flatRotation: {
    label: "instances, flat: a position and a rotation",
    run: drawn(
      () => [FlatThing, placeFlat(), turnFlat()],
      instanced("h", FlatThing, Transform2d)
    ),
  },
  flatAll: {
    label: "instances, flat: all three",
    run: drawn(
      () => [FlatThing, placeFlat(), turnFlat(), sizeFlat()],
      instanced("i", FlatThing, Transform2d)
    ),
  },
  objects: {
    label: "objects: an Object3D each, all three copied",
    run: drawn(
      () => [Thing, place(), turn(), size()],
      () =>
        Three.objects("e", {
          of: Thing,
          transform: Transform3d,
          make: () => new Object3D(),
        })
    ),
  },
  objectsFlat: {
    label: "objects, flat: an Object3D each, all three copied",
    run: drawn(
      () => [FlatThing, placeFlat(), turnFlat(), sizeFlat()],
      () =>
        Three.objects("j", {
          of: FlatThing,
          transform: Transform2d,
          make: () => new Object3D(),
        })
    ),
  },
  // Drawn between two ticks: each value on its way from the one a tick ago,
  // kept per entity by the renderer. No tick runs between these frames; a
  // frame that follows one does the same work.
  smooth: {
    label: "instances, smooth: a position",
    run: drawn(
      () => [Thing, place()],
      instanced("k", Thing, Transform3d, { smooth: true })
    ),
  },
  smoothAll: {
    label: "instances, smooth: all three",
    run: drawn(
      () => [Thing, place(), turn(), size()],
      instanced("l", Thing, Transform3d, { smooth: true })
    ),
  },
  smoothFlat: {
    label: "instances, smooth, flat: a position",
    run: drawn(
      () => [FlatThing, placeFlat()],
      instanced("m", FlatThing, Transform2d, { smooth: true })
    ),
  },
  smoothFlatAll: {
    label: "instances, smooth, flat: all three",
    run: drawn(
      () => [FlatThing, placeFlat(), turnFlat(), sizeFlat()],
      instanced("n", FlatThing, Transform2d, { smooth: true })
    ),
  },
  color: {
    label: "instances, a colour each: a position",
    run: drawn(
      () => [Thing, place(), paint()],
      instanced("o", Thing, Transform3d, { color: Color.Rgb })
    ),
  },
  colorLinear: {
    label: "instances, a colour each, as the renderer has it: a position",
    run: drawn(
      () => [Thing, place(), glow()],
      instanced("o2", Thing, Transform3d, { color: Color.Rgb })
    ),
  },
  colorSmooth: {
    label: "instances, a colour each, smooth: a position",
    run: drawn(
      () => [Thing, place(), paint()],
      instanced("p", Thing, Transform3d, { color: Color.Rgb, smooth: true })
    ),
  },
  instancesFrom: {
    label: "Three.instancesFrom: a position",
    run: drawn(
      () => [Thing, place()],
      () =>
        Three.instancesFrom("q", {
          of: Thing,
          transform: Transform3d,
          from: Level,
          look: ({ bark }) => ({ geometry, material: bark }),
          capacity: N,
        }),
      () => Assets.during(Level)
    ),
  },
  byHand: {
    label: "by hand: world.get and setMatrixAt, per entity",
    run: byHand,
  },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const name = process.argv[2];
  if (name === undefined) {
    console.log(`${N} entities, one frame:`);
    for (const { label, run } of Object.values(variants)) {
      const { bytes, ns } = run();
      console.log(
        `${label.padEnd(58)} ${ns.toFixed(1).padStart(6)} ns/entity ${String(bytes).padStart(8)} bytes/frame`
      );
    }
  } else {
    const variant = variants[name];
    if (variant === undefined) {
      throw new Error(
        `bench/instances.ts is given the name of a variant, one of: ${Object.keys(variants).join(", ")}.`
      );
    }
    console.log(JSON.stringify(variant.run()));
  }
}
