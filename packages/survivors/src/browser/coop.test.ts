import { SpriteSheetError } from "arcadekit/render-three";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { survivorsCoopRules } from "../coop";
import type { SurvivorsArt } from "./art";
import { makeSurvivorsCoopGame } from "./coop";

// The survivors Co-op game's own half, in Node: an EventTarget stands in for the window and for
// the surface, so the input's listeners can be counted. The Co-op client that runs the game is
// tested in arcadekit/net/browser; the views' live local slot in scene.test.ts and sound.test.ts.

/** An EventTarget that counts the listeners on it. */
const countingTarget = () => {
  const target = new EventTarget();
  let listening = 0;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (...args: Parameters<typeof add>) => {
    listening += 1;
    add(...args);
  };
  target.removeEventListener = (...args: Parameters<typeof remove>) => {
    listening -= 1;
    remove(...args);
  };
  return { target, listening: () => listening };
};

const art = {} as SurvivorsArt;

let window: ReturnType<typeof countingTarget>;
let surface: ReturnType<typeof countingTarget>;
let element: HTMLElement;

const listening = () => [window.listening(), surface.listening()];

describe("the survivors Co-op game", () => {
  beforeEach(() => {
    window = countingTarget();
    surface = countingTarget();
    element = Object.assign(surface.target, {
      style: {},
    }) as unknown as HTMLElement;
    vi.stubGlobal("window", window.target);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the Co-op rules plus the app's content", () => {
    const content = Effect.never;
    const game = makeSurvivorsCoopGame({ content, art: Effect.succeed(art) });
    const { content: gameContent, presentation: _, ...rules } = game;
    expect([gameContent === content, rules]).toStrictEqual([
      true,
      survivorsCoopRules,
    ]);
  });

  it("reads the hero's movement from the surface into one object, and stops listening when disposed", async () => {
    const game = makeSurvivorsCoopGame({
      content: Effect.never,
      art: Effect.succeed(art),
    });
    const { createInput } = await Effect.runPromise(game.presentation);
    const input = createInput(element);
    const attached = listening();
    const first = input.read(0);
    const read = { ...first };
    const same = input.read(1) === first;
    input.dispose();
    expect({ attached, read, same, disposed: listening() }).toStrictEqual({
      attached: [3, 4],
      read: { moveX: 0, moveZ: 0 },
      same: true,
      disposed: [0, 0],
    });
  });

  it("fails its presentation with the art's error, before any input is made", async () => {
    const error = new SpriteSheetError({
      file: "sprites/survivors.json",
      message: "no sheet",
    });
    const game = makeSurvivorsCoopGame({
      content: Effect.never,
      art: Effect.fail(error),
    });
    const failed = await Effect.runPromise(Effect.flip(game.presentation));
    expect([failed, listening()]).toStrictEqual([error, [0, 0]]);
  });
});
