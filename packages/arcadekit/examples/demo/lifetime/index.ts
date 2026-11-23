/** Things that last a while, and are gone when their time is up. */
import {
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  System,
  Time,
} from "../../../src/index";
import * as Physics from "../physics/index";

export const Lifetime = Component.define("demo/Lifetime", {
  seconds: Field.f32,
});

const Mortal = Query.all(Lifetime).pipe(Query.writes(Lifetime));

// It despawns from a callback per entity, through `Commands`: that is not
// a raw loop, so it stays here and not in a module of loops.
const Expiry = System.tick("Expiry", function* () {
  const mortal = yield* Mortal;
  const commands = yield* Commands;
  const { delta } = yield* Time;
  mortal.each((life, entity) => {
    life.seconds -= delta;
    if (life.seconds <= 0) {
      commands.despawn(entity);
    }
  });
});

export const plugin = Plugin.make("Lifetime", {
  plugins: [Physics.plugin],
  systems: [Expiry],
});
