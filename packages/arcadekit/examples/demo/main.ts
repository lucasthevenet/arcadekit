/**
 * A small simulation that uses every piece of the prototype, laid out as a
 * game is: a folder for each plugin, and this file, which makes the app.
 *
 *   pnpm --filter arcadekit demo
 */
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Field,
  Plugin,
  Query,
  Random,
  Resource,
  Singleton,
  System,
  Time,
  World,
} from "../../src/index.ts";
import * as Lifetime from "./lifetime/index.ts";
import * as Physics from "./physics/index.ts";
import * as Sketch from "./sketch/index.ts";

const { Frozen, Gravity, Position, Velocity } = Physics;

// --- game logic spread over many ticks ------------------------------------------
// What the fountain is in the middle of is in the world, so a save holds it
// and a replay or a rewind picks it up where it was.
const Spray = Singleton.define(
  "demo/Spray",
  { wave: Field.u8, wait: Field.f32 },
  { wave: 0, wait: 0 }
);
const WAVES = 5;
const Fountain = System.tick("Fountain", function* () {
  const spray = yield* Spray.writes;
  if (spray.wave >= WAVES) {
    return;
  }
  spray.wait -= (yield* Time).delta;
  if (spray.wait > 0) {
    return;
  }
  spray.wave += 1;
  spray.wait = 0.5;
  const commands = yield* Commands.spawns(
    Position,
    Velocity,
    Lifetime.Lifetime
  );
  // Seeded: the same seed sprays the same fountain on every run and machine.
  const random = yield* Random;
  for (let i = 0; i < 100; i++) {
    commands.spawn(
      Position.of({ x: 0, y: 0 }),
      Velocity.of({ x: random.next() * 10 - 5, y: 8 + spray.wave }),
      Lifetime.Lifetime.of({ seconds: 1 + random.next() })
    );
  }
});

// --- what a player does --------------------------------------------------------------
// Code outside the game changes it with actions alone, which the log holds and
// a replay repeats.
const Thaw = Action.define("demo/Thaw");
const thaw = Action.handler(Thaw, function* () {
  const commands = yield* Commands;
  for (const entity of (yield* Query.all(Frozen)).entities()) {
    commands.remove(entity, Frozen);
  }
});
const Launch = Action.define(
  "demo/Launch",
  Schema.Struct({ speed: Schema.Number })
);
const launch = Action.handler(Launch, function* ({ speed }) {
  (yield* Commands.spawns(Position, Velocity)).spawn(
    Position.of({ x: 0, y: 0 }),
    Velocity.of({ x: 0, y: speed })
  );
});

// The demo itself is a plugin too: the ones it is made of, and what no
// plugin of its has.
const Name = Component.define("demo/Name", { value: Field.json<string>() });
const Named = Query.all(Name, Position);
const Demo = Plugin.make("Demo", {
  plugins: [Physics.plugin, Lifetime.plugin, Sketch.plugin],
  systems: [Fountain],
  handlers: [thaw, launch],
  // A rock, held in the air until it thaws.
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Name, Position, Velocity, Frozen)).spawn(
      Name.of({ value: "rock" }),
      Position.of({ x: 0, y: 100 }),
      Velocity,
      Frozen
    );
  }),
});

// --- the entry point -------------------------------------------------------------
// Driver.run makes an app of the game and runs it until it is interrupted: sixty
// ticks a second, and the frame stage each time the display is due, which
// under Node is a timer. Before its first frame, its ready step has the app,
// where this demo steps the same app by hand.
const program = Effect.gen(function* () {
  const noted = { ticks: 0, frames: 0, app: undefined as App.Any | undefined };
  yield* Driver.run(App.define({ plugins: [Demo] }), {
    seed: 7,
    hz: 60,
    ready: (app) =>
      Effect.gen(function* () {
        yield* Console.log(
          `system order: ${app.systemOrder.join(" -> ")}; each frame: ${app.frameOrder.join(" -> ")}`
        );

        // Outside the game, it is read with app.read.
        const world = yield* app.read(World);
        const named = yield* app.read(Named);
        const rockY = (): string => {
          let y = Number.NaN;
          named.each((name, position) => {
            if (name.value === "rock") {
              y = position.y;
            }
          });
          return y.toFixed(1);
        };

        // 1. As fast as possible: three seconds of game time at a fixed 60 Hz.
        const step = Driver.fixedStep(app, { hz: 60, maxStepsPerCall: 1000 });
        const started = performance.now();
        for (let second = 1; second <= 3; second++) {
          step(1);
          yield* Console.log(
            `t=${app.time.elapsed.toFixed(2)}s tick=${app.time.tick} entities=${world.entityCount} ` +
              `rock.y=${rockY()}`
          );
          if (second === 1) {
            app.enqueue(Thaw, undefined);
          } // the rock starts falling
        }
        const { wave } = yield* app.read(Spray);
        yield* Console.log(
          `180 ticks took ${(performance.now() - started).toFixed(1)} ms; fountain: ${wave} of ${WAVES} waves`
        );

        // 2. Turn-based: nothing happens until a player acts, then exactly one tick.
        const before = app.time.tick;
        app.tick(1);
        yield* Console.log(
          `turn-based step: tick ${before} -> ${app.time.tick}`
        );

        // 3. Real time is what Driver.run does next, from here.
        app.enqueue(Launch, { speed: 30 });
        noted.app = app;
        noted.ticks = app.time.tick;
        noted.frames = Sketch.sketch.frames;
      }),
  }).pipe(
    Effect.provide(Resource.layer(Gravity, -20)),
    // A game runs until its page or its process goes away. This one is
    // interrupted after a quarter of a second, which stops the frame loop
    // and closes the app.
    Effect.timeoutOption("250 millis")
  );
  yield* Console.log(
    `real time: ${noted.app!.time.tick - noted.ticks} ticks and ${Sketch.sketch.frames - noted.frames} frames in 250 ms`
  );
});

// runMain runs the program, reports a failure, and interrupts it when the
// process is told to stop.
NodeRuntime.runMain(program);
