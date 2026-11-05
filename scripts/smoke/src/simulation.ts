// The smoke test's tiny game: dots that drift and wrap, and a player dot you move. DOM-free, as
// a genre's root entry is.
import {
  EventBuffer,
  FixedStepClock,
  SpatialGrid,
  clamp,
  createPool,
  makeRng,
} from "@arcadekit/core";
import type { Pool, Rng } from "@arcadekit/core";
import type { GameSimulation } from "@arcadekit/runtime";

export interface DotsConfig {
  readonly dots: number;
  readonly speed: number;
}

export interface DotsInput {
  readonly moveX: number;
  readonly moveY: number;
}

export type DotsEvent =
  | { readonly type: "hud"; readonly near: number }
  | { readonly type: "started"; readonly dots: number };

const DOT_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  vx: Float32Array,
  vz: Float32Array,
};

export interface Dots {
  readonly rng: Rng;
  readonly dots: Pool<typeof DOT_LAYOUT>;
  readonly grid: SpatialGrid;
  readonly found: Int32Array;
  readonly events: EventBuffer<DotsEvent>;
  readonly speed: number;
  playerX: number;
  playerZ: number;
  near: number;
}

const SIZE = 20;

export const dotsSimulation: GameSimulation<
  DotsConfig,
  Dots,
  DotsInput,
  DotsEvent
> = {
  create: (config, seed) => {
    const rng = makeRng(seed);
    const dots = createPool(config.dots, DOT_LAYOUT);
    for (let i = 0; i < config.dots; i++) {
      const index = dots.add();
      dots.fields.x[index] = rng.range(-SIZE / 2, SIZE / 2);
      dots.fields.z[index] = rng.range(-SIZE / 2, SIZE / 2);
      dots.fields.vx[index] = rng.range(-1, 1);
      dots.fields.vz[index] = rng.range(-1, 1);
    }
    const events = new EventBuffer<DotsEvent>();
    events.push({ type: "started", dots: dots.count });
    return {
      rng,
      dots,
      grid: new SpatialGrid({
        halfSize: SIZE / 2,
        cellSize: 2,
        capacity: config.dots,
      }),
      found: new Int32Array(config.dots),
      events,
      speed: config.speed,
      playerX: 0,
      playerZ: 0,
      near: 0,
    };
  },
  step: (state, input, dt) => {
    const { x, z, vx, vz } = state.dots.fields;
    for (let i = 0; i < state.dots.count; i++) {
      x[i] = wrap(x[i]! + vx[i]! * dt);
      z[i] = wrap(z[i]! + vz[i]! * dt);
    }
    state.playerX = clamp(
      state.playerX + input.moveX * state.speed * dt,
      -SIZE / 2,
      SIZE / 2
    );
    state.playerZ = clamp(
      state.playerZ + input.moveY * state.speed * dt,
      -SIZE / 2,
      SIZE / 2
    );
    state.grid.build(x, z, state.dots.count);
    state.near = state.grid.query(state.playerX, state.playerZ, 2, state.found);
  },
  drainEvents: (state) => state.events.drain(),
  sample: {
    everyMs: 250,
    read: (state) => ({ type: "hud", near: state.near }),
  },
};

const wrap = (value: number): number => {
  if (value > SIZE / 2) {
    return value - SIZE;
  }
  if (value < -SIZE / 2) {
    return value + SIZE;
  }
  return value;
};

/** Steps a run without a browser, as tests and replays do. */
export const replay = (seed: number, steps: number): number => {
  const clock = new FixedStepClock();
  const state = dotsSimulation.create({ dots: 64, speed: 4 }, seed);
  const input = { moveX: 1, moveY: 0 };
  for (let i = 0; i < steps; i++) {
    clock.advance(clock.stepSeconds, (dt) =>
      dotsSimulation.step(state, input, dt)
    );
  }
  return state.playerX;
};
