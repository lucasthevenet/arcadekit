import type { AudioSystem, CueSoundsOf } from "arcadekit/audio";
import type { SpriteSheet } from "arcadekit/render-three";
import { describe, expect, it, vi } from "vitest";

import type { SurvivorsCueTable } from "../../src/browser/cue-table";

// The view `SurvivorsEngine` declares, as both hosts make it: the engine, with its player at
// slot 0, and `SurvivorsCoop`'s client, at the slot the lobby gave. The two views it combines
// need WebGL and an audio system, which Node hasn't: stand-ins record what each is made with.
// What each view does with its local hero is in arena-sprites.test.ts and sound-view.test.ts.

/** What a view is made with, as far as this test reads it. */
interface Options {
  readonly localHero?: () => number;
}

/** The options each of the two views was last made with, and what was disposed, in order. */
const made: { sprites?: Options; sounds?: Options; disposed: string[] } = {
  disposed: [],
};

/**
 * A stand-in for one of the two views' `make`: it records the options it is made with, its third
 * argument, and that its view was disposed.
 */
const recorder =
  (name: "sprites" | "sounds") =>
  (...given: unknown[]) => {
    made[name] = given[2] as Options;
    return {
      render: () => {},
      dispose: () => {
        made.disposed.push(name);
      },
    };
  };

vi.mock(import("../../src/browser/internal/sprite-view"), () => ({
  make: recorder("sprites") as never,
}));

vi.mock(import("../../src/browser/internal/sound-view"), () => ({
  make: recorder("sounds") as never,
}));

const { SurvivorsEngine } = await import("../../src/browser/engine");

describe("survivors' engine", () => {
  it("makes a sprite view and a sound view that both follow the local player's slot, read when they ask", () => {
    // The Co-op client's local player is read live: slot 0 in the lobby, then the run's.
    const local = { slot: 0, names: ["Host", "Guest 1"] };
    const view = SurvivorsEngine.definition.view(
      {} as HTMLElement,
      {
        audio: {} as AudioSystem.AudioSystem,
        sounds: {} as CueSoundsOf<typeof SurvivorsCueTable>,
        sheet: {} as SpriteSheet.SpriteSheet,
      },
      { local }
    );
    const followed = () => [
      made.sprites?.localHero?.(),
      made.sounds?.localHero?.(),
    ];
    const inTheLobby = followed();
    local.slot = 1;
    const inTheRun = followed();
    view.dispose();
    expect([inTheLobby, inTheRun, made.disposed]).toStrictEqual([
      [0, 0],
      [1, 1],
      ["sounds", "sprites"],
    ]);
  });
});
