import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import type { Spawned } from "../src/index";
import {
  App,
  Commands,
  Component,
  Plugin,
  Query,
  Save,
  System,
  Time,
  Transform3d,
  World,
} from "../src/index";
import * as Entry from "../src/Transform3d";
import { placedIn } from "./placed";

const { Position, Rotation, Scale } = Transform3d;

const Rock = Component.tag("tf/Rock");

describe("Transform3d", () => {
  it("is three components of the game, of 32-bit floats, each known by its name", () => {
    expect(Position.name).toBe("arcadekit/Transform3d.Position");
    expect(Rotation.name).toBe("arcadekit/Transform3d.Rotation");
    expect(Scale.name).toBe("arcadekit/Transform3d.Scale");
    expect(Position.fields).toEqual(["x", "y", "z"]);
    expect(Rotation.fields).toEqual(["x", "y", "z", "w"]);
    expect(Scale.fields).toEqual(["x", "y", "z"]);
    for (const component of [Position, Rotation, Scale]) {
      expect(new Set(component.kinds)).toEqual(new Set(["f32"]));
      // In tables, so that a loop over columns reads them row for row.
      expect(component.storage).toBe("table");
    }
    // Added bare, it is where it was made, turned by nothing, and of its
    // own size: a Scale of zeros would be drawn as nothing.
    const Bare = Plugin.make("tf/Bare", {
      setup: Effect.gen(function* () {
        (yield* Commands.spawns(Position, Rotation, Scale)).spawn(
          Position,
          Rotation,
          Scale
        );
      }),
    });
    const bare = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Bare] }));
        const world = yield* app.read(World);
        return (yield* app.read(Query.all(Position, Scale)))
          .entities()
          .map((entity) => ({
            scale: world.get(entity, Scale),
            position: new Set(Object.values(world.get(entity, Position) ?? {})),
          }));
      })
    );
    expect(bare).toEqual([
      { scale: { x: 1, y: 1, z: 1 }, position: new Set([0]) },
    ]);
    // One module, whichever entry it is reached through.
    expect(Entry.Position).toBe(Position);
  });

  it("is moved by a system with a loop over its columns, like any component", () => {
    const Drift = System.tick("tf/Drift", function* () {
      const { delta } = yield* Time;
      (yield* Query.all(Position).pipe(Query.writes(Position))).eachChunk(
        (start, end, position) => {
          for (let i = start; i < end; i++) {
            position.x[i] = position.x[i]! + 2 * delta;
            position.z[i] = position.z[i]! - delta;
          }
        }
      );
    });
    const spawned: Spawned[] = [];
    const Rocks = Plugin.make("tf/Rocks", {
      setup: Effect.gen(function* () {
        const commands = yield* Commands.spawns(Position);
        spawned.push(
          commands.spawn(Position.of({ x: 1, y: 2, z: 3 })),
          // Added with no value, it is at the origin.
          commands.spawn(Position)
        );
      }),
    });
    const moved = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({ plugins: [Rocks], systems: [Drift] })
        );
        const world = yield* app.read(World);
        app.tick(0.5);
        return spawned.map((id) => world.get(placedIn(world, id), Position));
      })
    );
    expect(moved).toEqual([
      { x: 2, y: 2, z: 2.5 },
      { x: 1, y: 0, z: -0.5 },
    ]);
  });

  it("axisAngle gives the unit quaternion of a turn about an axis", () => {
    // No turn at all.
    expect(Transform3d.axisAngle(0, 1, 0, 0)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    });
    // A quarter turn about the vertical: half the angle, in sine and cosine.
    const quarter = Transform3d.axisAngle(0, 1, 0, Math.PI / 2);
    expect(quarter.x).toBe(0);
    expect(quarter.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(quarter.z).toBe(0);
    expect(quarter.w).toBeCloseTo(Math.SQRT1_2, 12);
    // A half turn about an axis that leans.
    const half = Transform3d.axisAngle(0.6, 0, 0.8, Math.PI);
    expect(half.x).toBeCloseTo(0.6, 12);
    expect(half.y).toBe(0);
    expect(half.z).toBeCloseTo(0.8, 12);
    expect(half.w).toBeCloseTo(0, 12);
    // The other way round is the same turn, backwards.
    const back = Transform3d.axisAngle(1, 0, 0, -1);
    expect(back.x).toBeCloseTo(-Math.sin(0.5), 12);
    expect(back.w).toBeCloseTo(Math.cos(0.5), 12);
    // Of length 1, whatever the angle, for an axis of length 1.
    for (const angle of [0.1, 1, 2.5, 4, -3]) {
      const { w, x, y, z } = Transform3d.axisAngle(0.6, 0.8, 0, angle);
      expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 12);
    }
    // The axis is a direction: of any length, it is the same turn.
    for (const by of [0.001, 2, 300]) {
      const long = Transform3d.axisAngle(0.6 * by, 0, 0.8 * by, 1.3);
      const unit = Transform3d.axisAngle(0.6, 0, 0.8, 1.3);
      expect(long.x).toBeCloseTo(unit.x, 12);
      expect(long.y).toBe(0);
      expect(long.z).toBeCloseTo(unit.z, 12);
      expect(long.w).toBeCloseTo(unit.w, 12);
    }
    // About no axis at all there is no turn, whatever the angle.
    expect(Transform3d.axisAngle(0, 0, 0, 2)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    });
    // It is what a Rotation is given.
    const Turned = Plugin.make("tf/Turned", {
      setup: Effect.gen(function* () {
        (yield* Commands.spawns(Rotation)).spawn(Rotation.of(quarter));
      }),
    });
    const turned = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Turned] }));
        const world = yield* app.read(World);
        return (yield* app.read(Query.all(Rotation)))
          .entities()
          .map((entity) => world.get(entity, Rotation)?.w);
      })
    );
    expect(turned).toEqual([Math.fround(quarter.w)]);
  });

  it("is saved and loaded by a game that names none of its components, with no renderer anywhere", () => {
    const spawned: Spawned[] = [];
    const Rocks = Plugin.make("tf/Rocks", {
      setup: Effect.gen(function* () {
        const commands = yield* Commands.spawns(
          Rock,
          Position,
          Rotation,
          Scale
        );
        spawned.push(
          commands.spawn(
            Rock,
            Position.of({ x: 1, y: 2, z: 3 }),
            Rotation.of(Transform3d.axisAngle(0, 0, 1, 1)),
            Scale.of({ x: 2, y: 3, z: 4 })
          )
        );
      }),
    });
    const Game = App.define({ plugins: [Rocks] });
    // What a reader of the game sees of the rocks.
    const rocks = Effect.gen(function* () {
      const world = yield* World;
      return {
        hash: world.hash(),
        rocks: spawned
          .map((id) => placedIn(world, id))
          .map((rock) => [
            world.get(rock, Position),
            world.get(rock, Rotation),
            world.get(rock, Scale),
          ]),
      };
    });
    const { made, save } = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(Game);
        return { made: yield* app.read(rocks), save: app.save() };
      })
    );
    if (Exit.isFailure(save)) {
      throw new Error("The game could not be saved");
    }
    const read = Save.decode(Save.encode(save.value));
    if (Exit.isFailure(read)) {
      throw new Error("The save could not be read back");
    }
    const loaded = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(Game, { save: read.value });
        return yield* app.read(rocks);
      })
    );
    expect(loaded).toEqual(made);
    expect(
      loaded.rocks.map(([position, , scale]) => [position, scale])
    ).toEqual([
      [
        { x: 1, y: 2, z: 3 },
        { x: 2, y: 3, z: 4 },
      ],
    ]);
  });
});
