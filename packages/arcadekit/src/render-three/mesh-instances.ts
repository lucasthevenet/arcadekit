import * as THREE from "three";

const DEFAULT_COLOR = new THREE.Color("#ffffff");

/** Floats per instance, by the name the material's shader reads each under. */
export type InstanceAttributes = Readonly<Record<string, 1 | 2 | 3 | 4>>;

export interface MeshInstancesOptions<Attributes extends InstanceAttributes> {
  /** The most instances it can draw at once. Fixed. */
  readonly capacity: number;
  /**
   * Values of the view's own for each instance, for a material whose shader reads them:
   * `{ aAura: 4, aColor: 3 }` is a `vec4 aAura` and a `vec3 aColor`. Written with
   * `setAttribute` and uploaded by `commit`.
   */
  readonly attributes?: Attributes;
}

/**
 * Draws up to `capacity` copies of one mesh in a single draw call. Each instance gets a matrix,
 * a color and the attributes its view declares.
 * Call `set` or `setMatrix` (and optionally `setColor` and `setAttribute`) for the instances
 * that changed, then `commit(count)` to show the first `count` instances and upload the changes.
 *
 * ```ts
 * const rings = new MeshInstances(quad, material, {
 *   capacity: 16,
 *   attributes: { aAura: 4, aColor: 3 },
 * });
 * rings.setAttribute(0, "aAura", x, z, radius, pulse);
 * rings.setAttribute(0, "aColor", color.r, color.g, color.b);
 * rings.commit(1);
 * ```
 *
 * A name that `attributes` doesn't declare is a type error, and `setAttribute` throws on it.
 * Making the instances throws for an attribute declared with anything but 1 to 4 floats (a
 * `RangeError`), under a name the geometry already has (`position`, `uv`, or what other
 * instances over the same geometry declared), or under `instanceMatrix` or `instanceColor`,
 * where Three.js keeps each instance's matrix and color. `dispose` takes the declared
 * attributes off the geometry again.
 */
export class MeshInstances<
  Attributes extends InstanceAttributes = Record<never, never>,
> {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  private readonly matrix = new THREE.Matrix4();
  /** The declared attributes, by name. Each is on the geometry under the same name. */
  private readonly own = new Map<string, THREE.InstancedBufferAttribute>();
  /** The same attributes in a list, for `commit` to walk. */
  private readonly declared: THREE.InstancedBufferAttribute[] = [];

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    options: MeshInstancesOptions<Attributes>
  ) {
    this.capacity = options.capacity;
    const declared = Object.entries(options.attributes ?? {});
    // Every refusal before the first attribute is set, so a throw leaves the geometry as given.
    for (const [name, size] of declared) {
      if (size !== 1 && size !== 2 && size !== 3 && size !== 4) {
        throw new RangeError(
          `MeshInstances: the attribute "${name}" has ${String(size)} floats per instance, and a shader reads 1 to 4 under one name (a float, a vec2, a vec3 or a vec4)`
        );
      }
      const taken = TAKEN.get(name);
      if (taken !== undefined) {
        throw new Error(
          `MeshInstances: the attribute "${name}" is where Three.js keeps each instance's ${taken}: declare the view's own value under another name`
        );
      }
      // Setting it would replace what the geometry draws with, or what other instances write.
      if (geometry.hasAttribute(name)) {
        throw new Error(
          `MeshInstances: the geometry already has an attribute "${name}", and declaring it would replace it: declare the view's own value under another name, or give each MeshInstances a geometry of its own`
        );
      }
    }
    for (const [name, size] of declared) {
      const attribute = new THREE.InstancedBufferAttribute(
        new Float32Array(Math.max(1, this.capacity) * size),
        size
      );
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      this.own.set(name, attribute);
      this.declared.push(attribute);
    }
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocates the per-instance color buffer.
    this.mesh.setColorAt(0, DEFAULT_COLOR);
    this.mesh.count = 0;
    // Instances can be anywhere, so the mesh's bounding sphere means nothing: never cull.
    this.mesh.frustumCulled = false;
  }

  /**
   * Places instance `index` at (x, y, z) with a uniform `scale` and a rotation around the vertical axis:
   * the short form of `setMatrix`.
   * For a fixed tilt every instance shares (a flat ring lying on the floor), rotate the geometry once instead.
   */
  set(
    index: number,
    x: number,
    y: number,
    z: number,
    scale = 1,
    rotationY = 0
  ): void {
    if (rotationY === 0) {
      this.matrix.makeScale(scale, scale, scale);
    } else {
      this.matrix.makeRotationY(rotationY);
      if (scale !== 1) {
        this.matrix.scale(SCALE.set(scale, scale, scale));
      }
    }
    this.matrix.setPosition(x, y, z);
    this.mesh.setMatrixAt(index, this.matrix);
  }

  /**
   * Gives instance `index` any transform: a squash, a tilt of its own. The matrix is copied, so
   * one the view keeps and refills for each instance allocates nothing.
   */
  setMatrix(index: number, matrix: THREE.Matrix4): void {
    this.mesh.setMatrixAt(index, matrix);
  }

  setColor(index: number, color: THREE.Color): void {
    this.mesh.setColorAt(index, color);
  }

  /**
   * Writes instance `index`'s value of a declared attribute: as many of `x`, `y`, `z` and `w`
   * as the attribute has floats, a missing one as 0. Throws for a name that `attributes`
   * didn't declare.
   */
  setAttribute(
    index: number,
    name: keyof Attributes & string,
    x: number,
    y = 0,
    z = 0,
    w = 0
  ): void {
    const attribute = this.own.get(name);
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

  /** Shows the first `count` instances and uploads this frame's changes. */
  commit(count: number): void {
    this.mesh.count = Math.min(count, this.capacity);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
    for (const attribute of this.declared) {
      attribute.needsUpdate = true;
    }
  }

  /**
   * Removes the mesh and frees its geometry and material. The declared attributes come off the
   * geometry, which is as it was given: new instances can be made over it.
   */
  dispose(): void {
    this.mesh.removeFromParent();
    // Freed first, with the declared attributes still on it, so their buffers go too.
    this.mesh.geometry.dispose();
    for (const name of this.own.keys()) {
      this.mesh.geometry.deleteAttribute(name);
    }
    const materials: THREE.Material[] = Array.isArray(this.mesh.material)
      ? this.mesh.material
      : [this.mesh.material];
    for (const material of materials) {
      material.dispose();
    }
  }
}

const SCALE = new THREE.Vector3();

/**
 * The names Three.js reads an `InstancedMesh`'s own buffers under, each with what it holds
 * and how these instances write it. A geometry's attribute of the same name is read first.
 */
const TAKEN: ReadonlyMap<string, string> = new Map([
  ["instanceMatrix", "matrix, which set and setMatrix write"],
  ["instanceColor", "color, which setColor writes"],
]);
