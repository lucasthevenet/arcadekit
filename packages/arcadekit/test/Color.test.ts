import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Entry from "../src/Color.ts";
import type { Spawned } from "../src/index.ts";
import {
  App,
  Color,
  Commands,
  Plugin,
  Query,
  System,
  World,
} from "../src/index.ts";
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

  it("is written as a hex code with Color.hex, and refuses a number that is none", () => {
    expect(Color.hex(0xff_61_88)).toEqual({
      r: 0xff / 255,
      g: 0x61 / 255,
      b: 0x88 / 255,
      space: Color.Srgb,
    });
    expect(Color.hex(0)).toEqual({ r: 0, g: 0, b: 0, space: Color.Srgb });
    expect(Color.Rgb.of(Color.hex(0xff_ff_ff)).value).toEqual({
      r: 1,
      g: 1,
      b: 1,
      space: Color.Srgb,
    });
    for (const code of [-1, 0x1_00_00_00, 0.5, Number.NaN]) {
      expect(() => Color.hex(code)).toThrow(
        `Color.hex was given ${code}, which is not the hex code of a colour`
      );
    }
  });

  it.effect(
    "is white when added bare, as an entity without one is drawn, and holds what it is given in either space",
    () =>
      Effect.gen(function* () {
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
        const app = yield* App.make(App.define({ plugins: [Paint] }));
        const world = yield* app.read(World);
        const colours = spawned
          .map((id) => placedIn(world, id))
          .map((entity) => world.get(entity, Color.Rgb));
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
      })
  );

  it.effect(
    "is drawn between its last two values by a frame system, however far it changed",
    () =>
      Effect.gen(function* () {
        const Fade = System.tick("co/Fade", function* () {
          (yield* Query.View(
            Query.all(Color.Rgb).pipe(Query.writes(Color.Rgb))
          )).each((color) => {
            color.r = 1;
          });
        });
        const Dark = Plugin.make("co/Dark", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Color.Rgb)).spawn(
              Color.Rgb.of({ r: 0, g: 0, b: 0, space: Color.Linear })
            );
          }),
        });
        const drawn: number[] = [];
        const Draw = System.frame("co/Draw", function* () {
          const smooth = yield* Color.smooth;
          (yield* Query.View(Query.all(Color.Rgb))).each((color, entity) => {
            drawn.push(smooth.color(entity, color).r);
          });
        });
        const app = yield* App.make(
          App.define({ plugins: [Dark], systems: [Fade, Draw] })
        );
        yield* app.frame(1);
        yield* app.tick(1);
        yield* app.frame(0.25);
        expect(drawn).toEqual([0, 0.25]);
      })
  );
});
