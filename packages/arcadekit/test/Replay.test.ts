import { Cause, Data, Effect, Exit, Layer, Schema } from "effect";
import { assert, describe, expect, it } from "vitest";

import { entityOf } from "../src/ecs/component";
import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  EntityId,
  Field,
  Journal,
  Plugin,
  Query,
  Random,
  Save,
  Singleton,
  System,
  Time,
  Timeline,
  World,
} from "../src/index";
import type { Entity } from "../src/index";
import type { BuiltIn } from "../src/Services";

// --- a small game: coins are dropped, drift about at random, and are taken ------

const Coin = Component.define("rp/Coin", { value: Field.i32, x: Field.f32 });
const Coins = Query.all(Coin).pipe(Query.writes(Coin));
/** The coins, read from outside the game. */
const Lying = Query.all(Coin);

const Drop = Action.define("rp/Drop", Schema.Struct({ value: Schema.Int }));
const Take = Action.define("rp/Take", Schema.Struct({ coin: EntityId }));
class NoSuchCoin extends Data.TaggedError("NoSuchCoin")<{
  readonly coin: Entity;
}> {}

const drop = Action.handler(Drop, function* ({ value }) {
  const random = yield* Random;
  return (yield* Commands.spawns(Coin)).spawn(
    Coin.of({ value, x: random.next() })
  );
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

const Drift = System.tick("Drift", function* () {
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
  System.tick("Fault", function* () {
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

/** The build's second system: the fault, or what a test puts in its place. */
type Faulty = System.System<never, BuiltIn>;

interface Options {
  readonly seed?: number;
  readonly checkpointEvery?: number;
  readonly faulty?: Faulty;
  /** The values of the coins the game starts with: none unless told. */
  readonly coins?: readonly number[];
}

/** A plugin whose setup spawns a coin of each value, at 0. */
const startingWith = (values: readonly number[]) =>
  Plugin.make("rp/Start", {
    setup: Effect.map(Commands.spawns(Coin), (commands) => {
      for (const value of values) {
        commands.spawn(Coin.of({ value, x: 0 }));
      }
    }),
  });

// A fault on tick -1 never happens: that is the game as it should be.
const coinGame = (
  faulty: Faulty = fault(-1, "nudge"),
  coins: readonly number[] = []
) =>
  App.define({
    plugins: [startingWith(coins)],
    systems: [Drift, faulty],
    handlers: [drop, take],
  });

const checkpointing = (options: Options) =>
  options.checkpointEvery === undefined
    ? {}
    : { checkpointEvery: options.checkpointEvery };

const game = (options: Options = {}) =>
  App.make(coinGame(options.faulty, options.coins), {
    seed: options.seed ?? 1,
    ...checkpointing(options),
  });

/** Runs `use` with an app and its world, as `app.read(World)` gives it. */
const withApp = <T extends Pick<App.Any, "read">, A>(
  make: Effect.Effect<T, never>,
  use: (app: T, world: Effect.Success<typeof World>) => A
): A =>
  Effect.runSync(
    Effect.flatMap(make, (app) =>
      Effect.map(app.read(World), (world) => use(app, world))
    )
  );

/** What stopped a replay that the test expects to diverge. */
const stoppedBy = <A extends App.Any>(
  replay: Effect.Effect<A, Journal.ReplayDiverged<A> | Save.LoadRefused>
): Journal.ReplayDiverged<A> =>
  Effect.runSync(
    replay.pipe(
      Effect.flatMap(() => Effect.die("it went the way the game went")),
      Effect.catchTag("ReplayDiverged", Effect.succeed),
      Effect.orDie
    )
  );

const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));
const checkpoints = (log: readonly Action.LogEntry[]): Action.Checkpoint[] =>
  log.filter((entry) => Action.isCheckpoint(entry));

/**
 * Plays a game of random moves, every one of them accepted, and returns its
 * log with the hash the world had after each tick.
 */
const record = (options: Options & { readonly ticks: number }) =>
  withApp(game(options), (app, world) => {
    const dice = new EcsWorld({ seed: 99 }).random;
    const coins: Entity[] = [];
    const hashes: number[] = [];
    const starting = world.hash();
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
      hashes.push(world.hash());
    }
    return {
      recording: app.record(),
      log: [...app.actionLog],
      hashes,
      starting,
      coins,
      ticks: options.ticks,
    };
  });

/**
 * `recording` with `fields` changed in its text, as a file edited by hand,
 * and read back.
 */
const altered = (
  recording: Journal.Recording,
  fields: Readonly<Record<string, unknown>>
): Journal.Recording => {
  const read = Journal.decode(
    JSON.stringify({
      ...(JSON.parse(Journal.encode(recording)) as object),
      ...fields,
    })
  );
  assert(Exit.isSuccess(read));
  return read.value;
};

/**
 * Replays a recording into the coin game `options` make, and returns what
 * stopped it, if anything did, with the app as the replay left it.
 */
const replayInto = (options: Options, recording: Journal.Recording) =>
  Effect.runSync(
    Effect.gen(function* () {
      // A replay that stops holds its app where it stopped.
      const { app, stopped } = yield* Journal.replay(
        recording,
        coinGame(options.faulty, options.coins),
        checkpointing(options)
      ).pipe(
        Effect.map((app) => ({ app, stopped: undefined })),
        Effect.catchTag("ReplayDiverged", (diverged) =>
          Effect.succeed({ app: diverged.app, stopped: diverged })
        ),
        Effect.orDie
      );
      return {
        stopped,
        tick: app.time.tick,
        hash: (yield* app.read(World)).hash(),
        log: [...app.actionLog],
      };
    })
  );

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

  it("are taken when a tick is over, after the commands its systems queued are applied", () => {
    // The last system's commands are the last thing a tick applies.
    const Mint = System.tick("Mint", function* () {
      (yield* Commands.spawns(Coin)).spawn(Coin.of({ value: 1, x: 0 }));
    });
    withApp(game({ checkpointEvery: 1, faulty: Mint }), (app, world) => {
      for (let tick = 1; tick <= 5; tick++) {
        app.tick(1 / 60);
        expect(world.entityCount).toBe(tick);
        expect(app.actionLog.at(-1)).toEqual({
          tick,
          hash: world.hash(),
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

  it("start from the state the game starts from, whichever of its moves comes first", () => {
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
      withApp(game({ coins: [5] }), (app, world) => {
        expect(app.actionLog).toEqual([]);
        const [coin] = Effect.runSync(app.read(Lying)).entities();
        assert(coin !== undefined);
        const starting = world.hash();
        first(app, coin);
        expect(app.actionLog[0]).toEqual({ tick: 0, hash: starting });
        expect(checkpoints(app.actionLog).length).toBe(1);
      });
    }
  });

  it("can be asked for between ticks, and not during one", () => {
    withApp(game({ checkpointEvery: 0, coins: [1] }), (app, world) => {
      app.tick(1);
      app.tick(1);
      expect(app.actionLog).toEqual([]);
      const hash = app.checkpoint();
      expect(hash).toBe(world.hash());
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
    withApp(game({ checkpointEvery: 5, coins: [1] }), (app) => {
      app.checkpoint();
      app.tick(1);
      expect(checkpoints(app.actionLog).map((entry) => entry.tick)).toEqual([
        0,
      ]);
    });

    let inside: unknown;
    const Asks = System.tick("Asks", function* () {
      try {
        asking!.checkpoint();
      } catch (error) {
        inside = error;
      }
    });
    let asking: App.Any | undefined;
    withApp(App.make(App.define({ systems: [Asks] })), (app) => {
      asking = app;
      app.tick(1);
    });
    expect(String(inside)).toMatch(/checkpoint\(\) was called during a tick/);
  });

  it("survive being written down, and a malformed one is refused", () => {
    const recorded = record({ ticks: 12, checkpointEvery: 4 });
    const text = Journal.encode(recorded.recording);
    const loaded = Journal.decode(text);
    expect(Exit.isSuccess(loaded) && loaded.value).toEqual(recorded.recording);
    expect(JSON.parse(text).log[0]).toEqual({
      tick: 0,
      hash: recorded.starting,
    });
    /** The recording, as text, holding `log`. */
    const holding = (log: readonly unknown[]): string =>
      JSON.stringify({ ...(JSON.parse(text) as object), log });

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
      const refused = Journal.decode(holding([entry]));
      expect(Exit.isFailure(refused), JSON.stringify(entry)).toBe(true);
    }
    const largest = Journal.decode(holding([{ tick: 0, hash: 2 ** 32 - 1 }]));
    expect(Exit.isSuccess(largest)).toBe(true);
    expect(Action.isCheckpoint({ tick: 1, hash: 0 })).toBe(true);
    expect(Action.isCheckpoint({ tick: 1, name: "x", payload: 0 })).toBe(false);
  });
});

describe("a replay that checks itself", () => {
  it("passes every checkpoint when it goes the way the game went", () => {
    for (const checkpointEvery of [1, 7, 60]) {
      const recorded = record({ ticks: 150, checkpointEvery });
      const replayed = replayInto({}, recorded.recording);
      expect(replayed.stopped).toBeUndefined();
      expect(replayed.tick).toBe(150);
      expect(replayed.hash).toBe(recorded.hashes.at(-1));
    }
    // Recording as it replays, it writes the same log again.
    const recorded = record({ ticks: 40, checkpointEvery: 1 });
    expect(replayInto({ checkpointEvery: 1 }, recorded.recording).log).toEqual(
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
      recorded.recording
    );
    const stopped = replayed.stopped!;
    expect(stopped).toBeInstanceOf(Journal.ReplayDiverged);
    expect(stopped.tick).toBe(40);
    // It stopped there: no later tick ran and no later move was applied.
    expect(replayed.tick).toBe(40);
    expect(moves(replayed.log).every((entry) => entry.tick < 40)).toBe(true);
    expect(moves(recorded.log).some((entry) => entry.tick >= 40)).toBe(true);

    const reason = stopped.reason as Journal.HashMismatch;
    expect(reason).toBeInstanceOf(Journal.HashMismatch);
    expect(reason.tick).toBe(40);
    expect(reason.agreedAt).toBe(39);
    expect(reason.expected).toBe(recorded.hashes[39]);
    expect(reason.actual).toBe(replayed.hash);
    expect(reason.actual).not.toBe(reason.expected);
    expect(stopped.entry).toEqual({ tick: 40, hash: recorded.hashes[39] });
    expect(recorded.log[stopped.index]).toEqual(stopped.entry);
    expect(stopped.message).toBe(
      `The replay diverged from its log (entry ${stopped.index}): the world's hash at tick 40 is ${reason.actual}, and ${reason.expected} was recorded. The last checkpoint that matched was at tick 39.`
    );
  });

  it("fails with its app where it stopped, an app of its game to look at", () => {
    const recorded = record({ ticks: 60, checkpointEvery: 1 });
    const looked = Effect.runSync(
      Journal.replay(recorded.recording, coinGame(fault(20, "lose")), {
        checkpointEvery: 1,
      }).pipe(
        Effect.flatMap(() => Effect.die("it went the way the game went")),
        Effect.catchTag("ReplayDiverged", (diverged) =>
          Effect.gen(function* () {
            const { app, reason } = diverged;
            assert(reason instanceof Journal.HashMismatch);
            const seen = {
              stoppedAt: diverged.tick,
              tick: app.time.tick,
              hash: (yield* app.read(World)).hash(),
              coins: (yield* app.read(Lying)).count(),
              reason,
            };
            // The replay closed it, and it is an app of the game all the
            // same: it takes the game's actions, and no other.
            const dropped = app.dispatch(Drop, { value: 1 });
            // @ts-expect-error the game has no handler for `Add`
            expect(() => app.dispatch(Add, { by: 1 })).toThrow(/No handler/);
            return {
              ...seen,
              dropped: Exit.isSuccess(dropped),
              after: (yield* app.read(Lying)).count(),
            };
          })
        )
      )
    );
    // Where the build that loses a coin on tick 20 stopped: at that tick's
    // checkpoint, with the world whose hash it compared.
    expect(looked.stoppedAt).toBe(20);
    expect(looked.tick).toBe(20);
    expect(looked.hash).toBe(looked.reason.actual);
    expect(looked.hash).not.toBe(recorded.hashes[19]);
    expect(looked.dropped).toBe(true);
    expect(looked.after).toBe(looked.coins + 1);
  });

  it("closes the app it stopped in, and leaves the app of one that went the way the game went to its caller", () => {
    const held: string[] = [];
    const Held = Plugin.make("rp/Held", {
      layer: Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => held.push("acquired")),
          () => Effect.sync(() => held.push("released"))
        )
      ),
    });
    const heldGame = (faulty: Faulty) =>
      App.define({
        plugins: [startingWith([]), Held],
        systems: [Drift, faulty],
        handlers: [drop, take],
      });
    const recorded = record({ ticks: 30, checkpointEvery: 1 });
    const stopped = stoppedBy(
      Journal.replay(recorded.recording, heldGame(fault(10, "lose")), {
        checkpointEvery: 1,
      })
    );
    expect(held).toEqual(["acquired", "released"]);
    // Closed, it is there to read.
    const reason = stopped.reason as Journal.HashMismatch;
    expect(Effect.runSync(stopped.app.read(World)).hash()).toBe(reason.actual);

    held.length = 0;
    const app = Effect.runSync(
      Journal.replay(recorded.recording, heldGame(fault(-1, "nudge")))
    );
    expect(app.time.tick).toBe(30);
    expect(held).toEqual(["acquired"]);
    Effect.runSync(app.close);
    expect(held).toEqual(["acquired", "released"]);
  });

  it("without them runs on until an action happens to be refused, or to its end, where it fails", () => {
    // The same recording with its checkpoints taken out. The faulty build
    // loses the oldest coin on tick 40, and the game takes that coin on tick
    // 100.
    const recorded = record({ ticks: 100, checkpointEvery: 1 });
    const oldest = recorded.coins[0]!;
    const log = [
      ...recorded.log,
      { tick: 100, name: "rp/Take", payload: { coin: oldest } },
    ];
    const blind = replayInto(
      { faulty: fault(40, "lose") },
      altered(recorded.recording, { log: moves(log), end: 110 })
    );
    // Somewhere after the fault: at the first move that named a coin the
    // faulty game no longer had, by tick 100 at the latest.
    expect(blind.stopped!.tick).toBeGreaterThan(40);
    expect(blind.stopped!.tick).toBeLessThanOrEqual(100);
    expect(blind.stopped!.reason).toBeInstanceOf(NoSuchCoin);
    expect(blind.stopped!.message).toMatch(
      /\("rp\/Take" at tick \d+\) was refused on replay/
    );
    // With them, sixty ticks earlier, where it went wrong.
    const checked = replayInto(
      { faulty: fault(40, "lose") },
      altered(recorded.recording, { log, end: 110 })
    );
    expect(checked.stopped!.tick).toBe(40);
    expect(checked.stopped!.reason).toBeInstanceOf(Journal.HashMismatch);

    // A fault that breaks no rule, in a game recorded with no checkpoints,
    // shows at the end: the replay's world isn't the one the game ended on.
    const unchecked = record({ ticks: 100, checkpointEvery: 0 });
    expect(checkpoints(unchecked.log)).toEqual([]);
    expect(unchecked.recording.endHash).toBe(unchecked.hashes.at(-1));
    expect(replayInto({}, unchecked.recording).stopped).toBeUndefined();
    const silent = replayInto(
      { faulty: fault(40, "nudge") },
      unchecked.recording
    );
    expect(silent.tick).toBe(100);
    expect(silent.stopped!.index).toBe(unchecked.log.length);
    expect(silent.stopped!.entry).toEqual({
      tick: 100,
      hash: unchecked.hashes.at(-1),
    });
    const reason = silent.stopped!.reason as Journal.HashMismatch;
    expect(reason).toBeInstanceOf(Journal.HashMismatch);
    expect(reason.expected).toBe(unchecked.hashes.at(-1));
    expect(reason.actual).toBe(silent.hash);
    expect(reason.agreedAt).toBeUndefined();
  });

  it("stops at the first checkpoint after it diverged when they are further apart, and names the last that matched", () => {
    const recorded = record({ ticks: 120, checkpointEvery: 10 });
    const replayed = replayInto(
      { faulty: fault(43, "nudge") },
      recorded.recording
    );
    expect(replayed.stopped!.tick).toBe(50);
    expect(replayed.tick).toBe(50);
    const reason = replayed.stopped!.reason as Journal.HashMismatch;
    expect(reason.agreedAt).toBe(40);
    expect(reason.expected).toBe(recorded.hashes[49]);
    // A fault on a checkpoint's own tick is caught by that checkpoint.
    const onIt = replayInto({ faulty: fault(50, "nudge") }, recorded.recording);
    expect(onIt.stopped!.tick).toBe(50);
    const after = replayInto(
      { faulty: fault(51, "nudge") },
      recorded.recording
    );
    expect(after.stopped!.tick).toBe(60);
    expect((after.stopped!.reason as Journal.HashMismatch).agreedAt).toBe(50);
  });

  it("stops before its first tick when it does not start where the game started", () => {
    const recorded = record({ ticks: 30, seed: 5 });
    const otherSeed = replayInto({}, altered(recorded.recording, { seed: 6 }));
    expect(otherSeed.stopped!.tick).toBe(0);
    expect(otherSeed.tick).toBe(0);
    expect(otherSeed.stopped!.index).toBe(0);
    const reason = otherSeed.stopped!.reason as Journal.HashMismatch;
    expect(reason.agreedAt).toBeUndefined();
    expect(reason.expected).toBe(recorded.starting);
    expect(otherSeed.stopped!.message).toMatch(
      /No earlier checkpoint matched, so the two did not start from the same state: check the seed, and what the plugins' setups spawn\.$/
    );
    // Nothing was applied to a world that was wrong from the start.
    expect(moves(otherSeed.log)).toEqual([]);

    // The right seed, but something in the world that the game did not have.
    const crowded = replayInto({ coins: [1] }, recorded.recording);
    expect(crowded.stopped!.tick).toBe(0);
    expect(crowded.tick).toBe(0);
    expect(replayInto({}, recorded.recording).stopped).toBeUndefined();
  });

  it("catches a log that was edited into another game the rules allow", () => {
    const recorded = record({ ticks: 60, checkpointEvery: 1 });
    const edit = (change: (log: Action.LogEntry[]) => void) => {
      const log = [...recorded.log];
      change(log);
      return replayInto({}, altered(recorded.recording, { log })).stopped;
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
      const drop = log[at] as Action.Logged;
      const { value } = drop.payload as { readonly value: number };
      log[at] = { ...drop, payload: { value: value + 1 } };
    });
    expect(changed!.reason).toBeInstanceOf(Journal.HashMismatch);
    expect(changed!.tick).toBe(tick + 1);
    expect((changed!.reason as Journal.HashMismatch).agreedAt).toBe(tick);

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
        (entry) => entry.tick === 20 && Action.isCheckpoint(entry)
      );
      const checkpoint = log[index] as Action.Checkpoint;
      log[index] = { ...checkpoint, hash: (checkpoint.hash ^ 1) >>> 0 };
    });
    expect(forged!.tick).toBe(20);
    expect((forged!.reason as Journal.HashMismatch).agreedAt).toBe(19);
  });

  it("catches a world that was changed behind the log's back", () => {
    // On its ninth tick the recorded game spawns a coin because of something
    // the world doesn't hold, which no action in the log says. The replay
    // cannot know, and says where it shows.
    let hidden: number | undefined;
    const Behind = System.tick("Behind", function* () {
      if (hidden !== undefined) {
        (yield* Commands.spawns(Coin)).spawn(Coin.of({ value: hidden, x: 0 }));
        hidden = undefined;
      }
    });
    const recorded = withApp(
      game({ checkpointEvery: 1, faulty: Behind }),
      (app) => {
        for (let tick = 0; tick < 20; tick++) {
          if (tick === 8) {
            hidden = 7;
          }
          app.dispatch(Drop, { value: 1 });
          app.tick(1 / 60);
        }
        return app.record();
      }
    );
    const replayed = replayInto({}, recorded);
    expect(replayed.stopped!.tick).toBe(9);
    expect((replayed.stopped!.reason as Journal.HashMismatch).agreedAt).toBe(8);
  });

  it("says so when a queued action meets another fate than the log records", () => {
    const recorded = withApp(game({ checkpointEvery: 0 }), (app) => {
      const dropped = app.dispatch(Drop, { value: 4 });
      const coin = Exit.isSuccess(dropped) ? dropped.value : entityOf(0);
      app.tick(1 / 60);
      app.enqueue(Take, { coin });
      app.enqueue(Take, { coin }); // refused: the coin is gone by then
      app.tick(1 / 60);
      app.tick(1 / 60);
      return app.record();
    });
    expect(moves(recorded.log).map((entry) => entry.refused)).toEqual([
      undefined,
      undefined,
      "NoSuchCoin",
    ]);
    expect(replayInto({}, recorded).stopped).toBeUndefined();

    // The game accepted the first take, and in this log it names no coin.
    const refusedNow = [...recorded.log];
    const take = refusedNow[1] as Action.Logged;
    refusedNow[1] = { ...take, payload: { coin: 4000 } };
    const first = replayInto(
      {},
      altered(recorded, { log: refusedNow })
    ).stopped!;
    expect(first.index).toBe(1);
    expect(first.reason).toBe("NoSuchCoin");
    expect(first.message).toBe(
      'Log entry 1 ("rp/Take" at tick 1) was refused on replay: NoSuchCoin'
    );

    // The game refused the second take, and here the first is gone, so the
    // second finds its coin.
    const acceptedNow = [...recorded.log];
    acceptedNow.splice(1, 1);
    const second = replayInto(
      {},
      altered(recorded, { log: acceptedNow })
    ).stopped!;
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
const Tallies = Query.all(Tally).pipe(Query.writes(Tally));
/** The tallies, read from outside the game. */
const Counted = Query.all(Tally);

/** A plugin whose setup spawns the tally, at `value`. */
const counting = (value: number) =>
  Plugin.make("rp/Counting", {
    setup: Effect.map(Commands.spawns(Tally), (commands) => {
      commands.spawn(Tally.of({ value, rejections: 0 }));
    }),
  });

/** The game's one tally, read from outside it. */
const tallyOf = (
  app: Pick<App.Any, "read">
): { value: number; rejections: number } => {
  const tallies = Effect.runSync(
    app.read(
      Effect.gen(function* () {
        const world = yield* World;
        return (yield* Counted).entities().flatMap((entity) => {
          const tally = world.get(entity, Tally);
          return tally === undefined
            ? []
            : [{ value: tally.value, rejections: tally.rejections }];
        });
      })
    )
  );
  const [tally] = tallies;
  assert(tally !== undefined && tallies.length === 1);
  return tally;
};

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
    return yield* new TooBig();
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
const Bot = System.tick("Bot", function* () {
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
const Referee = System.tick("Referee", function* () {
  const refused = (yield* Action.Rejected).read().length;
  (yield* Tallies).each((tally) => {
    tally.rejections += refused;
  });
});
/** The ticks the heckler waits before its next move. */
const Patience = Singleton.define(
  "rp/Patience",
  { left: Field.u8 },
  { left: 0 }
);
/** A system that makes a move of its own now and then. */
const Heckler = System.tick("Heckler", function* () {
  const random = yield* Random;
  const patience = yield* Patience.writes;
  if (patience.left > 1) {
    patience.left -= 1;
    return;
  }
  if (patience.left === 1) {
    (yield* Action.Actions).enqueue(Add, { by: random.int(1, 9) });
  }
  patience.left = random.int(1, 3);
});

const busyGame = (value = 1) =>
  App.define({
    plugins: [counting(value)],
    systems: [Bot, Referee, Heckler],
    handlers: [double, add, chain],
  });
const busy = (checkpointEvery = 1, value = 1) =>
  App.make(busyGame(value), { seed: 4, checkpointEvery });
const replayBusy = (recording: Journal.Recording) =>
  Journal.replay(recording, busyGame(), { checkpointEvery: 1 });

describe("the action log", () => {
  it("holds what came from outside, as it arrived, and not what the simulation issued itself", () => {
    withApp(busy(0), (app) => {
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
      expect(tallyOf(app).value).toBe((1001 + 1 + 100) * 2);
      // The tick ran the bot and the heckler, and none of their moves is logged.
      for (let i = 0; i < 12; i++) {
        app.tick(1);
      }
      expect(tallyOf(app).value).toBeGreaterThan(10_000);
      expect(app.actionLog.length).toBe(4);
    });
  });

  it("marks a queued action that was refused, and leaves out a dispatched one", () => {
    withApp(busy(0, 1e12), (app) => {
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
        ["rp/Add", expect.stringMatching(/by/)],
      ]);
      // The referee saw all three refusals.
      app.tick(1);
      expect(tallyOf(app).rejections).toBe(3);
    });
  });

  it("keeps its marks through text, and refuses a malformed one", () => {
    const log: Action.LogEntry[] = [
      { tick: 0, hash: 7 },
      { tick: 0, name: "a", payload: { x: 1 } },
      { tick: 0, name: "b", payload: null, queued: true },
      { tick: 1, name: "c", payload: [1], queued: true, refused: "Because" },
    ];
    const recording = altered(record({ ticks: 2 }).recording, { log });
    expect(recording.log).toEqual(log);
    const loaded = Journal.decode(Journal.encode(recording));
    expect(Exit.isSuccess(loaded) && loaded.value).toEqual(recording);
    for (const entry of [
      { tick: 0, name: "a", payload: 1, queued: false },
      { tick: 0, name: "a", payload: 1, queued: "yes" },
      { tick: 0, name: "a", payload: 1, queued: true, refused: true },
      { tick: 0, name: "a", payload: 1, refused: 5 },
    ]) {
      const refused = Journal.decode(
        JSON.stringify({
          ...(JSON.parse(Journal.encode(recording)) as object),
          log: [entry],
        })
      );
      expect(Exit.isFailure(refused), JSON.stringify(entry)).toBe(true);
    }
  });
});

describe("app.enqueue from inside the simulation", () => {
  /**
   * A game whose system and handler hold the app and enqueue through it, as
   * game code that keeps the app in a variable does. `Relay` adds through the
   * app when it is applied.
   */
  const Relay = Action.define("rp/Relay", Schema.Struct({ by: Schema.Int }));
  const holding = Effect.gen(function* () {
    let enqueue: ((by: number) => void) | undefined;
    const relay = Action.handler(Relay, function* ({ by }) {
      enqueue?.(by);
    });
    const Clock = System.tick("Clock", function* () {
      enqueue?.(1);
    });
    const app = yield* App.make(
      App.define({
        plugins: [counting(0)],
        systems: [Clock],
        handlers: [add, relay],
      }),
      { checkpointEvery: 1 }
    );
    enqueue = (by) => {
      app.enqueue(Add, { by });
    };
    return app;
  });
  /**
   * The same game, whose system and handler enqueue through `Actions`, which
   * `app.enqueue` is from inside the simulation. A replay makes its own app,
   * which no variable of the game's holds.
   */
  const Relaying = App.define({
    plugins: [counting(0)],
    systems: [
      System.tick("Clock", function* () {
        (yield* Action.Actions).enqueue(Add, { by: 1 });
      }),
    ],
    handlers: [
      add,
      Action.handler(Relay, function* ({ by }) {
        (yield* Action.Actions).enqueue(Add, { by });
      }),
    ],
  });
  const replayed = (recording: Journal.Recording) =>
    withApp(
      Effect.orDie(
        Journal.replay(recording, Relaying, {
          checkpointEvery: 1,
        })
      ),
      (app, world) => ({ value: tallyOf(app).value, hash: world.hash() })
    );

  it("is the simulation's own move from a system, so a replay makes it once", () => {
    const recorded = withApp(holding, (app, world) => {
      for (let i = 0; i < 3; i++) {
        app.tick(1);
      }
      return {
        recording: app.record(),
        value: tallyOf(app).value,
        hash: world.hash(),
      };
    });
    // The first tick's move is applied on the second, and so on.
    expect(recorded.value).toBe(2);
    expect(moves(recorded.recording.log)).toEqual([]);
    expect(replayed(recorded.recording)).toEqual({
      value: recorded.value,
      hash: recorded.hash,
    });
  });

  it("is the simulation's own move from a handler: only the dispatched action is logged", () => {
    const recorded = withApp(holding, (app, world) => {
      expect(Exit.isSuccess(app.dispatch(Relay, { by: 100 }))).toBe(true);
      app.tick(1);
      return {
        recording: app.record(),
        value: tallyOf(app).value,
        hash: world.hash(),
      };
    });
    expect(recorded.value).toBe(100);
    expect(moves(recorded.recording.log)).toEqual([
      { tick: 0, name: "rp/Relay", payload: { by: 100 } },
    ]);
    expect(replayed(recorded.recording)).toEqual({
      value: recorded.value,
      hash: recorded.hash,
    });
  });

  it("is the game's own move from a plugin's setup, and isn't logged", () => {
    const Opening = Plugin.make("Opening", {
      handlers: [add],
      setup: Effect.gen(function* () {
        (yield* Action.Actions).enqueue(Add, { by: 10 });
      }),
    });
    withApp(
      App.make(App.define({ plugins: [counting(0), Opening] }), {
        checkpointEvery: 0,
      }),
      (app) => {
        app.enqueue(Add, { by: 4000 });
        app.tick(1);
        expect(tallyOf(app).value).toBe(4010);
        expect(app.actionLog).toEqual([
          { tick: 0, name: "rp/Add", payload: { by: 4000 }, queued: true },
        ]);
      }
    );
  });
});

describe("a game whose simulation issues actions itself", () => {
  /** Outside moves mixed in with the bot's, the heckler's and a handler's. */
  const play = (app: Effect.Success<ReturnType<typeof busy>>) => {
    const dice = new EcsWorld({ seed: 77 }).random;
    for (let tick = 0; tick < 90; tick++) {
      for (let n = dice.int(0, 3); n > 0; n--) {
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
    const recorded = withApp(busy(), (app, world) => {
      play(app);
      return {
        recording: app.record(),
        log: [...app.actionLog],
        hash: world.hash(),
        tally: tallyOf(app),
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

    const replayed = withApp(
      Effect.orDie(replayBusy(recorded.recording)),
      (app, world) => ({
        log: [...app.actionLog],
        hash: world.hash(),
        tally: tallyOf(app),
      })
    );
    expect(replayed.hash).toBe(recorded.hash);
    expect(replayed.tally).toEqual(recorded.tally);
    // The replay's own log is the game's, entry for entry, marks included.
    expect(replayed.log).toEqual(recorded.log);
  });

  it("would not replay if the simulation's own moves were replayed from the log as well", () => {
    // The flaw this replaces: every applied action was logged and replayed,
    // so a move the bot made was made twice, once from the log and once by
    // the replay's own bot. Here the bot's moves are put back in by hand.
    const recorded = withApp(busy(), (app) => {
      for (let i = 0; i < 9; i++) {
        app.tick(1);
      }
      return app.record();
    });
    expect(moves(recorded.log)).toEqual([]);
    const withBotMoves = [...recorded.log];
    const at = withBotMoves.findIndex(
      (entry) => Action.isCheckpoint(entry) && entry.tick === 3
    );
    withBotMoves.splice(at + 1, 0, {
      tick: 3,
      name: "rp/Add",
      payload: { by: 7 },
    });
    const stopped = stoppedBy(
      replayBusy(altered(recorded, { log: withBotMoves }))
    );
    expect(stopped.reason).toBeInstanceOf(Journal.HashMismatch);
    expect(stopped.tick).toBe(4);
    // And as it is recorded, it replays.
    withApp(Effect.orDie(replayBusy(recorded)), (app) => {
      expect(app.time.tick).toBe(9);
    });
  });

  it("keeps the order of what was enqueued from outside and what a dispatched handler enqueued", () => {
    // Two actions wait for the next tick: a doubling enqueued from outside,
    // and an addition enqueued by the handler of a dispatched action. They do
    // not commute, so each order of arrival is its own game, and each has to
    // replay as itself.
    const Ordered = App.define({
      plugins: [counting(1)],
      handlers: [double, add, chain],
    });
    const make = App.make(Ordered, { checkpointEvery: 1 });
    const play = (first: "enqueue" | "dispatch") =>
      withApp(make, (app) => {
        if (first === "enqueue") {
          app.enqueue(Double, {});
          app.dispatch(Chain, { by: 10 });
        } else {
          app.dispatch(Chain, { by: 10 });
          app.enqueue(Double, {});
        }
        app.tick(1);
        return {
          value: tallyOf(app).value,
          recording: app.record(),
        };
      });
    const replay = (recording: Journal.Recording) =>
      withApp(
        Effect.orDie(
          Journal.replay(recording, Ordered, {
            checkpointEvery: 1,
          })
        ),
        (app) => tallyOf(app).value
      );

    const doubledFirst = play("enqueue");
    const addedFirst = play("dispatch");
    expect(doubledFirst.value).toBe(1 * 2 + 10);
    expect(addedFirst.value).toBe((1 + 10) * 2);
    expect(
      moves(doubledFirst.recording.log).map((entry) => entry.name)
    ).toEqual(["rp/Double", "rp/Chain"]);
    expect(moves(addedFirst.recording.log).map((entry) => entry.name)).toEqual([
      "rp/Chain",
      "rp/Double",
    ]);
    expect(replay(doubledFirst.recording)).toBe(doubledFirst.value);
    expect(replay(addedFirst.recording)).toBe(addedFirst.value);
  });
});

describe("a recording", () => {
  // A walker whose stride is the tick's delta: a tick of another length
  // leaves it somewhere else.
  const Walker = Component.define("rp/Walker", { x: Field.f64 });
  const Walk = System.tick("rp/Walk", function* () {
    const { delta } = yield* Time;
    (yield* Query.all(Walker).pipe(Query.writes(Walker))).each((walker) => {
      walker.x += delta;
    });
  });
  const Start = Plugin.make("rp/Walking", {
    setup: Effect.map(Commands.spawns(Walker), (commands) => {
      commands.spawn(Walker.of({ x: 0 }));
    }),
  });
  const Walking = App.define({
    plugins: [Start],
    systems: [Walk],
    handlers: [drop],
  });
  const walking = App.make(Walking, { checkpointEvery: 1 });
  const replayWalking = (recording: Journal.Recording) =>
    Effect.orDie(Journal.replay(recording, Walking, { checkpointEvery: 1 }));
  const steps = [1 / 60, 1 / 60, 1 / 60, 1 / 30, 1 / 30, 1 / 60];

  it("holds how long each tick was, so a replay takes the same steps to the same end", () => {
    const recorded = withApp(walking, (app, world) => {
      for (const delta of steps) {
        app.dispatch(Drop, { value: 1 });
        app.tick(delta);
      }
      return { recording: app.record(), hash: world.hash() };
    });
    expect(recorded.recording).toMatchObject({
      start: 0,
      end: 6,
      deltas: [
        { tick: 0, delta: 1 / 60 },
        { tick: 3, delta: 1 / 30 },
        { tick: 5, delta: 1 / 60 },
      ],
    });
    const decoded = Journal.decode(Journal.encode(recorded.recording));
    expect(decoded).toEqual(Exit.succeed(recorded.recording));
    withApp(replayWalking(recorded.recording), (app, world) => {
      expect(app.time.tick).toBe(6);
      expect(app.time.elapsed).toBeCloseTo(steps.reduce((a, b) => a + b));
      expect(world.hash()).toBe(recorded.hash);
    });
  });

  it("begins at a save of the app, with the run of deltas under way there", () => {
    withApp(walking, (app) => {
      app.tick(1 / 30);
      app.tick(1 / 30);
      app.tick(1 / 30);
      app.dispatch(Drop, { value: 2 });
      const save = app.save();
      assert(Exit.isSuccess(save));
      app.tick(1 / 30);
      app.tick(1 / 60);
      const tail = app.record(save.value);
      expect(tail).toMatchObject({
        start: 3,
        end: 5,
        deltas: [
          { tick: 3, delta: 1 / 30 },
          { tick: 4, delta: 1 / 60 },
        ],
      });
      expect(tail.log.every((entry) => entry.tick >= 3)).toBe(true);
    });
  });

  it("forgets the ticks a rewind gave up", () => {
    withApp(walking, (app) => {
      app.tick(1 / 60);
      const moment = Timeline.capture(app);
      assert(Exit.isSuccess(moment));
      app.tick(1 / 30);
      app.tick(1 / 30);
      Timeline.rewind(app, moment.value);
      app.tick(1 / 60);
      expect(app.record()).toMatchObject({
        end: 2,
        deltas: [{ tick: 0, delta: 1 / 60 }],
      });
    });
  });

  it("records only a save of its own app", () => {
    withApp(walking, (app) => {
      app.tick(1 / 60);
      // Not a save of this app: it is of a tick this one hasn't reached.
      const ahead = withApp(walking, (other) => {
        for (let i = 0; i < 5; i++) {
          other.tick(1 / 60);
        }
        return other.save();
      });
      assert(Exit.isSuccess(ahead));
      expect(() => app.record(ahead.value)).toThrow(
        /record\(\) was given a save of tick 5 that this app didn't make/
      );
    });
  });
});

describe("how a recorded game began", () => {
  /** What the schema said was wrong with a recording's text. */
  const refusal = (text: string): string => {
    const read = Journal.decode(text);
    assert(Exit.isFailure(read));
    return String(Cause.squash(read.cause));
  };
  /** Plays `ticks` ticks of a seeded game, dropping a coin on each. */
  const drops = (app: App.Any, ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      app.dispatchByName("rp/Drop", { value: i + 1 });
      app.tick(1 / 60);
    }
  };

  it("is its seed for a game recorded from its start: an app made from the recording begins the same way", () => {
    const recorded = record({ ticks: 40, seed: 5, checkpointEvery: 1 });
    expect(recorded.recording.seed).toBe(5);
    expect(recorded.recording.save).toBeUndefined();
    // The game and the recording, and no seed said again: the replay makes
    // its app from how the game began, and its own recording says so.
    const replayed = withApp(
      Effect.orDie(Journal.replay(recorded.recording, coinGame())),
      (app, world) => ({
        tick: app.time.tick,
        hash: world.hash(),
        seed: app.record().seed,
      })
    );
    expect(replayed).toEqual({
      tick: 40,
      hash: recorded.hashes.at(-1),
      seed: 5,
    });
    // Nor can another beginning be given: a replay's options are the rest of
    // what `App.make` takes.
    const { save } = withApp(game(), (app) => {
      const saved = app.save();
      assert(Exit.isSuccess(saved));
      return { save: saved.value };
    });
    const origin: Journal.Origin = { seed: 6 };
    const options = { seed: 6, checkpointEvery: 1 };
    void Journal.replay(
      recorded.recording,
      coinGame(),
      // @ts-expect-error the recording holds its seed
      { seed: 6 }
    );
    void Journal.replay(
      recorded.recording,
      coinGame(),
      // @ts-expect-error the recording holds its seed or its save
      { save }
    );
    void Journal.replay(
      recorded.recording,
      coinGame(),
      // @ts-expect-error nor spread from how a game began
      { ...origin, checkpointEvery: 1 }
    );
    // @ts-expect-error nor in a variable
    void Journal.replay(recorded.recording, coinGame(), options);
    // A game made with no seed began with seed 0, and its recording says so.
    withApp(App.make(coinGame()), (app) => {
      expect(app.record().seed).toBe(0);
    });
    // Through text and back.
    expect(Journal.decode(Journal.encode(recorded.recording))).toEqual(
      Exit.succeed(recorded.recording)
    );
  });

  it("is the save for a game recorded since one, which a replay goes on from to the present", () => {
    const played = withApp(
      game({ seed: 3, checkpointEvery: 1 }),
      (app, world) => {
        drops(app, 10);
        const saved = app.save();
        assert(Exit.isSuccess(saved));
        drops(app, 20);
        return {
          save: saved.value,
          tail: app.record(saved.value),
          whole: app.record(),
          hash: world.hash(),
        };
      }
    );
    const { save, tail } = played;
    expect(tail.save).toBe(save);
    expect(tail.seed).toBeUndefined();
    expect(tail).toMatchObject({ start: 10, end: 30 });
    // All of the same game is still from its seed.
    expect(played.whole.seed).toBe(3);
    expect(played.whole.save).toBeUndefined();

    // As text, the recording holds the save, and reads back as it was.
    const read = Journal.decode(Journal.encode(tail));
    assert(Exit.isSuccess(read));
    expect(read.value).toEqual(tail);
    const present = withApp(
      Effect.orDie(
        Journal.replay(read.value, coinGame(), { checkpointEvery: 1 })
      ),
      (app, world) => ({
        tick: app.time.tick,
        hash: world.hash(),
        save: app.record().save,
      })
    );
    expect(present).toEqual({ tick: 30, hash: played.hash, save });

    // An app made from a save began there, and its recording says so.
    withApp(Effect.orDie(App.make(coinGame(), { save })), (app) => {
      drops(app, 2);
      const recording = app.record();
      expect(recording.save).toEqual(save);
      expect(recording).toMatchObject({ start: 10, end: 12 });
    });
  });

  it("is checked when a recording is read from text", () => {
    const { save, tail, whole } = withApp(game({ seed: 3 }), (app) => {
      drops(app, 4);
      const saved = app.save();
      assert(Exit.isSuccess(saved));
      drops(app, 2);
      return {
        save: saved.value,
        tail: app.record(saved.value),
        whole: app.record(),
      };
    });
    const fromSeed = JSON.parse(Journal.encode(whole)) as Record<
      string,
      unknown
    >;
    const fromSave = JSON.parse(Journal.encode(tail)) as Record<
      string,
      unknown
    >;
    expect(typeof fromSave["save"]).toBe("string");
    const text = (recording: Record<string, unknown>): string =>
      JSON.stringify(recording);

    // Only `app.record()` and `Journal.decode` make a recording.
    const written: Journal.Played & Journal.Origin = {
      seed: 3,
      start: 0,
      end: 0,
      endHash: 0,
      deltas: [],
      log: [],
    };
    // @ts-expect-error a recording written by hand is not one
    void (() => Journal.replay(written, coinGame()));

    // A recording from before one held the hash its game ended on.
    const { endHash: _endHash, ...older } = fromSeed;
    expect(refusal(text(older))).toMatch(
      /older format: it holds no endHash, the hash its game ended on/
    );

    const { seed: _, ...neither } = fromSeed;
    expect(refusal(text(neither))).toMatch(
      /how its game began as a seed or as a save, one of the two/
    );
    expect(refusal(text({ ...fromSave, seed: 3 }))).toMatch(
      /how its game began as a seed or as a save, one of the two/
    );
    // A game from a seed begins at tick 0.
    expect(
      refusal(
        text({
          ...fromSeed,
          start: 2,
          deltas: [{ tick: 2, delta: 1 / 60 }],
          log: [],
        })
      )
    ).toMatch(/begins at tick 2 with a seed, and a game begins at tick 0/);
    // A save is of the tick its recording begins at.
    expect(
      refusal(
        text({
          ...fromSave,
          start: 5,
          deltas: [{ tick: 5, delta: 1 / 60 }],
          log: [],
        })
      )
    ).toMatch(/begins at tick 5, and its save was made at tick 4/);
    // And it reads as a save.
    expect(refusal(text({ ...fromSave, save: "bm90IGEgc2F2ZQ==" }))).toMatch(
      /its save can't be read: These bytes are not a saved game/
    );
    const cut = Save.encode(save).slice(0, 40);
    expect(
      refusal(text({ ...fromSave, save: Buffer.from(cut).toString("base64") }))
    ).toMatch(/its save can't be read/);
  });
});
