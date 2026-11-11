/**
 * Turns variable frame times into a whole number of fixed simulation steps.
 * A fixed step makes a game behave the same on 60 Hz and 144 Hz screens, and makes it deterministic.
 * Core exports it for `arcadekit/game`'s `Loop`, which steps every genre with it.
 */
export class FixedStepClock {
  readonly stepSeconds: number;
  /** Upper bound on catch-up steps per frame, so a slow frame can't snowball into slower frames. */
  readonly maxStepsPerFrame: number;
  private accumulator = 0;

  // Not default parameters: isolatedDeclarations needs their types written, and the linter
  // rejects a written type on a defaulted parameter.
  constructor(stepSeconds?: number, maxStepsPerFrame?: number) {
    this.stepSeconds = stepSeconds ?? 1 / 60;
    this.maxStepsPerFrame = maxStepsPerFrame ?? 5;
  }

  /** Adds `frameSeconds` of real time and calls `step` once per whole step owed. Returns the number of steps run. */
  advance(frameSeconds: number, step: (stepSeconds: number) => void): number {
    this.accumulator += frameSeconds;
    let steps = 0;
    while (
      this.accumulator >= this.stepSeconds &&
      steps < this.maxStepsPerFrame
    ) {
      step(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      steps += 1;
    }
    // Too far behind: drop the backlog instead of fast-forwarding.
    if (steps === this.maxStepsPerFrame) {
      this.accumulator = 0;
    }
    return steps;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
