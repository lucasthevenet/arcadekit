import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";

import { entityOf, idOf } from "../src/ecs/component.ts";
import { World as EcsWorld, readSnapshot } from "../src/ecs/index.ts";
import type { ReadingEvents } from "../src/Event.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Event,
  Events,
  Field,
  Input,
  Plugin,
  Query,
  Replay,
  Save,
  Singleton,
  System,
  Time,
  Timeline,
  View,
  World,
} from "../src/index.ts";
import type { Entity, JsonValue } from "../src/index.ts";
import * as Build from "../src/internal/build.ts";
import { partsOf } from "../src/internal/parts.ts";
import { Session } from "../src/net/index.ts";
import { thrown, unwrap } from "./checks.ts";
import {
  CoinGame,
  DELTA,
  Drop,
  Lying,
  Take,
  Whisper,
  game,
  moves,
  steered,
  withApp,
} from "./peers.ts";
import type { Game, SteeredGame } from "./peers.ts";

/** Runs `use` with what `make` makes: a build, a sync test. */
const withMade = <T, A, E2 = never>(
  make: Effect.Effect<T, never>,
  use: (made: T) => Effect.Effect<A, E2>
) => Effect.flatMap(make, use);

/** A stretch of a game, played by a seed: the same moves for the same seed. */
const stretch = Effect.fnUntraced(function* (
  app: Game,
  seed: number,
  ticks: number
) {
  const dice = new EcsWorld({ seed }).random;
  const world = yield* app.read(World);
  const lying = yield* app.read(Lying);
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const roll = dice.int(1, 5);
    if (roll <= 2) {
      yield* app.enqueue(Drop, { by: "ada", value: dice.int(1, 9) });
    } else if (roll === 3) {
      const [oldest, ...rest] = lying.entities();
      if (oldest !== undefined) {
        yield* app.enqueue(Take, {
          by: "grace",
          coin: dice.pick([oldest, ...rest]),
        });
        // And once more, which is refused: the coin is gone by then.
        yield* app.enqueue(Take, { by: "ada", coin: oldest });
      }
    }
    yield* app.tick(DELTA);
    hashes.push(world.hash());
  }
  return hashes;
});

const captured = Effect.fnUntraced(function* (app: App.Any) {
  const moment = yield* Effect.exit(Timeline.capture(app));
  if (Exit.isFailure(moment)) {
    throw new Error("the game could not be captured");
  }
  return moment.value;
});

describe("a game that is put back to a moment", () => {
  it.effect("is the game it was, and goes on as that game did", () =>
    Effect.gen(function* () {
      for (const seed of [1, 2, 3]) {
        yield* withApp(game(), (app, world) =>
          Effect.gen(function* () {
            yield* stretch(app, seed, 40);
            // Something is waiting at this moment: an action for the next tick.
            yield* app.enqueue(Drop, { by: "ada", value: 4 });
            const moment = yield* captured(app);
            expect(moment.tick).toBe(40);
            const then = {
              save: yield* Effect.exit(Save.make(app)),
              log: structuredClone(app.actionLog),
              time: { ...app.time },
              settled: app.settled,
            };
            const first = yield* stretch(app, seed + 10, 30);
            const firstLog = structuredClone(app.actionLog);
            // Another way from the same moment, and back again.
            yield* Timeline.rewind(app, moment);
            yield* stretch(app, seed + 20, 45);
            expect(world.hash()).not.toBe(first.at(-1));
            yield* Timeline.rewind(app, moment);
            expect({
              save: yield* Effect.exit(Save.make(app)),
              log: app.actionLog,
              time: { ...app.time },
              settled: app.settled,
            }).toEqual(then);
            // The same moves from there give the same game, tick for tick,
            // and the same log, the refusals in it among them.
            expect(yield* stretch(app, seed + 10, 30)).toEqual(first);
            expect(app.actionLog).toEqual(firstLog);
            expect(
              moves(app.actionLog).some((entry) => entry.refused !== undefined)
            ).toBe(true);
          })
        );
      }
    })
  );

  it.effect(
    "has the log it had there, to a moment of a future it gave up too, so that what it records replays to it",
    () =>
      Effect.gen(function* () {
        for (const seed of [1, 2, 3]) {
          const dice = new EcsWorld({ seed: seed + 100 }).random;
          yield* withApp(game(seed), (app, world) =>
            Effect.gen(function* () {
              const moments: {
                readonly moment: Timeline.Moment;
                readonly log: unknown;
                readonly hash: number;
              }[] = [];
              for (let step = 0; step < 60; step++) {
                const roll = dice.int(1, 6);
                if (roll <= 3) {
                  // Some of it refused, which the log says.
                  yield* stretch(app, dice.int(1, 99), dice.int(1, 4));
                } else if (roll === 4) {
                  moments.push({
                    moment: yield* captured(app),
                    log: structuredClone(app.actionLog),
                    hash: world.hash(),
                  });
                } else if (moments.length > 0) {
                  const to = dice.pick(moments);
                  yield* Timeline.rewind(app, to.moment, {
                    again: roll === 6,
                  });
                  expect(app.actionLog).toEqual(to.log);
                  expect(world.hash()).toBe(to.hash);
                }
              }
              const replayed = yield* Replay.verify(
                yield* Replay.record(app),
                CoinGame,
                { hashEvery: 1 }
              );
              expect((yield* replayed.read(World)).hash()).toBe(world.hash());
            })
          );
        }
      })
  );

  it.effect("is the same game as one that never went anywhere else", () =>
    Effect.gen(function* () {
      const straight = yield* withApp(game(), (app) =>
        Effect.gen(function* () {
          return [
            ...(yield* stretch(app, 5, 25)),
            ...(yield* stretch(app, 6, 25)),
          ];
        })
      );
      const wandering = yield* withApp(game(), (app) =>
        Effect.gen(function* () {
          const before = yield* stretch(app, 5, 25);
          const moment = yield* captured(app);
          yield* stretch(app, 99, 17);
          yield* Timeline.rewind(app, moment);
          return [...before, ...(yield* stretch(app, 6, 25))];
        })
      );
      expect(wandering).toEqual(straight);
    })
  );

  it.effect("can be a moment before the game had started", () =>
    withApp(game(), (app) =>
      Effect.gen(function* () {
        const moment = yield* captured(app);
        expect(app.actionLog).toEqual([]);
        const first = yield* stretch(app, 8, 5);
        const log = structuredClone(app.actionLog);
        // The log begins with the hash of the state the game starts from.
        expect(log[0]).toEqual({ tick: 0, hash: expect.any(Number) });
        yield* Timeline.rewind(app, moment);
        expect(app.actionLog).toEqual([]);
        expect(yield* stretch(app, 8, 5)).toEqual(first);
        // It starts again, and says so again.
        expect(app.actionLog).toEqual(log);
      })
    )
  );

  it.effect("is as settled as it was", () =>
    Effect.gen(function* () {
      // A clock that runs down for two ticks.
      const Left = Singleton.define(
        "rw/Left",
        { ticks: Field.u8 },
        { ticks: 2 }
      );
      const Clock = System.tick("rw/Clock", function* () {
        const left = yield* Left.writes;
        if (left.ticks > 0) {
          left.ticks -= 1;
        }
      });
      yield* withApp(App.make(App.define({ systems: [Clock] })), (app) =>
        Effect.gen(function* () {
          yield* app.tick(DELTA);
          expect(app.settled).toBe(false);
          const moment = yield* captured(app);
          yield* app.tick(DELTA);
          yield* app.tick(DELTA);
          expect(app.settled).toBe(true);
          yield* Timeline.rewind(app, moment);
          // The clock had changed in the tick before, and is owed the next again.
          expect(app.settled).toBe(false);
        })
      );
    })
  );

  it.effect("keeps an action that is waiting for the next tick", () =>
    withApp(game(), (app) =>
      Effect.gen(function* () {
        yield* app.dispatch(Drop, { by: "ada", value: 1 });
        yield* app.enqueue(Whisper, { to: "grace" });
        const moment = yield* captured(app);
        yield* app.tick(DELTA);
        expect(moves(app.actionLog).map((entry) => entry.name)).toEqual([
          "ls/Drop",
          "ls/Whisper",
        ]);
        yield* Timeline.rewind(app, moment);
        // It is waiting again, to be applied by the tick that follows.
        expect(app.settled).toBe(false);
        yield* app.tick(DELTA);
        expect(app.time.tick).toBe(1);
      })
    )
  );

  it.effect("takes back what became of an action that was waiting", () =>
    withApp(game(), (app) =>
      Effect.gen(function* () {
        yield* app.tick(DELTA);
        // No such coin: the tick that applies it will refuse it.
        yield* app.enqueue(Take, { by: "ada", coin: entityOf(77) });
        const moment = yield* captured(app);
        const entry = () => moves(app.actionLog).at(-1)!;
        expect(entry().refused).toBeUndefined();
        const logged = app.actionLog.length;
        yield* app.tick(DELTA);
        expect(entry().refused).toBeDefined();
        expect(app.actionLog.length).toBeGreaterThan(logged);
        yield* Timeline.rewind(app, moment);
        // Not yet applied, so not yet refused, and the log is as long as it was.
        expect(entry().refused).toBeUndefined();
        expect(app.actionLog.length).toBe(logged);
        yield* app.tick(DELTA);
        expect(entry().refused).toBeDefined();
      })
    )
  );

  it.effect(
    "puts back the events that were waiting, and everyone's place in them",
    () =>
      Effect.gen(function* () {
        const Rang = Event.define("rw/Rang", Schema.Struct({ n: Schema.Int }));
        const heard: number[][] = [];
        // Listed before the system that emits: it hears each event a tick late.
        const Listen = System.tick("rw/Listen", function* () {
          heard.push((yield* Rang).read().map((rang) => rang.n));
        });
        const Ring = System.tick("rw/Ring", function* () {
          (yield* Rang.emits).emit({ n: (yield* Time).tick });
        });
        yield* withApp(
          App.make(App.define({ systems: [Listen, Ring] })),
          (app) =>
            Effect.gen(function* () {
              yield* app.tick(DELTA);
              yield* app.tick(DELTA);
              const moment = yield* captured(app);
              yield* app.tick(DELTA);
              yield* app.tick(DELTA);
              expect(heard).toEqual([[], [1], [2], [3]]);
              yield* Timeline.rewind(app, moment);
              heard.length = 0;
              yield* app.tick(DELTA);
              yield* app.tick(DELTA);
              // Each once, from where it was: 2 was waiting, and 3 is rung again.
              expect(heard).toEqual([[2], [3]]);
            })
        );
      })
  );

  it.effect(
    "has what draws start over, and the simulation go on from where it was",
    () =>
      Effect.gen(function* () {
        const Dot = Component.define("rw/Dot", { x: Field.f32 });
        const NewDots = Query.all(Dot).pipe(Query.added(Dot));
        const seen = { tick: [] as number[], frame: [] as number[] };
        const Count = System.tick("rw/Count", function* () {
          seen.tick.push((yield* NewDots).entities().length);
        });
        const Draw = System.frame("rw/Draw", function* () {
          seen.frame.push((yield* NewDots).entities().length);
        });
        const Grow = System.tick("rw/Grow", function* () {
          (yield* Commands.spawns(Dot)).spawn(Dot.of({ x: 1 }));
        });
        // Listed ahead of what it watches, so that a dot is waiting for it when the
        // game goes back: an order the compiler refuses.
        const game = App.define(
          // @ts-expect-error a watcher listed ahead of what it watches, on purpose
          { systems: [Count, Draw, Grow] }
        );
        yield* withApp(App.make(game), (app) =>
          Effect.gen(function* () {
            for (let i = 0; i < 3; i++) {
              yield* app.tick(DELTA);
              yield* app.frame();
            }
            const moment = yield* captured(app);
            yield* app.tick(DELTA);
            yield* app.frame();
            expect(seen).toEqual({ tick: [0, 1, 1, 1], frame: [1, 1, 1, 1] });
            yield* Timeline.rewind(app, moment);
            seen.tick.length = 0;
            seen.frame.length = 0;
            yield* app.tick(DELTA);
            yield* app.frame();
            // The system of the tick sees the one dot it had yet to see. What
            // draws sees every dot again: all four are new to it.
            expect(seen).toEqual({ tick: [1], frame: [4] });
          })
        );
      })
  );

  it.effect(
    "is refused with a moment of another app, and in the middle of a tick",
    () =>
      Effect.gen(function* () {
        const moment = yield* withApp(game(), (app) => captured(app));
        yield* withApp(game(), (app) =>
          Effect.gen(function* () {
            expect(yield* thrown(Timeline.rewind(app, moment))).toThrow(
              /a moment that this app did not capture.*save it and load the save/u
            );
            expect(yield* thrown(Timeline.rewind(app, { tick: 0 }))).toThrow(
              /did not capture/u
            );
          })
        );
        let inside: App.Any | undefined;
        const Meddle = System.tick("rw/Meddle", function* () {
          if (inside !== undefined && inside.time.tick === 2) {
            yield* Timeline.capture(inside);
          }
        });
        yield* withApp(App.make(App.define({ systems: [Meddle] })), (app) =>
          Effect.gen(function* () {
            inside = app;
            yield* app.tick(DELTA);
            expect(yield* thrown(app.tick(DELTA))).toThrow(
              /Timeline\.capture\(\) was called during a tick/u
            );
          })
        );
        const taken: Timeline.Moment[] = [];
        const Undo = System.tick("rw/Undo", function* () {
          if (inside !== undefined && taken.length > 0) {
            yield* Timeline.rewind(inside, taken[0]!);
          }
        });
        yield* withApp(App.make(App.define({ systems: [Undo] })), (app) =>
          Effect.gen(function* () {
            inside = app;
            yield* app.tick(DELTA);
            taken.push(yield* captured(app));
            expect(yield* thrown(app.tick(DELTA))).toThrow(
              /Timeline\.rewind\(\) was called during a tick/u
            );
          })
        );
      })
  );

  it.effect(
    "keeps a transient field where nothing was written since the moment, and empties it where something was",
    () =>
      Effect.gen(function* () {
        const Sprite = Component.define("rw/Sprite", {
          x: Field.f32,
          handle: Field.transient<string>(),
        });
        const Lamp = Component.define("rw/Lamp", {
          on: Field.u8,
          handle: Field.transient<string>(),
        });
        const Move = Action.define("rw/Move", Schema.Struct({}));
        const Sprites = Query.all(Sprite).pipe(Query.writes(Sprite));
        const move = Action.handler(Move, function* () {
          (yield* Sprites).each((sprite) => {
            sprite.x += 1;
          });
        });
        yield* withApp(App.make(App.define({ handlers: [move] })), (app) =>
          Effect.gen(function* () {
            const world = partsOf(app).world;
            const sprite = world.spawn(Sprite.of({ x: 0, handle: "sprite" }));
            const lamp = world.spawn(Lamp.of({ on: 1, handle: "lamp" }));
            const moment = yield* captured(app);
            yield* app.dispatch(Move, {});
            yield* Timeline.rewind(app, moment);
            expect(world.get(sprite, Sprite)).toEqual({
              x: 0,
              handle: undefined,
            });
            expect(world.get(lamp, Lamp)).toEqual({ on: 1, handle: "lamp" });
          })
        );
      })
  );

  it.effect("cannot be captured with a field that cannot be saved", () =>
    Effect.gen(function* () {
      const Holder = Component.define("rw/Holder", {
        thing: Field.json<JsonValue>(),
      });
      const Hold = Action.define("rw/Hold", Schema.Struct({}));
      const hold = Action.handler(Hold, function* () {
        (yield* Commands.spawns(Holder)).spawn(
          // @ts-expect-error A function is not JSON.
          Holder.of({ thing: () => 1 })
        );
      });
      yield* withApp(App.make(App.define({ handlers: [hold] })), (app) =>
        Effect.gen(function* () {
          expect(
            Exit.isSuccess(yield* Effect.exit(Timeline.capture(app)))
          ).toBe(true);
          yield* app.dispatch(Hold, {});
          const refused = yield* Effect.exit(Timeline.capture(app));
          expect(Exit.isFailure(refused)).toBe(true);
          expect(String(Exit.isFailure(refused) ? refused.cause : "")).toMatch(
            /rw\/Holder/u
          );
        })
      );
    })
  );

  it.effect("is not for an action's handler to call", () =>
    Effect.gen(function* () {
      let inside: App.Any | undefined;
      const Back = Action.define("rw/Back", Schema.Struct({}));
      const taken: Timeline.Moment[] = [];
      const back = Action.handler(Back, function* () {
        yield* Timeline.rewind(inside!, taken[0]!);
      });
      yield* withApp(App.make(App.define({ handlers: [back] })), (app) =>
        Effect.gen(function* () {
          inside = app;
          taken.push(yield* captured(app));
          const exit = yield* Effect.exit(app.dispatch(Back, {}));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(String(Exit.isFailure(exit) ? exit.cause : "")).toMatch(
            /Timeline\.rewind\(\) was called during an action's handler/u
          );
        })
      );
    })
  );
});

describe("what the input stage issues, across a rewind and a save", () => {
  // The stage issues one shot each time it runs, and the tick applies it.
  const Fire = Action.define("rw/Fire", Schema.Struct({}));
  const pressing = () => {
    const fired: number[] = [];
    const fire = Action.handler(Fire, function* () {
      yield* Effect.sync(() => fired.push(1));
    });
    const Press = System.input("rw/Press", function* () {
      (yield* Action.Actions).enqueue(Fire, {});
    });
    return {
      fired,
      game: App.define({ systems: [Press], handlers: [fire] }),
    };
  };

  it.effect("is taken back by a rewind to a moment before the stage ran", () =>
    Effect.gen(function* () {
      const { fired, game: Pressed } = pressing();
      yield* withApp(App.make(Pressed), (app) =>
        Effect.gen(function* () {
          yield* app.tick(DELTA);
          fired.length = 0;
          const moment = yield* captured(app);
          yield* app.input();
          yield* Timeline.rewind(app, moment);
          yield* app.tick(DELTA);
          expect(fired).toEqual([]);
        })
      );
    })
  );

  it.effect("is kept by a moment taken after the stage ran", () =>
    Effect.gen(function* () {
      const { fired, game: Pressed } = pressing();
      yield* withApp(App.make(Pressed), (app) =>
        Effect.gen(function* () {
          yield* app.tick(DELTA);
          fired.length = 0;
          yield* app.input();
          const moment = yield* captured(app);
          yield* Timeline.rewind(app, moment);
          yield* app.tick(DELTA);
          expect(fired).toEqual([1]);
        })
      );
    })
  );

  it.effect("is kept by a save taken after the stage ran", () =>
    Effect.gen(function* () {
      const { fired, game: Pressed } = pressing();
      const saved = yield* withApp(App.make(Pressed), (app) =>
        Effect.gen(function* () {
          yield* app.tick(DELTA);
          yield* app.input();
          const save = yield* Effect.exit(Save.make(app));
          if (Exit.isFailure(save)) {
            throw new Error("the game could not be saved");
          }
          return save.value;
        })
      );
      fired.length = 0;
      yield* withApp(Effect.orDie(App.make(Pressed, { save: saved })), (app) =>
        Effect.gen(function* () {
          yield* app.tick(DELTA);
          expect(fired).toEqual([1]);
        })
      );
    })
  );

  it.effect(
    "is all the stage leaves: a stage that issues nothing changes neither the hash nor a save",
    () =>
      Effect.gen(function* () {
        const Idle = System.input("rw/Idle", function* () {});
        yield* withApp(
          App.make(App.define({ systems: [Idle] })),
          (app, world) =>
            Effect.gen(function* () {
              const before = world.hash();
              yield* app.input();
              expect(world.hash()).toBe(before);
              const save = yield* Effect.exit(Save.make(app));
              if (Exit.isFailure(save)) {
                throw new Error("the game could not be saved");
              }
              expect(readSnapshot(save.value.world).stores).toEqual([]);
            })
        );
      })
  );
});

describe("what the stages between ticks hear across a rewind", () => {
  const Rang = Event.define("rw/Rang", Schema.Struct({ n: Schema.Int }));
  const Bell = Component.define("rw/Bell", { extra: Field.i32 });
  const Bells = Query.all(Bell);
  const Louder = Action.define("rw/Louder", Schema.Struct({ by: Schema.Int }));
  const louder = Action.handler(Louder, function* ({ by }) {
    (yield* Commands.spawns(Bell)).spawn(Bell.of({ extra: by }));
  });
  // A number that says nothing of the tick it is chimed on.
  const Chimed = Event.define("rw/Chimed", Schema.Struct({ n: Schema.Int }));
  const Chime = Action.define("rw/Chime", Schema.Struct({ n: Schema.Int }));
  const chime = Action.handler(Chime, function* ({ n }) {
    (yield* Chimed.emits).emit({ n });
  });
  // Each tick rings its number twice, and once more for each bell.
  const Ring = System.tick("rw/Ring", function* () {
    const rang = yield* Rang.emits;
    const { tick } = yield* Time;
    rang.emit({ n: tick });
    rang.emit({ n: tick });
    (yield* Bells).each((bell) => rang.emit({ n: tick * 100 + bell.extra }));
  });
  /** A game whose stages between ticks listen to one of the two events. */
  const listening = (to: typeof Rang = Rang) => {
    const heard = { frame: [] as number[], input: [] as number[] };
    const Draw = System.frame("rw/Draw", function* () {
      heard.frame.push(...(yield* to).read().map((rang) => rang.n));
    });
    const Keys = System.input("rw/Keys", function* () {
      heard.input.push(...(yield* to).read().map((rang) => rang.n));
    });
    const game = App.define({
      systems: [Ring, Draw, Keys],
      handlers: [louder, chime],
    });
    return { heard, game, make: App.make(game) };
  };

  describe("to run the same ticks again, as a session does", () => {
    it.effect(
      "hear each event once, and what the ticks run again do otherwise",
      () =>
        Effect.gen(function* () {
          const { heard, game: Ringing } = listening();
          yield* withMade(Build.build(Ringing, {}), (built) =>
            Effect.gen(function* () {
              const session = steered(built);
              const { app } = session;
              yield* session.tick(DELTA);
              yield* app.frame();
              const back = yield* session.capture();
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([1, 1, 2, 2, 3, 3]);
              heard.frame.length = 0;
              heard.input.length = 0;
              // Run again with a bell that rings on tick 3: only that is new.
              yield* session.rewind(back);
              yield* session.tick(DELTA);
              yield* app.enqueue(Louder, { by: 7 });
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([307]);
              // Past where the game had got to, every event is new again. The input
              // stage runs before each tick, so it had not heard the third tick's
              // events before the rewind, and hears them now, before the fourth.
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard).toEqual({
                frame: [307, 4, 4, 407],
                input: [3, 3, 307],
              });
            })
          );
        })
    );

    it.effect(
      "hear once what they heard of ticks whose events were dropped since",
      () =>
        Effect.gen(function* () {
          const { heard, game: Ringing } = listening();
          yield* withMade(Build.build(Ringing, {}), (built) =>
            Effect.gen(function* () {
              const session = steered(built);
              const { app } = session;
              yield* session.tick(DELTA);
              yield* app.frame();
              const back = yield* session.capture();
              // Every stage hears each tick, so each tick drops the one before.
              for (let i = 0; i < 4; i++) {
                yield* session.tick(DELTA);
                yield* app.frame();
              }
              expect((yield* app.inspect()).stores[Event.STORE]).toEqual({
                "rw/Rang": [{ n: 5 }, { n: 5 }],
              });
              heard.frame.length = 0;
              yield* session.rewind(back);
              for (let i = 0; i < 4; i++) {
                yield* session.tick(DELTA);
                yield* app.frame();
              }
              expect(heard.frame).toEqual([]);
            })
          );
        })
    );

    it.effect(
      "hear again none of what they heard before a moment was taken",
      () =>
        Effect.gen(function* () {
          const { heard, game: Ringing } = listening();
          yield* withMade(Build.build(Ringing, {}), (built) =>
            Effect.gen(function* () {
              const session = steered(built);
              const { app } = session;
              // Taken before anything between ticks has run.
              const back = yield* session.capture();
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              yield* app.frame();
              const first = [...heard.frame];
              yield* session.rewind(back);
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(first).toEqual([1, 1, 2, 2]);
              expect(heard.frame).toEqual([1, 1, 2, 2]);
              // The input stage runs before each tick, and heard what came before
              // the second, once.
              expect(heard.input).toEqual([1, 1]);
            })
          );
        })
    );

    it.effect(
      "hear the events of ticks they never heard, after a rewind further back",
      () =>
        Effect.gen(function* () {
          const { heard, game: Ringing } = listening();
          yield* withMade(Build.build(Ringing, {}), (built) =>
            Effect.gen(function* () {
              const session = steered(built);
              const { app } = session;
              yield* session.tick(DELTA);
              yield* app.frame();
              const back = yield* session.capture();
              // Ticks run with no frame: the frame stage heard none of them.
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              yield* session.rewind(back);
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([1, 1, 2, 2, 3, 3]);
            })
          );
        })
    );

    it.effect(
      "hear an event a later tick now emits, though an earlier one emitted the same",
      () =>
        Effect.gen(function* () {
          const { heard, game: Chiming } = listening(Chimed);
          yield* withMade(Build.build(Chiming, {}), (built) =>
            Effect.gen(function* () {
              const session = steered(built);
              const { app } = session;
              yield* session.tick(DELTA);
              const back = yield* session.capture();
              // As predicted: the chime on the second tick.
              yield* app.enqueue(Chime, { n: 5 });
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([5]);
              // As it was: the second tick has none, and the third rings the same.
              yield* session.rewind(back);
              yield* session.tick(DELTA);
              yield* app.enqueue(Chime, { n: 5 });
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([5, 5]);
            })
          );
        })
    );

    it.effect(
      "hear an event an earlier tick now emits, though a later one emitted the same",
      () =>
        Effect.gen(function* () {
          const { heard, game: Chiming } = listening(Chimed);
          yield* withMade(Build.build(Chiming, {}), (built) =>
            Effect.gen(function* () {
              const session = steered(built);
              const { app } = session;
              yield* session.tick(DELTA);
              const back = yield* session.capture();
              // As predicted: the chime on the third tick.
              yield* session.tick(DELTA);
              yield* app.enqueue(Chime, { n: 5 });
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([5]);
              // As it was: on the second, which is not the tick it was heard of.
              yield* session.rewind(back);
              yield* app.enqueue(Chime, { n: 5 });
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([5, 5]);
            })
          );
        })
    );

    it.effect("leave the game as one that never went back", () =>
      Effect.gen(function* () {
        const one = listening();
        const other = listening();
        yield* withMade(Build.build(one.game, {}), (built) =>
          withApp(other.make, (straight) =>
            Effect.gen(function* () {
              const session = steered(built);
              const back = session.app;
              yield* session.tick(DELTA);
              yield* back.frame();
              const at = yield* session.capture();
              yield* session.tick(DELTA);
              yield* back.frame();
              yield* session.rewind(at);
              yield* session.tick(DELTA);
              yield* back.frame();
              for (let i = 0; i < 2; i++) {
                yield* straight.tick(DELTA);
                yield* straight.frame();
              }
              expect((yield* back.read(World)).hash()).toBe(
                (yield* straight.read(World)).hash()
              );
              expect(yield* Effect.exit(Save.make(back))).toEqual(
                yield* Effect.exit(Save.make(straight))
              );
              expect(one.heard.frame).toEqual(other.heard.frame);
            })
          )
        );
      })
    );
  });

  describe("to play on from there, as an undo does", () => {
    it.effect(
      "hear every event that follows, one they heard before the rewind among them",
      () =>
        Effect.gen(function* () {
          const { heard, make } = listening(Chimed);
          yield* withApp(make, (app) =>
            Effect.gen(function* () {
              yield* app.tick(DELTA);
              const back = yield* captured(app);
              yield* app.enqueue(Chime, { n: 5 });
              yield* app.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([5]);
              // The move is undone, and made again: it is a new one.
              yield* Timeline.rewind(app, back);
              yield* app.enqueue(Chime, { n: 5 });
              yield* app.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([5, 5]);
              // Between two ticks as well.
              yield* Timeline.rewind(app, back);
              yield* app.dispatch(Chime, { n: 5 });
              yield* app.frame();
              expect(heard.frame).toEqual([5, 5, 5]);
            })
          );
        })
    );

    it.effect(
      "hear nothing of the future that was given up before they had heard it",
      () =>
        Effect.gen(function* () {
          const { heard, make } = listening();
          yield* withApp(make, (app) =>
            Effect.gen(function* () {
              yield* app.tick(DELTA);
              yield* app.frame();
              const back = yield* captured(app);
              // Run ahead with no frame, as a search does, and come back.
              yield* app.tick(DELTA);
              yield* app.tick(DELTA);
              yield* Timeline.rewind(app, back);
              yield* app.frame();
              expect(heard.frame).toEqual([1, 1]);
              yield* app.tick(DELTA);
              yield* app.frame();
              expect(heard.frame).toEqual([1, 1, 2, 2]);
            })
          );
        })
    );
  });

  describe("code outside the game, which hears as the stages do", () => {
    /** A game whose bus is kept for code outside it, once it has ticked. */
    const kept = () => {
      let bus: ReadingEvents | undefined;
      const Keep = System.tick("rw/Keep", function* () {
        bus = yield* Effect.service(Events);
      });
      const game = App.define({ systems: [Ring, Keep], handlers: [louder] });
      const listen = () => {
        assert(bus !== undefined, "the game has not ticked");
        const reader = bus.handle(Rang);
        return () => reader.read().map((rang) => rang.n);
      };
      return { game, listen };
    };

    it.effect(
      "hears what a tick run again does otherwise, and nothing twice",
      () =>
        Effect.gen(function* () {
          const { game, listen } = kept();
          yield* withMade(Build.build(game, {}), (built) =>
            Effect.gen(function* () {
              const session = steered(built);
              yield* session.tick(DELTA);
              const heard = listen();
              const back = yield* session.capture();
              yield* session.tick(DELTA);
              yield* session.tick(DELTA);
              expect(heard()).toEqual([2, 2, 3, 3]);
              yield* session.rewind(back);
              yield* session.tick(DELTA);
              yield* session.app.enqueue(Louder, { by: 7 });
              yield* session.tick(DELTA);
              expect(heard()).toEqual([307]);
              yield* session.tick(DELTA);
              expect(heard()).toEqual([4, 4, 407]);
            })
          );
        })
    );

    it.effect(
      "hears every event told after an undo, before it next reads",
      () =>
        Effect.gen(function* () {
          const { game, listen } = kept();
          yield* withApp(App.make(game), (app) =>
            Effect.gen(function* () {
              yield* app.tick(DELTA);
              const heard = listen();
              const back = yield* captured(app);
              yield* app.tick(DELTA);
              yield* app.tick(DELTA);
              yield* Timeline.rewind(app, back);
              yield* app.tick(DELTA);
              expect(heard()).toEqual([2, 2]);
            })
          );
        })
    );
  });
});

describe("what the stages between ticks visit across a rewind", () => {
  const Dot = Component.define("rw/Dot", { x: Field.i32 });
  const Dots = Query.all(Dot);
  const Moved = Query.all(Dot).pipe(Query.changed(Dot));
  const Act = Action.define(
    "rw/Act",
    Schema.Struct({ op: Schema.Int, pick: Schema.Int, x: Schema.Int })
  );
  // Spawns a dot, despawns one, or moves one.
  const act = Action.handler(Act, function* ({ op, pick, x }) {
    const dots = (yield* Dots).entities();
    const dot = dots[pick % Math.max(1, dots.length)];
    if (op === 0 || dot === undefined) {
      (yield* Commands.spawns(Dot)).spawn(Dot.of({ x }));
    } else if (op === 1) {
      (yield* Commands).despawn(dot);
    } else {
      (yield* World.writes(Dot)).set(dot, Dot, { x });
    }
  });
  /** Where the frame stage last saw each dot. */
  const shown = new Map<Entity, number>();
  const Show = System.frame("rw/Show", function* () {
    const world = yield* World;
    for (const dot of (yield* Moved).entities()) {
      shown.set(dot, world.get(dot, Dot)?.x ?? -1);
    }
  });
  const game = App.define({ systems: [Show], handlers: [act] });

  it.effect(
    "keep nothing for a rewind once no moment of the game is held",
    () =>
      Effect.gen(function* () {
        setFlagsFromString("--expose-gc");
        const collect = runInNewContext("gc") as () => void;
        const app = yield* App.make(game);
        const { world } = partsOf(app);
        for (let x = 0; x < 20; x++) {
          yield* app.enqueue(Act, { op: 0, pick: 0, x });
        }
        yield* app.tick(DELTA);
        yield* app.frame(0);
        // A moment no one keeps, as an undo point that is let go.
        yield* captured(app);
        // A weakly held object outlives the turn it was last reached in.
        yield* Effect.promise(
          () => new Promise((resolve) => setTimeout(resolve, 0))
        );
        collect();
        for (let tick = 0; tick < 2000; tick++) {
          yield* app.enqueue(Act, { op: 2, pick: tick, x: tick });
          yield* app.enqueue(Act, { op: 1, pick: tick, x: 0 });
          yield* app.enqueue(Act, { op: 0, pick: 0, x: tick });
          yield* app.tick(DELTA);
          yield* app.frame(0);
        }
        const held = (kind: "changed" | "removed"): number => {
          const log = world._log(Dot, kind);
          return log.end - log.base;
        };
        expect({ changed: held("changed"), removed: held("removed") }).toEqual({
          changed: 0,
          removed: 0,
        });
      })
  );

  it.effect(
    "are enough to keep what they show true, through random rewinds",
    () =>
      Effect.gen(function* () {
        const wrong: string[] = [];
        for (const seed of [1, 2, 3, 4, 5, 6]) {
          const dice = new EcsWorld({ seed }).random;
          shown.clear();
          yield* withApp(App.make(game), (app, world) =>
            Effect.gen(function* () {
              const moments: Timeline.Moment[] = [];
              for (let step = 0; step < 300; step++) {
                const roll = dice.int(1, 10);
                if (roll <= 5) {
                  for (let i = dice.int(0, 2); i > 0; i--) {
                    yield* app.enqueue(Act, {
                      op: dice.int(0, 2),
                      pick: dice.int(0, 99),
                      x: dice.int(0, 999),
                    });
                  }
                  yield* app.tick(DELTA);
                } else if (roll <= 8) {
                  moments.push(yield* captured(app));
                } else if (moments.length > 0) {
                  // To a moment of this future or of one given up, to run the
                  // same ticks again or to play on.
                  yield* Timeline.rewind(app, dice.pick(moments), {
                    again: roll !== 10,
                  });
                }
                if (dice.int(0, 2) > 0) {
                  yield* app.frame(0);
                  const dots = (yield* app.read(Dots)).entities();
                  for (const dot of dots) {
                    if (shown.get(dot) !== world.get(dot, Dot)?.x) {
                      wrong.push(
                        `seed ${seed}, step ${step}, dot ${idOf(dot)}`
                      );
                    }
                  }
                }
              }
            })
          );
        }
        expect(wrong).toEqual([]);
      })
  );
});

describe("Session.syncTest", () => {
  const Mark = Component.define("vr/Mark", { n: Field.i32 });
  const Marks = Query.all(Mark);
  const Steady = System.tick("vr/Steady", function* () {
    (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: (yield* Time).tick }));
  });
  it.effect("names the system that keeps what it reads outside the world", () =>
    Effect.gen(function* () {
      let outside = 0;
      const Leaky = System.tick("vr/Leaky", function* () {
        outside++;
        (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: outside }));
      });
      const After = System.tick("vr/After", function* () {
        (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: 0 }));
      });
      yield* withMade(
        Session.syncTest(App.define({ systems: [Steady, Leaky, After] })),
        (test) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(test.tick(DELTA));
            expect(error).toBeInstanceOf(Session.RewindDiverged);
            expect(error).toMatchObject({ tick: 1, system: "vr/Leaky" });
            expect(String((error as Error).message)).toContain(
              'after system "vr/Leaky" ran'
            );
          })
      );
    })
  );

  it.effect("finds it before the first system, in a handler", () =>
    Effect.gen(function* () {
      let outside = 0;
      const Bump = Action.define("vr/Bump", Schema.Struct({}));
      const bump = Action.handler(Bump, function* () {
        outside++;
        (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: outside }));
      });
      yield* withMade(
        Session.syncTest(App.define({ systems: [Steady], handlers: [bump] })),
        (test) =>
          Effect.gen(function* () {
            yield* test.tick(DELTA);
            yield* test.app.enqueue(Bump, {});
            const error = yield* Effect.flip(test.tick(DELTA));
            expect(error).toMatchObject({ tick: 2, system: undefined });
          })
      );
    })
  );

  it.effect("names the system that fails on one run and not the other", () =>
    Effect.gen(function* () {
      let runs = 0;
      const Once = System.tick("vr/Once", function* () {
        runs++;
        if (runs === 2) {
          return yield* Effect.fail("the second time");
        }
      });
      yield* withMade(
        Session.syncTest(App.define({ systems: [Steady, Once] })),
        (test) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(test.tick(DELTA));
            expect(error).toMatchObject({ tick: 1, system: "vr/Once" });
          })
      );
    })
  );

  it.effect(
    "leaves a game that keeps everything in the world as it would be",
    () =>
      Effect.gen(function* () {
        const stepped = Effect.fnUntraced(function* (test: {
          readonly app: SteeredGame;
          readonly tick: (
            delta: number
          ) => Effect.Effect<void, Session.RewindDiverged | Save.Refused>;
          readonly checked: number;
        }) {
          const { app } = test;
          const world = yield* app.read(World);
          const dice = new EcsWorld({ seed: 11 }).random;
          const hashes: number[] = [];
          for (let i = 0; i < 40; i++) {
            if (dice.int(1, 3) === 1) {
              yield* app.enqueue(Drop, { by: "ada", value: dice.int(1, 9) });
            }
            yield* test.tick(DELTA);
            hashes.push(world.hash());
          }
          return {
            hashes,
            recording: Replay.encode(yield* Replay.record(app)),
            checked: test.checked,
          };
        });
        const played = Effect.fnUntraced(function* (checked: boolean) {
          return checked
            ? yield* withMade(
                Session.syncTest(CoinGame, { seed: 5, hashEvery: 1 }),
                stepped
              )
            : yield* withApp(game(5, 1), (app) =>
                stepped({
                  app,
                  tick: (delta) => app.tick(delta),
                  checked: 0,
                })
              );
        });
        const checked = yield* played(true);
        const plain = yield* played(false);
        expect(checked.checked).toBe(40);
        expect({ ...checked, checked: 0 }).toEqual(plain);
      })
  );

  it.effect("has the stages between ticks see each tick once", () =>
    Effect.gen(function* () {
      const Rang = Event.define("vr/Rang", Schema.Struct({ n: Schema.Int }));
      const New = Query.all(Mark).pipe(Query.added(Mark));
      const seen = { heard: [] as number[], added: [] as number[] };
      const keys: number[] = [];
      const Ring = System.tick("vr/Ring", function* () {
        (yield* Rang.emits).emit({ n: (yield* Time).tick });
      });
      const Draw = System.frame("vr/Draw", function* () {
        seen.heard.push(...(yield* Rang).read().map((rang) => rang.n));
        seen.added.push((yield* New).entities().length);
      });
      const Keys = System.input("vr/Keys", function* () {
        keys.push(...(yield* Rang).read().map((rang) => rang.n));
      });
      yield* withMade(
        Session.syncTest(App.define({ systems: [Steady, Ring, Draw, Keys] })),
        (test) =>
          Effect.gen(function* () {
            for (let i = 0; i < 3; i++) {
              yield* test.tick(DELTA);
              yield* test.frame();
            }
            expect(seen).toEqual({ heard: [1, 2, 3], added: [1, 1, 1] });
            // The input stage runs before each tick: it has heard the first two.
            expect(keys).toEqual([1, 2]);
            expect((yield* test.app.read(Marks)).count()).toBe(3);
          })
      );
    })
  );

  it.effect(
    "fails with the refusal of a game it can't capture, and takes the app over",
    () =>
      Effect.gen(function* () {
        const Held = Component.define("vr/Held", {
          thing: Field.json<JsonValue>(),
        });
        const Hold = System.tick("vr/Hold", function* () {
          (yield* Commands.spawns(Held)).spawn(
            // @ts-expect-error A function is not JSON.
            Held.of({ thing: () => 1 })
          );
        });
        yield* withMade(
          Session.syncTest(App.define({ systems: [Hold] })),
          (test) =>
            Effect.gen(function* () {
              expect(
                yield* thrown<unknown, unknown, never>(
                  // @ts-expect-error the app of a sync test has no tick: the test steps it
                  test.app.tick(DELTA)
                )
              ).toThrow(/taken over/u);
              yield* test.tick(DELTA);
              const exit = yield* Effect.exit(test.tick(DELTA));
              expect(Exit.isFailure(exit)).toBe(true);
              expect(String(Exit.isFailure(exit) ? exit.cause : "")).toMatch(
                /vr\/Held/u
              );
              expect(test.app.time.tick).toBe(1);
            })
        );
      })
  );
});

// --- a puzzle whose turns are kept, played under Driver.run -------------------------

const Cell = Singleton.define(
  "vr/Cell",
  { x: Field.i32, y: Field.i32 },
  { x: 0, y: 0 }
);
const Step = Action.define(
  "vr/Step",
  Schema.Struct({ dx: Schema.Int, dy: Schema.Int })
);
const Where = View.define("vr/Where", { x: 0, y: 0 });
/** The keys of the puzzle: the arrows move, Z goes back a turn and Y forward. */
const Keys = System.input("vr/Keys", function* () {
  const { pressed } = yield* Input.Devices;
  const { enqueue } = yield* Action.Actions;
  for (const code of pressed) {
    if (code === "ArrowRight") {
      enqueue(Step, { dx: 1, dy: 0 });
    } else if (code === "ArrowDown") {
      enqueue(Step, { dx: 0, dy: 1 });
    } else if (code === "KeyZ") {
      enqueue(Timeline.Undo, undefined);
    } else if (code === "KeyY") {
      enqueue(Timeline.Redo, undefined);
    }
  }
});
const Puzzle = App.define({
  plugins: [
    Plugin.make("vr/Puzzle", {
      plugins: [Timeline.plugin, View.plugin],
      systems: [
        Keys,
        View.publish(Where, function* () {
          const { x, y } = yield* Cell;
          return { x, y };
        }),
      ],
      handlers: [
        Action.handler(Step, function* ({ dx, dy }) {
          const cell = yield* Cell.writes;
          cell.x += dx;
          cell.y += dy;
        }),
      ],
    }),
  ],
});

describe("the turns of a game kept by Timeline.keep", () => {
  it.effect(
    "go back three turns and forward one under Driver.run, from the keys and the UI, to where the game was",
    () =>
      Effect.gen(function* () {
        const display = Driver.makeManualDisplay();
        const keys = Input.makeManualSource();
        let ui: View.Bridge<typeof Timeline.Undo> | undefined;
        let made: App.Any | undefined;
        yield* Effect.forkScoped(
          Driver.run(Puzzle, {
            hz: 60,
            ticks: "whenNeeded",
            ready: (app) =>
              Effect.andThen(
                Effect.sync(() => {
                  made = app;
                }),
                Timeline.keep(app)
              ),
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Driver.layer(display),
                Input.layer(keys),
                View.mount(Puzzle, (bridge) => {
                  ui = bridge;
                })
              )
            )
          ),
          { startImmediately: true }
        );
        let now = 0;
        /** Frames until the game is at rest. */
        const rest = () => {
          for (let i = 0; i < 10; i++) {
            display.frame(now);
            now += 1000 / 60;
          }
        };
        const press = (code: string) => {
          keys.press(code);
          rest();
          keys.release(code);
          rest();
        };
        const app = made!;
        const world = yield* app.read(World);
        ui!.subscribe(Where, () => {});
        rest();
        const hashes = [world.hash()];
        for (const code of [
          "ArrowRight",
          "ArrowDown",
          "ArrowRight",
          "ArrowDown",
        ]) {
          press(code);
          hashes.push(world.hash());
        }
        expect(yield* app.read(Cell)).toMatchObject({ x: 2, y: 2 });
        expect(new Set(hashes).size).toBe(5);

        // Two turns back from the keys, and one from the UI.
        press("KeyZ");
        expect(world.hash()).toBe(hashes[3]);
        press("KeyZ");
        ui!.send(Timeline.Undo);
        rest();
        expect(world.hash()).toBe(hashes[1]);
        expect(ui!.get(Where)).toEqual({ x: 1, y: 0 });
        // And one forward again.
        press("KeyY");
        expect(world.hash()).toBe(hashes[2]);
        expect(ui!.get(Where)).toEqual({ x: 1, y: 1 });
        // The log went with it: what it records is the two turns left.
        const replayed = yield* Replay.verify(
          yield* Replay.record(app),
          Puzzle
        );
        expect((yield* replayed.read(World)).hash()).toBe(hashes[2]);
        expect(moves(app.actionLog).map((entry) => entry.name)).toEqual([
          "vr/Step",
          "vr/Step",
        ]);

        // A turn played gives up what was ahead: there is nothing to redo.
        press("ArrowRight");
        press("KeyY");
        // The tick that applied it ran, and went nowhere.
        expect(yield* app.read(Cell)).toMatchObject({ x: 2, y: 1 });
        expect(yield* Timeline.redo(app)).toBe(false);
        expect(yield* Timeline.undo(app)).toBe(true);
        expect(world.hash()).toBe(hashes[2]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "go back a turn of moves dispatched or enqueued from outside, and are given up by a load",
    () =>
      withApp(App.make(Puzzle), (app, world) =>
        Effect.gen(function* () {
          yield* Timeline.keep(app);
          const start = world.hash();
          yield* app.dispatch(Step, { dx: 1, dy: 0 });
          const one = world.hash();
          yield* app.enqueue(Step, { dx: 0, dy: 1 });
          yield* app.tick(1 / 60);
          // A tick with nothing from outside is no turn.
          yield* app.tick(1 / 60);
          expect(yield* Timeline.undo(app)).toBe(true);
          expect(world.hash()).toBe(one);
          expect(yield* Timeline.undo(app)).toBe(true);
          expect(world.hash()).toBe(start);
          expect(yield* Timeline.undo(app)).toBe(false);
          expect(yield* Timeline.redo(app)).toBe(true);
          expect(world.hash()).toBe(one);

          const save = unwrap(yield* Effect.exit(Save.make(app)));
          yield* app.dispatch(Step, { dx: 1, dy: 0 });
          yield* Save.load(app, save);
          expect(yield* Timeline.undo(app)).toBe(false);
          expect(yield* Timeline.redo(app)).toBe(false);
        }).pipe(Effect.scoped)
      )
  );

  it.effect(
    "are kept once, of an app that ticks by itself, between ticks",
    () =>
      withApp(App.make(Puzzle), (app) =>
        Effect.gen(function* () {
          expect(yield* thrown(Timeline.undo(app))).toThrow(
            "Timeline.undo() was called on an app whose turns nothing keeps. Keep them with Timeline.keep(app), as Driver.run's ready can."
          );
          yield* Timeline.keep(app);
          expect(yield* thrown(Timeline.keep(app))).toThrow(
            "Timeline.keep() was called on an app whose turns are kept already. Keep them once."
          );
          // As a session steps it, with no tick.
          const steered: Omit<typeof app, "tick"> = app;
          // @ts-expect-error an app a session steps has no tick of its own
          expect(Timeline.keep(steered)).toBeDefined();
        }).pipe(Effect.scoped)
      )
  );
});
