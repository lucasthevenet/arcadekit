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
import { Data, Effect, Schema } from "effect";

import { World } from "../src/ecs/world";
import {
  Action,
  App,
  Component,
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
  View,
  World as WorldService,
} from "../src/index";
import type { Entity } from "../src/index";

const N = 100_000;
const DT = 1 / 60;

const Position = Component.define("bench/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("bench/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const tags = [0, 1, 2, 3, 4].map((i) => Component.tag(`bench/Tag${i}`));
const Frozen = Component.tag("bench/Frozen", { storage: "sparse" });
const Heat = Component.define(
  "bench/Heat",
  { degrees: Field.f32 },
  { storage: "sparse" }
);
const Moving = Query.all(Position, Velocity);
const Aims = Component.relation("bench/Aims", { onTargetDespawn: "remove" });
const Child = Component.relation("bench/Child", { onTargetDespawn: "despawn" });

/** Gives the sparse tag to one entity in every `n`. */
const tagEvery = (world: World, n: number): void => {
  const all = world.view(Query.all(Position)).entities();
  for (let i = 0; i < all.length; i += n) {
    world.add(all[i]!, Frozen);
  }
};

const populate = (world: World, fragmented = false): void => {
  for (let i = 0; i < N; i++) {
    const extra = fragmented ? tags.filter((_, bit) => (i >> bit) & 1) : [];
    world.spawn(
      Position.of({ x: i, y: i }),
      Velocity.of({ x: 1, y: 2 }),
      ...extra
    );
  }
};

/**
 * Median milliseconds per call. `before`, when given, runs ahead of every
 * call and is not timed: it puts back what the call uses up.
 */
const measure = (
  run: () => void,
  runs = 300,
  warmup = 80,
  before?: () => void
): number => {
  for (let i = 0; i < warmup; i++) {
    before?.();
    run();
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    before?.();
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1]!;
};

/** Visits only the entities whose position was written since its last visit. */
const Repositioned = Query.all(Velocity).pipe(Query.changed(Position));

class Refused extends Data.TaggedError("Refused")<{}> {}

const Nudge = Action.define(
  "bench/Nudge",
  Schema.Struct({ target: EntityId, refuse: Schema.Boolean })
);
const nudge = Action.handler(Nudge, function* ({ refuse, target }) {
  const world = yield* WorldService;
  const position = world.get(target, Position);
  if (position === undefined) {
    return yield* Effect.fail(new Refused());
  }
  world.set(target, Position, { x: position.x + 1 });
  if (refuse) {
    return yield* Effect.fail(new Refused());
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
    return yield* Effect.fail(new Refused());
  }
});

// A handler that looks at every entity and writes none. Without the word
// that it only reads, its transaction copies the columns it is handed.
const Scan = Action.define("bench/Scan", Schema.Struct({}));
const scanPlain = Action.handler(Scan, function* () {
  let sum = 0;
  (yield* Moving).each((pos, vel) => {
    sum += pos.x + vel.x;
  });
  return sum;
});
const MovingRead = Moving.pipe(Query.reads());
const scanReads = Action.handler(Scan, function* () {
  let sum = 0;
  (yield* MovingRead).each((pos, vel) => {
    sum += pos.x + vel.x;
  });
  return sum;
});

/** Median milliseconds of one dispatch, in an app whose world holds N entities. */
const dispatching = <P>(
  action: Action.ActionDef<any, P, any>,
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
        app.spawnScript(Effect.map(Power, (held) => held.set(power)));
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
          components: [Stats],
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
        }).pipe(Effect.provide(Sound.layer({ play() {} })));
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
          components: [Phase],
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

const variants: Record<
  string,
  {
    readonly label: string;
    /** How to report the time: divided by all entities, or for the whole pass. */
    readonly unit?: "entity" | "matches" | "dispatch" | "visit";
    readonly run: () => number;
  }
> = {
  raw: {
    label: "eachChunk: raw typed-array columns",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
      });
    },
  },

  each: {
    label: "each: accessors, only one system in the program",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  eachMany: {
    // A real game calls each() from dozens of systems, so V8 can no longer
    // inline the callback. This is the number to plan around.
    label: "each: accessors, after 6 other systems used each()",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const positions = world.view(Query.all(Position));
      const velocities = world.view(Query.all(Velocity));
      let sink = 0;
      for (let pass = 0; pass < 80; pass++) {
        positions.each((pos) => {
          sink += pos.x;
        });
        positions.each((pos) => {
          sink += pos.y;
        });
        velocities.each((vel) => {
          sink += vel.x;
        });
        velocities.each((vel, entity) => {
          sink += entity;
        });
        view.each((pos, vel) => {
          sink += pos.x - vel.y;
        });
        view.each((_, vel, entity) => {
          sink += vel.x + entity;
        });
      }
      void sink;
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  closures: {
    // What a fallback for strict-CSP pages would cost: getters that close
    // over the field name instead of being generated as static reads.
    label: "accessors without code generation",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const closureAccessor = (fields: readonly string[]) => {
        const acc: any = { _i: 0, _cols: undefined };
        for (const field of fields) {
          Object.defineProperty(acc, field, {
            get() {
              return this._cols[field][this._i];
            },
            set(value: number) {
              this._cols[field][this._i] = value;
            },
          });
        }
        return acc;
      };
      const cPos = closureAccessor(["x", "y"]);
      const cVel = closureAccessor(["x", "y"]);
      return measure(
        () => {
          view.eachChunk((start, end, pos, vel) => {
            cPos._cols = pos;
            cVel._cols = vel;
            for (let i = start; i < end; i++) {
              cPos._i = i;
              cVel._i = i;
              cPos.x += cVel.x * DT;
              cPos.y += cVel.y * DT;
            }
          });
        },
        100,
        30
      );
    },
  },

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

  fragmented: {
    label: "each: same entities spread over 32 tables",
    run: () => {
      const world = new World();
      populate(world, true);
      const view = world.view(Moving);
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  fragmentedRaw: {
    label: "eachChunk: same entities spread over 32 tables",
    run: () => {
      const world = new World();
      populate(world, true);
      const view = world.view(Moving);
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
      });
    },
  },

  withoutEach: {
    label: "each: without a sparse tag that 1% of entities have",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(Moving.pipe(Query.without(Frozen)));
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  withoutChunk: {
    label: "eachChunk: without a sparse tag that 1% have",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(Moving.pipe(Query.without(Frozen)));
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
      });
    },
  },

  withMask: {
    unit: "matches",
    label: "each: with a sparse tag 1 in 100 have, mask",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(Moving.pipe(Query.with(Frozen)));
      view._path = "mask";
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  withSorted: {
    unit: "matches",
    label: "each: with a sparse tag 1 in 100 have, sorted",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(Moving.pipe(Query.with(Frozen)));
      view._path = "sorted";
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  halfFrozenChunk: {
    label: "eachChunk: without a sparse tag every other entity has",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 2);
      const view = world.view(Moving.pipe(Query.without(Frozen)));
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
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
        let vx!: Float32Array;
        let vy!: Float32Array;
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
  hash: {
    // The same world as the first line: four float fields and an id per
    // entity, so five 32-bit words each.
    label: "world.hash(): 100,000 entities in one table",
    run: () => {
      const world = new World();
      populate(world);
      let sink = 0;
      const ms = measure(() => {
        sink ^= world.hash();
      });
      void sink;
      return ms;
    },
  },

  hashFragmented: {
    label: "world.hash(): same entities spread over 32 tables",
    run: () => {
      const world = new World();
      populate(world, true);
      let sink = 0;
      const ms = measure(() => {
        sink ^= world.hash();
      });
      void sink;
      return ms;
    },
  },

  hashSparse: {
    // Every entity also has a sparse component with one float field, whose
    // members are hashed one by one so that their order does not matter.
    label: "world.hash(): the same, plus a sparse field on each",
    run: () => {
      const world = new World();
      populate(world);
      for (const entity of world.view(Query.all(Position)).entities()) {
        world.add(entity, Heat.of({ degrees: 1 }));
      }
      let sink = 0;
      const ms = measure(() => {
        sink ^= world.hash();
      });
      void sink;
      return ms;
    },
  },
  snapshot: {
    // The same world as the first line: per entity an id, four floats and a
    // generation, 22 bytes.
    label: "world.snapshot(): 100,000 entities in one table",
    run: () => {
      const world = new World();
      populate(world);
      let sink = 0;
      const ms = measure(() => {
        sink += world.snapshot().length;
      });
      void sink;
      return ms;
    },
  },

  load: {
    label: "world.load(): the same snapshot, into a new world",
    run: () => {
      const world = new World();
      populate(world);
      const bytes = world.snapshot();
      let sink = 0;
      const ms = measure(() => {
        const fresh = new World();
        fresh.load(bytes, [Position, Velocity]);
        sink += fresh.entityCount;
      });
      void sink;
      return ms;
    },
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

  // A game that ticks when it is needed, at rest: what a frame costs when
  // no tick runs.
  restFrame: {
    unit: "matches",
    label: "a frame of a game at rest: devices, a view, no tick",
    run: () => atRest(),
  },

  // Change detection. A write is noticed per row, and only for a component
  // some query watches: here Position, watched by `Repositioned`. Before
  // each timed pass the watching query visits, untimed, so that the pass
  // has every row to note afresh, which is the most a write can cost.
  watchedEach: {
    label: "each: writing a watched component, all noted",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const watcher = world.view(Repositioned);
      return measure(
        () => {
          view.each((pos, vel) => {
            pos.x += vel.x * DT;
            pos.y += vel.y * DT;
          });
        },
        300,
        80,
        () => watcher.eachChunk(() => {})
      );
    },
  },
  watchedEachNoted: {
    label: "each: the same, every row noted already",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      world.view(Repositioned).eachChunk(() => {});
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },
  watchedChunk: {
    label: "eachChunk: handed a watched component, all noted",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const watcher = world.view(Repositioned);
      return measure(
        () => {
          view.eachChunk((start, end, pos, vel) => {
            const px = pos.x;
            const py = pos.y;
            const vx = vel.x;
            const vy = vel.y;
            for (let i = start; i < end; i++) {
              px[i]! += vx[i]! * DT;
              py[i]! += vy[i]! * DT;
            }
          });
        },
        300,
        80,
        () => watcher.eachChunk(() => {})
      );
    },
  },
  watchedChunkReads: {
    label: "eachChunk: handed a watched component it only reads",
    run: () => {
      const world = new World();
      populate(world);
      // Velocity is written from Position, which the query only reads.
      const view = world.view(Moving.pipe(Query.reads(Position)));
      const watcher = world.view(Repositioned);
      return measure(
        () => {
          view.eachChunk((start, end, pos, vel) => {
            const px = pos.x;
            const py = pos.y;
            const vx = vel.x;
            const vy = vel.y;
            for (let i = start; i < end; i++) {
              vx[i]! += px[i]! * DT;
              vy[i]! += py[i]! * DT;
            }
          });
        },
        300,
        80,
        () => watcher.eachChunk(() => {})
      );
    },
  },
  changedNone: {
    unit: "visit",
    label: "change query: nothing changed",
    run: () => {
      const world = new World();
      populate(world);
      const watcher = world.view(Repositioned);
      watcher.eachChunk(() => {});
      let sink = 0;
      const ms = measure(
        () => {
          // A thousand visits a sample: one is too short to time.
          for (let i = 0; i < 1000; i++) {
            watcher.each((vel) => {
              sink += vel.x;
            });
          }
        },
        2000,
        500
      );
      void sink;
      return ms / 1000;
    },
  },
  changedOne: {
    unit: "visit",
    label: "change query: one write in 100,000, set and visit",
    run: () => {
      const world = new World();
      populate(world);
      const watcher = world.view(Repositioned);
      watcher.eachChunk(() => {});
      const target = world.view(Moving).entities()[N >> 1]!;
      let sink = 0;
      const ms = measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            world.set(target, Position, { x: i });
            watcher.each((vel) => {
              sink += vel.x;
            });
          }
        },
        2000,
        500
      );
      void sink;
      return ms / 1000;
    },
  },
  changedPercent: {
    unit: "matches",
    label: "change query: visiting the 1,000 written, of 100,000",
    run: () => {
      const world = new World();
      populate(world);
      const watcher = world.view(Repositioned);
      watcher.eachChunk(() => {});
      const all = world.view(Moving).entities();
      let sink = 0;
      const ms = measure(
        () => {
          watcher.each((vel) => {
            sink += vel.x;
          });
        },
        2000,
        500,
        () => {
          for (let i = 0; i < N; i += 100) {
            world.set(all[i]!, Position, { x: i });
          }
        }
      );
      void sink;
      return ms;
    },
  },
  changedAll: {
    label: "change query: visiting all 100,000, all written",
    run: () => {
      const world = new World();
      populate(world);
      const writer = world.view(Query.all(Position));
      const watcher = world.view(Repositioned);
      let sink = 0;
      const ms = measure(
        () => {
          watcher.each((vel) => {
            sink += vel.x;
          });
        },
        300,
        80,
        () =>
          writer.each((pos) => {
            pos.x += 1;
          })
      );
      void sink;
      return ms;
    },
  },

  // Entities coming and going: a thousand spawned and despawned again, in
  // the world of 100,000. Despawning looks for who points at the entity.
  churn: {
    unit: "matches",
    label: "spawn 1,000 entities and despawn them again",
    run: () => {
      const world = new World();
      populate(world);
      const made: Entity[] = [];
      return measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            made.push(
              world.spawn(
                Position.of({ x: i, y: i }),
                Velocity.of({ x: 1, y: 2 })
              )
            );
          }
          for (let i = 0; i < 1000; i++) {
            world.despawn(made[i]!);
          }
          made.length = 0;
        },
        2000,
        500
      );
    },
  },

  churnRelated: {
    unit: "matches",
    label: "the same, each pointing at one entity with a relation",
    run: () => {
      const world = new World();
      populate(world);
      const anchor = world.spawn(Position.of({ x: 0, y: 0 }));
      const made: Entity[] = [];
      return measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            made.push(
              world.spawn(
                Position.of({ x: i, y: i }),
                Velocity.of({ x: 1, y: 2 }),
                Aims.of({ target: anchor })
              )
            );
          }
          for (let i = 0; i < 1000; i++) {
            world.despawn(made[i]!);
          }
          made.length = 0;
        },
        2000,
        500
      );
    },
  },
  cascade: {
    unit: "matches",
    label: "despawn 100 parents, each taking its 10 children",
    run: () => {
      const world = new World();
      populate(world);
      const parents: Entity[] = [];
      return measure(
        () => {
          for (let i = 0; i < 100; i++) {
            world.despawn(parents[i]!);
          }
          parents.length = 0;
        },
        2000,
        500,
        () => {
          for (let i = 0; i < 100; i++) {
            const parent = world.spawn(Position.of({ x: i, y: i }));
            parents.push(parent);
            for (let c = 0; c < 10; c++) {
              world.spawn(
                Position.of({ x: c, y: c }),
                Child.of({ target: parent })
              );
            }
          }
        }
      );
    },
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
    label: "dispatch: handler only looks at all 100,000",
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
    `no-codegen accessors vs raw columns:    ${ratio("closures", "raw")}`
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
