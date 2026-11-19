import { Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  EntityId,
  Field,
  Query,
  Random,
  Script,
  System,
  Time,
  World,
} from "../src/index";
import type { Entity } from "../src/index";

// --- a small game: coins are dropped, drift about at random, and are taken ------

const Coin = Component.define("rp/Coin", { value: Field.i32, x: Field.f32 });
const Coins = Query.all(Coin);

const Drop = Action.define("rp/Drop", Schema.Struct({ value: Schema.Int }));
const Take = Action.define("rp/Take", Schema.Struct({ coin: EntityId }));

class NoSuchCoin extends Data.TaggedError("NoSuchCoin")<{
  readonly coin: Entity;
}> {}

const drop = Action.handler(Drop, function* ({ value }) {
  const random = yield* Random;

  return (yield* Commands).spawn(Coin.of({ value, x: random.next() }));
});

const take = Action.handler(Take, function* ({ coin }) {
  const world = yield* World;
  const held = world.get(coin, Coin);

  if (held === undefined) {
    return yield* Effect.fail(new NoSuchCoin({ coin }));
  }

  (yield* Commands).despawn(coin);

  return held.value;
});

const Drift = System.make("Drift", function* () {
  const random = yield* Random;
  (yield* Coins).each((coin) => {
    coin.x += random.next() - 0.5;
  });
});

/**
 * A build of the game with a bug in it: on one tick it does something the
 * recorded game did not do.
 */
const fault = (onTick: number, kind: "nudge" | "lose") =>
  System.make("Fault", function* () {
    if ((yield* Time).tick !== onTick) {
      return;
    }

    const commands = yield* Commands;
    let first = true;
    (yield* Coins).each((coin, entity) => {
      if (!first) {
        return;
      }

      first = false;

      if (kind === "nudge") {
        coin.x += 1e-6;
      } else {
        commands.despawn(entity);
      }
    });
  });

interface Options {
  readonly seed?: number;
  readonly checkpointEvery?: number;
  readonly faulty?: ReturnType<typeof fault>;
}

const game = (options: Options = {}) =>
  App.make({
    // A fault on tick -1 never happens: that is the game as it should be.
    systems: [Drift, options.faulty ?? fault(-1, "nudge")],
    handlers: [drop, take],
    seed: options.seed ?? 1,
    ...(options.checkpointEvery === undefined
      ? {}
      : { checkpointEvery: options.checkpointEvery }),
  });

const withApp = <T, A>(
  make: Effect.Effect<T, never, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

const checkpoints = (log: readonly Action.LogEntry[]): Action.Checkpoint[] =>
  log.filter((entry) => Action.isCheckpoint(entry));

/**
 * Plays a game of random moves, every one of them accepted, and returns its
 * log with the hash the world had after each tick.
 */
const record = (options: Options & { readonly ticks: number }) =>
  withApp(game(options), (app) => {
    const dice = new EcsWorld({ seed: 99 }).random;
    const coins: Entity[] = [];
    const hashes: number[] = [];
    const starting = app.world.hash();

    for (let tick = 0; tick < options.ticks; tick += 1) {
      const roll = dice.int(1, 6);

      if (roll <= 2 || tick < 3) {
        const exit = app.dispatch(Drop, { value: dice.int(1, 9) });

        if (Exit.isSuccess(exit)) {
          coins.push(exit.value);
        }
      } else if (roll === 3 && coins.length > 1) {
        // Never the oldest coin: a later test takes that one itself.
        const [coin] = coins.splice(dice.int(1, coins.length - 1), 1);
        app.enqueue(Take, { coin: coin! });
      }

      app.tick(1 / 60);
      hashes.push(app.world.hash());
    }

    return {
      log: [...app.actionLog],
      hashes,
      starting,
      coins,
      ticks: options.ticks,
    };
  });

/** Replays a log into a fresh game and returns what stopped it, if anything did. */
const replayInto = (
  options: Options,
  log: readonly Action.LogEntry[],
  ticks: number
) =>
  withApp(game(options), (app) => {
    let stopped: App.ReplayDiverged | undefined;

    try {
      App.replay(app, log, { delta: 1 / 60, ticks });
    } catch (error) {
      if (!(error instanceof App.ReplayDiverged)) {
        throw error;
      }

      stopped = error;
    }

    return {
      stopped,
      tick: app.time.tick,
      hash: app.world.hash(),
      log: [...app.actionLog],
    };
  });

describe("checkpoints", () => {
  it("are recorded before the first action or tick, and after every tick the interval divides", () => {
    const recorded = record({ ticks: 10, checkpointEvery: 3 });
    expect(checkpoints(recorded.log).map((entry) => entry.tick)).toEqual([
      0, 3, 6, 9,
    ]);
    // Each is the world's hash at that point: the first before anything
    // happened, the others when that many ticks had completed.
    expect(checkpoints(recorded.log).map((entry) => entry.hash)).toEqual([
      recorded.starting,
      recorded.hashes[2],
      recorded.hashes[5],
      recorded.hashes[8],
    ]);
    // The log is in the order things happened: the first checkpoint, then
    // the first move, and each later checkpoint ahead of the moves that
    // were made once its tick had completed.
    expect(Action.isCheckpoint(recorded.log[0]!)).toBe(true);

    for (let i = 1; i < recorded.log.length; i += 1) {
      expect(recorded.log[i]!.tick).toBeGreaterThanOrEqual(
        recorded.log[i - 1]!.tick
      );
    }

    const third = recorded.log.findIndex(
      (entry) => Action.isCheckpoint(entry) && entry.tick === 3
    );

    expect(recorded.log.slice(0, third).every((entry) => entry.tick < 3)).toBe(
      true
    );
    expect(
      recorded.log.slice(third + 1).every((entry) => entry.tick >= 3)
    ).toBe(true);
    expect(moves(recorded.log).length).toBeGreaterThan(3);
  });

  it("are taken when a tick is over, after the commands its scripts queued are applied", () => {
    withApp(game({ checkpointEvery: 1 }), (app) => {
      // A script's commands are the last thing a tick applies.
      app.spawnScript(
        Effect.gen(function* () {
          const script = yield* Script;
          const commands = yield* Commands;

          for (;;) {
            yield* script.nextTick;
            commands.spawn(Coin.of({ value: 1, x: 0 }));
          }
        })
      );

      for (let tick = 1; tick <= 5; tick += 1) {
        app.tick(1 / 60);
        expect(app.world.entityCount).toBe(tick);
        expect(app.actionLog.at(-1)).toEqual({
          tick,
          hash: app.world.hash(),
        });
      }
    });
  });

  it("come every 60 ticks unless told otherwise, every tick with 1, and never with 0", () => {
    const ticksOf = (checkpointEvery?: number) =>
      checkpoints(
        record({
          ticks: 130,
          ...(checkpointEvery === undefined ? {} : { checkpointEvery }),
        }).log
      ).map((entry) => entry.tick);

    expect(ticksOf()).toEqual([0, 60, 120]);
    expect(ticksOf(1)).toEqual(Array.from({ length: 131 }, (_, i) => i));
    expect(ticksOf(50)).toEqual([0, 50, 100]);
    expect(ticksOf(1000)).toEqual([0]);
    expect(ticksOf(0)).toEqual([]);

    for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => withApp(game({ checkpointEvery: bad }), () => 0)).toThrow(
        /checkpointEvery must be a whole number of ticks/u
      );
    }
  });

  it("start from the state the game starts from, not the state the app was made in", () => {
    // Whichever comes first: a tick, a move, a queued move, a move by name,
    // or a move that is refused.
    type Game = Effect.Success<ReturnType<typeof game>>;

    const firsts: ((app: Game, coin: Entity) => void)[] = [
      (app) => app.tick(1),
      (app) => app.dispatchByName("rp/Drop", { value: 1 }),
      (app) => {
        app.enqueueByName("rp/Drop", { value: 1 });
        app.tick(1);
      },
      (app) => app.dispatchByName("rp/Take", { coin: 4000 }),
      (app) => app.dispatchByName("rp/Drop", { value: "not a number" }),
      (app, coin) => app.dispatch(Take, { coin }),
    ];

    for (const first of firsts) {
      withApp(game(), (app) => {
        expect(app.actionLog).toEqual([]);
        // What a game does between making its app and starting to play.
        const coin = app.world.spawn(Coin.of({ value: 5, x: 0 }));
        const starting = app.world.hash();
        first(app, coin);
        expect(app.actionLog[0]).toEqual({ tick: 0, hash: starting });
        expect(checkpoints(app.actionLog)).toHaveLength(1);
      });
    }
  });

  it("can be asked for between ticks, and not during one", () => {
    withApp(game({ checkpointEvery: 0 }), (app) => {
      app.world.spawn(Coin.of({ value: 1, x: 0 }));
      app.tick(1);
      app.tick(1);
      expect(app.actionLog).toEqual([]);
      const hash = app.checkpoint();
      expect(hash).toBe(app.world.hash());
      expect(app.actionLog).toEqual([{ tick: 2, hash }]);
      app.dispatch(Drop, { value: 2 });
      app.checkpoint();
      expect(app.actionLog.map((entry) => Action.isCheckpoint(entry))).toEqual([
        true,
        false,
        true,
      ]);
      expect(checkpoints(app.actionLog)[1]!.hash).not.toBe(hash);
    });

    // One taken by hand before the game starts is the starting checkpoint.
    withApp(game({ checkpointEvery: 5 }), (app) => {
      app.world.spawn(Coin.of({ value: 1, x: 0 }));
      app.checkpoint();
      app.tick(1);
      expect(checkpoints(app.actionLog).map((entry) => entry.tick)).toEqual([
        0,
      ]);
    });

    let inside: unknown;

    const Asks = System.make("Asks", function* () {
      try {
        asking!.checkpoint();
      } catch (error) {
        inside = error;
      }
    });

    let asking: App.Any | undefined;
    withApp(App.make({ systems: [Asks] }), (app) => {
      asking = app;
      app.tick(1);
    });
    expect(String(inside)).toMatch(/checkpoint\(\) was called during a tick/u);
  });

  it("survive being written down, and a malformed one is refused", () => {
    const recorded = record({ ticks: 12, checkpointEvery: 4 });
    const text = Action.encodeLog(recorded.log);
    const loaded = Action.decodeLog(text);
    expect(Exit.isSuccess(loaded) && loaded.value).toEqual(recorded.log);
    expect(JSON.parse(text)[0]).toEqual({ tick: 0, hash: recorded.starting });

    for (const entry of [
      { tick: 0, hash: -1 },
      { tick: 0, hash: 2 ** 32 },
      { tick: 0, hash: 1.5 },
      { tick: 0, hash: "12" },
      { tick: -1, hash: 12 },
      { tick: 0.5, hash: 12 },
      { hash: 12 },
      { tick: 0 },
    ]) {
      const refused = Action.decodeLog(JSON.stringify([entry]));
      expect(Exit.isFailure(refused), JSON.stringify(entry)).toBe(true);
    }

    const largest = Action.decodeLog(
      JSON.stringify([{ tick: 0, hash: 2 ** 32 - 1 }])
    );

    expect(Exit.isSuccess(largest)).toBe(true);
    expect(Action.isCheckpoint({ tick: 1, hash: 0 })).toBe(true);
    expect(Action.isCheckpoint({ tick: 1, name: "x", payload: 0 })).toBe(false);
  });
});

describe("a replay that checks itself", () => {
  it("passes every checkpoint when it goes the way the game went", () => {
    for (const checkpointEvery of [1, 7, 60]) {
      const recorded = record({ ticks: 150, checkpointEvery });
      const replayed = replayInto({}, recorded.log, recorded.ticks);
      expect(replayed.stopped).toBeUndefined();
      expect(replayed.tick).toBe(150);
      expect(replayed.hash).toBe(recorded.hashes.at(-1));
    }

    // Recording as it replays, it writes the same log again.
    const recorded = record({ ticks: 40, checkpointEvery: 1 });
    expect(replayInto({ checkpointEvery: 1 }, recorded.log, 40).log).toEqual(
      recorded.log
    );
  });

  it("stops at the tick it diverged on, not at the next refused action", () => {
    // The game is recorded with a checkpoint every tick. In the build that
    // replays it, a coin's position is off by a millionth on tick 40. No
    // rule is broken by that, and no action is refused because of it.
    const recorded = record({ ticks: 120, checkpointEvery: 1 });

    const replayed = replayInto(
      { faulty: fault(40, "nudge") },
      recorded.log,
      recorded.ticks
    );

    const stopped = replayed.stopped!;
    expect(stopped).toBeInstanceOf(App.ReplayDiverged);
    expect(stopped.tick).toBe(40);
    // It stopped there: no later tick ran and no later move was applied.
    expect(replayed.tick).toBe(40);
    expect(moves(replayed.log).every((entry) => entry.tick < 40)).toBe(true);
    expect(moves(recorded.log).some((entry) => entry.tick >= 40)).toBe(true);

    const reason = stopped.reason as App.HashMismatch;
    expect(reason).toBeInstanceOf(App.HashMismatch);
    expect(reason.tick).toBe(40);
    expect(reason.agreedAt).toBe(39);
    expect(reason.expected).toBe(recorded.hashes[39]);
    expect(reason.actual).toBe(replayed.hash);
    expect(reason.actual).not.toBe(reason.expected);
    expect(stopped.entry).toEqual({ tick: 40, hash: recorded.hashes[39] });
    expect(recorded.log[stopped.index]).toBe(stopped.entry);
    expect(stopped.message).toBe(
      `The replay diverged from its log (entry ${stopped.index}): the world's hash at tick 40 is ${reason.actual}, and ${reason.expected} was recorded. The last checkpoint that matched was at tick 39.`
    );
  });

  it("would otherwise run on until an action happened to be refused, or to the end", () => {
    // The same recording with its checkpoints taken out, as a log was before
    // it had any. The faulty build loses the oldest coin on tick 40, and the
    // game takes that coin on tick 100.
    const recorded = record({ ticks: 100, checkpointEvery: 1 });
    const oldest = recorded.coins[0]!;

    const log = [
      ...recorded.log,
      { tick: 100, name: "rp/Take", payload: { coin: oldest } },
    ];

    const blind = replayInto({ faulty: fault(40, "lose") }, moves(log), 110);
    // Somewhere after the fault: at the first move that named a coin the
    // faulty game no longer had, by tick 100 at the latest.
    expect(blind.stopped!.tick).toBeGreaterThan(40);
    expect(blind.stopped!.tick).toBeLessThanOrEqual(100);
    expect(blind.stopped!.reason).toBeInstanceOf(NoSuchCoin);
    expect(blind.stopped!.message).toMatch(
      /\("rp\/Take" at tick \d+\) was refused on replay/u
    );
    // With them, sixty ticks earlier, where it went wrong.
    const checked = replayInto({ faulty: fault(40, "lose") }, log, 110);
    expect(checked.stopped!.tick).toBe(40);
    expect(checked.stopped!.reason).toBeInstanceOf(App.HashMismatch);

    // And a fault that breaks no rule is never noticed without them.
    const silent = replayInto(
      { faulty: fault(40, "nudge") },
      moves(recorded.log),
      100
    );

    expect(silent.stopped).toBeUndefined();
    expect(silent.hash).not.toBe(recorded.hashes.at(-1));
  });

  it("stops at the first checkpoint after it diverged when they are further apart, and names the last that matched", () => {
    const recorded = record({ ticks: 120, checkpointEvery: 10 });

    const replayed = replayInto(
      { faulty: fault(43, "nudge") },
      recorded.log,
      recorded.ticks
    );

    expect(replayed.stopped!.tick).toBe(50);
    expect(replayed.tick).toBe(50);
    const reason = replayed.stopped!.reason as App.HashMismatch;
    expect(reason.agreedAt).toBe(40);
    expect(reason.expected).toBe(recorded.hashes[49]);

    // A fault on a checkpoint's own tick is caught by that checkpoint.
    const onIt = replayInto(
      { faulty: fault(50, "nudge") },
      recorded.log,
      recorded.ticks
    );

    expect(onIt.stopped!.tick).toBe(50);

    const after = replayInto(
      { faulty: fault(51, "nudge") },
      recorded.log,
      recorded.ticks
    );

    expect(after.stopped!.tick).toBe(60);
    expect((after.stopped!.reason as App.HashMismatch).agreedAt).toBe(50);
  });

  it("stops before its first tick when it does not start where the game started", () => {
    const recorded = record({ ticks: 30, seed: 5 });
    const otherSeed = replayInto({ seed: 6 }, recorded.log, recorded.ticks);
    expect(otherSeed.stopped!.tick).toBe(0);
    expect(otherSeed.tick).toBe(0);
    expect(otherSeed.stopped!.index).toBe(0);
    const reason = otherSeed.stopped!.reason as App.HashMismatch;
    expect(reason.agreedAt).toBeUndefined();
    expect(reason.expected).toBe(recorded.starting);
    expect(otherSeed.stopped!.message).toMatch(
      /No earlier checkpoint matched, so the two did not start from the same state: check the seed and what was spawned before the first tick\.$/u
    );
    // Nothing was applied to a world that was wrong from the start.
    expect(moves(otherSeed.log)).toEqual([]);

    // The right seed, but something in the world that the game did not have.
    const crowded = withApp(game({ seed: 5 }), (app) => {
      app.world.spawn(Coin.of({ value: 1, x: 0 }));

      try {
        App.replay(app, recorded.log, { delta: 1 / 60, ticks: 30 });
      } catch (error) {
        return error as App.ReplayDiverged;
      }
    });

    expect(crowded!.tick).toBe(0);
    expect(replayInto({ seed: 5 }, recorded.log, 30).stopped).toBeUndefined();
  });

  it("catches a log that was edited into another game the rules allow", () => {
    const recorded = record({ ticks: 60, checkpointEvery: 1 });

    const edit = (change: (log: any[]) => void) => {
      const log = structuredClone(recorded.log) as any[];
      change(log);

      return replayInto({}, log, recorded.ticks).stopped;
    };

    const drops = recorded.log.flatMap((entry, index) =>
      !Action.isCheckpoint(entry) && entry.name === "rp/Drop" && entry.tick > 5
        ? [index]
        : []
    );

    const at = drops[0]!;
    const { tick } = recorded.log[at]!;

    // A coin of another value: a legal move, and a different game.
    const changed = edit((log) => {
      log[at].payload.value += 1;
    });

    expect(changed!.reason).toBeInstanceOf(App.HashMismatch);
    expect(changed!.tick).toBe(tick + 1);
    expect((changed!.reason as App.HashMismatch).agreedAt).toBe(tick);

    // A move taken out, and a move put in.
    const removed = edit((log) => {
      log.splice(at, 1);
    });

    expect(removed!.tick).toBe(tick + 1);

    const added = edit((log) => {
      log.splice(at, 0, { tick, name: "rp/Drop", payload: { value: 3 } });
    });

    expect(added!.tick).toBe(tick + 1);

    // A checkpoint that was altered is itself the entry that does not hold.
    const forged = edit((log) => {
      const index = log.findIndex(
        (entry) => entry.tick === 20 && "hash" in entry
      );

      log[index].hash ^= 1;
    });

    expect(forged!.tick).toBe(20);
    expect((forged!.reason as App.HashMismatch).agreedAt).toBe(19);
  });

  it("catches a world that was changed behind the log's back", () => {
    // Between two ticks the recorded game spawns a coin directly, which no
    // action in the log says. The replay cannot know, and says where it shows.
    const recorded = withApp(game({ checkpointEvery: 1 }), (app) => {
      for (let tick = 0; tick < 20; tick += 1) {
        if (tick === 8) {
          app.world.spawn(Coin.of({ value: 7, x: 0 }));
        }

        app.dispatch(Drop, { value: 1 });
        app.tick(1 / 60);
      }

      return [...app.actionLog];
    });

    const replayed = replayInto({}, recorded, 20);
    expect(replayed.stopped!.tick).toBe(9);
    expect((replayed.stopped!.reason as App.HashMismatch).agreedAt).toBe(8);
  });

  it("says so when the log has a checkpoint the replay never reaches", () => {
    const recorded = record({ ticks: 30, checkpointEvery: 10 });

    // The moves of the first 25 ticks, and every checkpoint, the one at 30 too.
    const log = recorded.log.filter(
      (entry) => Action.isCheckpoint(entry) || entry.tick <= 25
    );

    const short = replayInto({}, log, 25);
    expect(short.stopped!.tick).toBe(30);
    expect(Action.isCheckpoint(short.stopped!.entry)).toBe(true);
    expect(short.stopped!.message).toMatch(
      /\(a checkpoint at tick 30\) was not reached on replay: its tick \(30\) was never reached/u
    );
    expect(short.tick).toBe(25);
  });

  it("says so when a queued action meets another fate than the log records", () => {
    const recorded = withApp(game({ checkpointEvery: 0 }), (app) => {
      const dropped = app.dispatch(Drop, { value: 4 });
      const coin = Exit.isSuccess(dropped) ? dropped.value : (0 as Entity);
      app.tick(1 / 60);
      app.enqueue(Take, { coin });
      app.enqueue(Take, { coin }); // refused: the coin is gone by then
      app.tick(1 / 60);
      app.tick(1 / 60);

      return [...app.actionLog];
    });

    expect(moves(recorded).map((entry) => entry.refused)).toEqual([
      undefined,
      undefined,
      "NoSuchCoin",
    ]);
    expect(replayInto({}, recorded, 3).stopped).toBeUndefined();

    // The game accepted the first take, and in this log it names no coin.
    const refusedNow = structuredClone(recorded) as any[];
    refusedNow[1].payload.coin = 4000;
    const first = replayInto({}, refusedNow, 3).stopped!;
    expect(first.index).toBe(1);
    expect(first.reason).toBe("NoSuchCoin");
    expect(first.message).toBe(
      'Log entry 1 ("rp/Take" at tick 1) was refused on replay: NoSuchCoin'
    );

    // The game refused the second take, and here the first is gone, so the
    // second finds its coin.
    const acceptedNow = structuredClone(recorded) as any[];
    acceptedNow.splice(1, 1);
    const second = replayInto({}, acceptedNow, 3).stopped!;
    expect(second.index).toBe(1);
    expect(second.message).toBe(
      'Log entry 1 ("rp/Take" at tick 1) did not replay: the game refused it (NoSuchCoin) and the replay accepted it'
    );
  });
});

// --- what the log holds, and a game whose simulation issues actions itself -------

const Tally = Component.define("rp/Tally", {
  value: Field.f64,
  rejections: Field.u32,
});

const Tallies = Query.all(Tally);

const Double = Action.define("rp/Double", Schema.Struct({}));
const Add = Action.define("rp/Add", Schema.Struct({ by: Schema.Int }));
const Chain = Action.define("rp/Chain", Schema.Struct({ by: Schema.Int }));

class TooBig extends Data.TaggedError("TooBig")<{}> {}

// Doubling and adding do not commute, so the tally gives away any change in
// the order actions were applied in.
const double = Action.handler(Double, function* () {
  let refuse = false;
  (yield* Tallies).each((tally) => {
    tally.value *= 2;
    refuse = tally.value > 1e12;
  });

  if (refuse) {
    return yield* Effect.fail(new TooBig());
  }
});

const add = Action.handler(Add, function* ({ by }) {
  (yield* Tallies).each((tally) => {
    tally.value += by;
  });
});

/** A handler that issues another action. */
const chain = Action.handler(Chain, function* ({ by }) {
  (yield* Action.Actions).enqueue(Add, { by });
});

/** An AI: a system that makes a move of its own every few ticks. */
const Bot = System.make("Bot", function* () {
  const { tick } = yield* Time;
  const actions = yield* Action.Actions;

  if (tick % 3 === 0) {
    actions.enqueue(Add, { by: 7 });
  }

  if (tick % 4 === 0) {
    actions.enqueue(Double, {});
  }
});

/** Counts refusals in the world, so that a refusal a replay misses shows. */
const Referee = System.make("Referee", function* () {
  const refused = (yield* Action.Rejected).read().length;
  (yield* Tallies).each((tally) => {
    tally.rejections += refused;
  });
});

/** A script that makes a move of its own now and then. */
const Heckler = Effect.gen(function* () {
  const script = yield* Script;
  const actions = yield* Action.Actions;
  const random = yield* Random;

  for (;;) {
    yield* script.sleep(random.int(1, 3));
    actions.enqueue(Add, { by: random.int(1, 9) });
  }
});

const busy = (checkpointEvery = 1) =>
  Effect.map(
    App.make({
      systems: [Bot, Referee],
      handlers: [double, add, chain],
      seed: 4,
      checkpointEvery,
    }),
    (app) => {
      const tally = app.world.spawn(Tally.of({ value: 1, rejections: 0 }));
      app.spawnScript(Heckler);

      return { app, tally };
    }
  );

describe("the action log", () => {
  it("holds what came from outside, as it arrived, and not what the simulation issued itself", () => {
    withApp(busy(0), ({ app, tally }) => {
      app.enqueue(Add, { by: 1 });
      app.dispatch(Chain, { by: 100 }); // its handler enqueues an Add
      app.enqueueByName("rp/Double", {});
      app.dispatch(Add, { by: 1000 });
      expect(app.actionLog).toEqual([
        { tick: 0, name: "rp/Add", payload: { by: 1 }, queued: true },
        { tick: 0, name: "rp/Chain", payload: { by: 100 } },
        { tick: 0, name: "rp/Double", payload: {}, queued: true },
        { tick: 0, name: "rp/Add", payload: { by: 1000 } },
      ]);
      // Applied in the order they arrived, the handler's own among them:
      // 1 + 1000 at once, then (+1, +100, doubled) when the tick starts.
      app.tick(1);
      expect(app.world.get(tally, Tally)!.value).toBe((1001 + 1 + 100) * 2);

      // The tick ran the bot and the script, and none of their moves is logged.
      for (let i = 0; i < 12; i += 1) {
        app.tick(1);
      }

      expect(app.world.get(tally, Tally)!.value).toBeGreaterThan(10_000);
      expect(app.actionLog).toHaveLength(4);
    });
  });

  it("marks a queued action that was refused, and leaves out a dispatched one", () => {
    withApp(busy(0), ({ app, tally }) => {
      app.world.set(tally, Tally, { value: 1e12 });
      expect(Exit.isFailure(app.dispatch(Double, {}))).toBe(true);
      app.enqueue(Double, {});
      app.enqueueByName("rp/Nothing", { x: 1 });
      app.enqueueByName("rp/Add", { by: "seven" });
      app.tick(1);
      expect(
        app.actionLog.map((entry) =>
          Action.isCheckpoint(entry) ? "?" : [entry.name, entry.refused]
        )
      ).toEqual([
        ["rp/Double", "TooBig"],
        ["rp/Nothing", "UnknownAction"],
        ["rp/Add", expect.stringMatching(/by/u)],
      ]);
      // The referee saw all three refusals.
      app.tick(1);
      expect(app.world.get(tally, Tally)!.rejections).toBe(3);
    });
  });

  it("keeps its marks through text, and refuses a malformed one", () => {
    const log: Action.LogEntry[] = [
      { tick: 0, hash: 7 },
      { tick: 0, name: "a", payload: { x: 1 } },
      { tick: 0, name: "b", payload: null, queued: true },
      { tick: 1, name: "c", payload: [1], queued: true, refused: "Because" },
    ];

    const loaded = Action.decodeLog(Action.encodeLog(log));
    expect(Exit.isSuccess(loaded) && loaded.value).toEqual(log);

    for (const entry of [
      { tick: 0, name: "a", payload: 1, queued: false },
      { tick: 0, name: "a", payload: 1, queued: "yes" },
      { tick: 0, name: "a", payload: 1, queued: true, refused: true },
      { tick: 0, name: "a", payload: 1, refused: 5 },
    ]) {
      const refused = Action.decodeLog(JSON.stringify([entry]));
      expect(Exit.isFailure(refused), JSON.stringify(entry)).toBe(true);
    }
  });
});

describe("a game whose simulation issues actions itself", () => {
  /** Outside moves mixed in with the bot's, the script's and a handler's. */
  const play = (app: Effect.Success<ReturnType<typeof busy>>["app"]) => {
    const dice = new EcsWorld({ seed: 77 }).random;

    for (let tick = 0; tick < 90; tick += 1) {
      for (let n = dice.int(0, 3); n > 0; n -= 1) {
        const by = dice.int(1, 5);
        const move = dice.int(1, 6);

        if (move === 1) {
          app.enqueue(Add, { by });
        } else if (move === 2) {
          app.dispatch(Chain, { by });
        } else if (move === 3) {
          app.enqueueByName("rp/Double", {});
        } else if (move === 4) {
          app.dispatch(Add, { by });
        } else if (move === 5) {
          app.enqueueByName("rp/Add", { by: "not a number" });
        } else {
          app.enqueue(Chain, { by });
        }
      }

      app.tick(1);
    }
  };

  it("replays from its log, checkpoint by checkpoint", () => {
    const recorded = withApp(busy(), ({ app, tally }) => {
      play(app);

      return {
        log: [...app.actionLog],
        hash: app.world.hash(),
        tally: app.world.get(tally, Tally)!,
      };
    });

    // The game was a busy one: the tally was doubled past its limit and
    // back-pressure refused moves, and the referee counted them.
    expect(recorded.tally.rejections).toBeGreaterThan(10);
    expect(moves(recorded.log).some((entry) => entry.queued === true)).toBe(
      true
    );
    expect(
      moves(recorded.log).some((entry) => entry.refused !== undefined)
    ).toBe(true);

    const replayed = withApp(busy(), ({ app, tally }) => {
      App.replay(app, recorded.log, { delta: 1, ticks: 90 });

      return {
        log: [...app.actionLog],
        hash: app.world.hash(),
        tally: app.world.get(tally, Tally)!,
      };
    });

    expect(replayed.hash).toBe(recorded.hash);
    expect(replayed.tally).toEqual(recorded.tally);
    // The replay's own log is the game's, entry for entry, marks included.
    expect(replayed.log).toEqual(recorded.log);
  });

  it("would not replay if the simulation's own moves were replayed from the log as well", () => {
    // The flaw this replaces: every applied action was logged and replayed,
    // so a move the bot made was made twice, once from the log and once by
    // the replay's own bot. Here the bot's moves are put back in by hand.
    const recorded = withApp(busy(), ({ app }) => {
      for (let i = 0; i < 9; i += 1) {
        app.tick(1);
      }

      return [...app.actionLog];
    });

    expect(moves(recorded)).toEqual([]);
    const withBotMoves = [...recorded];

    const at = withBotMoves.findIndex(
      (entry) => Action.isCheckpoint(entry) && entry.tick === 3
    );

    withBotMoves.splice(at + 1, 0, {
      tick: 3,
      name: "rp/Add",
      payload: { by: 7 },
    });

    const stopped = withApp(busy(), ({ app }) => {
      try {
        App.replay(app, withBotMoves, { delta: 1, ticks: 9 });
      } catch (error) {
        return error as App.ReplayDiverged;
      }
    });

    expect(stopped!.reason).toBeInstanceOf(App.HashMismatch);
    expect(stopped!.tick).toBe(4);
    // And as it is recorded, it replays.
    withApp(busy(), ({ app }) => {
      App.replay(app, recorded, { delta: 1, ticks: 9 });
    });
  });

  it("keeps the order of what was enqueued from outside and what a dispatched handler enqueued", () => {
    // Two actions wait for the next tick: a doubling enqueued from outside,
    // and an addition enqueued by the handler of a dispatched action. They do
    // not commute, so each order of arrival is its own game, and each has to
    // replay as itself.
    const make = Effect.map(
      App.make({ handlers: [double, add, chain], checkpointEvery: 1 }),
      (app) => ({
        app,
        tally: app.world.spawn(Tally.of({ value: 1, rejections: 0 })),
      })
    );

    const play = (first: "enqueue" | "dispatch") =>
      withApp(make, ({ app, tally }) => {
        if (first === "enqueue") {
          app.enqueue(Double, {});
          app.dispatch(Chain, { by: 10 });
        } else {
          app.dispatch(Chain, { by: 10 });
          app.enqueue(Double, {});
        }

        app.tick(1);

        return {
          value: app.world.get(tally, Tally)!.value,
          log: [...app.actionLog],
        };
      });

    const replay = (log: readonly Action.LogEntry[]) =>
      withApp(make, ({ app, tally }) => {
        App.replay(app, log, { delta: 1, ticks: 1 });

        return app.world.get(tally, Tally)!.value;
      });

    const doubledFirst = play("enqueue");
    const addedFirst = play("dispatch");
    expect(doubledFirst.value).toBe(1 * 2 + 10);
    expect(addedFirst.value).toBe((1 + 10) * 2);
    expect(moves(doubledFirst.log).map((entry) => entry.name)).toEqual([
      "rp/Double",
      "rp/Chain",
    ]);
    expect(moves(addedFirst.log).map((entry) => entry.name)).toEqual([
      "rp/Chain",
      "rp/Double",
    ]);
    expect(replay(doubledFirst.log)).toBe(doubledFirst.value);
    expect(replay(addedFirst.log)).toBe(addedFirst.value);
  });
});
