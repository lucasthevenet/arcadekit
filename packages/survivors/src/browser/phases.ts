// A pool moves its last entity into a removed one's slot, so a slot index isn't an entity. The
// view wants each enemy and gem a little out of step with the rest, and kept out of step as
// others die: this follows each entity across frames by where it is and what kind it is, and
// gives it a phase that sticks to it. View-only; the simulation has no ids for these.

/** Phases from the golden ratio: spread evenly, whatever how many. */
const GOLDEN = 0.61803398875;

/**
 * Per pool slot, a phase in [0, 1) that follows the entity in it from frame to frame. Call
 * `update` once a frame with the pool's count and fields, then read `phase(i)`. Nothing
 * allocates after construction.
 */
export class StablePhases {
  private phases: Float32Array;
  private next: Float32Array;
  private readonly lastX: Float32Array;
  private readonly lastZ: Float32Array;
  private readonly lastKind: Float32Array;
  private readonly claimed: Uint8Array;
  private readonly pending: Int32Array;
  private count = 0;
  private lastTime = 0;
  private made = 0;

  constructor(capacity: number) {
    this.phases = new Float32Array(capacity);
    this.next = new Float32Array(capacity);
    this.lastX = new Float32Array(capacity);
    this.lastZ = new Float32Array(capacity);
    this.lastKind = new Float32Array(capacity);
    this.claimed = new Uint8Array(capacity);
    this.pending = new Int32Array(capacity);
  }

  get capacity(): number {
    return this.phases.length;
  }

  /** Forgets every entity: a new run. */
  reset(): void {
    this.count = 0;
    this.made = 0;
  }

  /** The phase of the entity in slot `index` this frame. */
  phase(index: number): number {
    return this.phases[index]!;
  }

  /**
   * Matches this frame's `count` entities to last frame's. An entity still in its slot, of the
   * same kind and no further than it could have moved, keeps its phase; one moved into another
   * slot takes the phase of the nearest unmatched entity of its kind from last frame; a new one
   * gets a new phase. `maxSpeed` is how fast, in world units a second, anything can move.
   */
  update(
    count: number,
    x: ArrayLike<number>,
    z: ArrayLike<number>,
    kind: ArrayLike<number>,
    time: number,
    maxSpeed: number
  ): void {
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const reach = (0.25 + maxSpeed * dt) ** 2;
    const before = this.count;
    this.claimed.fill(0, 0, before);
    let pending = 0;
    for (let i = 0; i < count; i++) {
      if (
        i < before &&
        kind[i] === this.lastKind[i] &&
        (x[i]! - this.lastX[i]!) ** 2 + (z[i]! - this.lastZ[i]!) ** 2 <= reach
      ) {
        this.next[i] = this.phases[i]!;
        this.claimed[i] = 1;
      } else {
        this.pending[pending] = i;
        pending += 1;
      }
    }
    for (let p = 0; p < pending; p++) {
      const i = this.pending[p]!;
      let best = -1;
      let bestD = reach;
      for (let j = 0; j < before; j++) {
        if (this.claimed[j] === 0 && kind[i] === this.lastKind[j]) {
          const d =
            (x[i]! - this.lastX[j]!) ** 2 + (z[i]! - this.lastZ[j]!) ** 2;
          if (d <= bestD) {
            bestD = d;
            best = j;
          }
        }
      }
      if (best === -1) {
        this.next[i] = (this.made * GOLDEN) % 1;
        this.made += 1;
      } else {
        this.next[i] = this.phases[best]!;
        this.claimed[best] = 1;
      }
    }
    for (let i = 0; i < count; i++) {
      this.lastX[i] = x[i]!;
      this.lastZ[i] = z[i]!;
      this.lastKind[i] = kind[i]!;
    }
    const { phases } = this;
    this.phases = this.next;
    this.next = phases;
    this.count = count;
  }
}
