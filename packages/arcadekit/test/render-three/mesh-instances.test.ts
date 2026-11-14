import * as THREE from "three";
import { describe, expect, expectTypeOf, it } from "vitest";

import { MeshInstances } from "../../src/render-three/index";

// No WebGL here: the instances are a plain Three.js InstancedMesh, whose buffers a renderer
// uploads when their version has moved (`needsUpdate`).

const make = () =>
  MeshInstances.make(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), {
    capacity: 4,
    attributes: { aAura: 4, aColor: 3, aGlow: 1 },
  });

/** An attribute the instances' geometry holds under `name`. */
const attributeOf = (
  instances: { readonly mesh: THREE.InstancedMesh },
  name: string
) => instances.mesh.geometry.getAttribute(name) as THREE.BufferAttribute;

/** The values instance `index` has of an attribute. */
const valuesOf = (
  instances: { readonly mesh: THREE.InstancedMesh },
  name: string,
  index: number
) => {
  const attribute = attributeOf(instances, name);
  return [...attribute.array].slice(
    index * attribute.itemSize,
    (index + 1) * attribute.itemSize
  );
};

/** The names `MeshInstances.setAttribute` takes for these instances: what they declared. */
type NameOf<M> =
  M extends MeshInstances.MeshInstances<infer A> ? keyof A & string : never;

describe("mesh instances", () => {
  it("makes one buffer for each declared attribute, a value per instance, on the geometry", () => {
    const instances = make();
    expect(
      ["aAura", "aColor", "aGlow"].map((name) => {
        const attribute = attributeOf(instances, name);
        return [
          attribute instanceof THREE.InstancedBufferAttribute,
          attribute.itemSize,
          attribute.count,
        ];
      })
    ).toStrictEqual([
      [true, 4, 4],
      [true, 3, 4],
      [true, 1, 4],
    ]);
  });

  it("writes an instance's values of an attribute, as many floats as it declared", () => {
    const instances = make();
    MeshInstances.setAttribute(instances, 2, "aAura", 1, 2, 3, 4);
    MeshInstances.setAttribute(instances, 2, "aColor", 0.5, 0.25, 0.125);
    MeshInstances.setAttribute(instances, 2, "aGlow", 7);
    // A missing float is 0, and one too many is dropped: the next instance is untouched.
    MeshInstances.setAttribute(instances, 0, "aAura", 9);
    MeshInstances.setAttribute(instances, 0, "aGlow", 5, 6, 7, 8);
    expect({
      aura: valuesOf(instances, "aAura", 2),
      color: valuesOf(instances, "aColor", 2),
      glow: valuesOf(instances, "aGlow", 2),
      short: valuesOf(instances, "aAura", 0),
      long: [valuesOf(instances, "aGlow", 0), valuesOf(instances, "aGlow", 1)],
    }).toStrictEqual({
      aura: [1, 2, 3, 4],
      color: [0.5, 0.25, 0.125],
      glow: [7],
      short: [9, 0, 0, 0],
      long: [[5], [0]],
    });
  });

  it("gives an instance any matrix, and set stays the short form of one", () => {
    const instances = make();
    // Wide, flat and leaning: nothing a uniform scale and a turn around the vertical axis
    // make. Every number is one a 32-bit float holds exactly.
    const squash = new THREE.Matrix4().set(
      2,
      0.25,
      0,
      1,
      0,
      0.5,
      0,
      2,
      0,
      0,
      1,
      3,
      0,
      0,
      0,
      1
    );
    const written = [...squash.elements];
    MeshInstances.setMatrix(instances, 1, squash);
    MeshInstances.set(instances, 2, 4, 5, 6, 2);
    const read = new THREE.Matrix4();
    instances.mesh.getMatrixAt(1, read);
    expect(read.elements).toStrictEqual(written);
    // The matrix is copied: the view's own can be refilled for the next instance.
    squash.identity();
    instances.mesh.getMatrixAt(1, read);
    expect(read.elements).toStrictEqual(written);
    instances.mesh.getMatrixAt(2, read);
    expect(read.elements).toStrictEqual(
      new THREE.Matrix4().makeScale(2, 2, 2).setPosition(4, 5, 6).elements
    );
  });

  it("marks the matrices, the colors and each declared attribute for upload on commit, and shows count", () => {
    const instances = make();
    const { mesh } = instances;
    const buffers = () => [
      mesh.instanceMatrix.version,
      mesh.instanceColor?.version,
      attributeOf(instances, "aAura").version,
      attributeOf(instances, "aColor").version,
      attributeOf(instances, "aGlow").version,
    ];
    MeshInstances.setAttribute(instances, 0, "aGlow", 1);
    MeshInstances.setMatrix(instances, 0, new THREE.Matrix4());
    const before = buffers();
    MeshInstances.commit(instances, 3);
    expect({
      count: mesh.count,
      moved: buffers().map((version, i) => (version ?? 0) - (before[i] ?? 0)),
    }).toStrictEqual({ count: 3, moved: [1, 1, 1, 1, 1] });
    // Never more than it has room for.
    MeshInstances.commit(instances, 9);
    expect(mesh.count).toBe(4);
  });

  it("refuses a name that was not declared: a type error, and a throw", () => {
    const instances = make();
    expectTypeOf<NameOf<typeof instances>>().toEqualTypeOf<
      "aAura" | "aColor" | "aGlow"
    >();
    expect(() => {
      // @ts-expect-error "aHalo" is no attribute these instances declared.
      MeshInstances.setAttribute(instances, 0, "aHalo", 1);
    }).toThrow(
      'MeshInstances has no attribute "aHalo": declare it when the instances are made, as attributes: { aHalo: 1 }, with its number of floats (1 to 4)'
    );
  });

  it("declares none unless told, so every name is refused", () => {
    const instances = MeshInstances.make(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial(),
      { capacity: 2 }
    );
    expectTypeOf<NameOf<typeof instances>>().toBeNever();
    expect(() => {
      // @ts-expect-error No attribute was declared.
      MeshInstances.setAttribute(instances, 0, "aColor", 1);
    }).toThrow('MeshInstances has no attribute "aColor"');
    // The mesh, the matrices and the colors are as they were.
    MeshInstances.set(instances, 0, 1, 2, 3);
    MeshInstances.setColor(instances, 0, new THREE.Color("#ff0000"));
    MeshInstances.commit(instances, 1);
    expect([instances.capacity, instances.mesh.count]).toStrictEqual([2, 1]);
  });

  it("refuses an attribute that is not 1 to 4 floats: a type error, and a throw", () => {
    expect(() =>
      MeshInstances.make(
        new THREE.PlaneGeometry(),
        new THREE.MeshBasicMaterial(),
        {
          capacity: 2,
          // @ts-expect-error An attribute has 1 to 4 floats: a matrix is none of them.
          attributes: { aMatrix: 16 },
        }
      )
    ).toThrow(
      new RangeError(
        'MeshInstances.make: the attribute "aMatrix" has 16 floats per instance, and a shader reads 1 to 4 under one name (a float, a vec2, a vec3 or a vec4)'
      )
    );
  });

  it("refuses an attribute under a name the geometry already has", () => {
    const quad = new THREE.PlaneGeometry();
    const vertices = quad.getAttribute("position");
    expect(() =>
      MeshInstances.make(quad, new THREE.MeshBasicMaterial(), {
        capacity: 3,
        attributes: { aGlow: 1, position: 3 },
      })
    ).toThrow(
      new Error(
        'MeshInstances.make: the geometry already has an attribute "position", and declaring it would replace it: declare the view\'s own value under another name, or give each MeshInstances a geometry of its own'
      )
    );
    // The geometry is as it was given: its own vertices, and nothing of what was declared.
    expect({
      vertices: quad.getAttribute("position") === vertices,
      attributes: Object.keys(quad.attributes),
    }).toStrictEqual({
      vertices: true,
      attributes: ["position", "normal", "uv"],
    });
  });

  it("refuses a second instances over one geometry that declares the first's attribute", () => {
    const quad = new THREE.PlaneGeometry();
    const first = MeshInstances.make(quad, new THREE.MeshBasicMaterial(), {
      capacity: 2,
      attributes: { aGlow: 1 },
    });
    expect(() =>
      MeshInstances.make(quad, new THREE.MeshBasicMaterial(), {
        capacity: 5,
        attributes: { aGlow: 1 },
      })
    ).toThrow(
      'MeshInstances.make: the geometry already has an attribute "aGlow"'
    );
    // The first still writes the buffer the geometry draws from.
    MeshInstances.setAttribute(first, 1, "aGlow", 7);
    expect([...quad.getAttribute("aGlow").array]).toStrictEqual([0, 7]);
  });

  it("refuses an attribute under the names Three.js keeps an instance's matrix and color", () => {
    expect(() =>
      MeshInstances.make(
        new THREE.PlaneGeometry(),
        new THREE.MeshBasicMaterial(),
        { capacity: 2, attributes: { instanceColor: 3 } }
      )
    ).toThrow(
      new Error(
        "MeshInstances.make: the attribute \"instanceColor\" is where Three.js keeps each instance's color, which setColor writes: declare the view's own value under another name"
      )
    );
    expect(() =>
      MeshInstances.make(
        new THREE.PlaneGeometry(),
        new THREE.MeshBasicMaterial(),
        { capacity: 2, attributes: { instanceMatrix: 4 } }
      )
    ).toThrow(
      new Error(
        "MeshInstances.make: the attribute \"instanceMatrix\" is where Three.js keeps each instance's matrix, which set and setMatrix write: declare the view's own value under another name"
      )
    );
  });

  it("takes its attributes off the geometry on dispose, so new instances can be made over it", () => {
    const quad = new THREE.PlaneGeometry();
    const options = { capacity: 2, attributes: { aGlow: 1 } } as const;
    const first = MeshInstances.make(
      quad,
      new THREE.MeshBasicMaterial(),
      options
    );
    const glow = quad.getAttribute("aGlow");
    // A renderer frees an attribute's buffer when its geometry is freed with it still on.
    let held: unknown;
    quad.addEventListener("dispose", () => {
      held = quad.getAttribute("aGlow");
    });
    MeshInstances.dispose(first);
    expect({
      freedWithIt: held === glow,
      left: Object.keys(quad.attributes),
    }).toStrictEqual({ freedWithIt: true, left: ["position", "normal", "uv"] });

    const second = MeshInstances.make(
      quad,
      new THREE.MeshBasicMaterial(),
      options
    );
    MeshInstances.setAttribute(second, 0, "aGlow", 3);
    expect([...quad.getAttribute("aGlow").array]).toStrictEqual([3, 0]);
  });

  it("frees its geometry and material on dispose", () => {
    const instances = make();
    const scene = new THREE.Scene();
    scene.add(instances.mesh);
    const freed: string[] = [];
    instances.mesh.geometry.addEventListener("dispose", () =>
      freed.push("geometry")
    );
    (instances.mesh.material as THREE.Material).addEventListener(
      "dispose",
      () => freed.push("material")
    );
    MeshInstances.dispose(instances);
    expect({ freed, parent: instances.mesh.parent }).toStrictEqual({
      freed: ["geometry", "material"],
      parent: null,
    });
  });
});
