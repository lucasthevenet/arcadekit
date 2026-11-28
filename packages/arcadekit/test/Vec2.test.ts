import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  System,
  Vec2,
} from "../src/index.ts";

describe("a vector", () => {
  it("has a length, and two points a distance", () => {
    expect(Vec2.length(3, 4)).toBe(5);
    expect(Vec2.length(0, 0)).toBe(0);
    expect(Vec2.distance(1, 1, 4, 5)).toBe(5);
  });

  it("is normalized into what it is given, and a zero vector stays zero", () => {
    const out = { x: 9, y: 9 };
    expect(Vec2.normalize(out, 3, 4)).toBe(out);
    expect(out).toEqual({ x: 0.6, y: 0.8 });
    expect(Vec2.normalize(out, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("is shortened to a length, and left as it is when shorter", () => {
    const out = { x: 0, y: 0 };
    expect(Vec2.clampLength(out, 3, 4, 1)).toEqual({ x: 0.6, y: 0.8 });
    expect(Vec2.clampLength(out, 0.3, 0.4, 1)).toEqual({ x: 0.3, y: 0.4 });
    expect(Vec2.clampLength(out, 0.6, 0.8, 1)).toEqual({ x: 0.6, y: 0.8 });
  });

  // Too short or too long for a double to hold the square of its length.
  const scales = [1e-300, 1e-200, 1e-160, 1e160, 1e200, 1e300];

  it("has a length, and two points a distance, when a double cannot hold its square", () => {
    const one = scales.map(() => expect.closeTo(1, 15));
    expect(scales.map((by) => Vec2.length(3 * by, 4 * by) / (5 * by))).toEqual(
      one
    );
    expect(
      scales.map((by) => Vec2.distance(by, by, 4 * by, 5 * by) / (5 * by))
    ).toEqual(one);
    expect(Vec2.length(Number.MAX_VALUE, 0)).toBe(Number.MAX_VALUE);
    expect(Vec2.length(0, -Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    // Longer than the largest double.
    expect(Vec2.length(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Infinity);
  });

  it("is normalized when a double cannot hold its square", () => {
    const out = { x: 0, y: 0 };
    expect(
      scales.map((by) => ({ ...Vec2.normalize(out, 3 * by, -4 * by) }))
    ).toEqual(
      scales.map(() => ({
        x: expect.closeTo(0.6, 15),
        y: expect.closeTo(-0.8, 15),
      }))
    );
    expect(Vec2.normalize(out, 1e-200, 0)).toEqual({ x: 1, y: 0 });
    const diagonal = {
      x: expect.closeTo(Math.SQRT1_2, 15),
      y: expect.closeTo(Math.SQRT1_2, 15),
    };
    expect({
      ...Vec2.normalize(out, Number.MIN_VALUE, Number.MIN_VALUE),
    }).toEqual(diagonal);
    expect({
      ...Vec2.normalize(out, Number.MAX_VALUE, Number.MAX_VALUE),
    }).toEqual(diagonal);
  });

  it("is shortened to a length when a double cannot hold its square", () => {
    const out = { x: 0, y: 0 };
    const shortened = [
      [1e200, 1],
      [1e200, 4e200],
      [1e-200, 1e-200],
      [1e-200, 4e-200],
    ] as const;
    // Each in the direction (0.6, 0.8), shortened to its max.
    expect(
      shortened.map(([by, max]) => {
        Vec2.clampLength(out, 3 * by, 4 * by, max);
        return { x: out.x / max, y: out.y / max };
      })
    ).toEqual(
      shortened.map(() => ({
        x: expect.closeTo(0.6, 15),
        y: expect.closeTo(0.8, 15),
      }))
    );
    expect(Vec2.clampLength(out, 3e200, 4e200, 6e200)).toEqual({
      x: 3e200,
      y: 4e200,
    });
    expect(Vec2.clampLength(out, 3e-200, 4e-200, 1)).toEqual({
      x: 3e-200,
      y: 4e-200,
    });
  });

  it("gives the bits of squaring it as it is, for a vector whose square a double holds", () => {
    // Vec2's formulas with no scaling. A replay a game recorded with them ends
    // on its hash only if Vec2 gives the same bits.
    const length = (x: number, y: number) => Math.sqrt(x * x + y * y);
    const normalize = (x: number, y: number) => {
      const size = length(x, y);
      return size === 0 ? { x: 0, y: 0 } : { x: x / size, y: y / size };
    };
    const clampLength = (x: number, y: number, max: number) => {
      const squared = x * x + y * y;
      if (squared <= max * max) {
        return { x, y };
      }
      const size = Math.sqrt(squared);
      return { x: (x / size) * max, y: (y / size) * max };
    };

    let seed = 1;
    const next = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const signed = (magnitude: number) =>
      next() < 0.5 ? -magnitude : magnitude;
    // What a game holds in an f32 column, and parts from 1e-150 to 1e150,
    // whose squares and their sum a double holds at full precision.
    const part = () =>
      next() < 0.05
        ? 0
        : next() < 0.5
          ? Math.fround(signed(next() * 1000))
          : signed((1 + 9 * next()) * 10 ** (Math.floor(next() * 300) - 150));
    const vectors: Array<readonly [number, number]> = [
      // At the ends of where a double holds the square.
      [Math.sqrt(Number.MAX_VALUE / 2), Math.sqrt(Number.MAX_VALUE / 2)],
      [Math.sqrt(2.2250738585072014e-308), 0],
    ];
    for (let i = 0; i < 100_000; i++) {
      vectors.push([part(), part()]);
    }

    const same = (a: Vec2.Vec2, b: Vec2.Vec2) =>
      Object.is(a.x, b.x) && Object.is(a.y, b.y);
    const changed = vectors.filter(([x, y]) => {
      // Shorter than the vector about half the time.
      const max = length(x, y) * (0.5 + next());
      return !(
        Object.is(Vec2.length(x, y), length(x, y)) &&
        Object.is(Vec2.distance(0, 0, x, y), length(x, y)) &&
        same(Vec2.normalize({ x: 0, y: 0 }, x, y), normalize(x, y)) &&
        same(
          Vec2.clampLength({ x: 0, y: 0 }, x, y, max),
          clampLength(x, y, max)
        )
      );
    });
    expect(changed).toEqual([]);
  });
});

const Velocity = Component.define("v2/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Stick = Component.define("v2/Stick", { x: Field.f32, y: Field.f32 });
const Steered = Query.all(Velocity, Stick).pipe(Query.writes(Velocity));

const Steer = System.tick("v2/Steer", function* () {
  (yield* Query.View(Steered)).each((velocity, stick) => {
    Vec2.clampLength(velocity, stick.x, stick.y, 1);
  });
});

describe("a row of a query", () => {
  it.effect("is written by a function that writes a vector", () =>
    Effect.gen(function* () {
      const app = yield* App.make(
        App.define({
          plugins: [
            Plugin.make("v2/Sticks", {
              setup: Effect.gen(function* () {
                const commands = yield* Commands.spawns(Velocity, Stick);
                commands.spawn(Velocity, Stick.of({ x: 1, y: 1 }));
                commands.spawn(Velocity, Stick.of({ x: 0.5, y: 0 }));
              }),
            }),
          ],
          systems: [Steer],
        })
      );
      yield* app.tick(1 / 60);
      const speeds: number[] = [];
      (yield* app.read(Query.View(Query.all(Velocity)))).each((velocity) => {
        speeds.push(Vec2.length(velocity.x, velocity.y));
      });
      // A diagonal is no faster than a straight line: f32 columns hold it.
      expect(speeds[0]).toBeCloseTo(1, 6);
      expect(speeds[1]).toBe(0.5);
    })
  );
});
