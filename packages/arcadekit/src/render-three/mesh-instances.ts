/**
 * Mesh instances: copies of one mesh drawn in a single draw call, each with a matrix, a color
 * and the attributes its view declares for a shader of its own.
 *
 * They belong to the view and hold only what it draws: a view sets them from the state it
 * reads, each frame, with plain calls made inside the frame the browser shows. The
 * declared attributes go on the geometry the instances are given, and come off it when they are
 * disposed.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";
import * as THREE from "three";

const TypeId = "~arcadekit/render-three/MeshInstances";

const DEFAULT_COLOR = new THREE.Color("#ffffff");

/**
 * Floats per instance, by the name the material's shader reads each under: `{ aAura: 4,
 * aColor: 3 }` is a `vec4 aAura` and a `vec3 aColor`.
 *
 * **When to use**
 *
 * As the `attributes` of instances drawn with a shader of the game's own, which reads more than
 * a matrix and a color.
 *
 * **Details**
 *
 * Each has 1 to 4 floats, as a shader reads a float, a vec2, a vec3 or a vec4 under one name.
 * Any other count is a type error.
 *
 * **Example** (A ring's place and colour)
 *
 * ```ts
 * import type { MeshInstances } from "arcadekit/render-three";
 *
 * const RING_ATTRIBUTES = {
 *   aRing: 3,
 *   aColor: 3,
 * } as const satisfies MeshInstances.Attributes;
 * Object.keys(RING_ATTRIBUTES); // => ["aRing", "aColor"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Attributes = Readonly<Record<string, 1 | 2 | 3 | 4>>;

/**
 * What mesh instances are made with: the most they draw at once, and the attributes of the
 * view's own.
 *
 * **When to use**
 *
 * To make mesh instances with `make`.
 *
 * **Details**
 *
 * `capacity` is fixed: unlike a batch of sprites, mesh instances don't grow. `attributes` are
 * written with `setAttribute` and uploaded by `commit`.
 *
 * **Example** (Room for 16 rings)
 *
 * ```ts
 * import type { MeshInstances } from "arcadekit/render-three";
 *
 * const options: MeshInstances.Options<{ readonly aRing: 3 }> = {
 *   capacity: 16,
 *   attributes: { aRing: 3 },
 * };
 * options.capacity; // => 16
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options<A extends Attributes> {
  /** The most instances it can draw at once. Fixed. */
  readonly capacity: number;
  /**
   * Values of the view's own for each instance, for a material whose shader reads them:
   * `{ aAura: 4, aColor: 3 }` is a `vec4 aAura` and a `vec3 aColor`. Written with
   * `setAttribute` and uploaded by `commit`.
   */
  readonly attributes?: A;
}

/**
 * Up to `capacity` copies of one mesh, drawn in one draw call: an `InstancedMesh` whose
 * instances a view places, tints and gives the attributes it declared.
 *
 * **When to use**
 *
 * For a 3D view that draws one mesh many times, such as a crowd or a floor of tiles, or a
 * shader of the game's own drawn once per thing, such as an aura ring around each hero.
 *
 * **Details**
 *
 * Add `mesh` to the scene. Each frame, `set` or `setMatrix` (and `setColor` and `setAttribute`)
 * the instances that changed, then `commit(count)` shows the first `count` and uploads the
 * changes. `attributes` are what was declared. The mesh is never culled: instances can be
 * anywhere.
 *
 * **Example** (Three crates in a row)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const crates = MeshInstances.make(
 *   new THREE.BoxGeometry(),
 *   new THREE.MeshBasicMaterial(),
 *   { capacity: 8 }
 * );
 * for (let i = 0; i < 3; i++) {
 *   MeshInstances.set(crates, i, i * 2, 0.5, 0);
 * }
 * MeshInstances.commit(crates, 3);
 * [crates.mesh.count, crates.capacity]; // => [3, 8]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface MeshInstances<A extends Attributes = Record<never, never>>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  readonly mesh: THREE.InstancedMesh;
  /** The most instances it can draw at once. */
  readonly capacity: number;
  /** The attributes it declared, each with its floats per instance. */
  readonly attributes: A;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<MeshInstances<Attributes>> & {
  /** Refilled by `set`, for each instance it places. */
  readonly matrix: THREE.Matrix4;
  /** The declared attributes, by name. Each is on the geometry under the same name. */
  readonly own: Map<string, THREE.InstancedBufferAttribute>;
  /** The same attributes in a list, for `commit` to walk. */
  readonly declared: THREE.InstancedBufferAttribute[];
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: MeshInstances<Attributes>) {
    return {
      _id: "MeshInstances",
      capacity: this.capacity,
      count: this.mesh.count,
      attributes: this.attributes,
    };
  },
};

const SCALE = new THREE.Vector3();

/**
 * The names Three.js reads an `InstancedMesh`'s own buffers under, each with what it holds
 * and how these instances write it. A geometry's attribute of the same name is read first.
 */
const TAKEN: ReadonlyMap<string, string> = new Map([
  ["instanceMatrix", "matrix, which set and setMatrix write"],
  ["instanceColor", "color, which setColor writes"],
]);

/**
 * Checks whether a value is mesh instances.
 *
 * **When to use**
 *
 * Narrow an unknown value before placing its instances.
 *
 * **Details**
 *
 * The `InstancedMesh` the instances draw with is none.
 *
 * **Example** (Recognising mesh instances)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const instances = MeshInstances.make(
 *   new THREE.PlaneGeometry(),
 *   new THREE.MeshBasicMaterial(),
 *   { capacity: 2 }
 * );
 * MeshInstances.isMeshInstances(instances); // => true
 * MeshInstances.isMeshInstances(instances.mesh); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isMeshInstances = (
  value: unknown
): value is MeshInstances<Attributes> => Predicate.hasProperty(value, TypeId);

/**
 * Makes up to `capacity` instances of a geometry and a material, with none shown, and puts the
 * declared attributes on the geometry.
 *
 * **When to use**
 *
 * When a view is made, once for each mesh it draws many times.
 *
 * **Details**
 *
 * It throws a `RangeError` for an attribute declared with anything but 1 to 4 floats, and an
 * `Error` for an attribute under a name the geometry already has (`position`, `uv`, or what
 * other instances over the same geometry declared, which need a geometry of their own), or
 * under `instanceMatrix` or `instanceColor`, where Three.js keeps each instance's matrix and
 * color. Every refusal comes before the first attribute is set, so a throw leaves the geometry
 * as it was given.
 *
 * **Example** (Instances with a shader's attributes)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const quad = new THREE.PlaneGeometry(2, 2);
 * const rings = MeshInstances.make(quad, new THREE.ShaderMaterial(), {
 *   capacity: 16,
 *   attributes: { aRing: 3, aColor: 3 },
 * });
 * quad.getAttribute("aRing").itemSize; // => 3
 * rings.attributes; // => { aRing: 3, aColor: 3 }
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <A extends Attributes = Record<never, never>>(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  options: Options<A>
): MeshInstances<A> => {
  const attributes: Attributes = options.attributes ?? {};
  const declared = Object.entries(attributes);
  // Every refusal before the first attribute is set, so a throw leaves the geometry as given.
  for (const [name, size] of declared) {
    if (size !== 1 && size !== 2 && size !== 3 && size !== 4) {
      throw new RangeError(
        `MeshInstances.make: the attribute "${name}" has ${String(size)} floats per instance, and a shader reads 1 to 4 under one name (a float, a vec2, a vec3 or a vec4)`
      );
    }
    const taken = TAKEN.get(name);
    if (taken !== undefined) {
      throw new Error(
        `MeshInstances.make: the attribute "${name}" is where Three.js keeps each instance's ${taken}: declare the view's own value under another name`
      );
    }
    // Setting it would replace what the geometry draws with, or what other instances write.
    if (geometry.hasAttribute(name)) {
      throw new Error(
        `MeshInstances.make: the geometry already has an attribute "${name}", and declaring it would replace it: declare the view's own value under another name, or give each MeshInstances a geometry of its own`
      );
    }
  }
  const self = Object.create(Proto) as Types.Mutable<Internal>;
  self.capacity = options.capacity;
  self.attributes = attributes;
  self.matrix = new THREE.Matrix4();
  self.own = new Map();
  self.declared = [];
  for (const [name, size] of declared) {
    const attribute = new THREE.InstancedBufferAttribute(
      new Float32Array(Math.max(1, self.capacity) * size),
      size
    );
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
    self.own.set(name, attribute);
    self.declared.push(attribute);
  }
  self.mesh = new THREE.InstancedMesh(geometry, material, self.capacity);
  self.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Allocates the per-instance color buffer.
  self.mesh.setColorAt(0, DEFAULT_COLOR);
  self.mesh.count = 0;
  // Instances can be anywhere, so the mesh's bounding sphere means nothing: never cull.
  self.mesh.frustumCulled = false;
  return self as unknown as MeshInstances<A>;
};

/**
 * Places instance `index` at (x, y, z) with a uniform `scale` and a turn of `rotationY` radians
 * around the vertical axis: the short form of `setMatrix`.
 *
 * **When to use**
 *
 * For what stands upright on the ground: crates, trees, a crowd. For a fixed tilt every
 * instance shares (a flat ring lying on the floor), rotate the geometry once instead.
 *
 * **Details**
 *
 * `scale` defaults to 1 and `rotationY` to 0. It allocates nothing.
 *
 * **Example** (A crate twice the size)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const crates = MeshInstances.make(
 *   new THREE.BoxGeometry(),
 *   new THREE.MeshBasicMaterial(),
 *   { capacity: 4 }
 * );
 * MeshInstances.set(crates, 0, 4, 5, 6, 2);
 * const placed = new THREE.Matrix4();
 * crates.mesh.getMatrixAt(0, placed);
 * new THREE.Vector3().setFromMatrixPosition(placed).toArray(); // => [4, 5, 6]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const set: {
  (
    index: number,
    x: number,
    y: number,
    z: number,
    scale?: number,
    rotationY?: number
  ): <A extends Attributes>(self: MeshInstances<A>) => void;
  <A extends Attributes>(
    self: MeshInstances<A>,
    index: number,
    x: number,
    y: number,
    z: number,
    scale?: number,
    rotationY?: number
  ): void;
} = dual(
  (args) => isMeshInstances(args[0]),
  (
    self: MeshInstances<Attributes>,
    index: number,
    x: number,
    y: number,
    z: number,
    scale = 1,
    rotationY = 0
  ): void => {
    const { matrix, mesh } = self as Internal;
    if (rotationY === 0) {
      matrix.makeScale(scale, scale, scale);
    } else {
      matrix.makeRotationY(rotationY);
      if (scale !== 1) {
        matrix.scale(SCALE.set(scale, scale, scale));
      }
    }
    matrix.setPosition(x, y, z);
    mesh.setMatrixAt(index, matrix);
  }
);

/**
 * Gives instance `index` any transform: a squash, a tilt of its own.
 *
 * **When to use**
 *
 * For what `set` can't say, with a material that reads the instance's matrix, as Three.js's
 * own do.
 *
 * **Details**
 *
 * The matrix is copied, so one the view keeps and refills for each instance allocates nothing.
 *
 * **Example** (A crate squashed flat)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const crates = MeshInstances.make(
 *   new THREE.BoxGeometry(),
 *   new THREE.MeshBasicMaterial(),
 *   { capacity: 4 }
 * );
 * // One matrix, refilled for each instance: the instances keep a copy.
 * const squash = new THREE.Matrix4().makeScale(2, 0.5, 1).setPosition(1, 0.25, 2);
 * MeshInstances.setMatrix(crates, 1, squash);
 * squash.identity();
 * const read = new THREE.Matrix4();
 * crates.mesh.getMatrixAt(1, read);
 * new THREE.Vector3().setFromMatrixScale(read).toArray(); // => [2, 0.5, 1]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setMatrix: {
  (
    index: number,
    matrix: THREE.Matrix4
  ): <A extends Attributes>(self: MeshInstances<A>) => void;
  <A extends Attributes>(
    self: MeshInstances<A>,
    index: number,
    matrix: THREE.Matrix4
  ): void;
} = dual(
  3,
  (
    self: MeshInstances<Attributes>,
    index: number,
    matrix: THREE.Matrix4
  ): void => {
    self.mesh.setMatrixAt(index, matrix);
  }
);

/**
 * Tints instance `index` with `color`.
 *
 * **When to use**
 *
 * For instances drawn in colours of the game's: a team's, a damage flash. White leaves the
 * material's own.
 *
 * **Example** (A red crate)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const crates = MeshInstances.make(
 *   new THREE.BoxGeometry(),
 *   new THREE.MeshBasicMaterial(),
 *   { capacity: 4 }
 * );
 * MeshInstances.setColor(crates, 2, new THREE.Color(1, 0, 0));
 * const color = new THREE.Color();
 * crates.mesh.getColorAt(2, color);
 * color.toArray(); // => [1, 0, 0]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setColor: {
  (
    index: number,
    color: THREE.Color
  ): <A extends Attributes>(self: MeshInstances<A>) => void;
  <A extends Attributes>(
    self: MeshInstances<A>,
    index: number,
    color: THREE.Color
  ): void;
} = dual(
  3,
  (
    self: MeshInstances<Attributes>,
    index: number,
    color: THREE.Color
  ): void => {
    self.mesh.setColorAt(index, color);
  }
);

/**
 * Writes instance `index`'s value of a declared attribute: as many of `x`, `y`, `z` and `w` as
 * the attribute has floats.
 *
 * **When to use**
 *
 * Each frame, for each instance whose shader values changed: a ring's place and radius.
 *
 * **Details**
 *
 * A missing float is 0, and one past the attribute's count is dropped. A name the instances
 * didn't declare is a type error, and it throws an `Error` for one a cast gets past the types.
 *
 * **Example** (A ring around a hero)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const quad = new THREE.PlaneGeometry(2, 2);
 * const rings = MeshInstances.make(quad, new THREE.ShaderMaterial(), {
 *   capacity: 4,
 *   attributes: { aRing: 3 },
 * });
 * MeshInstances.setAttribute(rings, 1, "aRing", 2, 3, 0.5);
 * [...quad.getAttribute("aRing").array.slice(3, 6)]; // => [2, 3, 0.5]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const setAttribute: {
  <Name extends string>(
    index: number,
    name: Name,
    x: number,
    y?: number,
    z?: number,
    w?: number
  ): (self: MeshInstances<Readonly<Record<Name, 1 | 2 | 3 | 4>>>) => void;
  <A extends Attributes>(
    self: MeshInstances<A>,
    index: number,
    name: NoInfer<keyof A & string>,
    x: number,
    y?: number,
    z?: number,
    w?: number
  ): void;
} = dual(
  (args) => isMeshInstances(args[0]),
  (
    self: MeshInstances<Attributes>,
    index: number,
    name: string,
    x: number,
    y = 0,
    z = 0,
    w = 0
  ): void => {
    const attribute = (self as Internal).own.get(name);
    if (attribute === undefined) {
      throw new Error(
        `MeshInstances has no attribute "${name}": declare it when the instances are made, as attributes: { ${name}: 1 }, with its number of floats (1 to 4)`
      );
    }
    const { array, itemSize } = attribute;
    const at = index * itemSize;
    array[at] = x;
    if (itemSize > 1) {
      array[at + 1] = y;
    }
    if (itemSize > 2) {
      array[at + 2] = z;
    }
    if (itemSize > 3) {
      array[at + 3] = w;
    }
  }
);

/**
 * Shows the first `count` instances and uploads this frame's changes.
 *
 * **When to use**
 *
 * Last in each frame that changed the instances, before the stage renders.
 *
 * **Details**
 *
 * It marks the matrices, the colours and every declared attribute for upload. A `count` past
 * `capacity` shows `capacity`.
 *
 * **Example** (Showing two of four)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const crates = MeshInstances.make(
 *   new THREE.BoxGeometry(),
 *   new THREE.MeshBasicMaterial(),
 *   { capacity: 4 }
 * );
 * MeshInstances.commit(crates, 2);
 * crates.mesh.count; // => 2
 * crates.pipe(MeshInstances.commit(9));
 * crates.mesh.count; // => 4
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const commit: {
  (count: number): <A extends Attributes>(self: MeshInstances<A>) => void;
  <A extends Attributes>(self: MeshInstances<A>, count: number): void;
} = dual(2, (self: MeshInstances<Attributes>, count: number): void => {
  const { declared, mesh } = self as Internal;
  mesh.count = Math.min(count, self.capacity);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
  for (const attribute of declared) {
    attribute.needsUpdate = true;
  }
});

/**
 * Removes the mesh from its parent and frees its geometry and material. The declared
 * attributes come off the geometry, which is as it was given: new instances can be made over
 * it.
 *
 * **When to use**
 *
 * In the view's `dispose`, for instances it made.
 *
 * **Example** (Instances made again over one geometry)
 *
 * ```ts
 * import { MeshInstances } from "arcadekit/render-three";
 * import * as THREE from "three";
 *
 * const quad = new THREE.PlaneGeometry();
 * const make = () =>
 *   MeshInstances.make(quad, new THREE.ShaderMaterial(), {
 *     capacity: 4,
 *     attributes: { aGlow: 1 },
 *   });
 * MeshInstances.dispose(make());
 * quad.hasAttribute("aGlow"); // => false
 * MeshInstances.isMeshInstances(make()); // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const dispose = <A extends Attributes>(self: MeshInstances<A>): void => {
  const { mesh, own } = self as unknown as Internal;
  mesh.removeFromParent();
  // Freed first, with the declared attributes still on it, so their buffers go too.
  mesh.geometry.dispose();
  for (const name of own.keys()) {
    mesh.geometry.deleteAttribute(name);
  }
  const materials: THREE.Material[] = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  for (const material of materials) {
    material.dispose();
  }
};
