import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { SchemaBinary } from "effect/encoding";

import { entityOf } from "../src/ecs/component.ts";
import { finish, add as fold } from "../src/ecs/hash.ts";
import {
  World as EcsWorld,
  readSnapshot,
  writeSnapshot,
} from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  EntityId,
  Event,
  Field,
  Plugin,
  Query,
  Random,
  Replay,
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
import { thrown, unwrap } from "./checks.ts";

// --- a small game: coins are dropped, drift about at random, and are taken ------

const Coin = Component.define("rp/Coin", { value: Field.i32, x: Field.f32 });
const Coins = Query.all(Coin).pipe(Query.writes(Coin));
/** The coins, read from outside the game. */
const Lying = Query.all(Coin);

class NoSuchCoin extends Schema.TaggedError<NoSuchCoin>()("NoSuchCoin", {
  coin: EntityId,
}) {}
const Drop = Action.define("rp/Drop", {
  payload: Schema.Struct({ value: Schema.Int }),
});
const Take = Action.define("rp/Take", {
  payload: Schema.Struct({ coin: EntityId }),
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
  (yield* Query.View(Coins)).each((coin) => {
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
    (yield* Query.View(Coins)).each((coin, entity) => {
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
  readonly hashEvery?: number;
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

const hashChecking = (options: Options) =>
  options.hashEvery === undefined ? {} : { hashEvery: options.hashEvery };

const game = (options: Options = {}) =>
  App.make(coinGame(options.faulty, options.coins), {
    seed: options.seed ?? 1,
    ...hashChecking(options),
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
  replay: Effect.Effect<A, Replay.Diverged<A> | Save.LoadRefused>
) =>
  replay.pipe(
    Effect.flatMap(() => Effect.die("it went the way the game went")),
    Effect.catchTag("ReplayDiverged", Effect.succeed),
    Effect.orDie
  );

const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isHashCheck(entry));
const hashChecks = (log: readonly Action.LogEntry[]): Action.HashCheck[] =>
  log.filter((entry) => Action.isHashCheck(entry));

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
          const exit = yield* Effect.exit(
            app.dispatch(Drop, { value: dice.int(1, 9) })
          );
          if (Exit.isSuccess(exit)) {
            coins.push(exit.value);
          }
        } else if (roll === 3 && coins.length > 1) {
          // Never the oldest coin: a later test takes that one itself.
          const [coin] = coins.splice(dice.int(1, coins.length - 1), 1);
          yield* app.enqueue(Take, { coin: coin! });
        }
        yield* app.tick(1 / 60);
        hashes.push(world.hash());
      }
      return {
        recording: yield* Replay.record(app),
        log: [...app.actionLog],
        hashes,
        starting,
        coins,
        ticks: options.ticks,
      };
    })
  );
});

/** A recording's fields as its bytes hold them, each checked on its own. */
const Written = SchemaBinary.toCodec(Layout);
const fieldsOf = (recording: Replay.Recording) =>
  Effect.flatMap(Replay.encode(recording), Schema.decodeExit(Written));
/** Fields written as a recording's bytes, as a file edited by hand. */
const written = (fields: typeof Layout.Type) =>
  unwrap(Schema.encodeExit(Written)(fields));

/**
 * `recording` with `fields` changed in its bytes, as a file edited by hand,
 * and read back.
 */
const altered = Effect.fnUntraced(function* (
  recording: Replay.Recording,
  fields: Partial<typeof Layout.Type>
) {
  return yield* Replay.decode(
    written({ ...(yield* fieldsOf(recording)), ...fields })
  );
});

/**
 * Replays a recording into the coin game `options` make, and returns what
 * stopped it, if anything did, with the app as the replay left it.
 */
const replayInto = (options: Options, recording: Replay.Recording) =>
  Effect.gen(function* () {
    // A replay that stops holds its app where it stopped.
    const { app, stopped } = yield* Replay.verify(
      recording,
      coinGame(options.faulty, options.coins),
      hashChecking(options)
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

describe("hash checks", () => {
  it.effect(
    "are recorded before the first action or tick, and after every tick the interval divides",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 10, hashEvery: 3 });
        expect(hashChecks(recorded.log).map((entry) => entry.tick)).toEqual([
          0, 3, 6, 9,
        ]);
        // Each is the world's hash at that point: the first before anything
        // happened, the others when that many ticks had completed.
        expect(hashChecks(recorded.log).map((entry) => entry.hash)).toEqual([
          recorded.starting,
          recorded.hashes[2],
          recorded.hashes[5],
          recorded.hashes[8],
        ]);
        // The log is in the order things happened: the first hash check, then
        // the first move, and each later hash check ahead of the moves that
        // were made once its tick had completed.
        expect(Action.isHashCheck(recorded.log[0]!)).toBe(true);
        for (let i = 1; i < recorded.log.length; i++) {
          expect(recorded.log[i]!.tick).toBeGreaterThanOrEqual(
            recorded.log[i - 1]!.tick
          );
        }
        const third = recorded.log.findIndex(
          (entry) => Action.isHashCheck(entry) && entry.tick === 3
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
        yield* withApp(game({ hashEvery: 1, faulty: Mint }), (app, world) =>
          Effect.gen(function* () {
            for (let tick = 1; tick <= 5; tick++) {
              yield* app.tick(1 / 60);
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
        const ticksOf = Effect.fnUntraced(function* (hashEvery?: number) {
          return hashChecks(
            (yield* record({
              ticks: 130,
              ...(hashEvery === undefined ? {} : { hashEvery }),
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
              withApp(game({ hashEvery: bad }), () => Effect.succeed(0))
            )
          ).toThrow(/hashEvery must be a whole number of ticks/);
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
        const firsts: ((app: Game, coin: Entity) => Effect.Effect<unknown>)[] =
          [
            (app) => app.tick(1),
            (app) => Effect.exit(app.dispatchByName("rp/Drop", { value: 1 })),
            (app) =>
              Effect.andThen(
                app.enqueueByName("rp/Drop", { value: 1 }),
                app.tick(1)
              ),
            (app) => Effect.exit(app.dispatchByName("rp/Take", { coin: 4000 })),
            (app) =>
              Effect.exit(
                app.dispatchByName("rp/Drop", { value: "not a number" })
              ),
            (app, coin) => Effect.exit(app.dispatch(Take, { coin })),
          ];
        for (const first of firsts) {
          yield* withApp(game({ coins: [5] }), (app, world) =>
            Effect.gen(function* () {
              expect(app.actionLog).toEqual([]);
              const [coin] = (yield* app.read(Query.View(Lying))).entities();
              assert(coin !== undefined);
              const starting = world.hash();
              yield* first(app, coin);
              expect(app.actionLog[0]).toEqual({ tick: 0, hash: starting });
              expect(hashChecks(app.actionLog).length).toBe(1);
            })
          );
        }
      })
  );

  it.effect("can be asked for between ticks, and not during one", () =>
    Effect.gen(function* () {
      yield* withApp(game({ hashEvery: 0, coins: [1] }), (app, world) =>
        Effect.gen(function* () {
          yield* app.tick(1);
          yield* app.tick(1);
          expect(app.actionLog).toEqual([]);
          const hash = yield* Replay.hashCheck(app);
          expect(hash).toBe(world.hash());
          expect(app.actionLog).toEqual([{ tick: 2, hash }]);
          yield* app.dispatch(Drop, { value: 2 });
          yield* Replay.hashCheck(app);
          expect(
            app.actionLog.map((entry) => Action.isHashCheck(entry))
          ).toEqual([true, false, true]);
          expect(hashChecks(app.actionLog)[1]!.hash).not.toBe(hash);
        })
      );

      // One taken by hand before the game starts is the starting hash check.
      yield* withApp(game({ hashEvery: 5, coins: [1] }), (app) =>
        Effect.gen(function* () {
          yield* Replay.hashCheck(app);
          yield* app.tick(1);
          expect(hashChecks(app.actionLog).map((entry) => entry.tick)).toEqual([
            0,
          ]);
        })
      );

      let inside: unknown;
      const Asks = System.tick("Asks", function* () {
        const asked = yield* Effect.exit(Replay.hashCheck(asking!));
        inside = Exit.isFailure(asked) ? Cause.squash(asked.cause) : undefined;
      });
      let asking: App.Any | undefined;
      yield* withApp(App.make(App.define({ systems: [Asks] })), (app) =>
        Effect.gen(function* () {
          asking = app;
          yield* app.tick(1);
        })
      );
      expect(String(inside)).toMatch(/hashCheck\(\) was called during a tick/);
    })
  );

  it.effect("survive being written down, and a malformed one is refused", () =>
    Effect.gen(function* () {
      const recorded = yield* record({ ticks: 12, hashEvery: 4 });
      const loaded = Replay.decode(yield* Replay.encode(recorded.recording));
      expect(Exit.isSuccess(loaded) && loaded.value).toEqual(
        recorded.recording
      );
      expect((yield* fieldsOf(recorded.recording)).log[0]).toEqual({
        tick: 0,
        hash: recorded.starting,
      });
      /** A hash check as its bytes hold it, its tick and its hash, unchecked. */
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
      const fields = yield* fieldsOf(recorded.recording);
      const largest = Replay.decode(
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
        const refused = Replay.decode(holding({ ...fields, log: [entry] }));
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
          Replay.decode(
            unwrap(
              Schema.encodeExit(otherwise)({
                ...fields,
                log: [{ tick: 0.5, hash: "12" }],
              })
            )
          )
        )
      ).toBe(true);
      expect(Action.isHashCheck({ tick: 1, hash: 0 })).toBe(true);
      expect(Action.isHashCheck({ tick: 1, name: "x", payload: 0 })).toBe(
        false
      );
    })
  );
});

describe("a replay that checks itself", () => {
  it.effect("passes every hash check when it goes the way the game went", () =>
    Effect.gen(function* () {
      for (const hashEvery of [1, 7, 60]) {
        const recorded = yield* record({ ticks: 150, hashEvery });
        const replayed = yield* replayInto({}, recorded.recording);
        expect(replayed.stopped).toBeUndefined();
        expect(replayed.tick).toBe(150);
        expect(replayed.hash).toBe(recorded.hashes.at(-1));
      }
      // Recording as it replays, it writes the same log again.
      const recorded = yield* record({ ticks: 40, hashEvery: 1 });
      expect(
        (yield* replayInto({ hashEvery: 1 }, recorded.recording)).log
      ).toEqual(recorded.log);
    })
  );

  it.effect(
    "stops at the tick it diverged on, not at the next refused action",
    () =>
      Effect.gen(function* () {
        // The game is recorded with a hash check every tick. In the build that
        // replays it, a coin's position is off by a millionth on tick 40. No
        // rule is broken by that, and no action is refused because of it.
        const recorded = yield* record({ ticks: 120, hashEvery: 1 });
        const replayed = yield* replayInto(
          { faulty: fault(40, "nudge") },
          recorded.recording
        );
        const stopped = replayed.stopped!;
        expect(stopped).toBeInstanceOf(Replay.Diverged);
        expect(stopped.tick).toBe(40);
        // It stopped there: no later tick ran and no later move was applied.
        expect(replayed.tick).toBe(40);
        expect(moves(replayed.log).every((entry) => entry.tick < 40)).toBe(
          true
        );
        expect(moves(recorded.log).some((entry) => entry.tick >= 40)).toBe(
          true
        );

        const reason = stopped.reason as Replay.HashMismatch;
        expect(reason).toBeInstanceOf(Replay.HashMismatch);
        expect(reason.tick).toBe(40);
        expect(reason.agreedAt).toBe(39);
        expect(reason.expected).toBe(recorded.hashes[39]);
        expect(reason.actual).toBe(replayed.hash);
        expect(reason.actual).not.toBe(reason.expected);
        expect(stopped.entry).toEqual({ tick: 40, hash: recorded.hashes[39] });
        expect(recorded.log[stopped.index]).toEqual(stopped.entry);
        expect(stopped.message).toBe(
          `The replay diverged from its log (entry ${stopped.index}): the world's hash at tick 40 is ${reason.actual}, and ${reason.expected} was recorded. The last hash check that matched was at tick 39.`
        );
      })
  );

  it.effect(
    "fails with its app where it stopped, an app of its game to look at",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 60, hashEvery: 1 });
        const looked = yield* Replay.verify(
          recorded.recording,
          coinGame(fault(20, "lose")),
          {
            hashEvery: 1,
          }
        ).pipe(
          Effect.flatMap(() => Effect.die("it went the way the game went")),
          Effect.catchTag("ReplayDiverged", (diverged) =>
            Effect.gen(function* () {
              const { app, reason } = diverged;
              assert(reason instanceof Replay.HashMismatch);
              const seen = {
                stoppedAt: diverged.tick,
                tick: app.time.tick,
                hash: (yield* app.read(World)).hash(),
                coins: (yield* app.read(Query.View(Lying))).count(),
                reason,
              };
              // The replay closed it, and it is an app of the game all the
              // same: it takes the game's actions, and no other.
              const dropped = yield* Effect.exit(
                app.dispatch(Drop, { value: 1 })
              );
              // @ts-expect-error the game has no handler for `Add`
              expect(yield* thrown(app.dispatch(Add, { by: 1 }))).toThrow(
                /No handler/
              );
              return {
                ...seen,
                dropped: Exit.isSuccess(dropped),
                after: (yield* app.read(Query.View(Lying))).count(),
              };
            })
          )
        );
        // Where the build that loses a coin on tick 20 stopped: at that tick's
        // hash check, with the world whose hash it compared.
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
        const recorded = yield* record({ ticks: 30, hashEvery: 1 });
        const stopped = yield* stoppedBy(
          Replay.verify(recorded.recording, heldGame(fault(10, "lose")), {
            hashEvery: 1,
          })
        );
        expect(held).toEqual(["acquired", "released"]);
        // Closed, it is there to read.
        const reason = stopped.reason as Replay.HashMismatch;
        expect((yield* stopped.app.read(World)).hash()).toBe(reason.actual);

        held.length = 0;
        const app = yield* Replay.verify(
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
        // The same recording with its hash checks taken out. The faulty build
        // loses the oldest coin on tick 40, and the game takes that coin on tick
        // 100.
        const recorded = yield* record({ ticks: 100, hashEvery: 1 });
        const oldest = recorded.coins[0]!;
        const log = [
          ...recorded.log,
          { tick: 100, name: "rp/Take", payload: { coin: oldest } },
        ];
        const blind = yield* replayInto(
          { faulty: fault(40, "lose") },
          yield* altered(recorded.recording, { log: moves(log), end: 110 })
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
          yield* altered(recorded.recording, { log, end: 110 })
        );
        expect(checked.stopped!.tick).toBe(40);
        expect(checked.stopped!.reason).toBeInstanceOf(Replay.HashMismatch);

        // A fault that breaks no rule, in a game recorded with no hash checks,
        // shows at the end: the replay's world isn't the one the game ended on.
        const unchecked = yield* record({ ticks: 100, hashEvery: 0 });
        expect(hashChecks(unchecked.log)).toEqual([]);
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
        const reason = silent.stopped!.reason as Replay.HashMismatch;
        expect(reason).toBeInstanceOf(Replay.HashMismatch);
        expect(reason.expected).toBe(unchecked.hashes.at(-1));
        expect(reason.actual).toBe(silent.hash);
        expect(reason.agreedAt).toBeUndefined();
      })
  );

  it.effect(
    "stops at the first hash check after it diverged when they are further apart, and names the last that matched",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({ ticks: 120, hashEvery: 10 });
        const replayed = yield* replayInto(
          { faulty: fault(43, "nudge") },
          recorded.recording
        );
        expect(replayed.stopped!.tick).toBe(50);
        expect(replayed.tick).toBe(50);
        const reason = replayed.stopped!.reason as Replay.HashMismatch;
        expect(reason.agreedAt).toBe(40);
        expect(reason.expected).toBe(recorded.hashes[49]);
        // A fault on a hash check's own tick is caught by that hash check.
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
        expect((after.stopped!.reason as Replay.HashMismatch).agreedAt).toBe(
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
          yield* altered(recorded.recording, { seed: 6 })
        );
        expect(otherSeed.stopped!.tick).toBe(0);
        expect(otherSeed.tick).toBe(0);
        expect(otherSeed.stopped!.index).toBe(0);
        const reason = otherSeed.stopped!.reason as Replay.HashMismatch;
        expect(reason.agreedAt).toBeUndefined();
        expect(reason.expected).toBe(recorded.starting);
        expect(otherSeed.stopped!.message).toMatch(
          /No earlier hash check matched, so the two did not start from the same state: check the seed, and what the plugins' setups spawn\.$/
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
        const recorded = yield* record({ ticks: 60, hashEvery: 1 });
        const edit = Effect.fnUntraced(function* (
          change: (log: Action.LogEntry[]) => void
        ) {
          const log = [...recorded.log];
          change(log);
          return (yield* replayInto(
            {},
            yield* altered(recorded.recording, { log })
          )).stopped;
        });
        const drops = recorded.log.flatMap((entry, index) =>
          !Action.isHashCheck(entry) &&
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
        expect(changed!.reason).toBeInstanceOf(Replay.HashMismatch);
        expect(changed!.tick).toBe(tick + 1);
        expect((changed!.reason as Replay.HashMismatch).agreedAt).toBe(tick);

        // A move taken out, and a move put in.
        const removed = yield* edit((log) => {
          log.splice(at, 1);
        });
        expect(removed!.tick).toBe(tick + 1);
        const added = yield* edit((log) => {
          log.splice(at, 0, { tick, name: "rp/Drop", payload: { value: 3 } });
        });
        expect(added!.tick).toBe(tick + 1);

        // A hash check that was altered is itself the entry that does not hold.
        const forged = yield* edit((log) => {
          const index = log.findIndex(
            (entry) => entry.tick === 20 && Action.isHashCheck(entry)
          );
          const hashCheck = log[index] as Action.HashCheck;
          log[index] = { ...hashCheck, hash: (hashCheck.hash ^ 1) >>> 0 };
        });
        expect(forged!.tick).toBe(20);
        expect((forged!.reason as Replay.HashMismatch).agreedAt).toBe(19);
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
        game({ hashEvery: 1, faulty: Behind }),
        (app) =>
          Effect.gen(function* () {
            for (let tick = 0; tick < 20; tick++) {
              if (tick === 8) {
                hidden = 7;
              }
              yield* app.dispatch(Drop, { value: 1 });
              yield* app.tick(1 / 60);
            }
            return yield* Replay.record(app);
          })
      );
      const replayed = yield* replayInto({}, recorded);
      expect(replayed.stopped!.tick).toBe(9);
      expect((replayed.stopped!.reason as Replay.HashMismatch).agreedAt).toBe(
        8
      );
    })
  );

  it.effect(
    "says so when a queued action meets another fate than the log records",
    () =>
      Effect.gen(function* () {
        const recorded = yield* withApp(game({ hashEvery: 0 }), (app) =>
          Effect.gen(function* () {
            const dropped = yield* Effect.exit(
              app.dispatch(Drop, { value: 4 })
            );
            const coin = Exit.isSuccess(dropped) ? dropped.value : entityOf(0);
            yield* app.tick(1 / 60);
            yield* app.enqueue(Take, { coin });
            yield* app.enqueue(Take, { coin }); // refused: the coin is gone by then
            yield* app.tick(1 / 60);
            yield* app.tick(1 / 60);
            return yield* Replay.record(app);
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
          yield* altered(recorded, { log: refusedNow })
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
          yield* altered(recorded, { log: acceptedNow })
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
      return (yield* Query.View(Counted)).entities().flatMap((entity) => {
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
const Double = Action.define("rp/Double", {
  // oxlint-disable-next-line arcadekit/no-empty-payload -- the test enqueues it by name with {}, and expects {} in the log.
  payload: Schema.Struct({}),
  error: TooBig,
});
const Add = Action.define("rp/Add", {
  payload: Schema.Struct({ by: Schema.Int }),
});
const Chain = Action.define("rp/Chain", {
  payload: Schema.Struct({ by: Schema.Int }),
});

// Doubling and adding do not commute, so the tally gives away any change in
// the order actions were applied in.
const double = Action.handler(Double, function* () {
  let refuse = false;
  (yield* Query.View(Tallies)).each((tally) => {
    tally.value *= 2;
    refuse = tally.value > 1e12;
  });
  if (refuse) {
    return yield* TooBig.make({});
  }
});
const add = Action.handler(Add, function* ({ by }) {
  (yield* Query.View(Tallies)).each((tally) => {
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
  const refused = (yield* Event.Reader(Action.Rejected)).read().length;
  (yield* Query.View(Tallies)).each((tally) => {
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
  const patience = yield* Singleton.Write(Patience);
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
const busy = (hashEvery = 1, value = 1) =>
  App.make(busyGame(value), { seed: 4, hashEvery });
const replayBusy = (recording: Replay.Recording) =>
  Replay.verify(recording, busyGame(), { hashEvery: 1 });

describe("the action log", () => {
  it.effect(
    "holds what came from outside, as it arrived, and not what the simulation issued itself",
    () =>
      withApp(busy(0), (app) =>
        Effect.gen(function* () {
          yield* app.enqueue(Add, { by: 1 });
          yield* app.dispatch(Chain, { by: 100 }); // its handler enqueues an Add
          yield* app.enqueueByName("rp/Double", {});
          yield* app.dispatch(Add, { by: 1000 });
          expect(app.actionLog).toEqual([
            { tick: 0, name: "rp/Add", payload: { by: 1 }, queued: true },
            { tick: 0, name: "rp/Chain", payload: { by: 100 } },
            { tick: 0, name: "rp/Double", payload: {}, queued: true },
            { tick: 0, name: "rp/Add", payload: { by: 1000 } },
          ]);
          // Applied in the order they arrived, the handler's own among them:
          // 1 + 1000 at once, then (+1, +100, doubled) when the tick starts.
          yield* app.tick(1);
          expect((yield* tallyOf(app)).value).toBe((1001 + 1 + 100) * 2);
          // The tick ran the bot and the heckler, and none of their moves is logged.
          for (let i = 0; i < 12; i++) {
            yield* app.tick(1);
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
          expect(
            Exit.isFailure(yield* Effect.exit(app.dispatch(Double, {})))
          ).toBe(true);
          yield* app.enqueue(Double, {});
          yield* app.enqueueByName("rp/Nothing", { x: 1 });
          yield* app.enqueueByName("rp/Add", { by: "seven" });
          yield* app.tick(1);
          expect(
            app.actionLog.map((entry) =>
              Action.isHashCheck(entry) ? "?" : [entry.name, entry.refused]
            )
          ).toEqual([
            ["rp/Double", "TooBig"],
            ["rp/Nothing", "ActionUnknown"],
            ["rp/Add", expect.stringMatching(/by/)],
          ]);
          // The referee saw all three refusals.
          yield* app.tick(1);
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
      const recording = yield* altered(
        (yield* record({ ticks: 2 })).recording,
        {
          log,
        }
      );
      expect(recording.log).toEqual(log);
      const loaded = Replay.decode(yield* Replay.encode(recording));
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
      const refused = Replay.decode(
        unwrap(
          Schema.encodeExit(marked)({
            ...(yield* fieldsOf(recording)),
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
  const Relay = Action.define("rp/Relay", {
    payload: Schema.Struct({ by: Schema.Int }),
  });
  const holding = Effect.gen(function* () {
    let enqueue: ((by: number) => Effect.Effect<void>) | undefined;
    const relay = Action.handler(Relay, function* ({ by }) {
      if (enqueue !== undefined) {
        yield* enqueue(by);
      }
    });
    const Clock = System.tick("Clock", function* () {
      if (enqueue !== undefined) {
        yield* enqueue(1);
      }
    });
    const app = yield* App.make(
      App.define({
        plugins: [counting(0)],
        systems: [Clock],
        handlers: [add, relay],
      }),
      { hashEvery: 1 }
    );
    enqueue = (by) => Effect.orDie(app.enqueue(Add, { by }));
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
  const replayed = Effect.fnUntraced(function* (recording: Replay.Recording) {
    return yield* withApp(
      Effect.orDie(
        Replay.verify(recording, Relaying, {
          hashEvery: 1,
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
              yield* app.tick(1);
            }
            return {
              recording: yield* Replay.record(app),
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
            expect(
              Exit.isSuccess(
                yield* Effect.exit(app.dispatch(Relay, { by: 100 }))
              )
            ).toBe(true);
            yield* app.tick(1);
            return {
              recording: yield* Replay.record(app),
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
            hashEvery: 0,
          }),
          (app) =>
            Effect.gen(function* () {
              yield* app.enqueue(Add, { by: 4000 });
              yield* app.tick(1);
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
  const play = Effect.fnUntraced(function* (
    app: Effect.Success<ReturnType<typeof busy>>
  ) {
    const dice = new EcsWorld({ seed: 77 }).random;
    for (let tick = 0; tick < 90; tick++) {
      for (let n = dice.int(0, 3); n > 0; n--) {
        const by = dice.int(1, 5);
        const move = dice.int(1, 6);
        if (move === 1) {
          yield* app.enqueue(Add, { by });
        } else if (move === 2) {
          yield* app.dispatch(Chain, { by });
        } else if (move === 3) {
          yield* app.enqueueByName("rp/Double", {});
        } else if (move === 4) {
          yield* app.dispatch(Add, { by });
        } else if (move === 5) {
          yield* app.enqueueByName("rp/Add", { by: "not a number" });
        } else {
          yield* app.enqueue(Chain, { by });
        }
      }
      yield* app.tick(1);
    }
  });

  it.effect("replays from its log, hash check by hash check", () =>
    Effect.gen(function* () {
      const recorded = yield* withApp(busy(), (app, world) =>
        Effect.gen(function* () {
          yield* play(app);
          return {
            recording: yield* Replay.record(app),
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
              yield* app.tick(1);
            }
            return yield* Replay.record(app);
          })
        );
        expect(moves(recorded.log)).toEqual([]);
        const withBotMoves = [...recorded.log];
        const at = withBotMoves.findIndex(
          (entry) => Action.isHashCheck(entry) && entry.tick === 3
        );
        withBotMoves.splice(at + 1, 0, {
          tick: 3,
          name: "rp/Add",
          payload: { by: 7 },
        });
        const stopped = yield* stoppedBy(
          replayBusy(yield* altered(recorded, { log: withBotMoves }))
        );
        expect(stopped.reason).toBeInstanceOf(Replay.HashMismatch);
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
        const make = App.make(Ordered, { hashEvery: 1 });
        const play = Effect.fnUntraced(function* (
          first: "enqueue" | "dispatch"
        ) {
          return yield* withApp(make, (app) =>
            Effect.gen(function* () {
              if (first === "enqueue") {
                yield* app.enqueue(Double, {});
                yield* app.dispatch(Chain, { by: 10 });
              } else {
                yield* app.dispatch(Chain, { by: 10 });
                yield* app.enqueue(Double, {});
              }
              yield* app.tick(1);
              return {
                value: (yield* tallyOf(app)).value,
                recording: yield* Replay.record(app),
              };
            })
          );
        });
        const replay = Effect.fnUntraced(function* (
          recording: Replay.Recording
        ) {
          return yield* withApp(
            Effect.orDie(
              Replay.verify(recording, Ordered, {
                hashEvery: 1,
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

// --- bytes of a save changed so that they hash the same ------------------------------

const wordsOf = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length >>> 2 }, (_, i) =>
    view.getInt32(i * 4, true)
  );
};

/** A save's bytes hashed a 32-bit word at a time, as the app tells saves apart. */
const hashOf = (bytes: Uint8Array): number =>
  finish(
    bytes
      .subarray(bytes.length & ~3)
      .reduce(fold, wordsOf(bytes).reduce(fold, 0))
  );

/** What `fold` makes of a word before it folds it in. */
const scramble = (word: number): number => {
  const k = Math.imul(word, 0xcc9e2d51);
  return Math.imul((k << 15) | (k >>> 17), 0x1b873593);
};

/** The number whose product with `odd` is 1, in 32 bits. */
const inverse = (odd: number): number => {
  let x = odd;
  for (let i = 0; i < 4; i++) {
    x = Math.imul(x, 2 - Math.imul(odd, x));
  }
  return x;
};

const unscramble = (k: number): number => {
  const r = Math.imul(k, inverse(0x1b873593));
  return Math.imul((r >>> 15) | (r << 17), inverse(0xcc9e2d51));
};

/**
 * A copy of a save whose world says another tick, with its last word changed
 * so that `fold` gives the same state from its words as from the save's.
 */
const sayingTick = (save: Save.Save, tick: number): Save.Save => {
  const contents = readSnapshot(save.world);
  const time = contents.singletons.find(
    ({ component }) => component === "arcadekit/Time"
  );
  time!.columns["tick"]![0] = tick;
  const world = writeSnapshot(contents);
  const was = wordsOf(save.world);
  const last = was.length - 1;
  const before = (words: number[]) => words.slice(0, last).reduce(fold, 0);
  const word = unscramble(
    before(wordsOf(world)) ^ before(was) ^ scramble(was[last]!)
  );
  new DataView(world.buffer, world.byteOffset).setInt32(last * 4, word, true);
  return { version: save.version, world };
};

describe("a recording", () => {
  // A walker whose stride is the tick's delta: a tick of another length
  // leaves it somewhere else.
  const Walker = Component.define("rp/Walker", { x: Field.f64 });
  const Walk = System.tick("rp/Walk", function* () {
    const { delta } = yield* Time;
    (yield* Query.View(Query.all(Walker).pipe(Query.writes(Walker)))).each(
      (walker) => {
        walker.x += delta;
      }
    );
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
  const walking = App.make(Walking, { hashEvery: 1 });
  const replayWalking = (recording: Replay.Recording) =>
    Effect.orDie(Replay.verify(recording, Walking, { hashEvery: 1 }));
  const steps = [1 / 60, 1 / 60, 1 / 60, 1 / 30, 1 / 30, 1 / 60];

  it.effect(
    "holds how long each tick was, so a replay takes the same steps to the same end",
    () =>
      Effect.gen(function* () {
        const recorded = yield* withApp(walking, (app, world) =>
          Effect.gen(function* () {
            for (const delta of steps) {
              yield* app.dispatch(Drop, { value: 1 });
              yield* app.tick(delta);
            }
            return { recording: yield* Replay.record(app), hash: world.hash() };
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
        const decoded = Replay.decode(yield* Replay.encode(recorded.recording));
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
          yield* app.tick(1 / 30);
          yield* app.tick(1 / 30);
          yield* app.tick(1 / 30);
          yield* app.dispatch(Drop, { value: 2 });
          const save = yield* Effect.exit(Save.make(app));
          assert(Exit.isSuccess(save));
          yield* app.tick(1 / 30);
          yield* app.tick(1 / 60);
          const tail = yield* Replay.record(app, save.value);
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
        yield* app.tick(1 / 60);
        const moment = yield* Effect.exit(Timeline.capture(app));
        assert(Exit.isSuccess(moment));
        yield* app.tick(1 / 30);
        yield* app.tick(1 / 30);
        yield* Timeline.rewind(app, moment.value);
        yield* app.tick(1 / 60);
        expect(yield* Replay.record(app)).toMatchObject({
          end: 2,
          deltas: [{ tick: 0, delta: 1 / 60 }],
        });
      })
    )
  );

  it.effect("records only a save of its own app", () =>
    withApp(walking, (app) =>
      Effect.gen(function* () {
        yield* app.tick(1 / 60);
        // Not a save of this app: it is of a tick this one hasn't reached.
        const ahead = yield* withApp(walking, (other) =>
          Effect.gen(function* () {
            for (let i = 0; i < 5; i++) {
              yield* other.tick(1 / 60);
            }
            return yield* Effect.exit(Save.make(other));
          })
        );
        assert(Exit.isSuccess(ahead));
        expect(yield* thrown(Replay.record(app, ahead.value))).toThrow(
          /Replay\.record\(\) was given a save that this app didn't make/
        );
      })
    )
  );

  it.effect(
    "begins at a copy of a save read back from its bytes, as one from a slot is",
    () =>
      withApp(walking, (app, world) =>
        Effect.gen(function* () {
          yield* app.tick(1 / 60);
          yield* app.dispatch(Drop, { value: 1 });
          const save = unwrap(yield* Effect.exit(Save.make(app)));
          const copy = yield* Save.decode(Save.encode(save));
          expect(copy).not.toBe(save);
          yield* app.tick(1 / 30);
          yield* app.dispatch(Drop, { value: 2 });
          yield* app.tick(1 / 60);
          const tail = yield* Replay.record(app, copy);
          expect(tail.save).toBe(copy);
          expect(tail).toMatchObject({ start: 1, end: 3 });
          expect(moves(tail.log).map((entry) => entry.payload)).toEqual([
            { value: 2 },
          ]);
          const present = yield* withApp(replayWalking(tail), (_, replayed) =>
            Effect.succeed(replayed.hash())
          );
          expect(present).toBe(world.hash());
        })
      )
  );

  it.effect(
    "records no save its log no longer reaches: one of a future a rewind gave up, or from before a load",
    () =>
      withApp(App.make(Walking, { hashEvery: 0 }), (app) =>
        Effect.gen(function* () {
          // Two coins dropped at tick 1, then a tick: whichever coins they
          // are, the log is as long, and its ticks the same.
          const play = Effect.fnUntraced(function* (first: number) {
            yield* app.dispatch(Drop, { value: first });
            yield* app.dispatch(Drop, { value: first + 1 });
            yield* app.tick(1 / 60);
          });
          const unreached =
            /Replay\.record\(\) was given a save that this app didn't make, or that its log no longer reaches/;
          yield* app.tick(1 / 60);
          const before = unwrap(yield* Effect.exit(Save.make(app)));
          const moment = unwrap(yield* Effect.exit(Timeline.capture(app)));
          yield* play(1);
          const save = unwrap(yield* Effect.exit(Save.make(app)));
          const ahead = unwrap(yield* Effect.exit(Timeline.capture(app)));

          yield* Timeline.rewind(app, moment);
          yield* play(3);
          expect(yield* thrown(Replay.record(app, save))).toThrow(unreached);
          yield* Timeline.rewind(app, ahead);
          expect((yield* Replay.record(app, save)).start).toBe(2);

          yield* Save.load(app, before);
          yield* play(5);
          expect(yield* thrown(Replay.record(app, save))).toThrow(unreached);
          expect((yield* Replay.record(app, before)).start).toBe(1);
        })
      )
  );

  it.effect(
    "begins at a save taken where a moment was captured, once the game is rewound to the moment",
    () =>
      withApp(walking, (app, world) =>
        Effect.gen(function* () {
          yield* app.dispatch(Drop, { value: 1 });
          yield* app.tick(1 / 60);
          const moment = unwrap(yield* Effect.exit(Timeline.capture(app)));
          const save = unwrap(yield* Effect.exit(Save.make(app)));
          yield* app.dispatch(Drop, { value: 2 });
          yield* app.tick(1 / 60);
          yield* Timeline.rewind(app, moment);
          yield* app.dispatch(Drop, { value: 3 });
          yield* app.tick(1 / 60);
          const tail = yield* Replay.record(app, save);
          expect(tail).toMatchObject({ start: 1, end: 2 });
          expect(moves(tail.log).map((entry) => entry.payload)).toEqual([
            { value: 3 },
          ]);
          const present = yield* withApp(replayWalking(tail), (_, replayed) =>
            Effect.succeed(replayed.hash())
          );
          expect(present).toBe(world.hash());
        })
      )
  );

  it.effect(
    "begins at a save again once a game rewound to before it comes to its tick, with nothing logged on the way",
    () =>
      withApp(App.make(Walking, { hashEvery: 0 }), (app, world) =>
        Effect.gen(function* () {
          const unreached = /its log no longer reaches/;
          yield* app.tick(1 / 60);
          const moment = unwrap(yield* Effect.exit(Timeline.capture(app)));
          yield* app.tick(1 / 60);
          yield* app.tick(1 / 60);
          const save = unwrap(yield* Effect.exit(Save.make(app)));

          // Ticks of another length: the walker is elsewhere at tick 3.
          yield* Timeline.rewind(app, moment);
          yield* app.tick(1 / 30);
          yield* app.tick(1 / 30);
          expect(yield* thrown(Replay.record(app, save))).toThrow(unreached);

          yield* Timeline.rewind(app, moment);
          yield* app.tick(1 / 60);
          expect(yield* thrown(Replay.record(app, save))).toThrow(unreached);
          yield* app.tick(1 / 60);
          yield* app.dispatch(Drop, { value: 1 });
          yield* app.tick(1 / 60);
          const tail = yield* Replay.record(app, save);
          expect(tail).toMatchObject({ start: 3, end: 4 });
          const present = yield* withApp(replayWalking(tail), (_, replayed) =>
            Effect.succeed(replayed.hash())
          );
          expect(present).toBe(world.hash());
        })
      )
  );

  it.effect(
    "records no save whose bytes were changed to say another tick, though they hash the same",
    () =>
      withApp(walking, (app) =>
        Effect.gen(function* () {
          yield* app.tick(1 / 60);
          yield* app.tick(1 / 60);
          const save = unwrap(yield* Effect.exit(Save.make(app)));
          yield* app.tick(1 / 60);
          const forged = sayingTick(save, 1000);
          expect(forged.world).not.toEqual(save.world);
          expect(hashOf(forged.world)).toBe(hashOf(save.world));
          expect(yield* thrown(Replay.record(app, forged))).toThrow(
            /Replay\.record\(\) was given a save that this app didn't make/
          );
        })
      )
  );
});

describe("how a recorded game began", () => {
  /** What the schema said was wrong with a recording's bytes. */
  /** What `Replay.decode` refuses bytes with: its problem, then its message. */
  const refusal = (bytes: Uint8Array): string => {
    const read = Replay.decode(bytes);
    assert(Exit.isFailure(read));
    const error = Cause.squash(read.cause);
    assert(error instanceof Replay.Invalid);
    return `${error.problem}: ${error.message}`;
  };
  /** Plays `ticks` ticks of a seeded game, dropping a coin on each. */
  const drops = Effect.fnUntraced(function* (app: App.App, ticks: number) {
    for (let i = 0; i < ticks; i++) {
      yield* app.dispatchByName("rp/Drop", { value: i + 1 });
      yield* app.tick(1 / 60);
    }
  });

  it.effect(
    "is its seed for a game recorded from its start: an app made from the recording begins the same way",
    () =>
      Effect.gen(function* () {
        const recorded = yield* record({
          ticks: 40,
          seed: 5,
          hashEvery: 1,
        });
        expect(recorded.recording.seed).toBe(5);
        expect(recorded.recording.save).toBeUndefined();
        // The game and the recording, and no seed said again: the replay makes
        // its app from how the game began, and its own recording says so.
        const replayed = yield* withApp(
          Effect.orDie(Replay.verify(recorded.recording, coinGame())),
          (app, world) =>
            Effect.gen(function* () {
              return {
                tick: app.time.tick,
                hash: world.hash(),
                seed: (yield* Replay.record(app)).seed,
              };
            })
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
            const saved = yield* Effect.exit(Save.make(app));
            assert(Exit.isSuccess(saved));
            return { save: saved.value };
          })
        );
        const origin: Replay.Origin = { seed: 6 };
        const options = { seed: 6, hashEvery: 1 };
        void Replay.verify(
          recorded.recording,
          coinGame(),
          // @ts-expect-error the recording holds its seed
          { seed: 6 }
        );
        void Replay.verify(
          recorded.recording,
          coinGame(),
          // @ts-expect-error the recording holds its seed or its save
          { save }
        );
        void Replay.verify(
          recorded.recording,
          coinGame(),
          // @ts-expect-error nor spread from how a game began
          { ...origin, hashEvery: 1 }
        );
        // @ts-expect-error nor in a variable
        void Replay.verify(recorded.recording, coinGame(), options);
        // A game made with no seed began with seed 0, and its recording says so.
        yield* withApp(App.make(coinGame()), (app) =>
          Effect.gen(function* () {
            expect((yield* Replay.record(app)).seed).toBe(0);
          })
        );
        // Through bytes and back.
        expect(Replay.decode(yield* Replay.encode(recorded.recording))).toEqual(
          Exit.succeed(recorded.recording)
        );
      })
  );

  it.effect(
    "is the save for a game recorded since one, which a replay goes on from to the present",
    () =>
      Effect.gen(function* () {
        const played = yield* withApp(
          game({ seed: 3, hashEvery: 1 }),
          (app, world) =>
            Effect.gen(function* () {
              yield* drops(app, 10);
              const saved = yield* Effect.exit(Save.make(app));
              assert(Exit.isSuccess(saved));
              yield* drops(app, 20);
              return {
                save: saved.value,
                tail: yield* Replay.record(app, saved.value),
                whole: yield* Replay.record(app),
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
        const read = Replay.decode(yield* Replay.encode(tail));
        assert(Exit.isSuccess(read));
        expect(read.value).toEqual(tail);
        const present = yield* withApp(
          Effect.orDie(Replay.verify(read.value, coinGame(), { hashEvery: 1 })),
          (app, world) =>
            Effect.gen(function* () {
              return {
                tick: app.time.tick,
                hash: world.hash(),
                save: (yield* Replay.record(app)).save,
              };
            })
        );
        expect(present).toEqual({ tick: 30, hash: played.hash, save });

        // An app made from a save began there, and its recording says so.
        yield* withApp(Effect.orDie(App.make(coinGame(), { save })), (app) =>
          Effect.gen(function* () {
            yield* drops(app, 2);
            const recording = yield* Replay.record(app);
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
            yield* drops(app, 4);
            const saved = yield* Effect.exit(Save.make(app));
            assert(Exit.isSuccess(saved));
            yield* drops(app, 2);
            return {
              save: saved.value,
              tail: yield* Replay.record(app, saved.value),
              whole: yield* Replay.record(app),
            };
          })
        );
        const fromSeed = yield* Replay.encode(whole);
        const fromSave = yield* Replay.encode(tail);
        for (const bytes of [fromSeed, fromSave]) {
          expect(bytes).toBeInstanceOf(Uint8Array);
          expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
        }
        expect(Replay.decode(fromSeed)).toEqual(Exit.succeed(whole));
        expect(Replay.decode(fromSave)).toEqual(Exit.succeed(tail));
        expect(
          Buffer.from(fromSave).includes(Buffer.from(Save.encode(save)))
        ).toBe(true);
      })
  );

  it.effect("can't be written with a payload that has no JSON form", () =>
    withApp(game({ seed: 3 }), (app) =>
      Effect.gen(function* () {
        yield* app.enqueueByName("rp/Nothing", { n: 1n });
        yield* app.tick(1 / 60);
        const recording = yield* Replay.record(app);
        const written = yield* Effect.exit(Replay.encode(recording));
        assert(Exit.isFailure(written));
        expect(Cause.squash(written.cause)).toMatchObject({
          _tag: "ReplayInvalid",
          problem: "no JSON form",
        });
        expect(Cause.squash(written.cause)).toBeInstanceOf(Replay.Invalid);
      })
    )
  );

  it.effect("is checked when a recording is read from bytes", () =>
    Effect.gen(function* () {
      const { save, tail, whole } = yield* withApp(game({ seed: 3 }), (app) =>
        Effect.gen(function* () {
          yield* drops(app, 4);
          const saved = yield* Effect.exit(Save.make(app));
          assert(Exit.isSuccess(saved));
          yield* drops(app, 2);
          return {
            save: saved.value,
            tail: yield* Replay.record(app, saved.value),
            whole: yield* Replay.record(app),
          };
        })
      );
      const fromSeed = yield* fieldsOf(whole);
      const fromSave = yield* fieldsOf(tail);

      // Only `Replay.record(app)` and `Replay.decode` make a recording.
      const byHand: Replay.Played & Replay.Origin = {
        seed: 3,
        start: 0,
        end: 0,
        endHash: 0,
        deltas: [],
        log: [],
      };
      // @ts-expect-error a recording written by hand is not one
      void (() => Replay.verify(byHand, coinGame()));

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

// --- a recording a person watches -----------------------------------------------------

const Runner = Component.define("rp/Runner", {
  x: Field.f32,
  speed: Field.f32,
});
const Running = Query.all(Runner).pipe(Query.writes(Runner));
const Runners = Query.all(Runner);
const Sprint = Action.define("rp/Sprint", {
  payload: Schema.Struct({ by: Schema.Number }),
});
const Sprinted = Event.define(
  "rp/Sprinted",
  Schema.Struct({ by: Schema.Number })
);
/** What the frame stage drew, and heard. */
const shown = { drawn: [] as number[], heard: [] as number[] };
const Race = App.define({
  plugins: [
    Plugin.make("rp/Track", {
      setup: Effect.map(Commands.spawns(Runner), (commands) => {
        commands.spawn(Runner.of({ x: 0, speed: 1 }));
        commands.spawn(Runner.of({ x: 5, speed: 2 }));
      }),
    }),
  ],
  systems: [
    System.tick("rp/Run", function* () {
      const { delta } = yield* Time;
      (yield* Query.View(Running)).each((runner) => {
        runner.x += runner.speed * delta;
      });
    }),
    System.frame("rp/Draw", function* () {
      let lead = 0;
      (yield* Query.View(Runners)).each((runner) => {
        lead = Math.max(lead, runner.x);
      });
      shown.drawn.push(lead);
      for (const { by } of (yield* Event.Reader(Sprinted)).read()) {
        shown.heard.push(by);
      }
    }),
  ],
  handlers: [
    Action.handler(Sprint, function* ({ by }) {
      (yield* Query.View(Running)).each((runner) => {
        runner.speed += by;
      });
      (yield* Event.Emitter(Sprinted)).emit({ by });
    }),
  ],
});

describe("a recording a person watches", () => {
  it.effect(
    "plays at its own pace in a driver, and pauses, goes faster and goes to any tick, to end on its hash",
    () =>
      Effect.gen(function* () {
        // The race as it was played, with the world's hash at every tick.
        const raced = yield* App.make(Race, { seed: 3, hashEvery: 1 });
        const world = yield* raced.read(World);
        const hashes = new Map<number, number>([[0, world.hash()]]);
        for (let tick = 0; tick < 150; tick++) {
          if (tick % 40 === 5) {
            yield* raced.enqueue(Sprint, { by: tick / 10 });
          }
          yield* raced.tick(1 / 60);
          hashes.set(raced.time.tick, world.hash());
        }
        const recording = yield* Replay.record(raced);

        const display = Driver.makeManualDisplay();
        let player: Replay.Player<App.Any, never> | undefined;
        yield* Effect.forkScoped(
          Driver.run(Replay.play(recording, Race), {
            ready: (made) =>
              Effect.sync(() => {
                player = made;
              }),
          }).pipe(Effect.provide(Driver.layer(display))),
          { startImmediately: true }
        );
        let now = 0;
        const frames = (count: number) => {
          for (let i = 0; i < count; i++) {
            display.frame(now);
            now += 1000 / 60;
          }
        };
        const watched = player!;
        const at = () => watched.app.time.tick;
        const hash = Effect.map(watched.app.read(World), (one) => one.hash());
        shown.drawn.length = 0;
        // A tick of the recording a frame, and the frame stage draws it.
        frames(11);
        expect(at()).toBe(10);
        expect(yield* hash).toBe(hashes.get(10));
        expect(shown.drawn.length).toBe(11);
        expect(shown.heard).toEqual([0.5]);
        // Paused, it draws where it is.
        yield* watched.pause;
        frames(5);
        expect(at()).toBe(10);
        expect(shown.drawn.length).toBe(16);
        // Twice as fast.
        yield* watched.play(2);
        frames(10);
        expect(at()).toBe(30);
        expect(yield* hash).toBe(hashes.get(30));
        // Back, and on again, to where the game was there.
        yield* watched.seek(7);
        expect(at()).toBe(7);
        expect(yield* hash).toBe(hashes.get(7));
        yield* watched.seek(120);
        expect(yield* hash).toBe(hashes.get(120));
        // What it went past isn't heard.
        shown.heard.length = 0;
        frames(1);
        expect(shown.heard).toEqual([]);
        // To the end, where it stands still.
        yield* watched.play();
        frames(40);
        expect(at()).toBe(150);
        expect(watched.ended).toBe(true);
        expect(yield* hash).toBe(recording.endHash);
        frames(5);
        expect(at()).toBe(150);
        // And back from the end.
        yield* watched.seek(0);
        expect(watched.ended).toBe(false);
        expect(yield* hash).toBe(hashes.get(0));
      }).pipe(Effect.scoped)
  );

  it.effect("stops the driver where the recording doesn't replay", () =>
    Effect.gen(function* () {
      const raced = yield* App.make(Race, { seed: 3, hashEvery: 1 });
      for (let tick = 0; tick < 20; tick++) {
        yield* raced.tick(1 / 60);
      }
      const bytes = yield* Replay.encode(yield* Replay.record(raced));
      // Decoded by a game that runs another way: its runners don't run.
      const Still = App.define({ systems: [], handlers: [] });
      const recording = yield* Replay.decode(bytes);
      const display = Driver.makeManualDisplay();
      const fiber = yield* Effect.forkScoped(
        Effect.exit(
          Driver.run(Replay.play(recording, Still)).pipe(
            Effect.provide(Driver.layer(display))
          )
        ),
        { startImmediately: true }
      );
      for (let i = 0; i < 30 && fiber.pollUnsafe() === undefined; i++) {
        display.frame(i * 20);
      }
      const exit = yield* Fiber.join(fiber);
      assert(Exit.isFailure(exit));
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Replay.Diverged);
    }).pipe(Effect.scoped)
  );
});
