import * as Assets from "arcadekit/Assets";
import { entityIndex } from "arcadekit/ecs";
import type { Entity, EntityColumn } from "arcadekit/ecs";
import * as Query from "arcadekit/Query";
import * as System from "arcadekit/System";
import type { Object3D, Scene as ThreeScene } from "three";

import type { ObjectsOptions, ObjectsShared } from "../Objects.ts";
import { Scene } from "../Scene.ts";
import type { Entries, Needs } from "../Three.ts";
import { FromAssets } from "./assets.ts";
import type { Angle, Columns, Xy, Xyz, Xyzw } from "./columns.ts";
import { Holdings, heldIn } from "./holdings.ts";
import type { Kept } from "./holdings.ts";
import { isFlat, placedBy, required } from "./kind.ts";
import type { Placeable, Placing } from "./kind.ts";
import { smoothOf, stores } from "./smooth.ts";
import type { Smooth, Stores } from "./smooth.ts";

/** The options of `Gltf.objects`, as its system reads them. */
interface Bundled<
  B extends Entries,
  O extends Object3D,
> extends ObjectsShared<O> {
  readonly from: Assets.Bundle<B>;
  readonly make: (entity: Entity, assets: Assets.Loaded<B>) => O;
}

/** Either set of options, as the class that keeps the objects sees them. */
interface ObjectsOf<O extends Object3D> extends ObjectsShared<O>, Placing {
  // Handed the assets of its bundle, or none for a kind without one.
  readonly make: (entity: Entity, assets: never) => O;
}

/** One object per entity, by entity index, and the loops that position them. */
class Objects<O extends Object3D> implements Kept {
  private readonly scene: ThreeScene;
  private readonly options: ObjectsOf<O>;
  /** What the objects are built from, for a kind built from assets. */
  private readonly assets: unknown;
  private readonly objects: (O | undefined)[] = [];
  /** For each entity index, the entity its object was created for. */
  private readonly owner: (Entity | undefined)[] = [];
  /** For each entity index, the frame its entity was last found in, rotated, and scaled. */
  private seen = new Uint32Array(0);
  private turnedAt = new Uint32Array(0);
  private sizedAt = new Uint32Array(0);
  /** The entity indexes that have an object, unordered. */
  private readonly live: number[] = [];
  private stamp = 0;
  /** What interpolates the objects between two ticks, when the system was asked to. */
  private readonly smooth: Smooth | undefined;
  /** Whether the kind is placed by a flat game's transform. */
  private readonly flat: boolean;
  /** The three loops of the kind's transform, for a position, a rotation and a scale. */
  private readonly placedLoop: Columns;
  private readonly turnedLoop: Columns;
  private readonly sizedLoop: Columns;

  constructor(
    scene: ThreeScene,
    options: ObjectsOf<O>,
    assets: unknown,
    private readonly holdings: Holdings
  ) {
    this.scene = scene;
    this.options = options;
    this.assets = assets;
    this.smooth = smoothOf(options);
    this.flat = isFlat(options);
    this.placedLoop = this.flat ? this.placedFlat : this.placed;
    this.turnedLoop = this.flat ? this.turnedFlat : this.turned;
    this.sizedLoop = this.flat ? this.sizedFlat : this.sized;
  }

  /**
   * Places the objects of a run of rows, making the ones that are missing,
   * then turns and sizes them when their table has a rotation and a scale.
   */
  readonly draw = (
    start: number,
    end: number,
    position: unknown,
    rotation: unknown,
    scale: unknown,
    entities: EntityColumn
  ): void => {
    this.placedLoop(start, end, position, entities);
    if (rotation !== undefined) {
      this.turnedLoop(start, end, rotation, entities);
    }
    if (scale !== undefined) {
      this.sizedLoop(start, end, scale, entities);
    }
  };

  private grow(size: number): void {
    let length = Math.max(64, this.seen.length);
    while (length < size) {
      length *= 2;
    }
    for (const name of ["seen", "turnedAt", "sizedAt"] as const) {
      const bigger = new Uint32Array(length);
      bigger.set(this[name]);
      this[name] = bigger;
    }
  }

  private release(index: number): void {
    const object = this.objects[index]!;
    this.objects[index] = undefined;
    this.scene.remove(object);
    this.options.free?.(object, this.owner[index]!);
  }

  /** Creates the object of an entity that has none, or whose slot held another entity's. */
  private adopt(index: number, entity: Entity): O {
    if (this.objects[index] === undefined) {
      this.live.push(index);
    } else {
      this.release(index);
    }
    const object = this.options.make(entity, this.assets as never);
    this.holdings.holdAll(object);
    this.objects[index] = object;
    this.owner[index] = entity;
    this.turnedAt[index] = 0;
    this.sizedAt[index] = 0;
    this.scene.add(object);
    return object;
  }

  /** Starts a frame, with the app's store when the kind is drawn smoothly. */
  begin(stores: Stores | undefined): void {
    this.stamp++;
    if (stores !== undefined) {
      this.smooth?.begin(stores);
    }
  }

  readonly placed = (
    start: number,
    end: number,
    position: Xyz,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      position = this.smooth.position(start, end, position, entities);
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
    }
  };

  // A flat game's entities, for a kind of Transform2d. Only what its
  // components say is set: where an object is along the third axis, how it
  // is turned about the other two and how deep it is are as `make` left
  // them, or as the game sets them.

  readonly placedFlat = (
    start: number,
    end: number,
    position: Xy,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      position = this.smooth.flatPosition(start, end, position, entities);
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
    }
  };

  readonly turnedFlat = (
    start: number,
    end: number,
    rotation: Angle,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      rotation = this.smooth.flatRotation(start, end, rotation, entities);
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
      scale = this.smooth.flatScale(start, end, scale, entities);
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
      rotation = this.smooth.rotation(start, end, rotation, entities);
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
      scale = this.smooth.scale(start, end, scale, entities);
    }
    const { x, y, z } = scale;
    const { objects, sizedAt, stamp } = this;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      objects[index]!.scale.set(x[i]!, y[i]!, z[i]!);
      sizedAt[index] = stamp;
    }
  };

  /** Releases the objects whose entities weren't found this frame. */
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
        if (flat) {
          objects[index]!.rotation.z = 0;
        } else {
          objects[index]!.quaternion.identity();
        }
        turnedAt[index] = 0;
      }
      if (sizedAt[index] !== stamp && sizedAt[index] !== 0) {
        const size = objects[index]!.scale;
        if (flat) {
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
    this.holdings.letGo();
  }
}
/** Reads a kind's query each frame and places its objects. */
const placer = <O extends Object3D>(options: ObjectsShared<O> & Placing) => {
  const smooth = options.smooth === true;
  const { Position, Rotation, Scale } = options.transform;
  // One query for every entity of the kind, handed a rotation and a scale
  // for the tables that have them.
  const Placed = Query.all(
    Position,
    Query.maybe(Rotation),
    Query.maybe(Scale)
  ).pipe(
    Query.with(...required(options)),
    Query.without(...(options.without ?? []))
  );
  return function* (held: Objects<O>) {
    const placed = yield* Placed;
    // Every entity that is one of these is found here, and its object made
    // if it is missing; whatever was not found is let go at the end.
    held.begin(smooth ? yield* stores : undefined);
    placed.eachChunk(held.draw);
    held.finish();
  };
};

/**
 * The system of `Three.objects`.
 *
 * @internal
 */
export const objects = <O extends Object3D>(
  name: string,
  of: Placeable<ObjectsOptions<O>>
): System.System<never, Needs, string, "frame"> => {
  const options = { ...of, transform: placedBy(of.transform) };
  const place = placer(options);
  return System.frame(name, function* () {
    const kept = yield* Scene;
    let held = heldIn(kept).kept.get(name) as Objects<O> | undefined;
    if (held === undefined) {
      held = new Objects(
        kept.scene,
        options,
        undefined,
        new Holdings(heldIn(kept).owned)
      );
      heldIn(kept).kept.set(name, held);
    }
    yield* place(held);
  });
};

/**
 * The system of `Gltf.objects`.
 *
 * @internal
 */
export const bundledObjects = <B extends Entries, O extends Object3D>(
  name: string,
  of: Placeable<Bundled<B, O>>
): System.System<never, Needs | Assets.Store, string, "frame"> => {
  const options = { ...of, transform: placedBy(of.transform) };
  const place = placer(options);
  return System.frame(name, function* () {
    const kept = yield* Scene;
    let sourced = heldIn(kept).kept.get(name) as
      | FromAssets<Objects<O>>
      | undefined;
    if (sourced === undefined) {
      const { scene } = kept;
      const { owned } = heldIn(kept);
      sourced = new FromAssets(
        yield* Assets.Store,
        options.from,
        (assets) => new Objects(scene, options, assets, new Holdings(owned))
      );
      heldIn(kept).kept.set(name, sourced);
    }
    const held = sourced.now();
    // Its assets are not there: there is nothing to make an object of.
    if (held === undefined) {
      return;
    }
    yield* place(held);
  });
};
