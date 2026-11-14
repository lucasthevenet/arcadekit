# Timers and tweens

A timer is a number in the state, so it pauses, replays and hashes with the run, and nothing calls back. A step lowers it with `Timer.countDown`, which stops at 0; the timer is ready at 0, and armed by writing its length. A rate is a budget the step adds to: `Timer.takeWhole` gives the whole units in it, and the step subtracts what it took, so the fraction carries to the next step.

```ts
import { Timer } from "arcadekit/core";

interface Race {
  /** Seconds until a racer can be bumped again. Ready at 0. */
  bumpTimer: number;
  /** Coins the track owes, with the fraction carried from step to step. */
  coinBudget: number;
  coins: number;
}

const BUMP_SECONDS = 0.5;
const COINS_PER_SECOND = 2.5;

const step = (race: Race, bumped: boolean, dt: number) => {
  race.bumpTimer = Timer.countDown(race.bumpTimer, dt);
  if (bumped && race.bumpTimer === 0) {
    race.bumpTimer = BUMP_SECONDS;
  }
  race.coinBudget += COINS_PER_SECOND * dt;
  const due = Timer.takeWhole(race.coinBudget);
  race.coinBudget -= due;
  race.coins += due;
};
```

## Tweens

A tween is a number too: the time it started. A view computes where the thing is on each frame, from `Tween.progress` (0 at `startedAt`, 1 from `startedAt + duration` on) through an ease, so no object holds a tween and a view writes nothing. `Tween.progress` is 1 for a `startedAt` of `-Infinity`, which is how a thing at rest is written.

```ts
import { ExactMath, Tween } from "arcadekit/core";

interface Slide {
  readonly fromX: number;
  readonly toX: number;
  /** The frame time the slide started at, or -Infinity for a thing at rest. */
  readonly startedAt: number;
}

const SLIDE_SECONDS = 0.09;

/** Where a racer sliding into the next lane is drawn at `now`. */
const slideX = (slide: Slide, now: number): number =>
  ExactMath.lerp(
    slide.fromX,
    slide.toX,
    Tween.easeOut(Tween.progress(now, slide.startedAt, SLIDE_SECONDS))
  );
```

The eases are `Tween.easeIn` (`t * t`), `Tween.easeOut` (`t * (2 - t)`), `Tween.easeOutCubic` and `Tween.smoothstep`, which clamps its `t`. Each is a polynomial, so a step may call one as well.
