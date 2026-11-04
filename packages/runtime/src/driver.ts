import { animationFrames } from "./frames";
import type { FrameSource } from "./frames";
import { GameLoop } from "./loop";
import type { GameDefinition } from "./presentation";

/**
 * Runs a GameDefinition in the browser: the requestAnimationFrame adapter over `GameLoop`.
 * Each frame requests the next one, steps the loop by the real time since the last frame,
 * then draws. It's the plain-TypeScript frame loop for callers that don't use Effect;
 * `makeGameEngine` wraps it in an Effect API.
 *
 * `frames` is its frame clock (requestAnimationFrame by default); tests pass `manualFrames()`
 * from `@gamekit/runtime/testing`. To step without drawing, use a `GameLoop` instead.
 */
export class GameDriver<Config, State, Input, Event> {
  private readonly loop: GameLoop<Config, State, Input, Event>;
  private readonly definition: GameDefinition<Config, State, Input, Event>;
  private readonly frames: FrameSource;
  private detachCurrent: (() => void) | null = null;

  constructor(
    definition: GameDefinition<Config, State, Input, Event>,
    frames: FrameSource = animationFrames
  ) {
    this.definition = definition;
    this.frames = frames;
    this.loop = new GameLoop(definition);
  }

  /** Starts rendering into `element` and reading input from it. Returns a function that stops and cleans up. */
  attach(element: HTMLElement): () => void {
    if (this.detachCurrent) {
      throw new Error("GameDriver is already attached to an element");
    }
    const { frames, loop } = this;
    const view = this.definition.createView(element);
    const input = this.definition.createInput(element);
    let last = frames.now();
    let cancel: (() => void) | null = null;

    const frame = (now: number) => {
      if (this.detachCurrent !== detach) {
        return;
      }
      cancel = frames.request(frame);
      loop.frame(input, { seconds: (now - last) / 1000 }, now);
      last = now;
      view.render(loop.state, now / 1000);
    };

    const detach = () => {
      if (this.detachCurrent !== detach) {
        return;
      }
      cancel?.();
      input.dispose();
      view.dispose();
      this.detachCurrent = null;
    };
    this.detachCurrent = detach;
    cancel = frames.request(frame);
    return detach;
  }

  /** Starts a new run, replacing any current one. */
  start(config: Config, seed: number): void {
    this.loop.start(config, seed, this.frames.now());
  }

  /** Changes the current state from outside the loop (a menu choice, a cheat, a network message). */
  modify(change: (state: State) => void): void {
    this.loop.modify(change, this.frames.now());
  }

  setPaused(paused: boolean): void {
    this.loop.setPaused(paused);
  }

  /** Ends the current run. The view keeps rendering with a null state. */
  stop(): void {
    this.loop.stop();
  }

  subscribe(listener: (event: Event) => void): () => void {
    return this.loop.subscribe(listener);
  }
}
