/**
 * What an app's stages cost when they have little to do: a tick of ten
 * systems that do no work, with and without a condition, a frame of ten, and
 * the input stage, a view, cues, music and a game at rest. These are the
 * fixed costs a game pays every tick or frame, whatever its world holds.
 *
 * `bench/accessors.ts` reports these with the rest of the package's, and
 * `bench/compare.ts --suite app` runs them for two builds, turn and turn
 * about, to say whether a change made any of them slower: the `app` job of
 * the `Benchmarks` workflow. A variant is run on its own as
 *
 *   node --import tsx bench/app.ts <name>
 *
 * which prints the median milliseconds of a pass. Each run is a process of
 * its own, as `bench/core.ts` says why.
 *
 * Each pass yields what it measures from one fiber, as a driver yields a
 * tick, so a pass includes what yielding an app's method costs its caller.
 */
import { pathToFileURL } from "node:url";

import { Effect, Layer, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Driver,
  Event,
  Field,
  Input,
  Plugin,
  Query,
  Singleton,
  Sound,
  State,
  System,
  Time,
  Timeline,
  View,
} from "../src/index.ts";
import { Position, Velocity, sizes } from "./core.ts";
import type { Variant } from "./core.ts";

/**
 * `measure` for what an app runs: each pass calls `run` and yields what it
 * returns, as a driver yields a tick, all in one fiber. The median
 * milliseconds of a pass.
 */
export const measureEffect = <E>(
  run: () => Effect.Effect<unknown, E>,
  runs = 300,
  warmup = 80,
  before?: () => Effect.Effect<unknown, E>
): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    for (let i = 0; i < warmup; i++) {
      if (before !== undefined) {
        yield* before();
      }
      yield* run();
    }
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      if (before !== undefined) {
        yield* before();
      }
      const start = performance.now();
      yield* run();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1]!;
  });

// As `bench/core.ts` has it, and a constant of this module so that a loop
// reads it at no cost.
const DT = 1 / 60;
if (DT !== sizes.step) {
  throw new Error("bench/app.ts and bench/core.ts differ on DT.");
}

/** What a system that moves things asks for. */
export const Moving = Query.all(Position, Velocity).pipe(
  Query.writes(Position)
);
/** The same, read only. */
export const Seen = Query.all(Position, Velocity);

/** A plugin of nothing, so that a game of systems alone has one. */
export const Empty = Plugin.make("bench/Empty", {});

const Power = State.define("bench/Power", ["on", "off"]);

/** A system that fetches a query and the time, then does nothing. */
const idle = <const I extends number>(i: I) =>
  System.tick(`Idle${i}`, function* () {
    yield* Moving;
    yield* Time;
  });

/** The same, run when the power is on. */
const powered = <const I extends number>(i: I) =>
  idle(i).pipe(System.runIf(State.is(Power, "on")));

/** Median milliseconds of a tick of ten idle systems that run when the power is on. */
const idling = (power: "on" | "off"): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const systems = [
        powered(0),
        powered(1),
        powered(2),
        powered(3),
        powered(4),
        powered(5),
        powered(6),
        powered(7),
        powered(8),
        powered(9),
      ] as const;
      const Switched = Plugin.make("bench/Switched", {
        setup: Effect.gen(function* () {
          (yield* Power.sets).set(power);
        }),
      });
      const app = yield* App.make(App.define({ plugins: [Switched], systems }));
      return yield* measureEffect(() => app.tick(DT), 50_000, 20_000);
    })
  );

const Clock = Singleton.define(
  "bench/Clock",
  { ticks: Field.i32 },
  { ticks: 0 }
);
/** A clock that runs every tick, as a puzzle's timer does. */
const Counting = System.tick("bench/Counting", function* () {
  (yield* Clock.writes).ticks++;
});
/** A move of the player's: the first piece slides, a write to the board's positions. */
const Slide = Action.define("bench/Slide");
const Board = Plugin.make("bench/Board", {
  plugins: [Timeline.plugin],
  systems: [Counting],
  handlers: [
    Action.handler(Slide, function* () {
      (yield* Moving).eachChunk((start, _end, pos) => {
        pos.x[start]! += 1;
      });
    }),
  ],
  setup: Effect.gen(function* () {
    const pieces = yield* Commands.spawns(Position, Velocity);
    for (let i = 0; i < 1000; i++) {
      pieces.spawn(Position.of({ x: i, y: i }), Velocity.of({ x: 0, y: 0 }));
    }
  }),
});

/**
 * Median milliseconds of a tick of a board game that ticks by itself: a
 * clock that runs, and 1,000 pieces in one table that lie still. With
 * `moved`, a move of the player's is enqueued before each pass, untimed, and
 * the tick applies it. With `kept`, `Timeline.keep` keeps the game's turns,
 * so the tick ends with a capture of the game, and with `moved` it keeps a
 * turn, the last 100 of them.
 */
const playing = (kept: boolean, moved: boolean): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Board] }));
        if (kept) {
          yield* Timeline.keep(app);
        }
        const median = yield* measureEffect(
          () => app.tick(DT),
          50_000,
          20_000,
          moved ? () => app.enqueue(Slide, undefined) : undefined
        );
        const { tick } = app.time;
        const { ticks } = yield* app.read(Clock);
        let first = Number.NaN;
        (yield* app.read(Seen)).eachChunk((start, _end, pos) => {
          first = pos.x[start]!;
        });
        if (ticks !== tick || first !== (moved ? tick : 0)) {
          throw new Error(
            `Of ${tick} ticks, the clock ran ${ticks} and the first piece slid ${first}.`
          );
        }
        if (kept) {
          yield* app.enqueue(Slide, undefined);
          yield* app.tick(DT);
          if (
            !(yield* Timeline.undo(app)) ||
            (yield* app.read(Clock)).ticks !== tick
          ) {
            throw new Error(
              "Timeline.keep did not hold the game as it was after the last tick timed."
            );
          }
        }
        return median;
      })
    )
  );

/** A game's controls, as a platformer has them: a jump, a stick and a fire. */
const Controls = Input.controls("bench/Controls", [
  Input.button("bench/Jump", ["Space", "KeyW", Input.padButton(0, 0)]),
  Input.button("bench/Fire", [Input.pointerButton(), Input.padButton(0, 2)]),
  Input.stick("bench/Move", {
    left: ["ArrowLeft", "KeyA"],
    right: ["ArrowRight", "KeyD"],
    up: ["ArrowUp"],
    down: ["ArrowDown", "KeyS"],
    pad: Input.padStick(0, "left"),
  }),
]);

/**
 * Median milliseconds of reading the devices into the world: three keys
 * held and the pointer somewhere. With `changing`, a fourth key goes down
 * or up before each pass, and the pass includes the tick that applies the
 * report; without, nothing changes and the pass is the input stage alone.
 * With `controls`, the game declares three controls, which the stage works
 * out from the devices each time.
 */
const listening = (changing: boolean, controls = false): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const source = Input.makeManualSource();
      const app = yield* App.make(
        App.define({ plugins: [controls ? Controls : Input.plugin] }),
        { hashEvery: 0 }
      ).pipe(Effect.provide(Input.layer(source)));
      const held: readonly Input.ButtonCode[] = [
        "ArrowLeft",
        "ShiftLeft",
        Input.pointerButton(),
      ];
      for (const code of held) {
        source.press(code);
      }
      source.move(Input.pointerX, 120);
      source.move(Input.pointerY, 80);
      yield* app.input();
      yield* app.tick(DT);
      let down = false;
      return changing
        ? yield* measureEffect(
            () =>
              Effect.gen(function* () {
                down = !down;
                if (down) {
                  source.press("Space");
                } else {
                  source.release("Space");
                }
                yield* app.input();
                yield* app.tick(DT);
                // The log is the game's to keep; here it would only grow.
                (app.actionLog as unknown[]).length = 0;
              }),
            20_000,
            5000
          )
        : yield* measureEffect(() => app.input(), 50_000, 20_000);
    })
  );

/**
 * Median milliseconds of a frame whose one system publishes a view of four
 * fields, read from a singleton. `"same"`: a UI is listening and the value
 * is what it has. `"new"`: the value differs every frame, and the one
 * listener is told. `"nobody"`: no bridge was provided.
 */
const showing = (mode: "same" | "new" | "nobody"): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const Stats = Singleton.define(
        "bench/Stats",
        { score: Field.i32, lives: Field.i32, level: Field.i32 },
        { score: 0, lives: 3, level: 1 }
      );
      const Hud = View.define("bench/Hud", {
        score: 0,
        lives: 3,
        level: 1,
        phase: "playing",
      });
      let frames = 0;
      const Show = View.publish(Hud, function* () {
        const stats = yield* Stats;
        return {
          score: mode === "new" ? frames : stats.score,
          lives: stats.lives,
          level: stats.level,
          phase: "playing",
        };
      });
      const WithHud = App.define({ plugins: [View.plugin], systems: [Show] });
      // A UI that listens, so that a value published is told to someone.
      const ui = View.mount(WithHud, (bridge) => {
        bridge.subscribe(Hud, () => {});
      });
      const made = App.make(WithHud, { hashEvery: 0 });
      const app = yield* mode === "nobody"
        ? made
        : made.pipe(Effect.provide(ui));
      return yield* measureEffect(
        () => {
          frames++;
          return app.frame();
        },
        50_000,
        20_000
      );
    })
  );

/**
 * Median milliseconds of a frame whose one system plays cues for two kinds
 * of event, to an output that plays nothing. With `happening`, a tick
 * before each frame emits one event, and the frame plays its cue; the tick
 * is not timed.
 */
const sounding = (happening: boolean): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const Scored = Event.define("bench/Scored", Schema.Struct({}));
      const Bounced = Event.define("bench/Bounced", Schema.Struct({}));
      const Score = System.tick("bench/Score", function* () {
        if (happening) {
          (yield* Scored.emits).emit({});
        }
      });
      const Sfx = Sound.sheet("bench/Sfx", {
        coin: "/coin.wav",
        thud: "/thud.wav",
      });
      const Cues = Sound.cues(
        "bench/Cues",
        Sound.on(Scored, Sfx.coin),
        Sound.on(Bounced, { cue: Sfx.thud, volume: 0.5 })
      );
      const app = yield* App.make(
        App.define({ plugins: [Sound.plugin], systems: [Score, Cues] }),
        { hashEvery: 0 }
      ).pipe(Effect.provide(Sound.layer({ play() {}, music() {} })));
      return yield* measureEffect(
        () => app.frame(),
        50_000,
        20_000,
        () => app.tick(DT)
      );
    })
  );

/**
 * Median milliseconds of one frame of a game with music that goes on as it
 * was: the body asked what should be playing, a state read, the same answer
 * as the frame before, and the output told nothing.
 */
const scoring = (): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const Phase = State.define("bench/MusicPhase", ["playing", "title"]);
      const Tracks = Sound.sheet("bench/Tracks", { theme: "/theme.ogg" });
      const Score = Sound.music("bench/Music", function* () {
        return (yield* Phase).value === "playing"
          ? { track: Tracks.theme, volume: 0.5 }
          : undefined;
      });
      const app = yield* App.make(
        App.define({ plugins: [Sound.plugin], systems: [Score] }),
        { hashEvery: 0 }
      ).pipe(Effect.provide(Sound.layer({ play() {}, music() {} })));
      return yield* measureEffect(() => app.frame(), 50_000, 20_000);
    })
  );

/**
 * Median milliseconds of one frame of a game that ticks when it is needed
 * and is at rest: the devices read, the app asked whether anything waits,
 * no tick, and a frame stage of one system. The game has the picture of
 * the devices, a state and a view, as one with a menu would.
 */
const atRest = (): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const Phase = State.define("bench/RestPhase", ["title", "playing"]);
      const Shown = View.define("bench/Shown", { phase: "title" });
      const Show = View.publish(Shown, function* () {
        return { phase: (yield* Phase).value as string };
      });
      const source = Input.makeManualSource();
      const Resting = App.define({
        plugins: [Input.plugin, View.plugin],
        systems: [Show],
      });
      const app = yield* App.make(Resting, { hashEvery: 0 }).pipe(
        Effect.provide(
          Layer.merge(
            Input.layer(source),
            View.mount(Resting, (ui) => {
              ui.subscribe(Shown, () => {});
            })
          )
        )
      );
      const advance = Driver.fixedStep(app, { hz: 60, ticks: "whenNeeded" });
      // A new game rests after its first tick when that tick changed nothing.
      for (let i = 0; i < 10; i++) {
        yield* advance(DT);
      }
      if (app.time.tick !== 1) {
        throw new Error(`The game did not come to rest: tick ${app.time.tick}`);
      }
      return yield* measureEffect(() => advance(DT), 50_000, 20_000);
    })
  );

/** What the systems below drew, outside the app as a canvas is, so their loops are kept. */
export const drawn = { sum: 0 };

/** A system that draws: it fetches a query and the time, and with `reading` reads every column. */
export const drawer = <const I extends number>(i: I, reading: boolean) =>
  System.frame(`Draw${i}`, function* () {
    const moving = yield* Seen;
    yield* Time;
    if (reading) {
      moving.eachChunk((start, end, pos, vel) => {
        const px = pos.x;
        const vx = vel.x;
        for (let n = start; n < end; n++) {
          drawn.sum += px[n]! + vx[n]! * DT;
        }
      });
    }
  });

/** Median milliseconds of a frame of ten systems that draw nothing. */
const drawingIdle = (): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const systems = [
        drawer(0, false),
        drawer(1, false),
        drawer(2, false),
        drawer(3, false),
        drawer(4, false),
        drawer(5, false),
        drawer(6, false),
        drawer(7, false),
        drawer(8, false),
        drawer(9, false),
      ] as const;
      const app = yield* App.make(App.define({ plugins: [Empty], systems }));
      return yield* measureEffect(() => app.frame(0.5), 50_000, 20_000);
    })
  );

export const variants: Record<string, Variant> = {
  idle: {
    // The fixed cost Effect adds: ten systems that each fetch a query and the
    // time, then do nothing. Reported per tick, not per entity.
    unit: "matches",
    label: "app.tick: 10 systems that do no work",
    run: () =>
      Effect.runSync(
        Effect.gen(function* () {
          const systems = [
            idle(0),
            idle(1),
            idle(2),
            idle(3),
            idle(4),
            idle(5),
            idle(6),
            idle(7),
            idle(8),
            idle(9),
          ] as const;
          const app = yield* App.make(App.define({ systems }));
          return yield* measureEffect(() => app.tick(DT), 50_000, 20_000);
        })
      ),
  },
  idleConditioned: {
    // The same ten systems, each asked whether the game is in a state.
    unit: "matches",
    label: "app.tick: the same, each with a condition that holds",
    run: () => idling("on"),
  },
  idleSkipped: {
    unit: "matches",
    label: "app.tick: the same, each with a condition that does not",
    run: () => idling("off"),
  },

  // The turns an undo goes back to: `Timeline.keep` captures the game after
  // every tick, which in a game that ticks by itself is 60 times a second.
  // Each pair is the same tick without and with it. A capture shares what
  // did not change since the last one and copies what did, so at rest it
  // copies the clock, and after a move the board's positions as well.
  board: {
    unit: "matches",
    label: "app.tick: a clock and 1,000 pieces at rest",
    run: () => playing(false, false),
  },
  boardKept: {
    unit: "matches",
    label: "app.tick: the same, its turns kept by Timeline.keep",
    run: () => playing(true, false),
  },
  boardMoved: {
    unit: "matches",
    label: "app.tick: a clock and 1,000 pieces, one moved from outside",
    run: () => playing(false, true),
  },
  boardMovedKept: {
    unit: "matches",
    label: "app.tick: the same, its turns kept, one kept each tick",
    run: () => playing(true, true),
  },

  // The frame stage: systems that draw, run between ticks with the world
  // frozen. A frame costs what a tick of the same systems does.
  frameIdle: {
    unit: "matches",
    label: "app.frame: 10 systems that do no work",
    run: drawingIdle,
  },

  // The input stage: the devices are read once per tick and compared with
  // the picture the world holds. Nothing changed is the usual case, and
  // costs a run of the stage; a change costs an action as well.
  inputIdle: {
    unit: "matches",
    label: "app.input: the picture of the devices, nothing changed",
    run: () => listening(false),
  },
  inputChanged: {
    unit: "matches",
    label: "app.input and app.tick: one key went down or up",
    run: () => listening(true),
  },
  inputControls: {
    unit: "matches",
    label: "app.input: the same, with three controls",
    run: () => listening(false, true),
  },
  inputControlsChanged: {
    unit: "matches",
    label: "app.input and app.tick: a key of a control changed",
    run: () => listening(true, true),
  },

  // The view bridge: one view of four fields, worked out and compared in
  // the frame stage. Unchanged is the usual case.
  viewSame: {
    unit: "matches",
    label: "app.frame: a view published, the value unchanged",
    run: () => showing("same"),
  },
  viewNew: {
    unit: "matches",
    label: "app.frame: a view published, new, one listener",
    run: () => showing("new"),
  },
  viewNobody: {
    unit: "matches",
    label: "app.frame: a view with no UI there",
    run: () => showing("nobody"),
  },

  // Sound: one system of two lines, playing to an output that does nothing.
  soundIdle: {
    unit: "matches",
    label: "app.frame: cues for two events, nothing happened",
    run: () => sounding(false),
  },
  soundOne: {
    unit: "matches",
    label: "app.frame: cues for two events, one cue played",
    run: () => sounding(true),
  },

  musicSame: {
    unit: "matches",
    label: "app.frame: music that goes on as it was",
    run: () => scoring(),
  },

  // A game that ticks when it is needed, at rest: what a frame costs when
  // no tick runs.
  restFrame: {
    unit: "matches",
    label: "a frame of a game at rest: devices, a view, no tick",
    run: () => atRest(),
  },
};

// Run as a program: one variant, and its median on the last line.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const variant = variants[process.argv[2] ?? ""];
  if (variant === undefined) {
    throw new Error(
      `bench/app.ts is given the name of a variant, one of: ${Object.keys(variants).join(", ")}.`
    );
  }
  console.log(JSON.stringify(variant.run()));
}
