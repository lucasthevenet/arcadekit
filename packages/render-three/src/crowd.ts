import * as THREE from 'three'

const DEFAULT_COLOR = new THREE.Color('#ffffff')

/**
 * Draws up to `capacity` copies of one mesh in a single draw call.
 * Each frame: call `set` (and optionally `setColor`) for indices 0..count-1, then `commit(count)`.
 */
export class InstancedCrowd {
  readonly mesh: THREE.InstancedMesh
  private readonly matrix = new THREE.Matrix4()

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, readonly capacity: number) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, DEFAULT_COLOR) // allocates the per-instance color buffer
    this.mesh.count = 0
    // Instances move every frame, so the mesh's bounding sphere is meaningless: never cull.
    this.mesh.frustumCulled = false
  }

  /** Places instance `index` at (x, y, z) with a uniform `scale` and a rotation around the vertical axis. */
  set(index: number, x: number, y: number, z: number, scale = 1, rotationY = 0): void {
    if (rotationY === 0) this.matrix.makeScale(scale, scale, scale)
    else {
      this.matrix.makeRotationY(rotationY)
      if (scale !== 1) this.matrix.scale(SCALE.set(scale, scale, scale))
    }
    this.matrix.setPosition(x, y, z)
    this.mesh.setMatrixAt(index, this.matrix)
  }

  setColor(index: number, color: THREE.Color): void {
    this.mesh.setColorAt(index, color)
  }

  /** Shows the first `count` instances and uploads this frame's changes. */
  commit(count: number): void {
    this.mesh.count = Math.min(count, this.capacity)
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    const materials: THREE.Material[] = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material]
    for (const material of materials) material.dispose()
  }
}

const SCALE = new THREE.Vector3()
