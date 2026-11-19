/**
 * A small simulation that uses every piece of the prototype, laid out as a
 * game is: a folder for each plugin, and this file, which makes the app.
 *
 *   pnpm --filter arcadekit demo
 */
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import {
  App,
  Commands,
  Component,
  Driver,
  Field,
  Plugin,
  Random,
  Resource,
  Script,
} from "../../src/index";
import * as Lifetime from "./lifetime/index";
import * as Physics from "./physics/index";
import * as Sketch from "./sketch/index";

const { Frozen, Gravity, Position, Velocity } = Physics;

// The demo itself is a plugin too: the ones it is made of, and the one
// component no plugin of its has.
const Name = Component.define("demo/Name", { value: Field.json<string>() });

const Demo = Plugin.make("Demo", {
  plugins: [Physics.plugin, Lifetime.plugin, Sketch.plugin],
  components: [Name],
});

// --- a script: sequential game logic spread over many ticks --------------------
const Fountain = Effect.gen(function* () {
  const script = yield* Script;
  const commands = yield* Commands;
  // Seeded: the same seed sprays the same fountain on every run and machine.
  const random = yield* Random;

  for (let wave = 1; wave <= 5; wave++) {
    for (let i = 0; i < 100; i++) {
      commands.spawn(
        Position.of({ x: 0, y: 0 }),
        Velocity.of({ x: random.next() * 10 - 5, y: 8 + wave }),
        Lifetime.Lifetime.of({ seconds: 1 + random.next() })
      );
    }

    yield* script.sleep(0.5);
  }

  return "fountain finished";
});

// --- the entry point -------------------------------------------------------------
// App.run makes the app and runs it until it is interrupted: sixty ticks a
// second, and the frame stage each time the display is due, which under
// Node is a timer. Before its first frame it hands the app to `ready`,
// where this demo steps the same app by hand.
const program = Effect.gen(function* () {
  const noted = { ticks: 0, frames: 0, app: undefined as App.Any | undefined };
  yield* App.run(
    { plugins: [Demo], seed: 7 },
    {
      hz: 60,
      ready: (app) =>
        Effect.sync(() => {
          console.log(
            `system order: ${app.systemOrder.join(" -> ")}; each frame: ${app.frameOrder.join(" -> ")}`
          );

          const rock = app.world.spawn(
            Name.of({ value: "rock" }),
            Position.of({ x: 0, y: 100 }),
            Velocity
          );

          app.world.add(rock, Frozen);

          // 1. As fast as possible: three seconds of game time at a fixed 60 Hz.
          const fountain = app.spawnScript(Fountain);
          const step = Driver.fixedStep(app, { hz: 60, maxStepsPerCall: 1000 });
          const started = performance.now();

          for (let second = 1; second <= 3; second++) {
            step(1);
            console.log(
              `t=${app.time.elapsed.toFixed(2)}s tick=${app.time.tick} entities=${app.world.entityCount} ` +
                `rock.y=${app.world.get(rock, Position)!.y.toFixed(1)}`
            );

            if (second === 1) {
              app.world.remove(rock, Frozen);
            } // the rock starts falling
          }

          console.log(
            `180 ticks took ${(performance.now() - started).toFixed(1)} ms; script: ${fountain.pollUnsafe()}`
          );

          // 2. Turn-based: nothing happens until a player acts, then exactly one tick.
          const before = app.time.tick;
          app.tick(1);
          console.log(`turn-based step: tick ${before} -> ${app.time.tick}`);

          // 3. Real time is what App.run does next, from here.
          app.world.spawn(
            Position.of({ x: 0, y: 0 }),
            Velocity.of({ x: 0, y: 30 })
          );
          noted.app = app;
          noted.ticks = app.time.tick;
          noted.frames = Sketch.sketch.frames;
        }),
    }
  ).pipe(
    Effect.provide(Resource.layer(Gravity, -20)),
    // A game runs until its page or its process goes away. This one is
    // interrupted after a quarter of a second, which stops the frame loop
    // and closes the app's scope.
    Effect.timeoutOption("250 millis")
  );
  console.log(
    `real time: ${noted.app!.time.tick - noted.ticks} ticks and ${Sketch.sketch.frames - noted.frames} frames in 250 ms`
  );
});

// runMain runs the program, reports a failure, and interrupts it when the
// process is told to stop.
NodeRuntime.runMain(program);
