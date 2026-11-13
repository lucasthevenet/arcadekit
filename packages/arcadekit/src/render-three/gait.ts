// Whether a character is walking is a view's question: the rules hold a position and no
// animation. A view answers it from the positions it draws, with a little time after the last
// move, so a frame with no step, or the gap between two turns of a held key, doesn't flicker
// the character back to standing.

/**
 * Whether one character a view draws is walking, from the positions it is shown at.
 *
 * A view keeps one for each character and calls `update` once per frame it draws, then reads
 * `moving` to pick the walk or the idle tag and `since` to play it from its first frame.
 * Nothing allocates after it is made.
 *
 * ```ts
 * const gait = new Gait({ linger: 0.15 });
 * // Each frame, at the view's time in seconds:
 * gait.update(hero.x, hero.z, time);
 * const tag = gait.moving ? tags.walk : tags.idle;
 * const frame = frameAt(sheet.data, tag, time - gait.since);
 * ```
 *
 * It has no facing: which way a character looks is the game's to say.
 */
export class Gait {
  private readonly linger: number;
  /** False until the first `update` since it was made or reset. */
  private placed = false;
  private x = 0;
  private z = 0;
  private movedAt = Number.NEGATIVE_INFINITY;
  private movingNow = false;
  private sinceTime = 0;

  /** `linger`: seconds it still counts as moving after its position last changed. Defaults to 0.1. */
  constructor(options: { readonly linger?: number } = {}) {
    this.linger = options.linger ?? 0.1;
  }

  /** True from a change of position until `linger` seconds after the last one. */
  get moving(): boolean {
    return this.movingNow;
  }

  /** The time of the `update` that last changed `moving`, or of the first one. */
  get since(): number {
    return this.sinceTime;
  }

  /**
   * Where the character is at `time`, the view's seconds. Once per frame drawn.
   *
   * A walk whose `linger` ran out before this update ended then, though no update saw it end:
   * a change of position now starts a new one, and `since` is this update's time.
   */
  update(x: number, z: number, time: number): void {
    if (!this.placed) {
      this.placed = true;
      this.x = x;
      this.z = z;
      this.movingNow = false;
      this.sinceTime = time;
      return;
    }
    const lingering = time - this.movedAt < this.linger;
    let moving = lingering;
    if (x !== this.x || z !== this.z) {
      this.x = x;
      this.z = z;
      this.movedAt = time;
      moving = this.linger > 0;
    }
    if (moving !== this.movingNow || (moving && !lingering)) {
      this.movingNow = moving;
      this.sinceTime = time;
    }
  }

  /** Forgets the position: the next `update` is a first one, and no move. For a new run. */
  reset(): void {
    this.placed = false;
    this.movedAt = Number.NEGATIVE_INFINITY;
    this.movingNow = false;
  }
}
