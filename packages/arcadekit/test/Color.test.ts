import { Effect } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import * as Entry from "../src/Color";
import type { Spawned } from "../src/index";
import { App, Color, Commands, Plugin, World } from "../src/index";
import { placedIn } from "./placed";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

describe("Color", () => {
  it("is two components of three 32-bit floats, one for each way of writing a colour, each known by its name", () => {
    expect(Color.Srgb.name).toBe("arcadekit/Color.Srgb");
    expect(Color.Linear.name).toBe("arcadekit/Color.Linear");
    expect(Color.Srgb).not.toBe(Color.Linear);
    for (const component of [Color.Srgb, Color.Linear]) {
      expect(component.fields).toEqual(["r", "g", "b"]);
      expect(new Set(component.kinds)).toEqual(new Set(["f32"]));
      expect(component.storage).toBe("table");
    }
    // One module, whichever entry it is reached through.
    expect(Entry.Srgb).toBe(Color.Srgb);
  });

  it("is white when added bare, as an entity without one is drawn, and holds what it is given", () => {
    const spawned: Spawned[] = [];
    const Paint = Plugin.make("co/Paint", {
      setup: Effect.gen(function* () {
        const commands = yield* Commands.spawns(Color.Srgb, Color.Linear);
        spawned.push(
          commands.spawn(Color.Srgb, Color.Linear),
          commands.spawn(
            Color.Srgb.of({ r: 1, g: 0x61 / 255, b: 0x88 / 255 }),
            Color.Linear.of({ r: 4, g: 0, b: -1 })
          )
        );
      }),
    });
    const colours = run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Paint] }));
        const world = yield* app.read(World);
        return spawned
          .map((id) => placedIn(world, id))
          .map((entity) => [
            world.get(entity, Color.Srgb),
            world.get(entity, Color.Linear),
          ]);
      })
    );
    expect(colours).toEqual([
      [
        { r: 1, g: 1, b: 1 },
        { r: 1, g: 1, b: 1 },
      ],
      [
        { r: 1, g: Math.fround(0x61 / 255), b: Math.fround(0x88 / 255) },
        { r: 4, g: 0, b: -1 },
      ],
    ]);
  });
});
