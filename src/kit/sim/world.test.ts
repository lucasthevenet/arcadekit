import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { GameContent, findBrokenReferences } from '../content/schema'
import { type World, chooseUpgrade, createWorld, step } from './world'

const contentDir = new URL('../../../public/content/', import.meta.url)
const read = (file: string): unknown => JSON.parse(readFileSync(new URL(file, contentDir), 'utf8'))

const content = Schema.decodeUnknownSync(GameContent)({
  rules: read('rules.json'),
  heroes: read('heroes.json'),
  enemies: read('enemies.json'),
  weapons: read('weapons.json'),
  passives: read('passives.json'),
  waves: read('waves.json'),
})

const DT = 1 / 60

/** Plays `seconds` of a run: walks in a slow circle and always takes the first upgrade. */
const play = (world: World, seconds: number) => {
  for (let frame = 0; frame < seconds * 60 && world.status === 'running'; frame++) {
    if (world.offer) chooseUpgrade(world, 0)
    const angle = frame / 200
    step(world, { moveX: Math.cos(angle), moveZ: Math.sin(angle) }, DT)
  }
}

describe('content', () => {
  it('has no broken references', () => {
    expect(findBrokenReferences(content)).toEqual([])
  })
})

describe('simulation', () => {
  it('is deterministic for the same seed and inputs', () => {
    const a = createWorld(content, 'spark', 42)
    const b = createWorld(content, 'spark', 42)
    play(a, 60)
    play(b, 60)
    expect(a.kills).toBe(b.kills)
    expect(a.player.level).toBe(b.player.level)
    expect(a.player.hp).toBe(b.player.hp)
    expect(a.enemies.count).toBe(b.enemies.count)
  })

  it('spawns enemies, kills them and levels up', () => {
    const world = createWorld(content, 'ember', 7)
    play(world, 45)
    expect(world.enemies.count).toBeGreaterThan(0)
    expect(world.kills).toBeGreaterThan(0)
    expect(world.player.level).toBeGreaterThan(1)
  })

  it('freezes while an upgrade offer is open', () => {
    const world = createWorld(content, 'tide', 3)
    while (!world.offer && world.time < 120) step(world, { moveX: 0, moveZ: 0 }, DT)
    expect(world.offer).not.toBeNull()
    const time = world.time
    step(world, { moveX: 1, moveZ: 0 }, DT)
    expect(world.time).toBe(time)
    expect(chooseUpgrade(world, 0)).toBe(true)
    expect(world.offer).toBeNull()
  })

  it('ends the run when the player dies', () => {
    const world = createWorld(content, 'spark', 1)
    world.player.hp = 0.0001
    world.stats.regen = 0
    // Stand still until something touches the player.
    for (let i = 0; i < 60 * 120 && world.status === 'running'; i++) {
      if (world.offer) chooseUpgrade(world, 0)
      step(world, { moveX: 0, moveZ: 0 }, DT)
    }
    expect(world.status).toBe('dead')
  })
})
