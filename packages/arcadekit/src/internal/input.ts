import { Context } from "effect";

import type { Gamepads, Keyboard, Pointer } from "../Input.ts";

/**
 * The ticks the frame stage has not drawn yet: those after `since`, up to
 * the game's tick. The loop moves it on after each frame, and a rewind moves
 * it back to the moment it rewinds to.
 *
 * @internal
 */
export class Undrawn {
  /** The tick the last frame was drawn after, or the one a rewind went back to. */
  since: number;
  /**
   * The last tick a frame was drawn after, which a rewind with `again` runs
   * again: what the frame stage was shown of it, it is not shown twice.
   */
  drawn: number;
  /** How many frames were drawn, which a frame's reader tells its frames apart by. */
  frames = 0;

  constructor(tick: number) {
    this.since = tick;
    this.drawn = tick;
  }

  /** After a frame drawn after `tick`. */
  framed(tick: number): void {
    this.since = tick;
    this.drawn = tick;
    this.frames++;
  }

  /**
   * After a save of `tick` was loaded in place of the game: what it holds
   * of before that tick is no frame's to show.
   */
  restarted(tick: number): void {
    this.since = tick;
    this.drawn = tick;
  }

  /**
   * After a rewind to a moment of `tick`. What is run from there is new to
   * the frame stage, unless `again`: then the ticks it runs again were drawn,
   * and only what they do differently is new.
   */
  rewound(tick: number, again: boolean): void {
    this.since = Math.min(this.since, tick);
    if (!again) {
      this.drawn = this.since;
    }
  }
}

/**
 * What `Input.plugin` gives the frame stage in place of what it gives the
 * tick: the same devices, with `pressed` and `released` meaning since the
 * last frame rather than in this tick.
 *
 * @internal
 */
export class Views extends Context.Service<
  Views,
  {
    readonly frame: (
      undrawn: Readonly<Undrawn>
    ) => Context.Context<Keyboard | Pointer | Gamepads>;
  }
>()("arcadekit/Input.Views") {}
