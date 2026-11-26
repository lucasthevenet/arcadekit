/**
 * Timers on the game's clock: a cooldown, a lifetime, and a system that runs
 * every so often.
 *
 *   const Gun = Component.define("game/Gun", { cooldown: Timer.field })
 *
 *   (yield* Guns).each((gun) => {
 *     gun.cooldown = Timer.tick(gun.cooldown, delta)
 *     if (firing && Timer.ready(gun.cooldown)) {
 *       gun.cooldown = 0.2
 *       ...
 *     }
 *   })
 *
 *   commands.spawn(Bullet.of({ ... }), Timer.lifetime(1.5))   // gone in 1.5 s
 *
 *   System.tick("game/Rain", function* () { ... }).pipe(Timer.every(1))
 *
 * A timer is the seconds it has left, a number in the world: a field of a
 * component or a singleton, the `Timer.Lifetime` component, or the singleton
 * that `Timer.every` keeps for its system. So a save holds it, the hash covers
 * it, and a rewind and a replay count it down the same way. Game time moves
 * on only as the game ticks, by `Time.delta`, never by the wall clock.
 *
 * A timer that runs is written on every tick, which keeps a game that ticks
 * only when needed ticking. A timer that has run out is 0, and stays 0.
 */
import { Effect } from "effect";
import { dual } from "effect/Function";

import { Component, Field } from "./ecs/component.ts";
import * as Plugin from "./Plugin.ts";
import * as Query from "./Query.ts";
import { Commands, Time } from "./Services.ts";
import type { Sim, World } from "./Services.ts";
import * as Singleton from "./Singleton.ts";
import * as System from "./System.ts";

/**
 * A field that holds a timer: the seconds it has left, in a `Float64Array`.
 * Added without a value, it is 0, and ready.
 *
 *   const Gun = Component.define("game/Gun", { cooldown: Timer.field })
 *
 * @category Fields
 */
export const field = Field.f64;

/**
 * Returns the seconds a timer has left after `delta` more seconds of game
 * time, and never less than 0.
 *
 *   gun.cooldown = Timer.tick(gun.cooldown, delta)   // in a loop of the tick
 *
 * **Details**
 *
 * - It allocates nothing, so it belongs in a loop over a query's rows.
 * - A timer that has run out stays at 0, so writing it again changes nothing,
 *   and a game that ticks only when needed can rest.
 *
 * **Gotchas**
 *
 * - A timer goes down only where the game writes this back to it. One that
 *   nothing ticks keeps the seconds it was given.
 *
 * @category Utilities
 */
export const tick = (left: number, delta: number): number =>
  left > delta ? left - delta : 0;

/**
 * Returns whether a timer has run out.
 *
 *   if (Timer.ready(gun.cooldown)) gun.cooldown = 0.2
 *
 * @category Utilities
 */
export const ready = (left: number): boolean => left <= 0;

/**
 * The seconds an entity has left before `Timer.plugin` despawns it.
 *
 * **When to use**
 *
 * Use for what goes after a while: a bullet, a spark, a message on screen.
 * `Timer.lifetime` gives it a value. For a timer that the game reads and
 * restarts itself, use a `Timer.field` of its own component.
 *
 * **Gotchas**
 *
 * - Nothing counts it down without `Timer.plugin` among the game's plugins.
 *
 * @category Components
 */
export const Lifetime = Component.define("arcadekit/Timer.Lifetime", {
  left: field,
});

/**
 * Returns a `Timer.Lifetime` of `seconds`, to spawn or add with an entity.
 *
 *   const commands = yield* Commands.spawns(Bullet, Timer.Lifetime)
 *   commands.spawn(Bullet.of({ dx: 4 }), Timer.lifetime(1.5))
 *
 * **Details**
 *
 * - `Timer.plugin` counts it down by each tick's `delta`, at the start of each
 *   tick after the one it was spawned in, and despawns the entity on the tick
 *   it runs out.
 *
 * @category Constructors
 */
export const lifetime = (seconds: number) => Lifetime.of({ left: seconds });

const Mortal = Query.all(Lifetime).pipe(Query.writes(Lifetime));

const Expire = System.tick("arcadekit/Timer.Expire", function* () {
  const { delta } = yield* Time;
  const commands = yield* Commands;
  (yield* Mortal).each((life, entity) => {
    life.left = tick(life.left, delta);
    if (life.left <= 0) {
      commands.despawn(entity);
    }
  });
}).pipe(System.inStage("preUpdate"));

/**
 * The plugin that counts every `Timer.Lifetime` down, and despawns its entity
 * when it runs out. It runs in `"preUpdate"`, so the game's systems in
 * `"update"` never see an entity whose time is up.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Timer", { systems: [Expire] });

type TickStage = (typeof System.stages)[number];

type OfTheTick<St> = St extends TickStage
  ? unknown
  : "Timer.every counts the game's time, which only the tick moves on. Give it a system of the tick, made with System.tick.";

/**
 * Runs a system of the tick once every `seconds` of game time, first when
 * `seconds` have gone by.
 *
 *   const Rain = System.tick("catch/Rain", function* () {
 *     ...
 *   }).pipe(Timer.every(1))
 *
 * **Details**
 *
 * - The time to the next run is a singleton of the world, named after the
 *   system, `"arcadekit/Timer.every(catch/Rain)"`. A save holds it, the hash
 *   covers it, and a rewind puts it back.
 * - It is a condition, as `System.runIf` gives one, and counts down only on a
 *   tick on which it is checked. After `System.runIf(State.is(Phase,
 *   "playing"))` it waits while the game is not playing. Before it, it counts
 *   on, and a run that falls due while the game is not playing is skipped.
 * - A run late by part of a tick makes the next one that much sooner, so the
 *   runs keep to their beat. A system runs at most once per tick, however
 *   many periods the tick spans.
 *
 * **Gotchas**
 *
 * - A system of the frame or the input stage doesn't compile with it, and a
 *   period that is not a positive number throws.
 * - Renaming the system renames the singleton: a save taken before it starts
 *   the count again.
 *
 * @category Combinators
 */
export const every: {
  (
    seconds: number
  ): <E, R, N extends string, St extends System.Stage>(
    self: System.System<E, R, N, St, undefined> & OfTheTick<St>
  ) => System.System<E, R | World | Time, N, St, undefined>;
  <E, R, N extends string, St extends System.Stage>(
    self: System.System<E, R, N, St, undefined> & OfTheTick<St>,
    seconds: number
  ): System.System<E, R | World | Time, N, St, undefined>;
} = dual(
  2,
  <E, R, N extends string, St extends TickStage>(
    self: System.System<E, R, N, St, undefined>,
    seconds: number
  ): System.System<E, R | World | Time, N, St, undefined> => {
    if (!(seconds > 0 && Number.isFinite(seconds))) {
      throw new Error(
        `Timer.every(${seconds}) on system "${self.name}": the period is the seconds between two runs, a positive number.`
      );
    }
    const clock = Singleton.define(
      `arcadekit/Timer.every(${self.name})`,
      { left: field },
      { left: seconds }
    );
    const due = Effect.zipWith(
      Effect.service(Time),
      clock.writes,
      (time, timer) => {
        const left = timer.left - time.delta;
        if (left > 0) {
          timer.left = left;
          return false;
        }
        timer.left = left + seconds * (Math.floor(-left / seconds) + 1);
        return true;
      }
    );
    // runIf checks the stage of what it is given, which the tick's stages
    // pass whichever one it is: the system keeps the one it had.
    const gated = System.runIf<
      E,
      R,
      N,
      TickStage,
      undefined,
      never,
      World | Time | Sim
    >(self, due);
    return { ...gated, stage: self.stage };
  }
);
