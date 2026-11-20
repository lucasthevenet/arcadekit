/**
 * Things that fall: where they are, how fast they go, and what pulls them
 * down. The other plugins of the demo import what they need of it from
 * here, and nothing from `loops.ts`.
 */
import {
  Component,
  Field,
  Plugin,
  Query,
  Resource,
  System,
  Time,
} from "../../../src/index";
import { fall } from "./loops";

export const Position = Component.define("demo/Position", {
  x: Field.f32,
  y: Field.f32,
});
export const Velocity = Component.define("demo/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
// Toggled often, so it lives in a sparse set and never moves entities around.
export const Frozen = Component.tag("demo/Frozen", { storage: "sparse" });

export const Gravity = Resource.make("demo/Gravity", {
  defaultValue: () => -9.81,
});

export const Falling = Query.all(Position, Velocity).pipe(
  Query.without(Frozen)
);

// The system reads what the loop needs, and the loop does the rest. The
// query excludes Frozen, a sparse tag, so each table arrives as runs of
// consecutive rows that are not frozen: a sparse component filters a raw
// loop, and is not its data.
export const Physics = System.make("Physics", function* () {
  const gravity = yield* Gravity;
  const { delta } = yield* Time;
  (yield* Falling).eachChunk((start, end, pos, vel) =>
    fall(start, end, pos.x, pos.y, vel.x, vel.y, gravity, delta)
  );
});

export const plugin = Plugin.make("Physics", {
  systems: [Physics],
});
