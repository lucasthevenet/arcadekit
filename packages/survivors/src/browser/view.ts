import { InstancedCrowd, Stage, followTarget, orbitAround } from '@gamekit/render-three'
import type { GameView } from '@gamekit/runtime'
import * as THREE from 'three'

import { type World, auraRadius } from '../world'

const CAMERA_OFFSET = { x: 0, y: 20, z: 13 }
const MAX_AURAS = 4
const WHITE = new THREE.Color('#ffffff')

/** Draws a survivors World with Three.js. Reads the simulation; never changes it. */
export class SurvivorsView implements GameView<World> {
  private readonly stage: Stage
  private readonly player: THREE.Group
  private readonly playerBody: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>
  private readonly projectiles: InstancedCrowd
  private readonly gems: InstancedCrowd
  private readonly auras: Array<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>> = []
  private enemies: InstancedCrowd | null = null
  private ground: THREE.Group | null = null
  /** Colors cached per World so they're parsed once, not every frame. */
  private palette: { world: World; enemies: THREE.Color[]; weapons: THREE.Color[] } | null = null

  constructor(container: HTMLElement) {
    this.stage = new Stage(container, { background: '#1b2130', fog: { near: 30, far: 70 } })
    const { scene } = this.stage

    scene.add(new THREE.HemisphereLight('#dfe8ff', '#3a3f2a', 1.6))
    const sun = new THREE.DirectionalLight('#ffffff', 1.4)
    sun.position.set(8, 20, 6)
    scene.add(sun)

    this.playerBody = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 0.5, 4, 12),
      new THREE.MeshStandardMaterial({ color: '#ffffff' }),
    )
    this.playerBody.position.y = 0.65
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.35, 10), new THREE.MeshStandardMaterial())
    nose.rotation.x = Math.PI / 2
    nose.position.set(0, 0.7, 0.5)
    this.player = new THREE.Group()
    this.player.add(this.playerBody, nose)
    this.player.visible = false
    scene.add(this.player)

    this.projectiles = new InstancedCrowd(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial(), 512)
    this.gems = new InstancedCrowd(
      new THREE.OctahedronGeometry(0.22),
      new THREE.MeshStandardMaterial({ color: '#5ef2ff', emissive: '#1a8fa0' }),
      1024,
    )
    scene.add(this.projectiles.mesh, this.gems.mesh)

    for (let i = 0; i < MAX_AURAS; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 64),
        new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.visible = false
      this.auras.push(ring)
      scene.add(ring)
    }
  }

  render(world: World | null, timeSeconds: number): void {
    if (world) this.drawWorld(world, timeSeconds)
    else this.drawMenuBackdrop(timeSeconds)
    this.stage.render()
  }

  dispose(): void {
    // Stage.dispose frees everything in the scene, crowds included.
    this.stage.dispose()
  }

  private drawMenuBackdrop(t: number) {
    this.ensureGround(60)
    this.player.visible = false
    this.enemies?.commit(0)
    this.projectiles.commit(0)
    this.gems.commit(0)
    for (const ring of this.auras) ring.visible = false
    orbitAround(this.stage.camera, { x: 0, z: 0 }, { radius: 18, height: 16, angle: t * 0.05 })
  }

  private drawWorld(world: World, t: number) {
    const palette = this.paletteFor(world)
    this.ensureGround(world.content.rules.arenaHalfSize)
    const p = world.player

    this.player.visible = true
    this.player.position.set(p.x, 0, p.z)
    this.player.rotation.y = Math.atan2(p.faceX, p.faceZ)
    this.playerBody.material.color.set(p.hurtTimer > 0 ? '#ff4d4d' : world.hero.color)

    const enemies = this.enemyCrowd(world.enemies.capacity)
    const e = world.enemies.fields
    for (let i = 0; i < world.enemies.count; i++) {
      const def = world.enemyDefs[e.type[i]!]!
      const bob = Math.abs(Math.sin(t * 6 + i)) * 0.15
      enemies.set(i, e.x[i]!, def.radius + bob, e.z[i]!, def.radius)
      enemies.setColor(i, e.hitFlash[i]! > 0 ? WHITE : palette.enemies[e.type[i]!]!)
    }
    enemies.commit(world.enemies.count)

    const pr = world.projectiles.fields
    for (let i = 0; i < world.projectiles.count; i++) {
      this.projectiles.set(i, pr.x[i]!, 0.7, pr.z[i]!)
      this.projectiles.setColor(i, palette.weapons[pr.weapon[i]!] ?? WHITE)
    }
    this.projectiles.commit(world.projectiles.count)

    const g = world.gems.fields
    for (let i = 0; i < world.gems.count; i++) {
      this.gems.set(i, g.x[i]!, 0.35 + Math.sin(t * 4 + i) * 0.08, g.z[i]!, 1, t * 3 + i)
    }
    this.gems.commit(world.gems.count)

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

    followTarget(this.stage.camera, p, CAMERA_OFFSET)
  }

  private paletteFor(world: World) {
    if (this.palette?.world !== world) {
      this.palette = { world, enemies: world.enemyDefs.map(def => new THREE.Color(def.color)), weapons: [] }
    }
    // Indexed like world.weapons; weapons picked up mid-run get their color here.
    const weapons = this.palette.weapons
    for (let w = weapons.length; w < world.weapons.length; w++) weapons.push(new THREE.Color(world.weapons[w]!.def.color))
    return this.palette
  }

  private enemyCrowd(capacity: number): InstancedCrowd {
    if (this.enemies?.capacity !== capacity) {
      this.enemies?.dispose()
      this.enemies = new InstancedCrowd(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial(), capacity)
      this.stage.scene.add(this.enemies.mesh)
    }
    return this.enemies
  }

  private ensureGround(halfSize: number) {
    if (this.ground?.userData['halfSize'] === halfSize) return
    this.ground?.removeFromParent()
    const size = halfSize * 2
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: '#2f3d33' }))
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
    this.stage.scene.add(this.ground)
  }
}
