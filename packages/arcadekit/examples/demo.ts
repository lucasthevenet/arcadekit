/**
 * A small simulation that uses every piece of the prototype.
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
  Frame,
  Query,
  Random,
  Resource,
  Script,
  System,
  Time,
} from "../src/index";

// --- data --------------------------------------------------------------------
const Position = Component.define("demo/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("demo/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const Lifetime = Component.define("demo/Lifetime", { seconds: Field.f32 });
const Name = Component.define("demo/Name", { value: Field.json<string>() });
// Toggled often, so it lives in a sparse set and never moves entities around.
const Frozen = Component.tag("demo/Frozen", { storage: "sparse" });

const Gravity = Resource.make("demo/Gravity", { defaultValue: () => -9.81 });

const Falling = Query.all(Position, Velocity).pipe(Query.without(Frozen));
const Mortal = Query.all(Lifetime);

// --- systems -----------------------------------------------------------------
const Physics = System.make("Physics", function* () {
  const falling = yield* Falling;
  const gravity = yield* Gravity;
  const { delta } = yield* Time;
  // The hot loop: plain synchronous code over typed arrays, no Effect inside.
  // The query excludes Frozen (a sparse tag), so each table arrives as runs
  // of consecutive rows that are not frozen.
  falling.eachChunk((start, end, pos, vel) => {
    for (let i = start; i < end; i++) {
      vel.y[i]! += gravity * delta;
      pos.x[i]! += vel.x[i]! * delta;
      pos.y[i]! += vel.y[i]! * delta;
    }
  });
});

const Expiry = System.make("Expiry", function* () {
  const mortal = yield* Mortal;
  const commands = yield* Commands;
  const { delta } = yield* Time;
  mortal.each((life, entity) => {
    life.seconds -= delta;
    if (life.seconds <= 0) {
      commands.despawn(entity);
    }
  });
}).pipe(System.after(Physics));

// --- drawing: the frame stage --------------------------------------------------
// Runs once per frame, between ticks, with the world frozen: it reads the
// game and cannot change it. `Frame.alpha` says how far the frame is between
// the last tick and the next, so what moves is drawn where it is by now.
const sketch = { frames: 0, highest: 0 };
const Draw = System.make("Draw", function* () {
  const { alpha } = yield* Frame;
  const { delta } = yield* Time;
  let highest = 0;
  (yield* Falling).eachChunk((start, end, pos, vel) => {
    for (let i = start; i < end; i++) {
      highest = Math.max(highest, pos.y[i]! + vel.y[i]! * delta * alpha);
    }
  });
  sketch.frames++;
  sketch.highest = highest;
}).pipe(System.inStage("frame"));

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
        Lifetime.of({ seconds: 1 + random.next() })
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
    { systems: [Expiry, Physics, Draw], seed: 7 },
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
          noted.frames = sketch.frames;
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
    `real time: ${noted.app!.time.tick - noted.ticks} ticks and ${sketch.frames - noted.frames} frames in 250 ms`
  );
});

// runMain runs the program, reports a failure, and interrupts it when the
// process is told to stop.
NodeRuntime.runMain(program);
