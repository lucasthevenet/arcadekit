/**
 * What the demo draws, which under Node is a note of how high the highest
 * thing is. Leave the plugin out and the game is the same.
 */
import { Frame, Plugin, System, Time } from "../../../src/index";
import * as Physics from "../physics/index";

/** What the last frame drew, and how many frames there have been. */
export const sketch = { frames: 0, highest: 0 };

// Runs once per frame, between ticks, with the world frozen: it reads the
// game and cannot change it. `Frame.alpha` says how far the frame is between
// the last tick and the next, so what moves is drawn where it is by now.
const Draw = System.frame("Draw", function* () {
  const { alpha } = yield* Frame;
  const { delta } = yield* Time;
  let highest = 0;
  (yield* Physics.Bodies).eachChunk((start, end, pos, vel) => {
    for (let i = start; i < end; i++) {
      highest = Math.max(highest, pos.y[i]! + vel.y[i]! * delta * alpha);
    }
  });
  sketch.frames++;
  sketch.highest = highest;
});

export const plugin = Plugin.make("Sketch", {
  plugins: [Physics.plugin],
  systems: [Draw],
});
