import { describe, expect, it } from "vitest";

import { combineViews } from "./browser";
import type { View } from "./browser";

const recording = (name: string, calls: string[]): View<number> => ({
  render: (state, time) => calls.push(`${name} render ${state} ${time}`),
  dispose: () => calls.push(`${name} dispose`),
});

describe(combineViews, () => {
  it("renders each view in order and disposes them in reverse", () => {
    const calls: string[] = [];
    const view = combineViews(
      recording("draw", calls),
      recording("sound", calls)
    );
    view.render(3, 1.5);
    view.render(null, 2);
    view.dispose();
    expect(calls).toStrictEqual([
      "draw render 3 1.5",
      "sound render 3 1.5",
      "draw render null 2",
      "sound render null 2",
      "sound dispose",
      "draw dispose",
    ]);
  });
});
