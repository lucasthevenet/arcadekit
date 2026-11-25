/**
 * The game of the page: stars fall at sixty ticks a second, a basket
 * catches them, and both are drawn on a canvas once per repaint, wherever
 * they are by then.
 *
 * What the UI may see of it, and ask of it, is in protocol.ts. The game
 * publishes the first and handles the second, and knows nothing of what
 * the UI is built with.
 */
import { Context, Layer, Schema } from "effect";

// In a game of your own these are "arcadekit/browser/Browser" and "arcadekit".
import * as Browser from "../../src/browser/Browser.ts";
import {
  Action,
  Assets,
  Commands,
  Component,
  Event,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Random,
  Singleton,
  Sound,
  State,
  System,
  Time,
  View,
} from "../../src/index.ts";
import { Hud, Menu, Quit, Start, TogglePause } from "./protocol.ts";

export const WIDTH = 480;
export const HEIGHT = 320;
const BASKET = { width: 64, y: HEIGHT - 24, speed: 260 };

// --- the simulation ------------------------------------------------------------
const Star = Component.define("page/Star", {
  x: Field.f32,
  y: Field.f32,
  speed: Field.f32,
});
const Stars = Query.all(Star);
const Falling = Query.all(Star).pipe(Query.writes(Star));
// One of each per game: where the basket is, and how many stars it caught.
const Basket = Singleton.define(
  "page/Basket",
  { x: Field.f32, caught: Field.i32 },
  { x: WIDTH / 2, caught: 0 }
);
const Phase = State.define("page/Phase", ["title", "playing", "paused"]);
// What happened, said by the simulation for whoever wants to know. It
// knows nothing of the sounds they are played as.
const Caught = Event.define(
  "page/Caught",
  Schema.Struct({ stars: Schema.Int })
);
const Started = Event.define("page/Started", Schema.Struct({}));
const playing = System.runIf(State.is(Phase, "playing"));

// The devices, as the game has them this tick: the same picture for every
// system, and the same in a replay, which has no keyboard.
const Steer = System.tick("Steer", function* () {
  const keys = yield* Input.Keyboard;
  const pointer = yield* Input.Pointer;
  const basket = yield* Basket.writes;
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

const Fall = System.tick("Fall", function* () {
  const { delta } = yield* Time;
  const random = yield* Random;
  const basket = yield* Basket.writes;
  let caught = 0;
  (yield* Falling).each((star) => {
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
    (yield* Caught.emits).emit({ stars: caught });
  }
}).pipe(playing);

// --- what a player can ask for ---------------------------------------------------
// The game knows nothing of keys: the bindings below turn a key into one of
// these actions, which are logged like any other.
// `Start`, `Quit` and `TogglePause` are in protocol.ts, since the UI sends
// them too.
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
    const phase = yield* Phase.sets;
    if (phase.is("title")) {
      phase.set("playing");
      (yield* Started.emits).emit({});
    }
  }),
  Action.handler(Quit, function* () {
    const phase = yield* Phase.sets;
    if (phase.is("title")) {
      return;
    }
    const commands = yield* Commands;
    for (const star of (yield* Stars).entities()) {
      commands.despawn(star);
    }
    const basket = yield* Basket.writes;
    basket.x = WIDTH / 2;
    basket.caught = 0;
    phase.set("title");
  }),
  Action.handler(TogglePause, function* () {
    const phase = yield* Phase.sets;
    if (!phase.is("title")) {
      phase.set(phase.is("playing") ? "paused" : "playing");
    }
  }),
  Action.handler(Scatter, function* ({ fastest, slowest, stars }) {
    const commands = yield* Commands.spawns(Star);
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
  star: Browser.image("/star.png"),
  // The level's own sound, loaded and let go with the rest of it.
  caught: Browser.sound("/caught.wav"),
});
const LevelAssets = Assets.during(State.is(Phase, "playing", "paused"), Level);

// A system of the input stage: once the level's file is there, and the sky
// is still empty, it issues the action that fills it.
const Begin = System.input("Begin", function* () {
  const level = yield* Level;
  if (level._tag === "Ready" && (yield* Stars).count() === 0) {
    (yield* Action.Actions).enqueue(Scatter, level.assets.layout);
  }
}).pipe(System.runIf(State.is(Phase, "playing")));

// --- drawing: the frame stage ----------------------------------------------------
// What a frame system keeps from one frame to the next is in a service of
// its own, not in the world: here, the canvas it draws on.
export class Screen extends Context.Service<
  Screen,
  { readonly canvas: CanvasRenderingContext2D }
>()("page/Screen") {
  static readonly layer = Layer.sync(Screen, () => ({
    canvas: (document.querySelector("#game") as HTMLCanvasElement).getContext(
      "2d"
    )!,
  }));
}

const Draw = System.frame("Draw", function* () {
  const { canvas } = yield* Screen;
  const { delta } = yield* Time;
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
    (yield* Stars).eachChunk((start, end, star) => {
      for (let i = start; i < end; i++) {
        const y = star.y[i]! + star.speed[i]! * ahead;
        canvas.drawImage(picture, star.x[i]! - 4, y - 4);
      }
    });
    canvas.fillStyle = phase.is("paused") ? "#5c6370" : "#78dce8";
    canvas.fillRect(basket.x - BASKET.width / 2, BASKET.y, BASKET.width, 8);
  }
});

// --- what it sounds like: the frame stage too --------------------------------------
// Each event of the ticks since the last frame is played as a cue. The
// simulation never plays: a replay of this game is silent, and the same.
// "start" is a sound the page has for as long as it lasts, by its name.
const Cues = Sound.cues("page/Cues", Sound.on(Started, "start"));
// The level's cues are made of what its bundle holds, each time it is
// loaded, and are silent while it is not.
const LevelCues = Sound.cues("page/LevelCues", Level, ({ caught }) => [
  // Two at once are a little higher than one.
  Sound.on(Caught, ({ stars }) => ({
    cue: caught,
    rate: 1 + (stars - 1) / 4,
  })),
]);
// Music is not an event but what the game, as it is, should sound like:
// said each frame, and started, turned down and stopped as that changes.
const Score = Sound.music(
  "page/Score",
  function* () {
    const phase = (yield* Phase).value;
    if (phase === "title") {
      return undefined;
    }
    return { track: "theme", volume: phase === "paused" ? 0.1 : 0.4 };
  },
  { fade: 0.6 }
);

// --- what the UI sees: the frame stage too -----------------------------------------
// Each is worked out once per frame and published only when it is not what
// the UI already has: while the stars fall and none is caught, the UI is
// told nothing and does nothing.
const ShowMenu = View.publish(Menu, function* () {
  return { phase: (yield* Phase).value };
});
const ShowHud = View.publish(Hud, function* () {
  return {
    caught: (yield* Basket).caught,
    level: (yield* Level)._tag,
  };
});

export const Game = Plugin.make("Game", {
  plugins: [Input.plugin, Assets.plugin, View.plugin, Sound.plugin],
  handlers,
  systems: [
    Steer,
    Fall,
    Controls,
    Begin,
    LevelAssets,
    Draw,
    Cues,
    LevelCues,
    Score,
    ShowMenu,
    ShowHud,
  ],
});
