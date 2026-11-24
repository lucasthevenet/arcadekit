import * as Color from "arcadekit/Color";
import { entityGeneration, entityIndex } from "arcadekit/ecs";
import type { Entity, EntityColumn } from "arcadekit/ecs";
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
} from "three";
import type { BufferGeometry, Material, Scene as ThreeScene } from "three";

import * as matrices from "./matrices";
import type { Holdings, Kept } from "./scene";
import { smoothOf } from "./smooth";
import type { Smooth } from "./smooth";
import { isFlat } from "./which";
import type { Angle, Columns, Rgb, Which, Xy, Xyz, Xyzw } from "./which";

/**
 * How finely a colour is converted; the table has one more entry than this.
 * Sixteen steps for each of a byte's 255, so every byte value falls exactly on
 * a step, and any float is within a thirty-second of a byte of one.
 */
const STEPS = 4080;

/**
 * The linear value of each sRGB channel value, which is what a renderer works
 * in: the standard's transfer curve, at each of the table's steps from 0 to 1.
 * Computing a power per channel per instance per frame would cost more than the
 * rest of the instance.
 */
const LINEAR = /* @__PURE__ */ (() => {
  const table = new Float32Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) {
    const c = i / STEPS;
    table[i] = c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/** A finite step off the table, at the end of the table it is past. */
const onTable = (step: number): number =>
  step < 0 ? 0 : step < STEPS + 1 ? step : STEPS;

/**
 * How an instance looks: its mesh's geometry and material.
 *
 * @category Models
 */
export interface Look {
  readonly geometry: BufferGeometry;
  readonly material: Material | Material[];
}

/**
 * The options of `Three.instances`, wherever its look comes from.
 *
 * @category Options
 */
export interface InstancesShared extends Which {
  /**
   * `Color.Rgb`, for each instance to have its entity's colour, which
   * multiplies the material's own. An entity without one is drawn in the
   * material's own colour, as if its colour were white.
   *
   *   Three.instances("game/Rocks", { of: Rock, transform: Transform3d, geometry, material, color: Color.Rgb })
   *
   * Each entity's colour is drawn by the space its `space` names:
   *
   * - `Color.Srgb` is a colour as a hex code writes it. The renderer works in
   *   linear colour, so a lookup table converts each number: a hex code's byte
   *   over 255 exactly, and any other number to the nearest sixteenth of a
   *   byte. A number below 0 is drawn as 0 and one over 1 as 1, as CSS
   *   clamps an sRGB colour. NaN or an infinity isn't a colour, and fails the
   *   frame with an error that names the entity.
   * - `Color.Linear` is the renderer's own numbers, passed through as they are.
   *   A number over 1 is brighter than white, which a renderer with bloom can
   *   show.
   *
   * With `smooth`, a colour is interpolated between two ticks like a position,
   * however far it changes, since `snap` doesn't apply to it. It is
   * interpolated in the game's numbers, then converted by the space it has at
   * the later tick.
   */
  readonly color?: typeof Color.Rgb;
  /**
   * How many instances the mesh has room for at first. Defaults to 256. The
   * room doubles when it runs out, which is the only time the system
   * allocates.
   */
  readonly capacity?: number;
  /**
   * Called with the mesh each time one is created, to make it cast shadows or
   * to put it on a layer, for example. The mesh isn't frustum culled, since its
   * instances can be anywhere. A game that knows where they are can turn
   * culling on here.
   */
  readonly prepare?: (mesh: InstancedMesh) => void;
}

/**
 * Options for instances whose look exists when the system is created.
 *
 * @category Options
 */
export interface InstancesOptions extends InstancesShared, Look {}

/**
 * The four loops of a kind: positioned, scaled, rotated or all three.
 *
 * @internal
 */
export type Loop = "placed" | "sized" | "turned" | "whole";

/**
 * One instanced mesh, and the loops that fill its buffer from columns.
 *
 * @internal
 */
export class Instances implements Kept {
  readonly mesh: InstancedMesh;
  private readonly scene: ThreeScene;
  /** The instances' matrices, sixteen numbers each: the mesh's own buffer. */
  private array: Float32Array;
  private capacity: number;
  private count = 0;
  /** The part of the buffer uploaded to the renderer, reused every frame. */
  private readonly range = { start: 0, count: 0 };
  /** What interpolates the entities between two ticks, when the system was asked to. */
  private readonly smooth: Smooth | undefined;
  /** The instances' colours, three numbers each, for a kind that has them. */
  private colors: Float32Array | undefined;
  private readonly colorRange = { start: 0, count: 0 };
  private readonly name: string;
  /**
   * The four loops of the kind's transform as the system passes them to its
   * queries: as is, or, for a kind with a colour, each followed by the colours
   * of its rows.
   */
  readonly loops: Record<Loop, Columns>;
  /**
   * For a kind with a colour, the four loops for the entities that have none:
   * each followed by white for its rows.
   */
  readonly plain: Record<Loop, Columns>;

  constructor(
    scene: ThreeScene,
    name: string,
    options: InstancesOptions,
    private readonly holdings: Holdings
  ) {
    holdings.hold(options.geometry);
    holdings.hold(options.material);
    this.scene = scene;
    this.name = name;
    this.smooth = smoothOf(options);
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 256));
    this.array = new Float32Array(this.capacity * 16);
    const own: Record<Loop, Columns> = isFlat(options)
      ? {
          placed: this.placedFlat,
          sized: this.sizedFlat,
          turned: this.turnedFlat,
          whole: this.wholeFlat,
        }
      : {
          placed: this.placed,
          sized: this.sized,
          turned: this.turned,
          whole: this.whole,
        };
    if (options.color === undefined) {
      this.loops = own;
      this.plain = own;
    } else {
      this.plain = {
        placed: this.whitened(own.placed),
        sized: this.whitened(own.sized),
        turned: this.whitened(own.turned),
        whole: this.whitened(own.whole),
      };
      this.colors = new Float32Array(this.capacity * 3);
      this.loops = {
        placed: this.painted1(own.placed),
        sized: this.painted2(own.sized),
        turned: this.painted2(own.turned),
        whole: this.painted3(own.whole),
      };
    }
    this.mesh = new InstancedMesh(options.geometry, options.material, 0);
    this.mesh.name = name;
    // Its instances are wherever the entities are, which a bounding sphere
    // worked out once would not follow.
    this.mesh.frustumCulled = false;
    this.attach();
    options.prepare?.(this.mesh);
    scene.add(this.mesh);
  }

  private attach(): void {
    const attribute = new InstancedBufferAttribute(this.array, 16);
    attribute.setUsage(DynamicDrawUsage);
    this.mesh.instanceMatrix = attribute;
    if (this.colors !== undefined) {
      const colors = new InstancedBufferAttribute(this.colors, 3);
      colors.setUsage(DynamicDrawUsage);
      this.mesh.instanceColor = colors;
    }
  }

  // A kind with a colour is handed one more component by its queries, after
  // the ones a loop reads: the loop runs as it is, and the colours of the
  // same rows are written beside the matrices it wrote.

  private painted1<A>(
    loop: (start: number, end: number, a: A, entities: EntityColumn) => void
  ) {
    return (
      start: number,
      end: number,
      a: A,
      color: Rgb,
      entities: EntityColumn
    ): void => {
      const from = this.count;
      loop(start, end, a, entities);
      this.paint(from, start, end, color, entities);
    };
  }

  private painted2<A, B>(
    loop: (
      start: number,
      end: number,
      a: A,
      b: B,
      entities: EntityColumn
    ) => void
  ) {
    return (
      start: number,
      end: number,
      a: A,
      b: B,
      color: Rgb,
      entities: EntityColumn
    ): void => {
      const from = this.count;
      loop(start, end, a, b, entities);
      this.paint(from, start, end, color, entities);
    };
  }

  private painted3<A, B, C>(
    loop: (
      start: number,
      end: number,
      a: A,
      b: B,
      c: C,
      entities: EntityColumn
    ) => void
  ) {
    return (
      start: number,
      end: number,
      a: A,
      b: B,
      c: C,
      color: Rgb,
      entities: EntityColumn
    ): void => {
      const from = this.count;
      loop(start, end, a, b, c, entities);
      this.paint(from, start, end, color, entities);
    };
  }

  /** A loop of a kind with a colour, for entities that have none: white. */
  private whitened(loop: Columns): Columns {
    return (...columns: unknown[]): void => {
      const from = this.count;
      loop(...columns);
      // Read after the loop, which may have made more room.
      this.colors!.fill(1, from * 3, this.count * 3);
    };
  }

  /** Writes the colours of these rows, for the instances from `from` on. */
  private paint(
    from: number,
    start: number,
    end: number,
    color: Rgb,
    entities: EntityColumn
  ): void {
    // Read after the loop, which may have made more room for both.
    const out = this.colors!;
    const { space } = color;
    let { r, g, b } = color;
    if (this.smooth !== undefined) {
      ({
        x: r,
        y: g,
        z: b,
      } = this.smooth.color.run(start, end, r, g, b, entities));
    }
    let at = from * 3;
    for (let i = start; i < end; i++) {
      if (space[i] === Color.Linear) {
        out[at] = r[i]!;
        out[at + 1] = g[i]!;
        out[at + 2] = b[i]!;
        at += 3;
        continue;
      }
      // A hex code's numbers, each looked up in the table at the nearest of
      // its steps. One off either end of it is clamped to that end, as CSS
      // clamps an sRGB colour. NaN and an infinity are no colour.
      let u = r[i]! * STEPS + 0.5;
      let v = g[i]! * STEPS + 0.5;
      let w = b[i]! * STEPS + 0.5;
      if (
        space[i] !== Color.Srgb ||
        !(
          u >= 0 &&
          u < STEPS + 1 &&
          v >= 0 &&
          v < STEPS + 1 &&
          w >= 0 &&
          w < STEPS + 1
        )
      ) {
        if (
          space[i] !== Color.Srgb ||
          !(Number.isFinite(u) && Number.isFinite(v) && Number.isFinite(w))
        ) {
          this.refuse(entities[i]!, r[i]!, g[i]!, b[i]!, space[i]!);
        }
        u = onTable(u);
        v = onTable(v);
        w = onTable(w);
      }
      out[at] = LINEAR[u | 0]!;
      out[at + 1] = LINEAR[v | 0]!;
      out[at + 2] = LINEAR[w | 0]!;
      at += 3;
    }
  }

  private refuse(
    entity: Entity,
    r: number,
    g: number,
    b: number,
    space: number
  ): never {
    const why =
      space === Color.Srgb
        ? "each number of a colour in Color.Srgb is finite. One below 0 is drawn as 0 and one over 1 as 1, but NaN and an infinity, such as a division by zero leaves, have no colour to be drawn as."
        : `its space is ${space}, and a colour's space is Color.Srgb (${Color.Srgb}) or Color.Linear (${Color.Linear}).`;
    throw new Error(
      `Three.instances("${this.name}") was given the colour (${r}, ${g}, ${b}) by the entity of slot ${entityIndex(entity)}, generation ${entityGeneration(entity)}, which is no colour: ${why}`
    );
  }

  /** Makes room for `rows` more instances, and returns where the first goes. */
  private reserve(rows: number): number {
    const at = this.count;
    const needed = at + rows;
    if (needed > this.capacity) {
      let { capacity } = this;
      while (capacity < needed) {
        capacity *= 2;
      }
      const array = new Float32Array(capacity * 16);
      array.set(this.array.subarray(0, at * 16));
      if (this.colors !== undefined) {
        const colors = new Float32Array(capacity * 3);
        colors.set(this.colors.subarray(0, at * 3));
        this.colors = colors;
      }
      // A buffer cannot grow where it is: the renderer lets go of the ones
      // it made for the old attributes, and makes new ones.
      this.mesh.dispose();
      this.array = array;
      this.capacity = capacity;
      this.attach();
    }
    this.count = needed;
    return at * 16;
  }

  begin(tick: number, alpha: number, frame: number): void {
    this.count = 0;
    this.smooth?.begin(tick, alpha, frame);
  }

  readonly placed = (
    start: number,
    end: number,
    position: Xyz,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
    }
    const at = this.reserve(end - start);
    matrices.placed(this.array, at, start, end, position);
  };

  readonly sized = (
    start: number,
    end: number,
    position: Xyz,
    scale: Xyz,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
      scale = smooth.scale.blend(start, end, scale, entities);
    }
    const at = this.reserve(end - start);
    matrices.sized(this.array, at, start, end, position, scale);
  };

  readonly turned = (
    start: number,
    end: number,
    position: Xyz,
    rotation: Xyzw,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
      rotation = smooth.rotation.blend(start, end, rotation, entities);
    }
    const at = this.reserve(end - start);
    matrices.turned(this.array, at, start, end, position, rotation);
  };

  readonly whole = (
    start: number,
    end: number,
    position: Xyz,
    rotation: Xyzw,
    scale: Xyz,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.position.blend(start, end, position, entities);
      rotation = smooth.rotation.blend(start, end, rotation, entities);
      scale = smooth.scale.blend(start, end, scale, entities);
    }
    const at = this.reserve(end - start);
    matrices.whole(this.array, at, start, end, position, rotation, scale);
  };

  readonly placedFlat = (
    start: number,
    end: number,
    position: Xy,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
    }
    const at = this.reserve(end - start);
    matrices.placedFlat(this.array, at, start, end, position);
  };

  readonly sizedFlat = (
    start: number,
    end: number,
    position: Xy,
    scale: Xy,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
      scale = smooth.flatScale.blend(start, end, scale, entities);
    }
    const at = this.reserve(end - start);
    matrices.sizedFlat(this.array, at, start, end, position, scale);
  };

  readonly turnedFlat = (
    start: number,
    end: number,
    position: Xy,
    rotation: Angle,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
      rotation = smooth.flatRotation.blend(start, end, rotation, entities);
    }
    const at = this.reserve(end - start);
    matrices.turnedFlat(this.array, at, start, end, position, rotation);
  };

  readonly wholeFlat = (
    start: number,
    end: number,
    position: Xy,
    rotation: Angle,
    scale: Xy,
    entities: EntityColumn
  ): void => {
    const { smooth } = this;
    if (smooth !== undefined) {
      position = smooth.flatPosition.blend(start, end, position, entities);
      rotation = smooth.flatRotation.blend(start, end, rotation, entities);
      scale = smooth.flatScale.blend(start, end, scale, entities);
    }
    const at = this.reserve(end - start);
    matrices.wholeFlat(this.array, at, start, end, position, rotation, scale);
  };

  /** Sets the mesh's instance count, and the range to upload to the renderer. */
  finish(): void {
    const { count, mesh, range } = this;
    mesh.count = count;
    if (count > 0) {
      const attribute = mesh.instanceMatrix;
      // Only what is drawn is sent. The one range is this object every
      // frame: the renderer empties the list once it has sent it.
      range.count = count * 16;
      attribute.updateRanges.length = 0;
      attribute.updateRanges.push(range);
      attribute.needsUpdate = true;
      const colors = mesh.instanceColor;
      if (colors !== null) {
        this.colorRange.count = count * 3;
        colors.updateRanges.length = 0;
        colors.updateRanges.push(this.colorRange);
        colors.needsUpdate = true;
      }
    }
  }

  /** How many instances the buffer currently has room for. */
  get room(): number {
    return this.capacity;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.holdings.letGo();
  }
}
