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
  Transform2d,
} from "../src/index";
import * as Entry from "../src/Transform2d";

const { Position, Rotation, Scale } = Transform2d;

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const Card = Component.tag("t2/Card");

describe("Transform2d", () => {
  it("is three components of a flat game, of 32-bit floats, each known by its name", () => {
    expect(Position.name).toBe("arcadekit/Transform2d.Position");
    expect(Rotation.name).toBe("arcadekit/Transform2d.Rotation");
    expect(Scale.name).toBe("arcadekit/Transform2d.Scale");
    // No third dimension, and a turn is one number.
    expect(Position.fields).toEqual(["x", "y"]);
    expect(Rotation.fields).toEqual(["angle"]);
    expect(Scale.fields).toEqual(["x", "y"]);
    for (const component of [Position, Rotation, Scale]) {
      expect(new Set(component.kinds)).toEqual(new Set(["f32"]));
      expect(component.storage).toBe("table");
    }
    // One module, whichever entry it is reached through.
    expect(Entry.Position).toBe(Position);
    expect(Entry.plugin).toBe(Transform2d.plugin);
  });

  it("is not Transform: an entity can have either, and nothing keeps one in step with the other", () => {
    expect(Position).not.toBe(Transform.Position);
    expect(Rotation).not.toBe(Transform.Rotation);
    expect(Scale).not.toBe(Transform.Scale);
    const { world } = run(
      App.make({ plugins: [Transform.plugin, Transform2d.plugin] })
    );
    const both = world.spawn(
      Position.of({ x: 1, y: 2 }),
      Transform.Position.of({ x: 7, y: 8, z: 9 })
    );
    world.set(both, Position, { x: 3, y: 4 });
    expect(world.get(both, Position)).toEqual({ x: 3, y: 4 });
    expect(world.get(both, Transform.Position)).toEqual({ x: 7, y: 8, z: 9 });
    expect(world.view(Query.all(Position)).count()).toBe(1);
    world.remove(both, Position);
    expect(world.has(both, Transform.Position)).toBe(true);
  });

  it("is moved and turned by a system with a loop over its columns", () => {
    const Moving = Query.all(Position, Rotation);
    const Drift = System.make("t2/Drift", function* () {
      const { delta } = yield* Time;
      (yield* Moving).eachChunk((start, end, position, rotation) => {
        for (let i = start; i < end; i++) {
          position.x[i] = position.x[i]! + 4 * delta;
          position.y[i] = position.y[i]! - 2 * delta;
          rotation.angle[i] = rotation.angle[i]! + delta;
        }
      });
    });
    const app = run(
      App.make({ plugins: [Transform2d.plugin], systems: [Drift] })
    );
    const card = app.world.spawn(
      Position.of({ x: 1, y: 2 }),
      Rotation.of({ angle: 0.25 })
    );
    // Added with no value: at the origin, and not turned.
    const fresh = app.world.spawn(Position, Rotation);
    app.tick(0.5);
    expect(app.world.get(card, Position)).toEqual({ x: 3, y: 1 });
    expect(app.world.get(card, Rotation)).toEqual({ angle: 0.75 });
    expect(app.world.get(fresh, Position)).toEqual({ x: 2, y: -1 });
    expect(app.world.get(fresh, Rotation)).toEqual({ angle: 0.5 });
  });

  it("lists its components, so that a flat game saves and loads them", () => {
    const Rules = Plugin.make("t2/Rules", {
      plugins: [Transform2d.plugin],
      components: [Card],
    });
    expect(Transform2d.plugin.name).toBe("arcadekit/Transform2d");
    expect(Transform2d.plugin.components).toEqual([Position, Rotation, Scale]);
    const made = run(App.make({ plugins: [Rules] }));
    const card = made.world.spawn(
      Card,
      Position.of({ x: 1, y: 2 }),
      Rotation.of({ angle: 1.5 }),
      Scale.of({ x: 2, y: 3 })
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
    expect(loaded.world.get(card, Position)).toEqual({ x: 1, y: 2 });
    expect(loaded.world.get(card, Rotation)).toEqual({ angle: 1.5 });
    expect(loaded.world.get(card, Scale)).toEqual({ x: 2, y: 3 });
    // The other transform's plugin does not list them: each its own.
    const without = Effect.runSyncExit(
      Effect.scoped(
        App.load(read.value, {
          plugins: [
            Plugin.make("t2/Other", {
              plugins: [Transform.plugin],
              components: [Card],
            }),
          ],
        })
      )
    );
    expect(Exit.isFailure(without)).toBe(true);
  });
});
