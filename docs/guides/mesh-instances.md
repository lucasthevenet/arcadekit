# Mesh instances

`MeshInstances` draws up to `capacity` copies of one mesh in a single draw call. `MeshInstances.set(instances, index, x, y, z, scale?, rotationY?)` places one, `setMatrix` gives it any transform (a squash, a tilt of its own), `setColor` tints it, and `commit(instances, count)` shows the first `count` and uploads the changes.

A material with a shader of the game's own reads more than a matrix and a color. The view declares those values as `attributes`, floats per instance by the name the shader reads each under, and writes them with `MeshInstances.setAttribute`. A name it didn't declare is a type error.

The declared attributes go on the geometry the instances are given, and `MeshInstances.dispose` takes them off again. So a name the geometry already has is refused when the instances are made: `position` or `uv`, or what other instances over the same geometry declared, which need a geometry of their own. So are `instanceMatrix` and `instanceColor`, where Three.js keeps what `setMatrix` and `setColor` write.

```ts
import { MeshInstances } from "arcadekit/render-three";
import * as THREE from "three";

// The shader is the game's. For each ring it reads `aRing` (x, z and radius) and `aColor`.
const material = new THREE.ShaderMaterial({
  vertexShader: `
    attribute vec3 aRing;
    attribute vec3 aColor;
    varying vec3 vColor;
    void main() {
      vColor = aColor;
      vec2 p = aRing.xy + position.xz * aRing.z;
      gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.1, p.y, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      gl_FragColor = vec4(vColor, 1.0);
    }`,
});
// A quad lying on the ground.
const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

export const rings = MeshInstances.make(quad, material, {
  capacity: 16,
  attributes: { aRing: 3, aColor: 3 },
});

interface Hero {
  readonly x: number;
  readonly z: number;
  readonly reach: number;
  readonly color: THREE.Color;
}

/** Each frame: a ring around every hero. */
export const drawRings = (heroes: readonly Hero[]): void => {
  for (let i = 0; i < heroes.length; i++) {
    const hero = heroes[i]!;
    MeshInstances.setAttribute(rings, i, "aRing", hero.x, hero.z, hero.reach);
    MeshInstances.setAttribute(
      rings,
      i,
      "aColor",
      hero.color.r,
      hero.color.g,
      hero.color.b
    );
  }
  MeshInstances.commit(rings, heroes.length);
};

// A material that reads the instance's matrix, as Three.js's own do, takes any transform.
// One matrix, refilled for each instance: `setMatrix` copies it.
const lean = new THREE.Matrix4();
export const leanCrate = (
  crates: MeshInstances.MeshInstances,
  index: number,
  x: number,
  z: number,
  angle: number
): void => {
  lean.makeRotationZ(angle).setPosition(x, 0.5, z);
  MeshInstances.setMatrix(crates, index, lean);
};
```
