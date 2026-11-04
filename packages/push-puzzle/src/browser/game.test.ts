import { silentAudio } from "@gamekit/audio";
import { GameLoop } from "@gamekit/runtime";
import type { InputSource } from "@gamekit/runtime";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PuzzleContent, boardText } from "../index";
import type { HudSample, PushPuzzleInput } from "../index";
import { makePushPuzzleGame } from "./index";
import { testSheet } from "./test-sheet";

// Runs push-puzzle's real browser definition: its input source reads keys through
// InputController, and a GameLoop steps it the way the demo's driver does. No view is created.
// No DOM either: Node's EventTarget stands in for the window and the surface, and
// navigator.getGamepads reports no pads.

const ROOM = [
  "##############################",
  "#@                           #",
  "#                            #",
  "#                            #",
  "#                         $. #",
  "##############################",
];

const content = Schema.decodeUnknownSync(PuzzleContent)({
  levels: [{ id: "room", name: "Room", rows: ROOM }],
});

const pushPuzzleGame = makePushPuzzleGame({
  audio: silentAudio,
  sounds: {
    move: "move",
    push: "push",
    hole: "hole",
    undo: "undo",
    solved: "solved",
  },
  sheet: testSheet(),
});

let window: EventTarget;

const key = (type: "keydown" | "keyup", code: string) => {
  const event = new Event(type);
  Object.defineProperty(event, "code", { value: code });
  Object.defineProperty(event, "repeat", { value: false });
  window.dispatchEvent(event);
};

/** Presses and releases a key before the next step. */
const tap = (code: string) => {
  key("keydown", code);
  key("keyup", code);
};

/** A started run of the real definition, its input source, and the HUD samples it reported. */
const play = () => {
  const surface = Object.assign(new EventTarget(), {
    style: {},
    setPointerCapture: () => {},
  }) as unknown as HTMLElement;
  const input: InputSource<PushPuzzleInput> =
    pushPuzzleGame.createInput(surface);
  const loop = new GameLoop(pushPuzzleGame);
  const samples: HudSample[] = [];
  loop.subscribe((event) => {
    if (event.type === "hud") {
      samples.push(event.hud);
    }
  });
  loop.start({ content, levelId: "room" }, 0, 0);
  return {
    loop,
    input,
    samples,
    /** Runs `steps` steps in one frame. */
    run: (steps: number) => loop.frame(input, { steps }, 0),
    /** The player's [column, row]. */
    player: () => {
      const rows = boardText(loop.state!);
      const row = rows.findIndex((line) => line.includes("@"));
      return [rows[row]!.indexOf("@"), row];
    },
  };
};

describe("push-puzzle in the browser, stepped by GameLoop", () => {
  beforeEach(() => {
    window = new EventTarget();
    vi.stubGlobal("window", window);
    vi.stubGlobal("navigator", { getGamepads: () => [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves once for a key press, even on a frame of several steps", () => {
    const { run, player, samples, input } = play();
    tap("ArrowRight");
    run(4);
    input.dispose();
    expect(player()).toStrictEqual([2, 1]);
    expect(samples.map((sample) => sample.moves)).toStrictEqual([0, 1]);
  });

  it("moves on the press of a held key, again after 12 steps, then every 6 steps", () => {
    const { loop, run, input } = play();
    key("keydown", "ArrowRight");
    const movedAt: number[] = [];
    for (let i = 0; i < 25; i++) {
      const before = loop.state!.moves;
      run(1);
      if (loop.state!.moves > before) {
        movedAt.push(i);
      }
    }
    input.dispose();
    expect(movedAt).toStrictEqual([0, 12, 18, 24]);
  });

  it("repeats the direction pressed last while an earlier one is still held", () => {
    const { run, player, input } = play();
    key("keydown", "ArrowRight");
    run(1);
    // Right is still down.
    key("keydown", "ArrowDown");
    run(13);
    input.dispose();
    // Down on the press and again 12 steps later; right never repeats.
    expect(player()).toStrictEqual([2, 3]);
  });

  it("takes back a move on undo", () => {
    const { loop, run, player, input } = play();
    tap("ArrowRight");
    run(2);
    tap("KeyZ");
    run(2);
    input.dispose();
    expect(player()).toStrictEqual([1, 1]);
    expect(loop.state!.turns).toBe(2);
  });
});
