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
    return yield* new NoSuchCoin({ coin });
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
    for (let tick = 0; tick < options.ticks; tick++) {
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
    for (let i = 1; i < recorded.log.length; i++) {
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
      for (let tick = 1; tick <= 5; tick++) {
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
        /checkpointEvery must be a whole number of ticks/
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
        expect(checkpoints(app.actionLog).length).toBe(1);
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
    expect(String(inside)).toMatch(/checkpoint\(\) was called during a tick/);
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
      /\("rp\/Take" at tick \d+\) was refused on replay/
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
      /No earlier checkpoint matched, so the two did not start from the same state: check the seed and what was spawned before the first tick\.$/
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
      for (let tick = 0; tick < 20; tick++) {
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
      /\(a checkpoint at tick 30\) was not reached on replay: its tick \(30\) was never reached/
    );
    expect(short.tick).toBe(25);
  });

  it("catches a game whose system issues actions, which a log cannot replay yet", () => {
    // Known gap: an action a system enqueues is in the log, and the replay's
    // own system enqueues it again, so it is applied twice. Until the log
    // tells the two kinds of action apart, the checkpoint is what notices.
    const Count = Component.define("rp/Count", { n: Field.i32 });
    const Bump = Action.define("rp/Bump", Schema.Struct({ by: Schema.Int }));
    const bump = Action.handler(Bump, function* ({ by }) {
      (yield* Query.all(Count)).each((count) => {
        count.n += by;
      });
    });
    const Ai = System.make("Ai", function* () {
      if ((yield* Time).tick % 3 === 0) {
        (yield* Action.Actions).enqueue(Bump, { by: 10 });
      }
    });
    const make = App.make({
      systems: [Ai],
      handlers: [bump],
      checkpointEvery: 1,
    });
    const recorded = withApp(make, (app) => {
      app.world.spawn(Count);
      for (let i = 0; i < 9; i++) {
        app.tick(1);
      }
      return [...app.actionLog];
    });
    const stopped = withApp(make, (app) => {
      app.world.spawn(Count);
      try {
        App.replay(app, recorded, { delta: 1, ticks: 9 });
      } catch (error) {
        return error as App.ReplayDiverged;
      }
    });
    expect(stopped!.reason).toBeInstanceOf(App.HashMismatch);
    expect(stopped!.tick).toBe(4);
  });
});
