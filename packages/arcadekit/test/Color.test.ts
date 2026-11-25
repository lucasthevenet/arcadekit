import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import * as Entry from "../src/Color.ts";
import type { Spawned } from "../src/index.ts";
import { App, Color, Commands, Plugin, World } from "../src/index.ts";
import { placedIn } from "./placed.ts";

describe("Color", () => {
  it("is one component of three 32-bit floats and the space they are in, known by its name", () => {
    expect(Color.Rgb.name).toBe("arcadekit/Color.Rgb");
    expect(Color.Rgb.fields).toEqual(["r", "g", "b", "space"]);
    expect(Color.Rgb.kinds).toEqual(["f32", "f32", "f32", "u8"]);
    expect(Color.Rgb.storage).toBe("table");
    expect(Color.Srgb).not.toBe(Color.Linear);
    // One module, whichever entry it is reached through.
    expect(Entry.Rgb).toBe(Color.Rgb);
  });

  it("is white when added bare, as an entity without one is drawn, and holds what it is given in either space", () => {
    const spawned: Spawned[] = [];
    const Paint = Plugin.make("co/Paint", {
      setup: Effect.gen(function* () {
        const commands = yield* Commands.spawns(Color.Rgb);
        spawned.push(
          commands.spawn(Color.Rgb),
          commands.spawn(
            Color.Rgb.of({
              r: 1,
              g: 0x61 / 255,
              b: 0x88 / 255,
              space: Color.Srgb,
            })
          ),
          commands.spawn(
            Color.Rgb.of({ r: 4, g: 0, b: -1, space: Color.Linear })
          )
        );
      }),
    });
    const colours = Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Paint] }));
        const world = yield* app.read(World);
        return spawned
          .map((id) => placedIn(world, id))
          .map((entity) => world.get(entity, Color.Rgb));
      })
    );
    expect(colours).toEqual([
      { r: 1, g: 1, b: 1, space: Color.Srgb },
      {
        r: 1,
        g: Math.fround(0x61 / 255),
        b: Math.fround(0x88 / 255),
        space: Color.Srgb,
      },
      { r: 4, g: 0, b: -1, space: Color.Linear },
    ]);
  });
});
