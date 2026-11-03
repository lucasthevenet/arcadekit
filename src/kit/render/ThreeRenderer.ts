import * as THREE from 'three'

import { type World, auraRadius } from '../sim/world'

const CAMERA_OFFSET = new THREE.Vector3(0, 20, 13)
const MAX_AURAS = 4
const WHITE = new THREE.Color('#ffffff')

/**
 * Draws a World with Three.js. Reads the simulation's arrays; never changes them.
 * Every crowd (enemies, projectiles, gems) is one InstancedMesh: one draw call each, however many there are.
 */
export class ThreeRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400)
  private readonly resizeObserver: ResizeObserver
  private readonly matrix = new THREE.Matrix4()
  private readonly color = new THREE.Color()

  private readonly player: THREE.Group
  private readonly playerBody: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>
  private readonly projectiles: THREE.InstancedMesh
  private readonly gems: THREE.InstancedMesh
  private readonly auras: Array<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>> = []
  private enemies: THREE.InstancedMesh | null = null
  private ground: THREE.Group | null = null
  /** Colors cached per World so they're parsed once, not every frame. */
  private palette: { world: World; enemies: THREE.Color[]; weapons: THREE.Color[] } | null = null

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color('#1b2130')
    this.scene.fog = new THREE.Fog('#1b2130', 30, 70)
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#3a3f2a', 1.6))
    const sun = new THREE.DirectionalLight('#ffffff', 1.4)
    sun.position.set(8, 20, 6)
    this.scene.add(sun)

    this.playerBody = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 0.5, 4, 12),
      new THREE.MeshStandardMaterial({ color: '#ffffff' }),
    )
    this.playerBody.position.y = 0.65
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.15, 0.35, 10),
      new THREE.MeshStandardMaterial({ color: '#ffffff' }),
    )
    nose.rotation.x = Math.PI / 2
    nose.position.set(0, 0.7, 0.5)
    this.player = new THREE.Group()
    this.player.add(this.playerBody, nose)
    this.player.visible = false
    this.scene.add(this.player)

    this.projectiles = makeInstanced(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial(), 512)
    this.gems = makeInstanced(
      new THREE.OctahedronGeometry(0.22),
      new THREE.MeshStandardMaterial({ color: '#5ef2ff', emissive: '#1a8fa0' }),
      1024,
    )
    this.scene.add(this.projectiles, this.gems)

    for (let i = 0; i < MAX_AURAS; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 64),
        new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.05
      ring.visible = false
      this.auras.push(ring)
      this.scene.add(ring)
    }

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  /** Draws one frame. With no world, shows an empty arena (the menu backdrop). */
  render(world: World | null, timeSeconds: number): void {
    if (world) this.drawWorld(world, timeSeconds)
    else {
      this.ensureGround(60)
      this.player.visible = false
      if (this.enemies) this.enemies.count = 0
      this.projectiles.count = 0
      this.gems.count = 0
      for (const ring of this.auras) ring.visible = false
      // Slow orbit as a menu backdrop.
      const a = timeSeconds * 0.05
      this.camera.position.set(Math.sin(a) * 18, 16, Math.cos(a) * 18)
      this.camera.lookAt(0, 0, 0)
    }
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.resizeObserver.disconnect()
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      }
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private drawWorld(world: World, t: number) {
    const palette = this.paletteFor(world)
    this.ensureGround(world.content.rules.arenaHalfSize)
    const p = world.player

    // Player
    this.player.visible = true
    this.player.position.set(p.x, 0, p.z)
    this.player.rotation.y = Math.atan2(p.faceX, p.faceZ)
    this.playerBody.material.color.set(p.hurtTimer > 0 ? '#ff4d4d' : world.hero.color)

    // Enemies
    const enemies = this.enemyMesh(world.enemies.x.length)
    const e = world.enemies
    for (let i = 0; i < e.count; i++) {
      const def = world.enemyDefs[e.type[i]!]!
      const bob = Math.abs(Math.sin(t * 6 + i)) * 0.15
      this.matrix.makeScale(def.radius, def.radius, def.radius)
      this.matrix.setPosition(e.x[i]!, def.radius + bob, e.z[i]!)
      enemies.setMatrixAt(i, this.matrix)
      const base = palette.enemies[e.type[i]!]!
      enemies.setColorAt(i, e.hitFlash[i]! > 0 ? WHITE : base)
    }
    enemies.count = e.count
    markDirty(enemies)

    // Projectiles
    const pr = world.projectiles
    for (let i = 0; i < pr.count; i++) {
      this.matrix.makeTranslation(pr.x[i]!, 0.7, pr.z[i]!)
      this.projectiles.setMatrixAt(i, this.matrix)
      this.projectiles.setColorAt(i, palette.weapons[pr.weapon[i]!] ?? WHITE)
    }
    this.projectiles.count = pr.count
    markDirty(this.projectiles)

    // XP gems, spinning
    const g = world.gems
    for (let i = 0; i < g.count; i++) {
      this.matrix.makeRotationY(t * 3 + i)
      this.matrix.setPosition(g.x[i]!, 0.35 + Math.sin(t * 4 + i) * 0.08, g.z[i]!)
      this.gems.setMatrixAt(i, this.matrix)
    }
    this.gems.count = g.count
    markDirty(this.gems)

    // Aura rings: flash bright on each damage pulse, then fade.
    let ringIndex = 0
    for (let w = 0; w < world.weapons.length && ringIndex < MAX_AURAS; w++) {
      const slot = world.weapons[w]!
      if (slot.def.behavior.kind !== 'aura') continue
      const ring = this.auras[ringIndex++]!
      const r = auraRadius(world, slot)
      ring.visible = true
      ring.position.set(p.x, 0.05, p.z)
      ring.scale.set(r, r, 1)
      ring.material.color.copy(palette.weapons[w] ?? WHITE)
      ring.material.opacity = 0.25 + Math.max(0, 0.6 - slot.sinceFired * 2)
    }
    for (let i = ringIndex; i < MAX_AURAS; i++) this.auras[i]!.visible = false

    // Camera follows the player.
    this.camera.position.set(p.x + CAMERA_OFFSET.x, CAMERA_OFFSET.y, p.z + CAMERA_OFFSET.z)
    this.camera.lookAt(p.x, 0, p.z)
  }

  private paletteFor(world: World) {
    if (this.palette?.world !== world) {
      this.palette = {
        world,
        enemies: world.enemyDefs.map(def => new THREE.Color(def.color)),
        // Indexed like world.weapons; weapons added later get their color on the next lookup.
        weapons: [],
      }
    }
    const weapons = this.palette.weapons
    for (let w = weapons.length; w < world.weapons.length; w++) weapons.push(new THREE.Color(world.weapons[w]!.def.color))
    return this.palette
  }

  private enemyMesh(capacity: number): THREE.InstancedMesh {
    if (!this.enemies || this.enemies.instanceMatrix.count !== capacity) {
      if (this.enemies) {
        this.scene.remove(this.enemies)
        this.enemies.geometry.dispose()
        ;(this.enemies.material as THREE.Material).dispose()
      }
      this.enemies = makeInstanced(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial(), capacity)
      this.scene.add(this.enemies)
    }
    return this.enemies
  }

  private ensureGround(halfSize: number) {
    if (this.ground?.userData['halfSize'] === halfSize) return
    if (this.ground) this.scene.remove(this.ground)
    const size = halfSize * 2
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: '#2f3d33' }),
    )
    plane.rotation.x = -Math.PI / 2
    const grid = new THREE.GridHelper(size, halfSize, '#3f5244', '#3f5244')
    grid.position.y = 0.01
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size, 1, size)),
      new THREE.LineBasicMaterial({ color: '#8aa0ff' }),
    )
    border.position.y = 0.5
    this.ground = new THREE.Group()
    this.ground.userData['halfSize'] = halfSize
    this.ground.add(plane, grid, border)
    this.scene.add(this.ground)
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }
}

const makeInstanced = (geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) => {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  // Allocate the per-instance color buffer up front.
  mesh.setColorAt(0, WHITE)
  mesh.count = 0
  // Instances move every frame, so the mesh's bounding sphere is meaningless: never cull.
  mesh.frustumCulled = false
  return mesh
}

const markDirty = (mesh: THREE.InstancedMesh) => {
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}
