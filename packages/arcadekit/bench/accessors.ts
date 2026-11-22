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
import { Data, Effect, Exit, Schema } from "effect";

import {
  Action,
  App,
  Driver,
  EntityId,
  Event,
  Field,
  Input,
  Query,
  Singleton,
  Sound,
  State,
  System,
  Time,
  Timeline,
  View,
  EcsWorld as World,
  World as WorldService,
} from "../src/index";
import type { Entity } from "../src/index";
import {
  Position,
  Velocity,
  variants as coreVariants,
  measure,
  populate,
  sizes,
} from "./core";
import type { Variant } from "./core";

// As `bench/core.ts` has them, and constants of this module so that a loop
// reads them at no cost.
const N = 100_000;
const DT = 1 / 60;
if (N !== sizes.entities || DT !== sizes.step) {
  throw new Error("bench/accessors.ts and bench/core.ts differ on N or DT.");
}

const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));

class Refused extends Data.TaggedError("Refused")<{}> {}

const Nudge = Action.define(
  "bench/Nudge",
  Schema.Struct({ target: EntityId, refuse: Schema.Boolean })
);
const nudge = Action.handler(Nudge, function* ({ refuse, target }) {
  const world = yield* WorldService;
  const position = world.get(target, Position);
  if (position === undefined) {
    return yield* new Refused();
  }
  world.set(target, Position, { x: position.x + 1 });
  if (refuse) {
    return yield* new Refused();
  }
});

const Sweep = Action.define(
  "bench/Sweep",
  Schema.Struct({ refuse: Schema.Boolean })
);
const sweep = Action.handler(Sweep, function* ({ refuse }) {
  (yield* Moving).each((pos, vel) => {
    pos.x += vel.x * DT;
    pos.y += vel.y * DT;
  });
  if (refuse) {
    return yield* new Refused();
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

/** Median milliseconds of one dispatch, in an app whose world holds N entities. */
const dispatching = <P>(
  action: Action.ActionDef<string, P>,
  payload: (target: Entity) => P,
  runs = 20_000,
  warmup = 5000
): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        // No checkpoints: this measures the action, not the hash.
        const app = yield* App.make({
          handlers: [nudge, sweep],
          checkpointEvery: 0,
        });
        populate(app.world);
        const target = app.world.view(Moving).entities()[N >> 1]!;
        const given = payload(target);
        const dispatch = app.dispatch as (a: unknown, p: unknown) => unknown;
        return measure(() => dispatch(action, given), runs, warmup);
      })
    )
  );

const Power = State.define("bench/Power", ["on", "off"]);

/** Median milliseconds of a tick of ten idle systems that run when the power is on. */
const idling = (power: "on" | "off"): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const systems = Array.from({ length: 10 }, (_, i) =>
          System.make(`Idle${i}`, function* () {
            yield* Moving;
            yield* Time;
          }).pipe(System.runIf(State.is(Power, "on")))
        );
        const app = yield* App.make({ systems });
        yield* Effect.map(Power, (held) => held.set(power)).pipe(
          Effect.provideService(WorldService, app.world)
        );
        return measure(() => app.tick(DT), 50_000, 20_000);
      })
    )
  );

/**
 * Median milliseconds of reading the devices into the world: three keys
 * held and the pointer somewhere. With `changing`, a fourth key goes down
 * or up before each pass, and the pass includes the tick that applies the
 * report; without, nothing changes and the pass is the input stage alone.
 */
const listening = (changing: boolean): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const source = Input.makeManualSource();
        const app = yield* App.make({
          plugins: [Input.plugin],
          checkpointEvery: 0,
        }).pipe(Effect.provideService(Input.Source, source));
        for (const code of ["ArrowLeft", "ShiftLeft", "Pointer0"]) {
          source.press(code);
        }
        source.move(Input.pointerX, 120);
        source.move(Input.pointerY, 80);
        app.input();
        app.tick(DT);
        let down = false;
        return changing
          ? measure(
              () => {
                down = !down;
                if (down) {
                  source.press("Space");
                } else {
                  source.release("Space");
                }
                app.input();
                app.tick(DT);
                // The log is the game's to keep; here it would only grow.
                (app.actionLog as unknown[]).length = 0;
              },
              20_000,
              5000
            )
          : measure(() => app.input(), 50_000, 20_000);
      })
    )
  );

/**
 * Median milliseconds of a frame whose one system publishes a view of four
 * fields, read from a singleton. `"same"`: a UI is listening and the value
 * is what it has. `"new"`: the value differs every frame, and the one
 * listener is told. `"nobody"`: no bridge was provided.
 */
const showing = (mode: "same" | "new" | "nobody"): number =>
  Effect.runSync(
    Effect.scoped(
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
        const ui = View.makeBridge();
        let heard = 0;
        ui.subscribe(Hud, () => {
          heard++;
        });
        const made = App.make({
          plugins: [View.plugin],
          systems: [Show],
          checkpointEvery: 0,
        });
        const app = yield* mode === "nobody"
          ? made
          : made.pipe(Effect.provide(View.layer(ui)));
        return measure(
          () => {
            frames++;
            app.frame(0);
          },
          50_000,
          20_000
        );
      })
    )
  );

/**
 * Median milliseconds of a frame whose one system plays cues for two kinds
 * of event, to an output that plays nothing. With `happening`, a tick
 * before each frame emits one event, and the frame plays its cue; the tick
 * is not timed.
 */
const sounding = (happening: boolean): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const Scored = Event.define("bench/Scored", Schema.Struct({}));
        const Bounced = Event.define("bench/Bounced", Schema.Struct({}));
        const Score = System.make("bench/Score", function* () {
          if (happening) {
            (yield* Scored).emit({});
          }
        });
        const Cues = Sound.cues(
          "bench/Cues",
          Sound.on(Scored, "coin"),
          Sound.on(Bounced, { cue: "thud", volume: 0.5 })
        );
        const app = yield* App.make({
          plugins: [Sound.plugin],
          systems: [Score, Cues],
          checkpointEvery: 0,
        }).pipe(Effect.provide(Sound.layer({ play() {}, music() {} })));
        return measure(
          () => app.frame(0),
          50_000,
          20_000,
          () => app.tick(DT)
        );
      })
    )
  );

/**
 * Median milliseconds of one frame of a game with music that goes on as it
 * was: the body asked what should be playing, a state read, the same answer
 * as the frame before, and the output told nothing.
 */
const scoring = (): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const Phase = State.define("bench/MusicPhase", ["playing", "title"]);
        const Score = Sound.music("bench/Music", function* () {
          return (yield* Phase).value === "playing"
            ? { track: "theme", volume: 0.5 }
            : undefined;
        });
        const app = yield* App.make({
          plugins: [Sound.plugin],
          systems: [Score],
          checkpointEvery: 0,
        }).pipe(Effect.provide(Sound.layer({ play() {}, music() {} })));
        return measure(() => app.frame(0), 50_000, 20_000);
      })
    )
  );

/**
 * Median milliseconds of one frame of a game that ticks when it is needed
 * and is at rest: the devices read, the app asked whether anything waits,
 * no tick, and a frame stage of one system. The game has the picture of
 * the devices, a state and a view, as one with a menu would.
 */
const atRest = (): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const Phase = State.define("bench/RestPhase", ["title", "playing"]);
        const Shown = View.define("bench/Shown", { phase: "title" });
        const Show = View.publish(Shown, function* () {
          return { phase: (yield* Phase).value as string };
        });
        const source = Input.makeManualSource();
        const app = yield* App.make({
          plugins: [Input.plugin, View.plugin],
          systems: [Show],
          checkpointEvery: 0,
        }).pipe(
          Effect.provideService(Input.Source, source),
          Effect.provide(View.layer(View.makeBridge()))
        );
        const advance = Driver.fixedStep(app, { hz: 60, ticks: "whenNeeded" });
        // The first tick enters the state, and one more follows it.
        for (let i = 0; i < 10; i++) {
          advance(DT);
        }
        if (app.time.tick !== 2) {
          throw new Error(
            `The game did not come to rest: tick ${app.time.tick}`
          );
        }
        return measure(() => advance(DT), 50_000, 20_000);
      })
    )
  );

/** Median milliseconds of a frame of `count` systems that read the world or do nothing. */
/** A game of 100,000 moving entities, captured or put back. */
const rewinding = (back: boolean): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const Movement = System.make("Movement", function* () {
          (yield* Moving).eachChunk((start, end, pos, vel) => {
            for (let n = start; n < end; n++) {
              pos.x[n] = pos.x[n]! + vel.x[n]! * DT;
            }
          });
        });
        const app = yield* App.make({ systems: [Movement] });
        populate(app.world);
        app.tick(DT);
        const moment = Timeline.capture(app);
        if (Exit.isFailure(moment)) {
          throw new Error("the game could not be captured");
        }
        let sink = 0;
        const ms = back
          ? measure(() => {
              Timeline.rewind(app, moment.value);
              sink += app.time.tick;
            })
          : measure(() => {
              sink += Exit.isSuccess(Timeline.capture(app)) ? 1 : 0;
            });
        void sink;
        return ms;
      })
    )
  );

const drawing = (count: number, reading: boolean, verify: boolean): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        let sink = 0;
        const systems = Array.from({ length: count }, (_, i) =>
          System.make(`Draw${i}`, function* () {
            const moving = yield* Moving;
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
          }).pipe(System.inStage("frame"))
        );
        const app = yield* App.make({ systems, verifyFrames: verify });
        if (reading) {
          populate(app.world);
        }
        const ms = reading
          ? measure(() => app.frame(0.5))
          : measure(() => app.frame(0.5), 50_000, 20_000);
        void sink;
        return ms;
      })
    )
  );

/** Median milliseconds of a dispatch whose handler looks at every entity. */
const scanned = (handler: typeof scanPlain): number =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* App.make({
          handlers: [handler],
          checkpointEvery: 0,
        });
        populate(app.world);
        return measure(() => app.dispatch(Scan, {}), 300, 80);
      })
    )
  );

const Movement = System.make("Movement", function* () {
  const moving = yield* Moving;
  const { delta } = yield* Time;
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
    pos.y += vel.y * delta;
  });
});

const MovementRaw = System.make("MovementRaw", function* () {
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
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* App.make({ systems: [Movement] });
            populate(app.world);
            return measure(() => app.tick(DT));
          })
        )
      ),
  },

  tickRaw: {
    label: "app.tick: one Effect per system, raw columns inside",
    run: () =>
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* App.make({ systems: [MovementRaw] });
            populate(app.world);
            return measure(() => app.tick(DT));
          })
        )
      ),
  },

  idle: {
    // The fixed cost Effect adds: ten systems that each fetch a query and the
    // time, then do nothing. Reported per tick, not per entity.
    label: "app.tick: 10 systems that do no work",
    run: () =>
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const systems = Array.from({ length: 10 }, (_, i) =>
              System.make(`Idle${i}`, function* () {
                yield* Moving;
                yield* Time;
              })
            );
            const app = yield* App.make({ systems });
            return measure(() => app.tick(DT), 50_000, 20_000);
          })
        )
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

  // The frame stage: systems that draw, run between ticks with the world
  // frozen. A frame costs what a tick of the same systems does; checking
  // that it left the world alone costs a hash before and one per system.
  frameIdle: {
    unit: "matches",
    label: "app.frame: 10 systems that do no work",
    run: () => drawing(10, false, false),
  },
  frameRaw: {
    label: "app.frame: one system reading raw columns",
    run: () => drawing(1, true, false),
  },
  frameVerified: {
    label: "app.frame: the same, with verifyFrames",
    run: () => drawing(1, true, true),
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
    run: () => dispatching(Nudge, (target) => ({ target, refuse: false })),
  },
  dispatchSetRefused: {
    unit: "dispatch",
    label: "dispatch: the same, refused after its write",
    run: () => dispatching(Nudge, (target) => ({ target, refuse: true })),
  },
  dispatchLoop: {
    unit: "dispatch",
    label: "dispatch: handler loops over all 100,000, accepted",
    run: () => dispatching(Sweep, () => ({ refuse: false }), 300, 80),
  },
  dispatchLoopRefused: {
    unit: "dispatch",
    label: "dispatch: the same, refused after its loop",
    run: () => dispatching(Sweep, () => ({ refuse: true }), 300, 80),
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
