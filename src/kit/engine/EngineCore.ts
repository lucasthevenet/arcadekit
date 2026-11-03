import type { GameContent } from '../content/schema'
import { InputController } from '../input/InputController'
import { ThreeRenderer } from '../render/ThreeRenderer'
import { type UpgradeChoice, type World, chooseUpgrade, createWorld, step } from '../sim/world'

/** Simulation rate. Fixed, so runs behave the same on 60 Hz and 144 Hz screens. */
const STEP_SECONDS = 1 / 60
const MAX_STEPS_PER_FRAME = 5
const HUD_INTERVAL_MS = 100

export interface HudSnapshot {
  readonly hp: number
  readonly maxHp: number
  readonly level: number
  readonly xp: number
  readonly xpNext: number
  readonly time: number
  readonly runLength: number
  readonly kills: number
  readonly enemies: number
}

export interface RunSummary {
  readonly won: boolean
  readonly heroName: string
  readonly time: number
  readonly kills: number
  readonly level: number
}

/** The few, coarse facts the engine reports to the UI. Never one per frame for each enemy. */
export type EngineEvent =
  | { readonly type: 'hud'; readonly hud: HudSnapshot }
  | { readonly type: 'levelUp'; readonly choices: ReadonlyArray<UpgradeChoice> }
  | { readonly type: 'runEnded'; readonly summary: RunSummary }

/**
 * Owns the frame loop: reads input, steps the simulation at a fixed rate, renders,
 * and reports events. Plain TypeScript; the Effect service in GameEngine.ts wraps it.
 */
export class EngineCore {
  private world: World | null = null
  private paused = false
  private reportedOffer: World['offer'] = null
  private reportedEnd = false
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private view: { renderer: ThreeRenderer; input: InputController; frame: number } | null = null

  /** Starts drawing into `element`. Returns a function that stops and cleans up. */
  attach(element: HTMLElement): () => void {
    if (this.view) throw new Error('EngineCore is already attached')
    const renderer = new ThreeRenderer(element)
    const input = new InputController(element)
    let last = performance.now()
    let accumulator = 0
    let lastHud = 0
    const frame = (now: number) => {
      if (!this.view) return
      this.view.frame = requestAnimationFrame(frame)
      // Clamp long gaps (tab was hidden, debugger paused) so the game doesn't fast-forward.
      const dt = Math.min((now - last) / 1000, 0.25)
      last = now
      const world = this.world
      if (world && !this.paused) {
        accumulator += dt
        let steps = 0
        while (accumulator >= STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
          step(world, input.read(), STEP_SECONDS)
          accumulator -= STEP_SECONDS
          steps++
        }
        if (steps === MAX_STEPS_PER_FRAME) accumulator = 0
        this.reportTransitions(world)
        if (now - lastHud >= HUD_INTERVAL_MS) {
          lastHud = now
          this.emit({ type: 'hud', hud: hudOf(world) })
        }
      }
      renderer.render(world, now / 1000)
    }
    this.view = { renderer, input, frame: requestAnimationFrame(frame) }
    return () => {
      if (!this.view) return
      cancelAnimationFrame(this.view.frame)
      this.view.input.dispose()
      this.view.renderer.dispose()
      this.view = null
    }
  }

  startRun(content: GameContent, heroId: string, seed = (Math.random() * 2 ** 32) >>> 0): void {
    this.world = createWorld(content, heroId, seed)
    this.paused = false
    this.reportedOffer = null
    this.reportedEnd = false
    this.emit({ type: 'hud', hud: hudOf(this.world) })
  }

  chooseUpgrade(index: number): void {
    if (this.world) chooseUpgrade(this.world, index)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  endRun(): void {
    this.world = null
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private reportTransitions(world: World) {
    if (world.offer && world.offer !== this.reportedOffer) {
      this.reportedOffer = world.offer
      this.emit({ type: 'levelUp', choices: world.offer })
    }
    if (world.status !== 'running' && !this.reportedEnd) {
      this.reportedEnd = true
      this.emit({ type: 'hud', hud: hudOf(world) })
      this.emit({
        type: 'runEnded',
        summary: {
          won: world.status === 'won',
          heroName: world.hero.name,
          time: world.time,
          kills: world.kills,
          level: world.player.level,
        },
      })
    }
  }

  private emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

const hudOf = (world: World): HudSnapshot => ({
  hp: world.player.hp,
  maxHp: world.player.maxHp,
  level: world.player.level,
  xp: world.player.xp,
  xpNext: world.player.xpNext,
  time: world.time,
  runLength: world.content.rules.runLength,
  kills: world.kills,
  enemies: world.enemies.count,
})
