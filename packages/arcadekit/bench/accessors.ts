import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * How should a system touch component data?
 *
 * Every variant does the same work: pos += vel * dt over the same 100,000
 * entities. Reported as nanoseconds per entity (median of many passes, after
 * warm-up).
 *
 * Each variant runs in its own process, three times, and the best median is
 * reported. Separate processes matter: V8 optimises a call site for the
 * functions it has seen there, so running variants one after another in one
 * process makes later ones look slower than they are.
 *
 *   pnpm --filter arcadekit bench
 */
import { Effect, Exit, Layer, Schema } from "effect";

import { World } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  EntityId,
  Event,
  Field,
  Grid,
  Input,
  Overlap,
  Plugin,
  Query,
  Singleton,
  Sound,
  State,
  System,
  Time,
  Timeline,
  Transform2d,
  View,
  World as WorldService,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import {
  Position,
  Velocity,
  variants as coreVariants,
  measure,
  populate,
  sizes,
} from "./core.ts";
import type { Variant } from "./core.ts";

/**
 * `measure` for what an app runs: each pass calls `run` and yields what it
 * returns, as a driver yields a tick, all in one fiber. The median
 * milliseconds of a pass.
 */
const measureEffect = <E>(
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

// As `bench/core.ts` has them, and constants of this module so that a loop
// reads them at no cost.
const N = 100_000;
const DT = 1 / 60;
if (N !== sizes.entities || DT !== sizes.step) {
  throw new Error("bench/accessors.ts and bench/core.ts differ on N or DT.");
}

const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));
const Seen = Query.all(Position, Velocity);
const Moved = Query.all(Position).pipe(Query.changed(Position));

const Empty = Plugin.make("bench/Empty", {});

/** The N entities of `populate`, spawned by a game's setup. */
const Populated = Plugin.make("bench/Populated", {
  setup: Effect.gen(function* () {
    const commands = yield* Commands.spawns(Position, Velocity);
    for (let i = 0; i < N; i++) {
      commands.spawn(Position.of({ x: i, y: i }), Velocity.of({ x: 1, y: 2 }));
    }
  }),
});

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Nudge = Action.define(
  "bench/Nudge",
  Schema.Struct({ target: EntityId, refuse: Schema.Boolean }),
  { error: Refused }
);
const nudge = Action.handler(Nudge, function* ({ refuse, target }) {
  const world = yield* WorldService.writes(Position);
  const position = world.get(target, Position);
  if (position === undefined) {
    return yield* Refused.make({});
  }
  world.set(target, Position, { x: position.x + 1 });
  if (refuse) {
    return yield* Refused.make({});
  }
});

const Sweep = Action.define(
  "bench/Sweep",
  Schema.Struct({ refuse: Schema.Boolean }),
  { error: Refused }
);
const sweep = Action.handler(Sweep, function* ({ refuse }) {
  (yield* Moving).each((pos, vel) => {
    pos.x += vel.x * DT;
    pos.y += vel.y * DT;
  });
  if (refuse) {
    return yield* Refused.make({});
  }
});

// A handler that looks at every entity and writes none. Through a query
// that says it writes them, its transaction copies the columns it is handed.
const Scan = Action.define("bench/Scan", Schema.Struct({}));
const Written = Query.all(Position, Velocity).pipe(
  Query.writes(Position, Velocity)
);
const scanPlain = Action.handler(Scan, function* () {
  let sum = 0;
  (yield* Written).each((pos, vel) => {
    sum += pos.x + vel.x;
  });
  return sum;
});
const Looked = Query.all(Position, Velocity);
const scanReads = Action.handler(Scan, function* () {
  let sum = 0;
  (yield* Looked).each((pos, vel) => {
    sum += pos.x + vel.x;
  });
  return sum;
});

/** The game a dispatch is measured in: N entities, and the two actions. */
const dispatchable = () =>
  // No checkpoints: this measures the action, not the hash.
  App.make(App.define({ plugins: [Populated], handlers: [nudge, sweep] }), {
    checkpointEvery: 0,
  });

/**
 * Median milliseconds of one dispatch, in an app whose world holds N
 * entities. `send` is given the app and an entity, and returns the dispatch
 * to measure, its payload made once.
 */
const dispatching = (
  send: (
    app: Effect.Success<ReturnType<typeof dispatchable>>,
    target: Entity
  ) => () => Effect.Effect<unknown, Action.InvalidPayload | Refused>,
  runs = 20_000,
  warmup = 5000
): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const app = yield* dispatchable();
      const target = (yield* app.read(Seen)).entities()[N >> 1]!;
      const dispatch = send(app, target);
      return yield* measureEffect(() => Effect.exit(dispatch()), runs, warmup);
    })
  );

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

/**
 * Median milliseconds of reading the devices into the world: three keys
 * held and the pointer somewhere. With `changing`, a fourth key goes down
 * or up before each pass, and the pass includes the tick that applies the
 * report; without, nothing changes and the pass is the input stage alone.
 */
const listening = (changing: boolean): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const source = Input.makeManualSource();
      const app = yield* App.make(App.define({ plugins: [Input.plugin] }), {
        checkpointEvery: 0,
      }).pipe(Effect.provide(Input.layer(source)));
      for (const code of ["ArrowLeft", "ShiftLeft", "Pointer0"]) {
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
      const made = App.make(WithHud, { checkpointEvery: 0 });
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
      const Cues = Sound.cues(
        "bench/Cues",
        Sound.on(Scored, "coin"),
        Sound.on(Bounced, { cue: "thud", volume: 0.5 })
      );
      const app = yield* App.make(
        App.define({ plugins: [Sound.plugin], systems: [Score, Cues] }),
        { checkpointEvery: 0 }
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
      const Score = Sound.music("bench/Music", function* () {
        return (yield* Phase).value === "playing"
          ? { track: "theme", volume: 0.5 }
          : undefined;
      });
      const app = yield* App.make(
        App.define({ plugins: [Sound.plugin], systems: [Score] }),
        { checkpointEvery: 0 }
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
      const app = yield* App.make(Resting, { checkpointEvery: 0 }).pipe(
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

/** Median milliseconds of a frame of `count` systems that read the world or do nothing. */
/**
 * A game of 100,000 moving entities, captured or put back after a tick that
 * moved every one of them, as a rollback session captures and rewinds.
 */
const rewinding = (back: boolean): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const Movement = System.tick("Movement", function* () {
        (yield* Moving).eachChunk((start, end, pos, vel) => {
          for (let n = start; n < end; n++) {
            pos.x[n] = pos.x[n]! + vel.x[n]! * DT;
          }
        });
      });
      const app = yield* App.make(
        App.define({ plugins: [Populated], systems: [Movement] })
      );
      yield* app.tick(DT);
      const moment = yield* Timeline.capture(app);
      let sink = 0;
      const ms = back
        ? yield* measureEffect(
            () =>
              Effect.map(Timeline.rewind(app, moment), () => {
                sink += app.time.tick;
              }),
            300,
            80,
            () => app.tick(DT)
          )
        : yield* measureEffect(
            () =>
              Effect.map(Effect.exit(Timeline.capture(app)), (captured) => {
                sink += Exit.isSuccess(captured) ? 1 : 0;
              }),
            300,
            80,
            () => app.tick(DT)
          );
      void sink;
      return ms;
    })
  );

/**
 * A session's rollback of a tick that wrote 10 of the 100,000 entities: back
 * to run it again, the tick, and a frame whose change query watches them all.
 */
const rollingBack = (): number =>
  Effect.runSync(
    Effect.gen(function* () {
      let ten: readonly Entity[] = [];
      const Write = System.tick("Write", function* () {
        const world = yield* WorldService.writes(Position);
        const { tick } = yield* Time;
        for (const entity of ten) {
          world.set(entity, Position, { x: tick });
        }
      });
      let sink = 0;
      const Draw = System.frame("Draw", function* () {
        (yield* Moved).eachChunk((start, end) => {
          sink += end - start;
        });
      });
      const app = yield* App.make(
        App.define({ plugins: [Populated], systems: [Write, Draw] })
      );
      ten = (yield* app.read(Seen)).entities().slice(0, 10);
      yield* app.tick(DT);
      yield* app.frame(0);
      const moment = yield* Timeline.capture(app);
      yield* app.tick(DT);
      yield* app.frame(0);
      const ms = yield* measureEffect(() =>
        Effect.gen(function* () {
          yield* Timeline.rewind(app, moment, { again: true });
          yield* app.tick(DT);
          yield* app.frame(0);
        })
      );
      void sink;
      return ms;
    })
  );

let sink = 0;

/** A system that draws: it fetches a query and the time, and with `reading` reads every column. */
const drawer = <const I extends number>(i: I, reading: boolean) =>
  System.frame(`Draw${i}`, function* () {
    const moving = yield* Seen;
    yield* Time;
    if (reading) {
      moving.eachChunk((start, end, pos, vel) => {
        const px = pos.x;
        const vx = vel.x;
        for (let n = start; n < end; n++) {
          sink += px[n]! + vx[n]! * DT;
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

/** Median milliseconds of a frame of one system that reads raw columns. */
const drawingRaw = (verify: boolean): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const app = yield* App.make(
        App.define({ plugins: [Populated], systems: [drawer(0, true)] }),
        { verifyFrames: verify }
      );
      const ms = yield* measureEffect(() => app.frame(0.5));
      void sink;
      return ms;
    })
  );

/** Median milliseconds of a dispatch whose handler looks at every entity. */
const scanned = (handler: typeof scanPlain): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const app = yield* App.make(
        App.define({ plugins: [Populated], handlers: [handler] }),
        { checkpointEvery: 0 }
      );
      return yield* measureEffect(
        () => Effect.exit(app.dispatch(Scan, {})),
        300,
        80
      );
    })
  );

const Movement = System.tick("Movement", function* () {
  const moving = yield* Moving;
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
    pos.y += vel.y * delta;
  });
});

const MovementRaw = System.tick("MovementRaw", function* () {
  const moving = yield* Moving;
  const { delta } = yield* Time;
  moving.eachChunk((start, end, pos, vel) => {
    const px = pos.x;
    const py = pos.y;
    const vx = vel.x;
    const vy = vel.y;
    for (let i = start; i < end; i++) {
      px[i]! += vx[i]! * delta;
      py[i]! += vy[i]! * delta;
    }
  });
});

const Red = Component.tag("bench/Red");
const Blue = Component.tag("bench/Blue");
const Reds = Query.all(Transform2d.Position, Overlap.Circle, Red);
const Blues = Query.all(Transform2d.Position, Overlap.Circle, Blue);

/**
 * A thousand red circles against a thousand blue, scattered so that about a
 * pair in a hundred touches, as bullets among enemies do. Nothing is
 * despawned, so every pass tests the same pairs.
 */
const pairing = (): number => {
  const world = new World();
  let seed = 1;
  const next = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  for (const colour of [Red, Blue]) {
    for (let i = 0; i < 1000; i++) {
      world.spawn(
        colour,
        Transform2d.Position.of({ x: next() * 200, y: next() * 200 }),
        Overlap.Circle.of({ radius: 4 })
      );
    }
  }
  const reds = world.view(Reds);
  const blues = world.view(Blues);
  const commands = { despawn: () => {} };
  const keep = (): Overlap.Despawn => "neither";
  return measure(() => {
    Overlap.pairs(commands, reds, blues, keep);
  });
};

const Cell = Component.define("bench/Cell", { x: Field.i32, y: Field.i32 });
const Creatures = Query.all(Cell);

/**
 * A thousand creatures on a map of 80 by 50, and one of them moves: what
 * that costs the next `Grid.occupants`, which works out who is where afresh.
 */
const occupying = (): number => {
  const world = new World();
  let seed = 1;
  const next = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  for (let i = 0; i < 1000; i++) {
    world.spawn(
      Cell.of({ x: Math.floor(next() * 80), y: Math.floor(next() * 50) })
    );
  }
  const map = Grid.fill(80, 50);
  const view = world.view(Creatures);
  const mover = view.entities()[500]!;
  let step = 0;
  return measure(() => {
    step = (step + 1) % 80;
    world.set(mover, Cell, { x: step, y: 25 });
    Grid.occupants(map, view).first(step, 25);
  });
};

const variants: Record<string, Variant> = {
  // The storage core's own, which `bench/core.ts` holds and CI compares.
  ...coreVariants,

  objects: {
    label: "baseline: array of plain objects",
    run: () => {
      const objects = Array.from({ length: N }, (_, i) => ({
        pos: { x: i, y: i },
        vel: { x: 1, y: 2 },
      }));
      return measure(() => {
        for (let i = 0; i < objects.length; i++) {
          const o = objects[i]!;
          o.pos.x += o.vel.x * DT;
          o.pos.y += o.vel.y * DT;
        }
      });
    },
  },

  effectPerEntity: {
    // The thing the design forbids, measured so the rule has a number.
    label: "one Effect per entity (yield* inside the loop)",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const perEntity = Effect.gen(function* () {
        let px!: Float32Array;
        let py!: Float32Array;
        let vx!: ArrayLike<number>;
        let vy!: ArrayLike<number>;
        view.eachChunk((_start, _end, pos, vel) => {
          px = pos.x;
          py = pos.y;
          vx = vel.x;
          vy = vel.y;
        });
        for (let i = 0; i < N; i++) {
          yield* Effect.sync(() => {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          });
        }
      });
      return measure(() => Effect.runSync(perEntity), 60, 20);
    },
  },

  tick: {
    label: "app.tick: one Effect per system, accessors inside",
    run: () =>
      Effect.runSync(
        Effect.gen(function* () {
          const app = yield* App.make(
            App.define({ plugins: [Populated], systems: [Movement] })
          );
          return yield* measureEffect(() => app.tick(DT));
        })
      ),
  },

  tickRaw: {
    label: "app.tick: one Effect per system, raw columns inside",
    run: () =>
      Effect.runSync(
        Effect.gen(function* () {
          const app = yield* App.make(
            App.define({ plugins: [Populated], systems: [MovementRaw] })
          );
          return yield* measureEffect(() => app.tick(DT));
        })
      ),
  },

  idle: {
    // The fixed cost Effect adds: ten systems that each fetch a query and the
    // time, then do nothing. Reported per tick, not per entity.
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
    label: "app.tick: the same, each with a condition that holds",
    run: () => idling("on"),
  },
  idleSkipped: {
    label: "app.tick: the same, each with a condition that does not",
    run: () => idling("off"),
  },

  // What predicting a tick costs: the game is captured before a tick the
  // session is not sure of, and put back when the tick was wrong.
  capture: {
    label: "Timeline.capture(): a game of those 100,000 entities",
    run: () => rewinding(false),
  },
  rewind: {
    label: "Timeline.rewind(): back to that moment",
    run: () => rewinding(true),
  },
  rollback: {
    label: "rollback: rewind, the tick again, a frame watching them",
    run: rollingBack,
  },

  // The frame stage: systems that draw, run between ticks with the world
  // frozen. A frame costs what a tick of the same systems does; checking
  // that it left the world alone costs a hash before and one per system.
  frameIdle: {
    unit: "matches",
    label: "app.frame: 10 systems that do no work",
    run: drawingIdle,
  },
  frameRaw: {
    label: "app.frame: one system reading raw columns",
    run: () => drawingRaw(false),
  },
  frameVerified: {
    label: "app.frame: the same, with verifyFrames",
    run: () => drawingRaw(true),
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

  // What an action costs, in a world of 100,000 entities. A refused action
  // has to leave nothing behind, so what its handler may write is saved
  // first: one row for `world.set`, the visited columns for a query's loop.
  dispatchSet: {
    unit: "dispatch",
    label: "dispatch: handler reads and sets one entity, accepted",
    run: () =>
      dispatching((app, target) => {
        const payload = { target, refuse: false };
        return () => app.dispatch(Nudge, payload);
      }),
  },
  dispatchSetRefused: {
    unit: "dispatch",
    label: "dispatch: the same, refused after its write",
    run: () =>
      dispatching((app, target) => {
        const payload = { target, refuse: true };
        return () => app.dispatch(Nudge, payload);
      }),
  },
  dispatchLoop: {
    unit: "dispatch",
    label: "dispatch: handler loops over all 100,000, accepted",
    run: () =>
      dispatching(
        (app) => {
          const payload = { refuse: false };
          return () => app.dispatch(Sweep, payload);
        },
        300,
        80
      ),
  },
  dispatchLoopRefused: {
    unit: "dispatch",
    label: "dispatch: the same, refused after its loop",
    run: () =>
      dispatching(
        (app) => {
          const payload = { refuse: true };
          return () => app.dispatch(Sweep, payload);
        },
        300,
        80
      ),
  },
  dispatchScan: {
    unit: "dispatch",
    label:
      "dispatch: handler only looks at all 100,000, through a query that writes them",
    run: () => scanned(scanPlain),
  },
  dispatchScanReads: {
    unit: "dispatch",
    label: "dispatch: the same, through a query that only reads",
    run: () => scanned(scanReads),
  },
  pairs: {
    unit: "matches",
    label: "Overlap.pairs: 1,000 circles against 1,000",
    run: pairing,
  },
  occupants: {
    unit: "matches",
    label: "Grid.occupants: one of 1,000 moves on 80 by 50",
    run: occupying,
  },
};

const only = process.argv[2];
if (only === undefined) {
  const self = fileURLToPath(import.meta.url);
  const results: Record<string, number> = {};
  for (const [name, variant] of Object.entries(variants)) {
    // Best of three processes: on a shared machine the fastest run is the
    // one least disturbed by its neighbours.
    let ms = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = execFileSync(
        process.execPath,
        ["--import", "tsx", self, name],
        { encoding: "utf8" }
      );
      ms = Math.min(ms, JSON.parse(out.trim().split("\n").pop()!) as number);
    }
    results[name] = ms;
    const text = name.startsWith("idle")
      ? `${(ms * 1000).toFixed(2).padStart(8)} µs per tick`
      : variant.unit === "matches"
        ? `${(ms * 1000).toFixed(2).padStart(8)} µs per pass`
        : variant.unit === "dispatch"
          ? `${(ms * 1000).toFixed(2).padStart(8)} µs per dispatch`
          : variant.unit === "visit"
            ? `${(ms * 1e6).toFixed(1).padStart(8)} ns per visit`
            : `${((ms * 1e6) / N).toFixed(2).padStart(8)} ns/entity ${ms.toFixed(3).padStart(8)} ms/pass`;
    console.log(`${variant.label.padEnd(54)} ${text}`);
  }
  const ratio = (a: string, b: string) =>
    (results[a]! / results[b]!).toFixed(1) + "x";
  console.log("");
  console.log(
    `accessors (realistic) vs raw columns:   ${ratio("eachMany", "raw")}`
  );
  console.log(
    `accessors (best case) vs raw columns:   ${ratio("each", "raw")}`
  );
  console.log(
    `accessors (ten components) vs raw:      ${ratio("eachComponents", "raw")}`
  );
  console.log(
    `array of objects vs raw columns:        ${ratio("objects", "raw")}`
  );
  console.log(
    `Effect per entity vs raw columns:       ${ratio("effectPerEntity", "raw")}`
  );
  console.log(
    `Effect per entity vs accessors:         ${ratio("effectPerEntity", "eachMany")}`
  );
  console.log(
    `cost of going through app.tick (raw):   ${ratio("tickRaw", "raw")}`
  );
  console.log(
    `sparse "without" filter, raw columns:   ${ratio("withoutChunk", "raw")}`
  );
  console.log(
    `sparse "without" filter, accessors:     ${ratio("withoutEach", "each")}`
  );
  console.log(
    `half the entities excluded, raw columns: ${ratio("halfFrozenChunk", "raw")}`
  );
  console.log(
    `hashing the world vs one pass over it:  ${ratio("hash", "raw")}`
  );
  console.log(
    `writing a watched component, accessors: ${ratio("watchedEach", "each")}`
  );
  console.log(
    `handing out a watched one, raw columns: ${ratio("watchedChunk", "raw")}`
  );
} else {
  // Child process: run one variant and print its median.
  console.log(JSON.stringify(variants[only]!.run()));
}
