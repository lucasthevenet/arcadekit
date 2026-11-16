import { Effect, Exit } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  App,
  Component,
  Plugin,
  Query,
  Save,
  System,
  Time,
  Transform,
} from "../src/index";
import * as TransformEntry from "../src/Transform";

const { Position, Rotation, Scale } = Transform;

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const Rock = Component.tag("tf/Rock");

describe("Transform", () => {
  it("is three components of the game, of 32-bit floats, each known by its name", () => {
    expect(Position.name).toBe("arcadekit/Transform.Position");
    expect(Rotation.name).toBe("arcadekit/Transform.Rotation");
    expect(Scale.name).toBe("arcadekit/Transform.Scale");
    expect(Position.fields).toEqual(["x", "y", "z"]);
    expect(Rotation.fields).toEqual(["x", "y", "z", "w"]);
    expect(Scale.fields).toEqual(["x", "y", "z"]);
    for (const component of [Position, Rotation, Scale]) {
      expect(new Set(component.kinds)).toEqual(new Set(["f32"]));
      // In tables, so that a loop over columns reads them row for row.
      expect(component.storage).toBe("table");
    }
    // One module, whichever entry it is reached through.
    expect(TransformEntry.Position).toBe(Position);
    expect(TransformEntry.plugin).toBe(Transform.plugin);
  });

  it("is moved by a system with a loop over its columns, like any component", () => {
    const Drift = System.make("tf/Drift", function* () {
      const { delta } = yield* Time;
      (yield* Query.all(Position)).eachChunk((start, end, position) => {
        for (let i = start; i < end; i++) {
          position.x[i] = position.x[i]! + 2 * delta;
          position.z[i] = position.z[i]! - delta;
        }
      });
    });
    const app = run(
      App.make({ plugins: [Transform.plugin], systems: [Drift] })
    );
    const rock = app.world.spawn(Position.of({ x: 1, y: 2, z: 3 }));
    // Added with no value, it is at the origin.
    const flat = app.world.spawn(Position);
    app.tick(0.5);
    expect(app.world.get(rock, Position)).toEqual({ x: 2, y: 2, z: 2.5 });
    expect(app.world.get(flat, Position)).toEqual({ x: 1, y: 0, z: -0.5 });
  });

  it("axisAngle gives the unit quaternion of a turn about an axis", () => {
    // No turn at all.
    expect(Transform.axisAngle(0, 1, 0, 0)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    // A quarter turn about the vertical: half the angle, in sine and cosine.
    const quarter = Transform.axisAngle(0, 1, 0, Math.PI / 2);
    expect(quarter.x).toBe(0);
    expect(quarter.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(quarter.z).toBe(0);
    expect(quarter.w).toBeCloseTo(Math.SQRT1_2, 12);
    // A half turn about an axis that leans.
    const half = Transform.axisAngle(0.6, 0, 0.8, Math.PI);
    expect(half.x).toBeCloseTo(0.6, 12);
    expect(half.y).toBe(0);
    expect(half.z).toBeCloseTo(0.8, 12);
    expect(half.w).toBeCloseTo(0, 12);
    // The other way round is the same turn, backwards.
    const back = Transform.axisAngle(1, 0, 0, -1);
    expect(back.x).toBeCloseTo(-Math.sin(0.5), 12);
    expect(back.w).toBeCloseTo(Math.cos(0.5), 12);
    // Of length 1, whatever the angle, for an axis of length 1.
    for (const angle of [0.1, 1, 2.5, 4, -3]) {
      const { w, x, y, z } = Transform.axisAngle(0.6, 0.8, 0, angle);
      expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 12);
    }
    // It is what a Rotation is given.
    const world = run(App.make({ plugins: [Transform.plugin] })).world;
    const turned = world.spawn(Rotation.of(quarter));
    expect(world.get(turned, Rotation)!.w).toBe(Math.fround(quarter.w));
  });

  it("lists its components, so that a game saves and loads them with no renderer anywhere", () => {
    const Rules = Plugin.make("tf/Rules", {
      plugins: [Transform.plugin],
      components: [Rock],
    });
    expect(Transform.plugin.name).toBe("arcadekit/Transform");
    expect(Transform.plugin.components).toEqual([Position, Rotation, Scale]);
    const made = run(App.make({ plugins: [Rules] }));
    const rock = made.world.spawn(
      Rock,
      Position.of({ x: 1, y: 2, z: 3 }),
      Rotation.of(Transform.axisAngle(0, 0, 1, 1)),
      Scale.of({ x: 2, y: 3, z: 4 })
    );
    const save = made.save();
    if (Exit.isFailure(save)) {
      throw new Error("The game could not be saved");
    }
    const read = Save.decode(Save.encode(save.value));
    if (Exit.isFailure(read)) {
      throw new Error("The save could not be read back");
    }
    const loaded = run(App.load(read.value, { plugins: [Rules] }));
    expect(loaded.world.hash()).toBe(made.world.hash());
    expect(loaded.world.get(rock, Position)).toEqual({ x: 1, y: 2, z: 3 });
    expect(loaded.world.get(rock, Rotation)).toEqual(
      made.world.get(rock, Rotation)
    );
    expect(loaded.world.get(rock, Scale)).toEqual({ x: 2, y: 3, z: 4 });
    // A game that does not list them cannot read the save: they are named in it.
    const without = Effect.runSyncExit(
      Effect.scoped(
        App.load(read.value, {
          plugins: [Plugin.make("tf/Bare", { components: [Rock] })],
        })
      )
    );
    expect(Exit.isFailure(without)).toBe(true);
  });
});
