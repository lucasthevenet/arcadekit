import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { GameContent, type SurvivorsEvent, type World, chooseUpgrade, createWorld, findBrokenReferences, step } from './index'

// Small, self-contained content so these tests don't depend on any particular game.
const content = Schema.decodeUnknownSync(GameContent)({
  rules: {
    arenaHalfSize: 40,
    maxEnemies: 300,
    xpToLevel2: 3,
    xpGrowth: 1.3,
    baseMoveSpeedScale: 1,
    basePickupRadius: 2.5,
    choicesPerLevelUp: 3,
    runLength: 120,
  },
  heroes: [
    { id: 'bolter', name: 'Bolter', description: '', color: '#ffffff', maxHp: 100, moveSpeed: 6, startingWeapon: 'bolt' },
    { id: 'burner', name: 'Burner', description: '', color: '#ff0000', maxHp: 120, moveSpeed: 5, startingWeapon: 'aura' },
  ],
  enemies: [
    { id: 'grunt', name: 'Grunt', color: '#00ff00', hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 },
  ],
  weapons: [
    {
      id: 'bolt',
      name: 'Bolt',
      description: '',
      color: '#ffff00',
      damage: 10,
      damagePerLevel: 3,
      cooldown: 0.5,
      cooldownScalePerLevel: 0.9,
      maxLevel: 5,
      behavior: { kind: 'bolt', projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
    },
    {
      id: 'aura',
      name: 'Aura',
      description: '',
      color: '#ff8800',
      damage: 6,
      damagePerLevel: 2,
      cooldown: 0.5,
      cooldownScalePerLevel: 0.95,
      maxLevel: 5,
      behavior: { kind: 'aura', radius: 2.6, radiusPerLevel: 0.3 },
    },
  ],
  passives: [{ id: 'power', name: 'Power', description: '', stat: 'damage', amountPerLevel: 0.1, maxLevel: 3 }],
  waves: [{ from: 0, to: 120, enemy: 'grunt', perSecond: 3 }],
})

const DT = 1 / 60

/** Plays `seconds` of a run: walks in a slow circle and always takes the first upgrade. Returns all events. */
const play = (world: World, seconds: number): SurvivorsEvent[] => {
  const events: SurvivorsEvent[] = []
  for (let frame = 0; frame < seconds * 60 && world.status === 'running'; frame++) {
    if (world.offer) chooseUpgrade(world, 0)
    const angle = frame / 200
    step(world, { moveX: Math.cos(angle), moveZ: Math.sin(angle) }, DT)
    events.push(...world.events.drain())
  }
  return events
}

describe('content', () => {
  it('reports ids that point at nothing', () => {
    expect(findBrokenReferences(content)).toEqual([])
    const broken = { ...content, waves: [{ from: 0, to: 1, enemy: 'ghost', perSecond: 1 }] as const }
    expect(findBrokenReferences(broken)).toEqual(['wave 0-1s spawns unknown enemy "ghost"'])
  })
})

describe('simulation', () => {
  it('is deterministic for the same seed and inputs', () => {
    const a = createWorld({ content, heroId: 'bolter' }, 42)
    const b = createWorld({ content, heroId: 'bolter' }, 42)
    play(a, 60)
    play(b, 60)
    expect(a.kills).toBe(b.kills)
    expect(a.player.level).toBe(b.player.level)
    expect(a.player.hp).toBe(b.player.hp)
    expect(a.enemies.count).toBe(b.enemies.count)
  })

  it('spawns enemies, kills them, levels up, and reports each level-up', () => {
    const world = createWorld({ content, heroId: 'burner' }, 7)
    const events = play(world, 45)
    expect(world.enemies.count).toBeGreaterThan(0)
    expect(world.kills).toBeGreaterThan(0)
    expect(world.player.level).toBeGreaterThan(1)
    expect(events.filter(e => e.type === 'levelUp')).toHaveLength(world.player.level - 1)
  })

  it('freezes while an upgrade offer is open', () => {
    const world = createWorld({ content, heroId: 'bolter' }, 3)
    while (!world.offer && world.time < 60) step(world, { moveX: 0, moveZ: 0 }, DT)
    expect(world.offer).not.toBeNull()
    const time = world.time
    step(world, { moveX: 1, moveZ: 0 }, DT)
    expect(world.time).toBe(time)
    expect(chooseUpgrade(world, 0)).toBe(true)
    expect(world.offer).toBeNull()
  })

  it('reports runEnded once when the player dies', () => {
    const world = createWorld({ content, heroId: 'bolter' }, 1)
    world.player.hp = 0.0001
    const events: SurvivorsEvent[] = []
    for (let i = 0; i < 60 * 60 && world.status === 'running'; i++) {
      if (world.offer) chooseUpgrade(world, 0)
      step(world, { moveX: 0, moveZ: 0 }, DT)
      events.push(...world.events.drain())
    }
    expect(world.status).toBe('dead')
    const ended = events.filter(e => e.type === 'runEnded')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ summary: { won: false, heroName: 'Bolter' } })
  })

  it('reports a win when the timer runs out', () => {
    const world = createWorld({ content, heroId: 'burner' }, 5)
    world.time = content.rules.runLength - DT / 2
    step(world, { moveX: 0, moveZ: 0 }, DT)
    expect(world.status).toBe('won')
    expect(world.events.drain().some(e => e.type === 'runEnded' && e.summary.won)).toBe(true)
  })
})
