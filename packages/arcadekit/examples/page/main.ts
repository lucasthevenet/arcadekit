/**
 * A game in a page: stars fall at sixty ticks a second, and are drawn on a
 * canvas once per repaint, wherever they are by then.
 *
 *   pnpm --filter arcadekit page
 */
import { BrowserRuntime } from "@effect/platform-browser";
import { Context, Effect, Layer } from "effect";

import {
  App,
  Commands,
  Component,
  Driver,
  Field,
  Frame,
  Plugin,
  Query,
  Random,
  System,
  Time,
} from "../../src/index";

const WIDTH = 480;
const HEIGHT = 320;

// --- the simulation ------------------------------------------------------------
const Star = Component.define("page/Star", {
  x: Field.f32,
  y: Field.f32,
  speed: Field.f32,
});
const Stars = Query.all(Star);

const Fall = System.make("Fall", function* () {
  const { delta } = yield* Time;
  const random = yield* Random;
  (yield* Stars).each((star) => {
    star.y += star.speed * delta;
    if (star.y > HEIGHT) {
      star.y = 0;
      star.x = random.next() * WIDTH;
    }
  });
});

const scatter = Effect.gen(function* () {
  const commands = yield* Commands;
  const random = yield* Random;
  for (let i = 0; i < 40; i++) {
    commands.spawn(
      Star.of({
        x: random.next() * WIDTH,
        y: random.next() * HEIGHT,
        speed: 40 + random.next() * 120,
      })
    );
  }
});

// --- drawing: the frame stage ----------------------------------------------------
// What a frame system keeps from one frame to the next is in a service of
// its own, not in the world: here, the canvas it draws on.
class Screen extends Context.Service<
  Screen,
  {
    readonly canvas: CanvasRenderingContext2D;
    readonly hud: HTMLElement;
  }
>()("page/Screen") {
  static readonly layer = Layer.sync(Screen, () => ({
    canvas: (document.querySelector("#game") as HTMLCanvasElement).getContext(
      "2d"
    )!,
    hud: document.querySelector("#hud") as HTMLElement,
  }));
}

const Draw = System.make("Draw", function* () {
  const { canvas, hud } = yield* Screen;
  const { alpha, count } = yield* Frame;
  const { delta, tick } = yield* Time;
  canvas.clearRect(0, 0, WIDTH, HEIGHT);
  canvas.fillStyle = "#ffd866";
  // Each star is drawn where it is by now: `alpha` of a tick further on.
  (yield* Stars.pipe(Query.reads())).eachChunk((start, end, star) => {
    for (let i = start; i < end; i++) {
      const y = star.y[i]! + star.speed[i]! * delta * alpha;
      canvas.fillRect(star.x[i]! - 2, y - 2, 4, 4);
    }
  });
  hud.textContent = `tick ${tick} · frame ${count}`;
}).pipe(System.inStage("frame"));

const Game = Plugin.make("Game", {
  components: [Star],
  systems: [Fall, Draw],
  setup: scatter,
});

// --- the entry point -------------------------------------------------------------
// The frame loop follows the page's repaints until the program is
// interrupted, which runMain does when the page goes away: the loop takes
// its frame request back, and the app's scope closes.
const main = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game], seed: Date.now() });
  return yield* Driver.frames(app, { hz: 60 });
});

BrowserRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(Screen.layer)));
