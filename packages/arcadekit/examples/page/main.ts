/**
 * A game in a page: stars fall at sixty ticks a second, a basket catches
 * them, and both are drawn on a canvas once per repaint, wherever they are
 * by then.
 *
 * Enter starts the level, whose assets are loaded when it starts and let go
 * when it is left with Q. The arrow keys move the basket, and so does the
 * pointer while its button is held. P pauses the game.
 *
 *   pnpm --filter arcadekit page
 */
import { BrowserRuntime } from "@effect/platform-browser";
import { Context, Effect, Layer, Schema } from "effect";

import {
  Action,
  App,
  Assets,
  Commands,
  Component,
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
const Phase = State.define("page/Phase", ["title", "playing", "paused"]);
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

// --- what a player can ask for ---------------------------------------------------
// The game knows nothing of keys: the bindings below turn a key into one of
// these actions, which are logged like any other.
const Start = Action.define("page/Start", Schema.Struct({}));
const Quit = Action.define("page/Quit", Schema.Struct({}));
const TogglePause = Action.define("page/TogglePause", Schema.Struct({}));
// What a level is made of. It comes from a file, so it has a schema, and it
// reaches the game as the payload of an action: a replay has it in its log
// and loads no file.
const Layout = Schema.Struct({
  name: Schema.String,
  stars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  slowest: Schema.Finite,
  fastest: Schema.Finite,
});
const Scatter = Action.define("page/Scatter", Layout);

const handlers = [
  Action.handler(Start, function* () {
    const phase = yield* Phase;
    if (phase.is("title")) {
      phase.set("playing");
    }
  }),
  Action.handler(Quit, function* () {
    const phase = yield* Phase;
    if (phase.is("title")) {
      return;
    }
    const commands = yield* Commands;
    for (const star of (yield* Stars).entities()) {
      commands.despawn(star);
    }
    const basket = yield* Basket;
    basket.x = WIDTH / 2;
    basket.caught = 0;
    phase.set("title");
  }),
  Action.handler(TogglePause, function* () {
    const phase = yield* Phase;
    if (!phase.is("title")) {
      phase.set(phase.is("playing") ? "paused" : "playing");
    }
  }),
  Action.handler(Scatter, function* ({ fastest, slowest, stars }) {
    const commands = yield* Commands;
    const random = yield* Random;
    for (let i = 0; i < stars; i++) {
      commands.spawn(
        Star.of({
          x: random.next() * WIDTH,
          y: random.next() * HEIGHT,
          speed: slowest + random.next() * (fastest - slowest),
        })
      );
    }
  }),
] as const;

const Controls = Input.bind(
  "page/Controls",
  Input.onPress("Enter", Start, {}),
  Input.onPress("KeyQ", Quit, {}),
  Input.onPress(["KeyP", "Escape", Input.padButton(0, 9)], TogglePause, {})
);

// --- a level's assets ------------------------------------------------------------
// Loaded when the level starts and let go when the game leaves it: the
// picture is closed, and the next time the level starts it is fetched again.
const Level = Assets.bundle("page/Level", {
  layout: Assets.json("/level.json", Layout),
  star: Assets.image("/star.png"),
});
const LevelAssets = Assets.during(State.is(Phase, "playing", "paused"), Level);

// A system of the input stage: once the level's file is there, and the sky
// is still empty, it issues the action that fills it.
const Begin = System.make("Begin", function* () {
  const level = yield* Level;
  if (level._tag === "Ready" && (yield* Stars).count() === 0) {
    (yield* Action.Actions).enqueue(Scatter, level.assets.layout);
  }
}).pipe(System.inStage("input"), System.runIf(State.is(Phase, "playing")));

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
  const phase = yield* Phase;
  const level = yield* Level;
  canvas.clearRect(0, 0, WIDTH, HEIGHT);
  canvas.fillStyle = "#c8d0e0";
  canvas.font = "16px system-ui, sans-serif";
  canvas.textAlign = "center";
  if (phase.is("title")) {
    canvas.fillText("Press Enter", WIDTH / 2, HEIGHT / 2);
  } else if (level._tag !== "Ready") {
    canvas.fillText(
      level._tag === "Failed" ? level.error.message : "Loading",
      WIDTH / 2,
      HEIGHT / 2
    );
  } else {
    const picture = level.assets.star;
    // Each star is drawn where it is by now: `alpha` of a tick further on.
    const ahead = phase.is("paused") ? 0 : (yield* Frame).alpha * delta;
    (yield* Stars.pipe(Query.reads())).eachChunk((start, end, star) => {
      for (let i = start; i < end; i++) {
        const y = star.y[i]! + star.speed[i]! * ahead;
        canvas.drawImage(picture, star.x[i]! - 4, y - 4);
      }
    });
    canvas.fillStyle = phase.is("paused") ? "#5c6370" : "#78dce8";
    canvas.fillRect(basket.x - BASKET.width / 2, BASKET.y, BASKET.width, 8);
  }
  hud.textContent = `tick ${tick} · frame ${count} · ${phase.value} · assets ${level._tag} · caught ${basket.caught} · basket ${Math.round(basket.x)}`;
}).pipe(System.inStage("frame"));

const Game = Plugin.make("Game", {
  plugins: [Input.plugin, Assets.plugin],
  components: [Star, Basket, Phase],
  handlers,
  systems: [Steer, Fall, Controls, Begin, LevelAssets, Draw],
});

// --- the entry point -------------------------------------------------------------
// App.run makes the app and follows the page's repaints, sixty ticks a
// second, until it is interrupted, which runMain does when the page goes
// away: the frame loop takes its request back, the app's scope closes,
// what was loaded is let go, and the page's devices are no longer listened
// to.
BrowserRuntime.runMain(
  App.run({ plugins: [Game], seed: Date.now() }, { hz: 60 }).pipe(
    Effect.provide(Screen.layer),
    Effect.provide(
      Input.layerBrowser({
        target: document.querySelector("#game")!,
        preventDefault: ["ArrowLeft", "ArrowRight", "Space"],
      })
    )
  )
);
