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

const program = Effect.gen(function* () {
  const app = yield* App.make({ systems: [Expiry, Physics], seed: 7 }).pipe(
    Effect.provide(Resource.layer(Gravity, -20))
  );
  console.log("system order:", app.systemOrder.join(" -> "));

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

  // 3. Real time: tick on a timer until interrupted, then the timer is cleaned up.
  const ticksBefore = app.time.tick;
  yield* Driver.interval(app, { hz: 60 }).pipe(
    Effect.timeoutOption("250 millis")
  );
  console.log(`real time: ${app.time.tick - ticksBefore} ticks in 250 ms`);
});

// The entry point: runMain runs the program, reports a failure, and
// interrupts it (stopping the timer and closing the app's scope) when the
// process is told to stop.
NodeRuntime.runMain(Effect.scoped(program));
