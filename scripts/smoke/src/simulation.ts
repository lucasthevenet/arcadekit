// The smoke test's tiny game: dots that drift and wrap, and a player dot you move. DOM-free, as
// a genre's root entry is.
import { SpatialGrid, clamp, createPool, makeRng } from "arcadekit/core";
import type { Pool, Rng } from "arcadekit/core";
import * as Game from "arcadekit/game";
import { Schema } from "effect";

export interface DotsConfig {
  readonly dots: number;
  readonly speed: number;
}

/** One player's input for one step. */
export const DotsInput = Schema.Struct({
  moveX: Schema.Number,
  moveY: Schema.Number,
});
export type DotsInput = typeof DotsInput.Type;

/** What a run reports: that it started, and the HUD's sample. */
export class Started extends Game.Event("Started", { dots: Schema.Int }) {}
export class Hud extends Game.Event("Hud", { near: Schema.Int }) {}

const DOT_LAYOUT = {
  x: Float32Array,
  z: Float32Array,
  vx: Float32Array,
  vz: Float32Array,
};

export interface Field {
  readonly rng: Rng;
  readonly dots: Pool<typeof DOT_LAYOUT>;
  readonly grid: SpatialGrid;
  readonly found: Int32Array;
  readonly speed: number;
  playerX: number;
  playerZ: number;
  near: number;
}

const SIZE = 20;

const createField = (config: DotsConfig, seed: number): Field => {
  const rng = makeRng(seed);
  const dots = createPool(config.dots, DOT_LAYOUT);
  for (let i = 0; i < config.dots; i++) {
    const index = dots.add();
    dots.fields.x[index] = rng.range(-SIZE / 2, SIZE / 2);
    dots.fields.z[index] = rng.range(-SIZE / 2, SIZE / 2);
    dots.fields.vx[index] = rng.range(-1, 1);
    dots.fields.vz[index] = rng.range(-1, 1);
  }
  return {
    rng,
    dots,
    grid: new SpatialGrid({
      halfSize: SIZE / 2,
      cellSize: 2,
      capacity: config.dots,
    }),
    found: new Int32Array(config.dots),
    speed: config.speed,
    playerX: 0,
    playerZ: 0,
    near: 0,
  };
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

const stepField = (field: Field, input: DotsInput, dt: number): void => {
  const { x, z, vx, vz } = field.dots.fields;
  for (let i = 0; i < field.dots.count; i++) {
    x[i] = wrap(x[i]! + vx[i]! * dt);
    z[i] = wrap(z[i]! + vz[i]! * dt);
  }
  field.playerX = clamp(
    field.playerX + input.moveX * field.speed * dt,
    -SIZE / 2,
    SIZE / 2
  );
  field.playerZ = clamp(
    field.playerZ + input.moveY * field.speed * dt,
    -SIZE / 2,
    SIZE / 2
  );
  field.grid.build(x, z, field.dots.count);
  field.near = field.grid.query(field.playerX, field.playerZ, 2, field.found);
};

/** The game's rules for one player: what the engine runs in the browser. */
export class Dots extends Game.Simulation("Dots", {
  input: DotsInput,
  events: [Started],
  create: (config: DotsConfig, { seed, report }) => {
    const field = createField(config, seed);
    report(new Started({ dots: field.dots.count }));
    return field;
  },
  step: (field, input, { dt }) => {
    stepField(field, input, dt);
  },
  sample: {
    event: Hud,
    every: "250 millis",
    read: (field) => ({ near: field.near }),
  },
}) {}

const STILL: DotsInput = { moveX: 0, moveY: 0 };

/** The player dot is at the edge already. */
export class AtTheEdge extends Game.Rejection("AtTheEdge") {}

/** A player's decision: the player dot jumps `by` to the right. */
export class Nudge extends Game.Command(
  "Nudge",
  { by: Schema.Number },
  { rejects: [AtTheEdge] }
) {}

/**
 * The same rules for several players, which is what a lockstep run steps: its step input is
 * every player's `DotsInput`, by slot. The first player moves the dot, and any player may nudge
 * it with a command.
 */
export class DotsTogether extends Game.Simulation("DotsTogether", {
  input: Game.PlayerInputs(DotsInput),
  commands: [Nudge],
  create: (config: DotsConfig, { seed }) => createField(config, seed),
  step: (field, input, { dt }) => {
    stepField(field, input.players[0] ?? STILL, dt);
  },
  apply: {
    Nudge: (field, { by }) => {
      if (field.playerX >= SIZE / 2) {
        return new AtTheEdge();
      }
      field.playerX = clamp(field.playerX + by, -SIZE / 2, SIZE / 2);
    },
  },
}) {}

/** Steps a run without a browser, as tests and replays do: a script for the input, and `Game.Loop`. */
export const replay = (seed: number, steps: number): number => {
  const loop = new Game.Loop(Dots);
  loop.start({ dots: 64, speed: 4 }, seed, 0);
  const script: Game.StepInput<DotsInput> = {
    read: () => ({ moveX: 1, moveY: 0 }),
  };
  const budget: Game.FrameBudget = { steps };
  loop.frame(script, budget, 0);
  return loop.state?.playerX ?? 0;
};
