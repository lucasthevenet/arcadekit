import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { SchemaBinary } from "effect/encoding";

import { entityOf } from "../src/ecs/component.ts";
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
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import { Layout } from "../src/internal/recording.ts";
import type { BuiltIn } from "../src/Services.ts";
import { thrown } from "./checks.ts";

// --- a small game: coins are dropped, drift about at random, and are taken ------

const Coin = Component.define("rp/Coin", { value: Field.i32, x: Field.f32 });
const Coins = Query.all(Coin).pipe(Query.writes(Coin));
/** The coins, read from outside the game. */
const Lying = Query.all(Coin);

class NoSuchCoin extends Schema.TaggedError<NoSuchCoin>()("NoSuchCoin", {
  coin: EntityId,
}) {}
const Drop = Action.define("rp/Drop", Schema.Struct({ value: Schema.Int }));
const Take = Action.define("rp/Take", Schema.Struct({ coin: EntityId }), {
  error: NoSuchCoin,
});

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
    return yield* NoSuchCoin.make({ coin });
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
const withApp = <T extends Pick<App.Any, "read">, A, E2 = never>(
  make: Effect.Effect<T, never>,
  use: (app: T, world: Effect.Success<typeof World>) => Effect.Effect<A, E2>
) =>
  Effect.flatMap(make, (app) =>
    Effect.flatMap(app.read(World), (world) => use(app, world))
  );

/** What stopped a replay that the test expects to diverge. */
const stoppedBy = <A extends App.Any>(
  replay: Effect.Effect<A, Journal.ReplayDiverged<A> | Save.LoadRefused>
) =>
  replay.pipe(
    Effect.flatMap(() => Effect.die("it went the way the game went")),
    Effect.catchTag("ReplayDiverged", Effect.succeed),
    Effect.orDie
  );

const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));
const checkpoints = (log: readonly Action.LogEntry[]): Action.Checkpoint[] =>
  log.filter((entry) => Action.isCheckpoint(entry));

/**
 * Plays a game of random moves, every one of them accepted, and returns its
 * log with the hash the world had after each tick.
 */
const record = Effect.fnUntraced(function* (
  options: Options & { readonly ticks: number }
) {
  return yield* withApp(game(options), (app, world) =>
    Effect.gen(function* () {
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
    })
  );
});

const unwrap = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  }
  return exit.value;
};

/** A recording's fields as its bytes hold them, each checked on its own. */
const Written = SchemaBinary.toCodec(Layout);
const fieldsOf = (recording: Journal.Recording) =>
  unwrap(Schema.decodeExit(Written)(Journal.encode(recording)));
/** Fields written as a recording's bytes, as a file edited by hand. */
const written = (fields: typeof Layout.Type) =>
  unwrap(Schema.encodeExit(Written)(fields));

/**
 * `recording` with `fields` changed in its bytes, as a file edited by hand,
 * and read back.
 */
const altered = (
  recording: Journal.Recording,
  fields: Partial<typeof Layout.Type>
): Journal.Recording => {
  const read = Journal.decode(written({ ...fieldsOf(recording), ...fields }));
  assert(Exit.isSuccess(read));
  return read.value;
};

/**
 * Replays a recording into the coin game `options` make, and returns what
 * stopped it, if anything did, with the app as the replay left it.
 */
const replayInto = (options: Options, recording: Journal.Recording) =>
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
  });

describe("checkpoints", () => {
  it.effect(
    "are recorded before the first action or tick, and after every tick the interval divides",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 10, checkpointEvery: 3 });
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
        expect(
          recorded.log.slice(0, third).every((entry) => entry.tick < 3)
        ).toBe(true);
        expect(
          recorded.log.slice(third + 1).every((entry) => entry.tick >= 3)
        ).toBe(true);
        expect(moves(recorded.log).length).toBeGreaterThan(3);
      })
  );

  it.effect(
    "are taken when a tick is over, after the commands its systems queued are applied",
    () =>
      Effect.gen(function* () {
        // The last system's commands are the last thing a tick applies.
        const Mint = System.tick("Mint", function* () {
          (yield* Commands.spawns(Coin)).spawn(Coin.of({ value: 1, x: 0 }));
        });
        yield* withApp(
          game({ checkpointEvery: 1, faulty: Mint }),
          (app, world) =>
            Effect.gen(function* () {
              for (let tick = 1; tick <= 5; tick++) {
                app.tick(1 / 60);
                expect(world.entityCount).toBe(tick);
                expect(app.actionLog.at(-1)).toEqual({
                  tick,
                  hash: world.hash(),
                });
              }
            })
        );
      })
  );

  it.effect(
    "come every 60 ticks unless told otherwise, every tick with 1, and never with 0",
    () =>
      Effect.gen(function* () {
        const ticksOf = Effect.fnUntraced(function* (checkpointEvery?: number) {
          return checkpoints(
            (yield* record({
              ticks: 130,
              ...(checkpointEvery === undefined ? {} : { checkpointEvery }),
            })).log
          ).map((entry) => entry.tick);
        });
        expect(yield* ticksOf()).toEqual([0, 60, 120]);
        expect(yield* ticksOf(1)).toEqual(
          Array.from({ length: 131 }, (_, i) => i)
        );
        expect(yield* ticksOf(50)).toEqual([0, 50, 100]);
        expect(yield* ticksOf(1000)).toEqual([0]);
        expect(yield* ticksOf(0)).toEqual([]);
        for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
          expect(
            yield* thrown(
              withApp(game({ checkpointEvery: bad }), () => Effect.succeed(0))
            )
          ).toThrow(/checkpointEvery must be a whole number of ticks/);
        }
      })
  );

  it.effect(
    "start from the state the game starts from, whichever of its moves comes first",
    () =>
      Effect.gen(function* () {
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
          yield* withApp(game({ coins: [5] }), (app, world) =>
            Effect.gen(function* () {
              expect(app.actionLog).toEqual([]);
              const [coin] = (yield* app.read(Lying)).entities();
              assert(coin !== undefined);
              const starting = world.hash();
              first(app, coin);
              expect(app.actionLog[0]).toEqual({ tick: 0, hash: starting });
              expect(checkpoints(app.actionLog).length).toBe(1);
            })
          );
        }
      })
  );

  it.effect("can be asked for between ticks, and not during one", () =>
    Effect.gen(function* () {
      yield* withApp(game({ checkpointEvery: 0, coins: [1] }), (app, world) =>
        Effect.gen(function* () {
          app.tick(1);
          app.tick(1);
          expect(app.actionLog).toEqual([]);
          const hash = app.checkpoint();
          expect(hash).toBe(world.hash());
          expect(app.actionLog).toEqual([{ tick: 2, hash }]);
          app.dispatch(Drop, { value: 2 });
          app.checkpoint();
          expect(
            app.actionLog.map((entry) => Action.isCheckpoint(entry))
          ).toEqual([true, false, true]);
          expect(checkpoints(app.actionLog)[1]!.hash).not.toBe(hash);
        })
      );

      // One taken by hand before the game starts is the starting checkpoint.
      yield* withApp(game({ checkpointEvery: 5, coins: [1] }), (app) =>
        Effect.gen(function* () {
          app.checkpoint();
          app.tick(1);
          expect(checkpoints(app.actionLog).map((entry) => entry.tick)).toEqual(
            [0]
          );
        })
      );

      let inside: unknown;
      const Asks = System.tick("Asks", function* () {
        try {
          asking!.checkpoint();
        } catch (error) {
          inside = error;
        }
      });
      let asking: App.Any | undefined;
      yield* withApp(App.make(App.define({ systems: [Asks] })), (app) =>
        Effect.gen(function* () {
          asking = app;
          app.tick(1);
        })
      );
      expect(String(inside)).toMatch(/checkpoint\(\) was called during a tick/);
    })
  );

  it.effect("survive being written down, and a malformed one is refused", () =>
    Effect.gen(function* () {
      const recorded = yield* record({ ticks: 12, checkpointEvery: 4 });
      const loaded = Journal.decode(Journal.encode(recorded.recording));
      expect(Exit.isSuccess(loaded) && loaded.value).toEqual(
        recorded.recording
      );
      expect(fieldsOf(recorded.recording).log[0]).toEqual({
        tick: 0,
        hash: recorded.starting,
      });
      /** A checkpoint as its bytes hold it, its tick and its hash, unchecked. */
      const Holding = SchemaBinary.toCodec(
        Schema.Struct({
          ...Layout.fields,
          log: Schema.Array(
            Schema.Union([
              Layout.fields.log.value.members[0],
              Schema.Tuple([Schema.Int, Schema.Int]),
            ])
          ),
        })
      );
      const holding = (fields: typeof Holding.Type) =>
        unwrap(Schema.encodeExit(Holding)(fields));
      const fields = fieldsOf(recorded.recording);
      const largest = Journal.decode(
        holding({ ...fields, log: [[0, 2 ** 32 - 1]] })
      );
      expect(Exit.isSuccess(largest) && largest.value.log).toEqual([
        { tick: 0, hash: 2 ** 32 - 1 },
      ]);
      for (const entry of [
        [0, -1],
        [0, 2 ** 32],
        [-1, 12],
      ] as const) {
        const refused = Journal.decode(holding({ ...fields, log: [entry] }));
        expect(Exit.isFailure(refused), JSON.stringify(entry)).toBe(true);
      }
      // A log of entries of another kind.
      const otherwise = SchemaBinary.toCodec(
        Schema.Struct({
          ...Layout.fields,
          log: Schema.Array(
            Schema.Struct({ tick: Schema.Number, hash: Schema.String })
          ),
        })
      );
      expect(
        Exit.isFailure(
          Journal.decode(
            unwrap(
              Schema.encodeExit(otherwise)({
                ...fields,
                log: [{ tick: 0.5, hash: "12" }],
              })
            )
          )
        )
      ).toBe(true);
      expect(Action.isCheckpoint({ tick: 1, hash: 0 })).toBe(true);
      expect(Action.isCheckpoint({ tick: 1, name: "x", payload: 0 })).toBe(
        false
      );
    })
  );
});

describe("a replay that checks itself", () => {
  it.effect("passes every checkpoint when it goes the way the game went", () =>
    Effect.gen(function* () {
      for (const checkpointEvery of [1, 7, 60]) {
        const recorded = yield* record({ ticks: 150, checkpointEvery });
        const replayed = yield* replayInto({}, recorded.recording);
        expect(replayed.stopped).toBeUndefined();
        expect(replayed.tick).toBe(150);
        expect(replayed.hash).toBe(recorded.hashes.at(-1));
      }
      // Recording as it replays, it writes the same log again.
      const recorded = yield* record({ ticks: 40, checkpointEvery: 1 });
      expect(
        (yield* replayInto({ checkpointEvery: 1 }, recorded.recording)).log
      ).toEqual(recorded.log);
    })
  );

  it.effect(
    "stops at the tick it diverged on, not at the next refused action",
    () =>
      Effect.gen(function* () {
        // The game is recorded with a checkpoint every tick. In the build that
        // replays it, a coin's position is off by a millionth on tick 40. No
        // rule is broken by that, and no action is refused because of it.
        const recorded = yield* record({ ticks: 120, checkpointEvery: 1 });
        const replayed = yield* replayInto(
          { faulty: fault(40, "nudge") },
          recorded.recording
        );
        const stopped = replayed.stopped!;
        expect(stopped).toBeInstanceOf(Journal.ReplayDiverged);
        expect(stopped.tick).toBe(40);
        // It stopped there: no later tick ran and no later move was applied.
        expect(replayed.tick).toBe(40);
        expect(moves(replayed.log).every((entry) => entry.tick < 40)).toBe(
          true
        );
        expect(moves(recorded.log).some((entry) => entry.tick >= 40)).toBe(
          true
        );

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
      })
  );

  it.effect(
    "fails with its app where it stopped, an app of its game to look at",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 60, checkpointEvery: 1 });
        const looked = yield* Journal.replay(
          recorded.recording,
          coinGame(fault(20, "lose")),
          {
            checkpointEvery: 1,
          }
        ).pipe(
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
        );
        // Where the build that loses a coin on tick 20 stopped: at that tick's
        // checkpoint, with the world whose hash it compared.
        expect(looked.stoppedAt).toBe(20);
        expect(looked.tick).toBe(20);
        expect(looked.hash).toBe(looked.reason.actual);
        expect(looked.hash).not.toBe(recorded.hashes[19]);
        expect(looked.dropped).toBe(true);
        expect(looked.after).toBe(looked.coins + 1);
      })
  );

  it.effect(
    "closes the app it stopped in, and leaves the app of one that went the way the game went to its caller",
    () =>
      Effect.gen(function* () {
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
        const recorded = yield* record({ ticks: 30, checkpointEvery: 1 });
        const stopped = yield* stoppedBy(
          Journal.replay(recorded.recording, heldGame(fault(10, "lose")), {
            checkpointEvery: 1,
          })
        );
        expect(held).toEqual(["acquired", "released"]);
        // Closed, it is there to read.
        const reason = stopped.reason as Journal.HashMismatch;
        expect((yield* stopped.app.read(World)).hash()).toBe(reason.actual);

        held.length = 0;
        const app = yield* Journal.replay(
          recorded.recording,
          heldGame(fault(-1, "nudge"))
        );
        expect(app.time.tick).toBe(30);
        expect(held).toEqual(["acquired"]);
        yield* app.close;
        expect(held).toEqual(["acquired", "released"]);
      })
  );

  it.effect(
    "without them runs on until an action happens to be refused, or to its end, where it fails",
    () =>
      Effect.gen(function* () {
        // The same recording with its checkpoints taken out. The faulty build
        // loses the oldest coin on tick 40, and the game takes that coin on tick
        // 100.
        const recorded = yield* record({ ticks: 100, checkpointEvery: 1 });
        const oldest = recorded.coins[0]!;
        const log = [
          ...recorded.log,
          { tick: 100, name: "rp/Take", payload: { coin: oldest } },
        ];
        const blind = yield* replayInto(
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
        const checked = yield* replayInto(
          { faulty: fault(40, "lose") },
          altered(recorded.recording, { log, end: 110 })
        );
        expect(checked.stopped!.tick).toBe(40);
        expect(checked.stopped!.reason).toBeInstanceOf(Journal.HashMismatch);

        // A fault that breaks no rule, in a game recorded with no checkpoints,
        // shows at the end: the replay's world isn't the one the game ended on.
        const unchecked = yield* record({ ticks: 100, checkpointEvery: 0 });
        expect(checkpoints(unchecked.log)).toEqual([]);
        expect(unchecked.recording.endHash).toBe(unchecked.hashes.at(-1));
        expect(
          (yield* replayInto({}, unchecked.recording)).stopped
        ).toBeUndefined();
        const silent = yield* replayInto(
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
      })
  );

  it.effect(
    "stops at the first checkpoint after it diverged when they are further apart, and names the last that matched",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 120, checkpointEvery: 10 });
        const replayed = yield* replayInto(
          { faulty: fault(43, "nudge") },
          recorded.recording
        );
        expect(replayed.stopped!.tick).toBe(50);
        expect(replayed.tick).toBe(50);
        const reason = replayed.stopped!.reason as Journal.HashMismatch;
        expect(reason.agreedAt).toBe(40);
        expect(reason.expected).toBe(recorded.hashes[49]);
        // A fault on a checkpoint's own tick is caught by that checkpoint.
        const onIt = yield* replayInto(
          { faulty: fault(50, "nudge") },
          recorded.recording
        );
        expect(onIt.stopped!.tick).toBe(50);
        const after = yield* replayInto(
          { faulty: fault(51, "nudge") },
          recorded.recording
        );
        expect(after.stopped!.tick).toBe(60);
        expect((after.stopped!.reason as Journal.HashMismatch).agreedAt).toBe(
          50
        );
      })
  );

  it.effect(
    "stops before its first tick when it does not start where the game started",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 30, seed: 5 });
        const otherSeed = yield* replayInto(
          {},
          altered(recorded.recording, { seed: 6 })
        );
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
        const crowded = yield* replayInto({ coins: [1] }, recorded.recording);
        expect(crowded.stopped!.tick).toBe(0);
        expect(crowded.tick).toBe(0);
        expect(
          (yield* replayInto({}, recorded.recording)).stopped
        ).toBeUndefined();
      })
  );

  it.effect(
    "catches a log that was edited into another game the rules allow",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 60, checkpointEvery: 1 });
        const edit = Effect.fnUntraced(function* (
          change: (log: Action.LogEntry[]) => void
        ) {
          const log = [...recorded.log];
          change(log);
          return (yield* replayInto({}, altered(recorded.recording, { log })))
            .stopped;
        });
        const drops = recorded.log.flatMap((entry, index) =>
          !Action.isCheckpoint(entry) &&
          entry.name === "rp/Drop" &&
          entry.tick > 5
            ? [index]
            : []
        );
        const at = drops[0]!;
        const { tick } = recorded.log[at]!;

        // A coin of another value: a legal move, and a different game.
        const changed = yield* edit((log) => {
          const drop = log[at] as Action.Logged;
          const { value } = drop.payload as { readonly value: number };
          log[at] = { ...drop, payload: { value: value + 1 } };
        });
        expect(changed!.reason).toBeInstanceOf(Journal.HashMismatch);
        expect(changed!.tick).toBe(tick + 1);
        expect((changed!.reason as Journal.HashMismatch).agreedAt).toBe(tick);

        // A move taken out, and a move put in.
        const removed = yield* edit((log) => {
          log.splice(at, 1);
        });
        expect(removed!.tick).toBe(tick + 1);
        const added = yield* edit((log) => {
          log.splice(at, 0, { tick, name: "rp/Drop", payload: { value: 3 } });
        });
        expect(added!.tick).toBe(tick + 1);

        // A checkpoint that was altered is itself the entry that does not hold.
        const forged = yield* edit((log) => {
          const index = log.findIndex(
            (entry) => entry.tick === 20 && Action.isCheckpoint(entry)
          );
          const checkpoint = log[index] as Action.Checkpoint;
          log[index] = { ...checkpoint, hash: (checkpoint.hash ^ 1) >>> 0 };
        });
        expect(forged!.tick).toBe(20);
        expect((forged!.reason as Journal.HashMismatch).agreedAt).toBe(19);
      })
  );

  it.effect("catches a world that was changed behind the log's back", () =>
    Effect.gen(function* () {
      // On its ninth tick the recorded game spawns a coin because of something
      // the world doesn't hold, which no action in the log says. The replay
      // cannot know, and says where it shows.
      let hidden: number | undefined;
      const Behind = System.tick("Behind", function* () {
        if (hidden !== undefined) {
          (yield* Commands.spawns(Coin)).spawn(
            Coin.of({ value: hidden, x: 0 })
          );
          hidden = undefined;
        }
      });
      const recorded = yield* withApp(
        game({ checkpointEvery: 1, faulty: Behind }),
        (app) =>
          Effect.gen(function* () {
            for (let tick = 0; tick < 20; tick++) {
              if (tick === 8) {
                hidden = 7;
              }
              app.dispatch(Drop, { value: 1 });
              app.tick(1 / 60);
            }
            return app.record();
          })
      );
      const replayed = yield* replayInto({}, recorded);
      expect(replayed.stopped!.tick).toBe(9);
      expect((replayed.stopped!.reason as Journal.HashMismatch).agreedAt).toBe(
        8
      );
    })
  );

  it.effect(
    "says so when a queued action meets another fate than the log records",
    () =>
      Effect.gen(function* () {
        const recorded = yield* withApp(game({ checkpointEvery: 0 }), (app) =>
          Effect.gen(function* () {
            const dropped = app.dispatch(Drop, { value: 4 });
            const coin = Exit.isSuccess(dropped) ? dropped.value : entityOf(0);
            app.tick(1 / 60);
            app.enqueue(Take, { coin });
            app.enqueue(Take, { coin }); // refused: the coin is gone by then
            app.tick(1 / 60);
            app.tick(1 / 60);
            return app.record();
          })
        );
        expect(moves(recorded.log).map((entry) => entry.refused)).toEqual([
          undefined,
          undefined,
          "NoSuchCoin",
        ]);
        expect((yield* replayInto({}, recorded)).stopped).toBeUndefined();

        // The game accepted the first take, and in this log it names no coin.
        const refusedNow = [...recorded.log];
        const take = refusedNow[1] as Action.Logged;
        refusedNow[1] = { ...take, payload: { coin: 4000 } };
        const first = (yield* replayInto(
          {},
          altered(recorded, { log: refusedNow })
        )).stopped!;
        expect(first.index).toBe(1);
        expect(first.reason).toBe("NoSuchCoin");
        expect(first.message).toBe(
          'Log entry 1 ("rp/Take" at tick 1) was refused on replay: NoSuchCoin'
        );

        // The game refused the second take, and here the first is gone, so the
        // second finds its coin.
        const acceptedNow = [...recorded.log];
        acceptedNow.splice(1, 1);
        const second = (yield* replayInto(
          {},
          altered(recorded, { log: acceptedNow })
        )).stopped!;
        expect(second.index).toBe(1);
        expect(second.message).toBe(
          'Log entry 1 ("rp/Take" at tick 1) did not replay: the game refused it (NoSuchCoin) and the replay accepted it'
        );
      })
  );
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
const tallyOf = Effect.fnUntraced(function* (app: Pick<App.Any, "read">) {
  const tallies = yield* app.read(
    Effect.gen(function* () {
      const world = yield* World;
      return (yield* Counted).entities().flatMap((entity) => {
        const tally = world.get(entity, Tally);
        return tally === undefined
          ? []
          : [{ value: tally.value, rejections: tally.rejections }];
      });
    })
  );
  const [tally] = tallies;
  assert(tally !== undefined && tallies.length === 1);
  return tally;
});

class TooBig extends Schema.TaggedError<TooBig>()("TooBig", {}) {}
const Double = Action.define("rp/Double", Schema.Struct({}), {
  error: TooBig,
});
const Add = Action.define("rp/Add", Schema.Struct({ by: Schema.Int }));
const Chain = Action.define("rp/Chain", Schema.Struct({ by: Schema.Int }));

// Doubling and adding do not commute, so the tally gives away any change in
// the order actions were applied in.
const double = Action.handler(Double, function* () {
  let refuse = false;
  (yield* Tallies).each((tally) => {
    tally.value *= 2;
    refuse = tally.value > 1e12;
  });
  if (refuse) {
    return yield* TooBig.make({});
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
  it.effect(
    "holds what came from outside, as it arrived, and not what the simulation issued itself",
    () =>
      withApp(busy(0), (app) =>
        Effect.gen(function* () {
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
          expect((yield* tallyOf(app)).value).toBe((1001 + 1 + 100) * 2);
          // The tick ran the bot and the heckler, and none of their moves is logged.
          for (let i = 0; i < 12; i++) {
            app.tick(1);
          }
          expect((yield* tallyOf(app)).value).toBeGreaterThan(10_000);
          expect(app.actionLog.length).toBe(4);
        })
      )
  );

  it.effect(
    "marks a queued action that was refused, and leaves out a dispatched one",
    () =>
      withApp(busy(0, 1e12), (app) =>
        Effect.gen(function* () {
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
          expect((yield* tallyOf(app)).rejections).toBe(3);
        })
      )
  );

  it.effect("keeps its marks through bytes, and refuses a malformed one", () =>
    Effect.gen(function* () {
      const log: Action.LogEntry[] = [
        { tick: 0, hash: 7 },
        { tick: 0, name: "a", payload: { x: 1 } },
        { tick: 0, name: "b", payload: null, queued: true },
        { tick: 1, name: "c", payload: [1], queued: true, refused: "Because" },
      ];
      const recording = altered((yield* record({ ticks: 2 })).recording, {
        log,
      });
      expect(recording.log).toEqual(log);
      const loaded = Journal.decode(Journal.encode(recording));
      expect(Exit.isSuccess(loaded) && loaded.value).toEqual(recording);
      // A mark of another kind is bytes in another layout.
      const marked = SchemaBinary.toCodec(
        Schema.Struct({
          ...Layout.fields,
          log: Schema.Array(
            Schema.Struct({
              tick: Schema.Int,
              name: Schema.String,
              payload: Schema.Unknown,
              queued: Schema.String,
            })
          ),
        })
      );
      const refused = Journal.decode(
        unwrap(
          Schema.encodeExit(marked)({
            ...fieldsOf(recording),
            log: [{ tick: 0, name: "a", payload: 1, queued: "yes" }],
          })
        )
      );
      expect(Exit.isFailure(refused)).toBe(true);
    })
  );
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
  const replayed = Effect.fnUntraced(function* (recording: Journal.Recording) {
    return yield* withApp(
      Effect.orDie(
        Journal.replay(recording, Relaying, {
          checkpointEvery: 1,
        })
      ),
      (app, world) =>
        Effect.gen(function* () {
          return { value: (yield* tallyOf(app)).value, hash: world.hash() };
        })
    );
  });

  it.effect(
    "is the simulation's own move from a system, so a replay makes it once",
    () =>
      Effect.gen(function* () {
        const recorded = yield* withApp(holding, (app, world) =>
          Effect.gen(function* () {
            for (let i = 0; i < 3; i++) {
              app.tick(1);
            }
            return {
              recording: app.record(),
              value: (yield* tallyOf(app)).value,
              hash: world.hash(),
            };
          })
        );
        // The first tick's move is applied on the second, and so on.
        expect(recorded.value).toBe(2);
        expect(moves(recorded.recording.log)).toEqual([]);
        expect(yield* replayed(recorded.recording)).toEqual({
          value: recorded.value,
          hash: recorded.hash,
        });
      })
  );

  it.effect(
    "is the simulation's own move from a handler: only the dispatched action is logged",
    () =>
      Effect.gen(function* () {
        const recorded = yield* withApp(holding, (app, world) =>
          Effect.gen(function* () {
            expect(Exit.isSuccess(app.dispatch(Relay, { by: 100 }))).toBe(true);
            app.tick(1);
            return {
              recording: app.record(),
              value: (yield* tallyOf(app)).value,
              hash: world.hash(),
            };
          })
        );
        expect(recorded.value).toBe(100);
        expect(moves(recorded.recording.log)).toEqual([
          { tick: 0, name: "rp/Relay", payload: { by: 100 } },
        ]);
        expect(yield* replayed(recorded.recording)).toEqual({
          value: recorded.value,
          hash: recorded.hash,
        });
      })
  );

  it.effect(
    "is the game's own move from a plugin's setup, and isn't logged",
    () =>
      Effect.gen(function* () {
        const Opening = Plugin.make("Opening", {
          handlers: [add],
          setup: Effect.gen(function* () {
            (yield* Action.Actions).enqueue(Add, { by: 10 });
          }),
        });
        yield* withApp(
          App.make(App.define({ plugins: [counting(0), Opening] }), {
            checkpointEvery: 0,
          }),
          (app) =>
            Effect.gen(function* () {
              app.enqueue(Add, { by: 4000 });
              app.tick(1);
              expect((yield* tallyOf(app)).value).toBe(4010);
              expect(app.actionLog).toEqual([
                {
                  tick: 0,
                  name: "rp/Add",
                  payload: { by: 4000 },
                  queued: true,
                },
              ]);
            })
        );
      })
  );
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

  it.effect("replays from its log, checkpoint by checkpoint", () =>
    Effect.gen(function* () {
      const recorded = yield* withApp(busy(), (app, world) =>
        Effect.gen(function* () {
          play(app);
          return {
            recording: app.record(),
            log: [...app.actionLog],
            hash: world.hash(),
            tally: yield* tallyOf(app),
          };
        })
      );
      // The game was a busy one: the tally was doubled past its limit and
      // back-pressure refused moves, and the referee counted them.
      expect(recorded.tally.rejections).toBeGreaterThan(10);
      expect(moves(recorded.log).some((entry) => entry.queued === true)).toBe(
        true
      );
      expect(
        moves(recorded.log).some((entry) => entry.refused !== undefined)
      ).toBe(true);

      const replayed = yield* withApp(
        Effect.orDie(replayBusy(recorded.recording)),
        (app, world) =>
          Effect.gen(function* () {
            return {
              log: [...app.actionLog],
              hash: world.hash(),
              tally: yield* tallyOf(app),
            };
          })
      );
      expect(replayed.hash).toBe(recorded.hash);
      expect(replayed.tally).toEqual(recorded.tally);
      // The replay's own log is the game's, entry for entry, marks included.
      expect(replayed.log).toEqual(recorded.log);
    })
  );

  it.effect(
    "would not replay if the simulation's own moves were replayed from the log as well",
    () =>
      Effect.gen(function* () {
        // The flaw this replaces: every applied action was logged and replayed,
        // so a move the bot made was made twice, once from the log and once by
        // the replay's own bot. Here the bot's moves are put back in by hand.
        const recorded = yield* withApp(busy(), (app) =>
          Effect.gen(function* () {
            for (let i = 0; i < 9; i++) {
              app.tick(1);
            }
            return app.record();
          })
        );
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
        const stopped = yield* stoppedBy(
          replayBusy(altered(recorded, { log: withBotMoves }))
        );
        expect(stopped.reason).toBeInstanceOf(Journal.HashMismatch);
        expect(stopped.tick).toBe(4);
        // And as it is recorded, it replays.
        yield* withApp(Effect.orDie(replayBusy(recorded)), (app) =>
          Effect.gen(function* () {
            expect(app.time.tick).toBe(9);
          })
        );
      })
  );

  it.effect(
    "keeps the order of what was enqueued from outside and what a dispatched handler enqueued",
    () =>
      Effect.gen(function* () {
        // Two actions wait for the next tick: a doubling enqueued from outside,
        // and an addition enqueued by the handler of a dispatched action. They do
        // not commute, so each order of arrival is its own game, and each has to
        // replay as itself.
        const Ordered = App.define({
          plugins: [counting(1)],
          handlers: [double, add, chain],
        });
        const make = App.make(Ordered, { checkpointEvery: 1 });
        const play = Effect.fnUntraced(function* (
          first: "enqueue" | "dispatch"
        ) {
          return yield* withApp(make, (app) =>
            Effect.gen(function* () {
              if (first === "enqueue") {
                app.enqueue(Double, {});
                app.dispatch(Chain, { by: 10 });
              } else {
                app.dispatch(Chain, { by: 10 });
                app.enqueue(Double, {});
              }
              app.tick(1);
              return {
                value: (yield* tallyOf(app)).value,
                recording: app.record(),
              };
            })
          );
        });
        const replay = Effect.fnUntraced(function* (
          recording: Journal.Recording
        ) {
          return yield* withApp(
            Effect.orDie(
              Journal.replay(recording, Ordered, {
                checkpointEvery: 1,
              })
            ),
            (app) =>
              Effect.gen(function* () {
                return (yield* tallyOf(app)).value;
              })
          );
        });

        const doubledFirst = yield* play("enqueue");
        const addedFirst = yield* play("dispatch");
        expect(doubledFirst.value).toBe(1 * 2 + 10);
        expect(addedFirst.value).toBe((1 + 10) * 2);
        expect(
          moves(doubledFirst.recording.log).map((entry) => entry.name)
        ).toEqual(["rp/Double", "rp/Chain"]);
        expect(
          moves(addedFirst.recording.log).map((entry) => entry.name)
        ).toEqual(["rp/Chain", "rp/Double"]);
        expect(yield* replay(doubledFirst.recording)).toBe(doubledFirst.value);
        expect(yield* replay(addedFirst.recording)).toBe(addedFirst.value);
      })
  );
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

  it.effect(
    "holds how long each tick was, so a replay takes the same steps to the same end",
    () =>
      Effect.gen(function* () {
        const recorded = yield* withApp(walking, (app, world) =>
          Effect.gen(function* () {
            for (const delta of steps) {
              app.dispatch(Drop, { value: 1 });
              app.tick(delta);
            }
            return { recording: app.record(), hash: world.hash() };
          })
        );
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
        yield* withApp(replayWalking(recorded.recording), (app, world) =>
          Effect.gen(function* () {
            expect(app.time.tick).toBe(6);
            expect(app.time.elapsed).toBeCloseTo(steps.reduce((a, b) => a + b));
            expect(world.hash()).toBe(recorded.hash);
          })
        );
      })
  );

  it.effect(
    "begins at a save of the app, with the run of deltas under way there",
    () =>
      withApp(walking, (app) =>
        Effect.gen(function* () {
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
        })
      )
  );

  it.effect("forgets the ticks a rewind gave up", () =>
    withApp(walking, (app) =>
      Effect.gen(function* () {
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
      })
    )
  );

  it.effect("records only a save of its own app", () =>
    withApp(walking, (app) =>
      Effect.gen(function* () {
        app.tick(1 / 60);
        // Not a save of this app: it is of a tick this one hasn't reached.
        const ahead = yield* withApp(walking, (other) =>
          Effect.gen(function* () {
            for (let i = 0; i < 5; i++) {
              other.tick(1 / 60);
            }
            return other.save();
          })
        );
        assert(Exit.isSuccess(ahead));
        expect(() => app.record(ahead.value)).toThrow(
          /record\(\) was given a save of tick 5 that this app didn't make/
        );
      })
    )
  );
});

describe("how a recorded game began", () => {
  /** What the schema said was wrong with a recording's bytes. */
  const refusal = (bytes: Uint8Array): string => {
    const read = Journal.decode(bytes);
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

  it.effect(
    "is its seed for a game recorded from its start: an app made from the recording begins the same way",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({
          ticks: 40,
          seed: 5,
          checkpointEvery: 1,
        });
        expect(recorded.recording.seed).toBe(5);
        expect(recorded.recording.save).toBeUndefined();
        // The game and the recording, and no seed said again: the replay makes
        // its app from how the game began, and its own recording says so.
        const replayed = yield* withApp(
          Effect.orDie(Journal.replay(recorded.recording, coinGame())),
          (app, world) =>
            Effect.sync(() => ({
              tick: app.time.tick,
              hash: world.hash(),
              seed: app.record().seed,
            }))
        );
        expect(replayed).toEqual({
          tick: 40,
          hash: recorded.hashes.at(-1),
          seed: 5,
        });
        // Nor can another beginning be given: a replay's options are the rest of
        // what `App.make` takes.
        const { save } = yield* withApp(game(), (app) =>
          Effect.gen(function* () {
            const saved = app.save();
            assert(Exit.isSuccess(saved));
            return { save: saved.value };
          })
        );
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
        yield* withApp(App.make(coinGame()), (app) =>
          Effect.gen(function* () {
            expect(app.record().seed).toBe(0);
          })
        );
        // Through bytes and back.
        expect(Journal.decode(Journal.encode(recorded.recording))).toEqual(
          Exit.succeed(recorded.recording)
        );
      })
  );

  it.effect(
    "is the save for a game recorded since one, which a replay goes on from to the present",
    () =>
      Effect.gen(function* () {
        const played = yield* withApp(
          game({ seed: 3, checkpointEvery: 1 }),
          (app, world) =>
            Effect.gen(function* () {
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
            })
        );
        const { save, tail } = played;
        expect(tail.save).toBe(save);
        expect(tail.seed).toBeUndefined();
        expect(tail).toMatchObject({ start: 10, end: 30 });
        // All of the same game is still from its seed.
        expect(played.whole.seed).toBe(3);
        expect(played.whole.save).toBeUndefined();

        // In bytes, the recording holds the save, and reads back as it was.
        const read = Journal.decode(Journal.encode(tail));
        assert(Exit.isSuccess(read));
        expect(read.value).toEqual(tail);
        const present = yield* withApp(
          Effect.orDie(
            Journal.replay(read.value, coinGame(), { checkpointEvery: 1 })
          ),
          (app, world) =>
            Effect.sync(() => ({
              tick: app.time.tick,
              hash: world.hash(),
              save: app.record().save,
            }))
        );
        expect(present).toEqual({ tick: 30, hash: played.hash, save });

        // An app made from a save began there, and its recording says so.
        yield* withApp(Effect.orDie(App.make(coinGame(), { save })), (app) =>
          Effect.gen(function* () {
            drops(app, 2);
            const recording = app.record();
            expect(recording.save).toEqual(save);
            expect(recording).toMatchObject({ start: 10, end: 12 });
          })
        );
      })
  );

  it.effect(
    "is written in bytes and read back, from a seed and since a save, which it holds as the bytes of the save",
    () =>
      Effect.gen(function* () {
        const { save, tail, whole } = yield* withApp(game({ seed: 3 }), (app) =>
          Effect.gen(function* () {
            drops(app, 4);
            const saved = app.save();
            assert(Exit.isSuccess(saved));
            drops(app, 2);
            return {
              save: saved.value,
              tail: app.record(saved.value),
              whole: app.record(),
            };
          })
        );
        const fromSeed = Journal.encode(whole);
        const fromSave = Journal.encode(tail);
        for (const bytes of [fromSeed, fromSave]) {
          expect(bytes).toBeInstanceOf(Uint8Array);
          expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
        }
        expect(Journal.decode(fromSeed)).toEqual(Exit.succeed(whole));
        expect(Journal.decode(fromSave)).toEqual(Exit.succeed(tail));
        expect(
          Buffer.from(fromSave).includes(Buffer.from(Save.encode(save)))
        ).toBe(true);
      })
  );

  it.effect("can't be written with a payload that has no JSON form", () =>
    withApp(game({ seed: 3 }), (app) =>
      Effect.gen(function* () {
        app.enqueueByName("rp/Nothing", { n: 1n });
        app.tick(1 / 60);
        expect(() => Journal.encode(app.record())).toThrow(
          /a payload in its log has no JSON form/u
        );
      })
    )
  );

  it.effect("is checked when a recording is read from bytes", () =>
    Effect.gen(function* () {
      const { save, tail, whole } = yield* withApp(game({ seed: 3 }), (app) =>
        Effect.gen(function* () {
          drops(app, 4);
          const saved = app.save();
          assert(Exit.isSuccess(saved));
          drops(app, 2);
          return {
            save: saved.value,
            tail: app.record(saved.value),
            whole: app.record(),
          };
        })
      );
      const fromSeed = fieldsOf(whole);
      const fromSave = fieldsOf(tail);

      // Only `app.record()` and `Journal.decode` make a recording.
      const byHand: Journal.Played & Journal.Origin = {
        seed: 3,
        start: 0,
        end: 0,
        endHash: 0,
        deltas: [],
        log: [],
      };
      // @ts-expect-error a recording written by hand is not one
      void (() => Journal.replay(byHand, coinGame()));

      // A recording as an earlier version wrote it, as text.
      expect(refusal(new TextEncoder().encode(JSON.stringify(whole)))).toMatch(
        /^.*older format: .*written as text by an earlier arcadekit/u
      );

      const { seed: _, ...neither } = fromSeed;
      expect(refusal(written(neither))).toMatch(
        /how its game began as a seed or as a save, one of the two/
      );
      expect(refusal(written({ ...fromSave, seed: 3 }))).toMatch(
        /how its game began as a seed or as a save, one of the two/
      );
      // A game from a seed begins at tick 0.
      expect(
        refusal(
          written({
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
          written({
            ...fromSave,
            start: 5,
            deltas: [{ tick: 5, delta: 1 / 60 }],
            log: [],
          })
        )
      ).toMatch(/begins at tick 5, and its save was made at tick 4/);
      // And it reads as a save.
      expect(
        refusal(
          written({ ...fromSave, save: new TextEncoder().encode("not a save") })
        )
      ).toMatch(/its save can't be read: These bytes are not a saved game/);
      expect(
        refusal(written({ ...fromSave, save: Save.encode(save).slice(0, 40) }))
      ).toMatch(/its save can't be read/);
    })
  );
});
