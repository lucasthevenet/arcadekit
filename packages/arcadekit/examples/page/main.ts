/**
 * A game in a page: stars fall at sixty ticks a second, a basket catches
 * them, and both are drawn on a canvas once per repaint, wherever they are
 * by then.
 *
 * The arrow keys move the basket, and so does the pointer while its button
 * is held. P pauses the game.
 *
 *   pnpm --filter arcadekit page
 */
import { BrowserRuntime } from "@effect/platform-browser";
import { Context, Effect, Layer, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Random,
  Singleton,
  State,
  System,
  Time,
} from "../../src/index";

const WIDTH = 480;
const HEIGHT = 320;
const BASKET = { width: 64, y: HEIGHT - 24, speed: 260 };

// --- the simulation ------------------------------------------------------------
const Star = Component.define("page/Star", {
  x: Field.f32,
  y: Field.f32,
  speed: Field.f32,
});
const Stars = Query.all(Star);
// One of each per game: where the basket is, and how many stars it caught.
const Basket = Singleton.define(
  "page/Basket",
  { x: Field.f32, caught: Field.i32 },
  { x: WIDTH / 2, caught: 0 }
);
const Phase = State.define("page/Phase", ["playing", "paused"]);
const playing = System.runIf(State.is(Phase, "playing"));

// The devices, as the game has them this tick: the same picture for every
// system, and the same in a replay, which has no keyboard.
const Steer = System.make("Steer", function* () {
  const keys = yield* Input.Keyboard;
  const pointer = yield* Input.Pointer;
  const basket = yield* Basket;
  const { delta } = yield* Time;
  let { x } = basket;
  if (keys.down("ArrowLeft")) {
    x -= BASKET.speed * delta;
  }
  if (keys.down("ArrowRight")) {
    x += BASKET.speed * delta;
  }
  if (pointer.down()) {
    ({ x } = pointer);
  }
  x = Math.min(WIDTH - BASKET.width / 2, Math.max(BASKET.width / 2, x));
  if (x !== basket.x) {
    basket.x = x;
  }
}).pipe(playing);

const Fall = System.make("Fall", function* () {
  const { delta } = yield* Time;
  const random = yield* Random;
  const basket = yield* Basket;
  let caught = 0;
  (yield* Stars).each((star) => {
    const before = star.y;
    star.y += star.speed * delta;
    // Caught if it crossed the basket's line this tick, over the basket.
    const got =
      before < BASKET.y &&
      star.y >= BASKET.y &&
      Math.abs(star.x - basket.x) <= BASKET.width / 2;
    if (got) {
      caught++;
    }
    if (got || star.y > HEIGHT) {
      star.y = 0;
      star.x = random.next() * WIDTH;
    }
  });
  if (caught > 0) {
    basket.caught += caught;
  }
}).pipe(System.after(Steer), playing);

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

// --- what a player can ask for ---------------------------------------------------
// The game knows nothing of the key that pauses it: the binding below turns
// a key into this action, which is logged like any other.
const TogglePause = Action.define("page/TogglePause", Schema.Struct({}));
const togglePause = Action.handler(TogglePause, function* () {
  const phase = yield* Phase;
  phase.set(phase.is("playing") ? "paused" : "playing");
});

const Controls = Input.bind(
  "page/Controls",
  Input.onPress(["KeyP", "Escape", Input.padButton(0, 9)], TogglePause, {})
);

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
  const { count } = yield* Frame;
  const { delta, tick } = yield* Time;
  const basket = yield* Basket;
  const paused = (yield* Phase).is("paused");
  // Each star is drawn where it is by now: `alpha` of a tick further on.
  const ahead = paused ? 0 : (yield* Frame).alpha * delta;
  canvas.clearRect(0, 0, WIDTH, HEIGHT);
  canvas.fillStyle = "#ffd866";
  (yield* Stars.pipe(Query.reads())).eachChunk((start, end, star) => {
    for (let i = start; i < end; i++) {
      const y = star.y[i]! + star.speed[i]! * ahead;
      canvas.fillRect(star.x[i]! - 2, y - 2, 4, 4);
    }
  });
  canvas.fillStyle = paused ? "#5c6370" : "#78dce8";
  canvas.fillRect(basket.x - BASKET.width / 2, BASKET.y, BASKET.width, 8);
  hud.textContent = `tick ${tick} · frame ${count} · caught ${basket.caught} · basket ${Math.round(basket.x)}${paused ? " · paused" : ""}`;
}).pipe(System.inStage("frame"));

const Game = Plugin.make("Game", {
  plugins: [Input.plugin],
  components: [Star, Basket, Phase],
  handlers: [togglePause],
  systems: [Steer, Fall, Controls, Draw],
  setup: scatter,
});

// --- the entry point -------------------------------------------------------------
// The frame loop follows the page's repaints until the program is
// interrupted, which runMain does when the page goes away: the loop takes
// its frame request back, the app's scope closes, and the page's devices
// are no longer listened to.
const main = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game], seed: Date.now() });
  return yield* Driver.frames(app, { hz: 60 });
});

BrowserRuntime.runMain(
  main.pipe(
    Effect.scoped,
    Effect.provide(Screen.layer),
    // Provided to the whole program, so that it listens for as long.
    Effect.provide(
      Input.layerBrowser({
        target: document.querySelector("#game")!,
        preventDefault: ["ArrowLeft", "ArrowRight", "Space"],
      })
    )
  )
);
