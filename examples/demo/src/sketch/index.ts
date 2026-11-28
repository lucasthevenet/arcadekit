/**
 * What the demo draws, which under Node is a note of how high the highest
 * thing is. Leave the plugin out and the game is the same.
 */
import { Frame, Plugin, Query, System, Time } from "arcadekit";
import { Context } from "effect";

import * as Physics from "../physics/index.ts";

/**
 * What the demo draws on: how high the highest thing was in the last frame,
 * and how many frames there have been. The app is given it, as a page gives
 * an app its canvas, so that each app draws on its own.
 */
export class Note extends Context.Service<
  Note,
  { frames: number; highest: number }
>()("demo/Note") {}

// Runs once per frame, between ticks, with the world frozen: it reads the
// game and cannot change it. `Frame.alpha` says how far the frame is between
// the last tick and the next, so what moves is drawn where it is by now.
const Draw = System.frame("Draw", function* () {
  const { alpha } = yield* Frame;
  const { delta } = yield* Time;
  const note = yield* Note;
  let highest = 0;
  (yield* Query.View(Physics.Bodies)).eachChunk((start, end, pos, vel) => {
    for (let i = start; i < end; i++) {
      highest = Math.max(highest, pos.y[i]! + vel.y[i]! * delta * alpha);
    }
  });
  note.frames++;
  note.highest = highest;
});

export const plugin = Plugin.make("Sketch", {
  plugins: [Physics.plugin],
  systems: [Draw],
});
