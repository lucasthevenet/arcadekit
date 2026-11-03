/**
 * Collects events a simulation produces during a step ("leveled up", "boss spawned")
 * until the runtime drains them. Keep events rare: they cross into the UI.
 */
export class EventBuffer<E> {
  private pending: E[] = [];

  push(event: E): void {
    this.pending.push(event);
  }

  /** Returns everything pushed since the last drain, oldest first, and empties the buffer. */
  drain(): ReadonlyArray<E> {
    if (this.pending.length === 0) return EMPTY;
    const drained = this.pending;
    this.pending = [];
    return drained;
  }
}

const EMPTY: ReadonlyArray<never> = [];
