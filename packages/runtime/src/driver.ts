import { FixedStepClock } from '@gamekit/core'

import type { GameDefinition, GameView, InputSource } from './definition'

/** Longest frame gap counted, so a hidden tab or a debugger pause doesn't fast-forward the game. */
const MAX_FRAME_SECONDS = 0.25

/**
 * Runs a GameDefinition in the browser: a requestAnimationFrame loop that steps the
 * simulation at a fixed rate, renders, and forwards events to listeners.
 * Plain TypeScript; `makeGameEngine` wraps it in an Effect API.
 */
export class GameDriver<Config, State, Input, Event> {
  private state: State | null = null
  private paused = false
  private readonly clock: FixedStepClock
  private readonly listeners = new Set<(event: Event) => void>()
  private attached: { view: GameView<State>; input: InputSource<Input>; frame: number } | null = null
  private lastSample = 0

  constructor(private readonly definition: GameDefinition<Config, State, Input, Event>) {
    this.clock = new FixedStepClock(definition.stepSeconds ?? 1 / 60)
  }

  /** Starts rendering into `element` and reading input from it. Returns a function that stops and cleans up. */
  attach(element: HTMLElement): () => void {
    if (this.attached) throw new Error('GameDriver is already attached to an element')
    const view = this.definition.createView(element)
    const input = this.definition.createInput(element)
    let last = performance.now()

    const frame = (now: number) => {
      if (!this.attached) return
      this.attached.frame = requestAnimationFrame(frame)
      const dt = Math.min((now - last) / 1000, MAX_FRAME_SECONDS)
      last = now
      const state = this.state
      if (state !== null && !this.paused) {
        const steps = this.clock.advance(dt, stepSeconds => this.definition.step(state, input.read(), stepSeconds))
        if (steps > 0) input.endFrame?.()
        this.flushEvents(state)
        const sample = this.definition.sample
        if (sample && now - this.lastSample >= sample.everyMs) {
          this.lastSample = now
          this.emit(sample.read(state))
        }
      }
      view.render(state, now / 1000, this.clock.alpha)
    }

    this.attached = { view, input, frame: requestAnimationFrame(frame) }
    return () => {
      if (!this.attached) return
      cancelAnimationFrame(this.attached.frame)
      this.attached.input.dispose()
      this.attached.view.dispose()
      this.attached = null
    }
  }

  /** Starts a new run, replacing any current one. */
  start(config: Config, seed: number): void {
    const state = this.definition.create(config, seed)
    this.state = state
    this.paused = false
    this.clock.reset()
    this.flushEvents(state)
    if (this.definition.sample) this.emit(this.definition.sample.read(state))
  }

  /** Changes the current state from outside the loop (a menu choice, a cheat, a network message). */
  modify(change: (state: State) => void): void {
    if (this.state === null) return
    change(this.state)
    this.flushEvents(this.state)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  /** Ends the current run. The view keeps rendering with a null state. */
  stop(): void {
    this.state = null
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private flushEvents(state: State) {
    for (const event of this.definition.drainEvents(state)) this.emit(event)
  }

  private emit(event: Event) {
    for (const listener of this.listeners) listener(event)
  }
}
