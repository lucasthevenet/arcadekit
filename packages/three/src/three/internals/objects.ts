import * as Assets from "arcadekit/Assets";
import { entityIndex } from "arcadekit/ecs";
import type { ComponentDef, Entity, EntityColumn } from "arcadekit/ecs";
import * as Query from "arcadekit/Query";
import { Frame, Time } from "arcadekit/Services";
import * as System from "arcadekit/System";
import type { Object3D, Scene as ThreeScene } from "three";

import type {
  ObjectsFromOptions,
  ObjectsOptions,
  ObjectsShared,
} from "../Objects";
import { Scene } from "../Scene";
import { FromAssets } from "./assets";
import type { Entries } from "./assets";
import type { Angle, Columns, Xy, Xyz, Xyzw } from "./columns";
import { Holdings } from "./holdings";
import type { Kept } from "./holdings";
import { isFlat, required } from "./kind";
import type { Needs } from "./kind";
import { smoothOf } from "./smooth";
import type { Smooth } from "./smooth";

/** Either set of options, as the class that keeps the objects sees them. */
interface ObjectsOf<O extends Object3D> extends ObjectsShared<O> {
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
  /** The three loops of the kind's transform, as the system passes them to its queries. */
  readonly loops: Record<"placed" | "turned" | "sized", Columns>;

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
    this.loops = this.flat
      ? {
          placed: this.placedFlat,
          turned: this.turnedFlat,
          sized: this.sizedFlat,
        }
      : { placed: this.placed, turned: this.turned, sized: this.sized };
  }

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

  begin(tick: number, alpha: number, frame: number): void {
    this.stamp++;
    this.smooth?.begin(tick, alpha, frame);
  }

  readonly placed = (
    start: number,
    end: number,
    position: Xyz,
    entities: EntityColumn
  ): void => {
    if (this.smooth !== undefined) {
      position = this.smooth.position.blend(start, end, position, entities);
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
      position = this.smooth.flatPosition.blend(start, end, position, entities);
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
      rotation = this.smooth.flatRotation.blend(start, end, rotation, entities);
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
      scale = this.smooth.flatScale.blend(start, end, scale, entities);
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
      rotation = this.smooth.rotation.blend(start, end, rotation, entities);
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
      scale = this.smooth.scale.blend(start, end, scale, entities);
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
/**
 * The system of `Three.objects`, for either set of options.
 *
 * @internal
 */
export const objects = <O extends Object3D>(
  name: string,
  options: ObjectsOptions<O> | ObjectsFromOptions<Entries, O>
): System.System<never, Needs | Assets.Store, string, "frame"> => {
  const from = "from" in options ? options.from : undefined;
  const smooth = options.smooth === true;
  const marked = required(options);
  const excluded = options.without ?? [];
  const { Position, Rotation, Scale } = options.transform;
  const query = (term: ComponentDef, also: readonly ComponentDef[]) =>
    Query.all(term).pipe(
      Query.with(...also, ...marked),
      Query.without(...excluded)
    );
  const Placed = query(Position, []);
  const Turned = query(Rotation, [Position]);
  const Sized = query(Scale, [Position]);
  return System.frame(name, function* () {
    const kept = yield* Scene;
    const placed = yield* Placed;
    const turned = yield* Turned;
    const sized = yield* Sized;
    const tick = smooth ? (yield* Time).tick : 0;
    const frame = smooth ? yield* Frame : undefined;
    let held: Objects<O> | undefined;
    if (from === undefined) {
      held = kept._kept.get(name) as Objects<O> | undefined;
      if (held === undefined) {
        held = new Objects(
          kept.scene,
          options,
          undefined,
          new Holdings(kept._owned)
        );
        kept._kept.set(name, held);
      }
    } else {
      let sourced = kept._kept.get(name) as FromAssets<Objects<O>> | undefined;
      if (sourced === undefined) {
        const { _owned, scene } = kept;
        sourced = new FromAssets(
          yield* Assets.Store,
          from,
          (assets) => new Objects(scene, options, assets, new Holdings(_owned))
        );
        kept._kept.set(name, sourced);
      }
      held = sourced.now();
      // Its assets are not there: there is nothing to make an object of.
      if (held === undefined) {
        return;
      }
    }
    // Every entity that is one of these is found by the first loop, which
    // makes the objects that are missing; whatever it did not find is let
    // go at the end.
    held.begin(tick, frame?.alpha ?? 0, frame?.count ?? 0);
    const { loops } = held;
    placed.eachChunk(loops.placed);
    turned.eachChunk(loops.turned);
    sized.eachChunk(loops.sized);
    held.finish();
  });
};
