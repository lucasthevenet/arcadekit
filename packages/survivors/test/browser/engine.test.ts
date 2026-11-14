import type { AudioSystem } from "arcadekit/audio";
import type { SpriteSheet } from "arcadekit/render-three";
import { describe, expect, it, vi } from "vitest";

import type { SurvivorsSounds } from "../../src/browser/sound";

// The view `SurvivorsEngine` declares, as both hosts make it: the engine, with its player at
// slot 0, and `SurvivorsCoop`'s client, at the slot the lobby gave. The two views it combines
// need WebGL and an audio system, which Node hasn't: stand-ins record what each is made with.
// What each view does with its local hero is in scene.test.ts and sound.test.ts.

/** What a view is made with, as far as this test reads it. */
interface Options {
  readonly localHero?: () => number;
}

/** The options each of the two views was last made with, and what was disposed, in order. */
const made: { sprites?: Options; sounds?: Options; disposed: string[] } = {
  disposed: [],
};

/**
 * A stand-in for one of the two views, to call with `new`: it records the options it is made
 * with, the argument at `optionsAt`, and that it was disposed.
 */
const recorder = (name: "sprites" | "sounds", optionsAt: number) =>
  // oxlint-disable-next-line typescript/no-extraneous-class -- the engine's view calls these with `new`, which an arrow can't take.
  class {
    constructor(...given: unknown[]) {
      made[name] = given[optionsAt] as Options;
      Object.assign(this, {
        render: () => {},
        dispose: () => {
          made.disposed.push(name);
        },
      });
    }
  };

vi.mock(import("../../src/browser/view"), () => ({
  SurvivorsView: recorder("sprites", 2) as never,
}));

// The cue table is declared beside the sound view, and the engine uses it: only the view is
// stood in for.
vi.mock(import("../../src/browser/sound"), async (importOriginal) => ({
  ...(await importOriginal()),
  SurvivorsSoundView: recorder("sounds", 0) as never,
}));

const { SurvivorsEngine } = await import("../../src/browser/game");

describe("survivors' engine", () => {
  it("makes a sprite view and a sound view that both follow the local player's slot, read when they ask", () => {
    // The Co-op client's local player is read live: slot 0 in the lobby, then the run's.
    const local = { slot: 0, names: ["Host", "Guest 1"] };
    const view = SurvivorsEngine.definition.view(
      {} as HTMLElement,
      {
        audio: {} as AudioSystem.AudioSystem,
        sounds: {} as SurvivorsSounds,
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
