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
});

const Velocity = Component.define("v2/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Stick = Component.define("v2/Stick", { x: Field.f32, y: Field.f32 });
const Steered = Query.all(Velocity, Stick).pipe(Query.writes(Velocity));

const Steer = System.tick("v2/Steer", function* () {
  (yield* Steered).each((velocity, stick) => {
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
      (yield* app.read(Query.all(Velocity))).each((velocity) => {
        speeds.push(Vec2.length(velocity.x, velocity.y));
      });
      // A diagonal is no faster than a straight line: f32 columns hold it.
      expect(speeds[0]).toBeCloseTo(1, 6);
      expect(speeds[1]).toBe(0.5);
    })
  );
});
