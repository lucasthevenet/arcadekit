import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  Event,
  Field,
  Journal,
  Query,
  Rollback,
  Save,
  System,
  Ticks,
  Time,
  Timeline,
  readSnapshot,
} from "../src/index";
import type { Entity } from "../src/index";
import {
  Coin,
  DELTA,
  Drop,
  Take,
  Whisper,
  game,
  moves,
  steered,
  withApp,
} from "./peers";
import type { Game } from "./peers";

/** A stretch of a game, played by a seed: the same moves for the same seed. */
const stretch = (app: Game, seed: number, ticks: number): number[] => {
  const dice = new EcsWorld({ seed }).random;
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const roll = dice.int(1, 5);
    if (roll <= 2) {
      app.enqueue(Drop, { by: "ada", value: dice.int(1, 9) });
    } else if (roll === 3) {
      const coins = app.world.view(Query.all(Coin)).entities();
      if (coins.length > 0) {
        app.enqueue(Take, { by: "grace", coin: dice.pick(coins) });
        // And once more, which is refused: the coin is gone by then.
        app.enqueue(Take, { by: "ada", coin: coins[0]! });
      }
    }
    app.tick(DELTA);
    hashes.push(app.world.hash());
  }
  return hashes;
};

const captured = (app: App.Any): Timeline.Moment => {
  const moment = Timeline.capture(app);
  if (Exit.isFailure(moment)) {
    throw new Error("the game could not be captured");
  }
  return moment.value;
};

describe("a game that is put back to a moment", () => {
  it("is the game it was, and goes on as that game did", () => {
    for (const seed of [1, 2, 3]) {
      withApp(game(), (app) => {
        stretch(app, seed, 40);
        // Something is waiting at this moment: an action for the next tick.
        app.enqueue(Drop, { by: "ada", value: 4 });
        const moment = captured(app);
        expect(moment.tick).toBe(40);
        const then = {
          save: app.save(),
          log: structuredClone(app.actionLog),
          time: { ...app.time },
          settled: app.settled,
        };
        const first = stretch(app, seed + 10, 30);
        const firstLog = structuredClone(app.actionLog);
        // Another way from the same moment, and back again.
        Timeline.rewind(app, moment);
        stretch(app, seed + 20, 45);
        expect(app.world.hash()).not.toBe(first.at(-1));
        Timeline.rewind(app, moment);
        expect({
          save: app.save(),
          log: app.actionLog,
          time: { ...app.time },
          settled: app.settled,
        }).toEqual(then);
        // The same moves from there give the same game, tick for tick,
        // and the same log, the refusals in it among them.
        expect(stretch(app, seed + 10, 30)).toEqual(first);
        expect(app.actionLog).toEqual(firstLog);
        expect(
          moves(app.actionLog).some((entry) => entry.refused !== undefined)
        ).toBe(true);
      });
    }
  });

  it("is the same game as one that never went anywhere else", () => {
    const straight = withApp(game(), (app) => [
      ...stretch(app, 5, 25),
      ...stretch(app, 6, 25),
    ]);
    const wandering = withApp(game(), (app) => {
      const before = stretch(app, 5, 25);
      const moment = captured(app);
      stretch(app, 99, 17);
      Timeline.rewind(app, moment);
      return [...before, ...stretch(app, 6, 25)];
    });
    expect(wandering).toEqual(straight);
  });

  it("can be a moment before the game had started", () => {
    withApp(game(), (app) => {
      const moment = captured(app);
      expect(app.actionLog).toEqual([]);
      const first = stretch(app, 8, 5);
      const log = structuredClone(app.actionLog);
      // The log begins with the hash of the state the game starts from.
      expect(log[0]).toEqual({ tick: 0, hash: expect.any(Number) });
      Timeline.rewind(app, moment);
      expect(app.actionLog).toEqual([]);
      expect(stretch(app, 8, 5)).toEqual(first);
      // It starts again, and says so again.
      expect(app.actionLog).toEqual(log);
    });
  });

  it("is as settled as it was", () => {
    // A clock that runs for three ticks, and asks for each of them.
    const Clock = System.make("rw/Clock", function* () {
      if ((yield* Time).tick < 3) {
        (yield* Ticks).more();
      }
    });
    withApp(App.make(App.define({ systems: [Clock] })), (app) => {
      app.tick(DELTA);
      expect(app.settled).toBe(false);
      const moment = captured(app);
      app.tick(DELTA);
      app.tick(DELTA);
      expect(app.settled).toBe(true);
      Timeline.rewind(app, moment);
      // The clock had asked for the next tick, and is owed it again.
      expect(app.settled).toBe(false);
    });
  });

  it("keeps an action that is waiting for the next tick", () => {
    withApp(game(), (app) => {
      app.dispatch(Drop, { by: "ada", value: 1 });
      app.enqueue(Whisper, { to: "grace" });
      const moment = captured(app);
      app.tick(DELTA);
      expect(moves(app.actionLog).map((entry) => entry.name)).toEqual([
        "ls/Drop",
        "ls/Whisper",
      ]);
      Timeline.rewind(app, moment);
      // It is waiting again, to be applied by the tick that follows.
      expect(app.settled).toBe(false);
      app.tick(DELTA);
      expect(app.time.tick).toBe(1);
    });
  });

  it("takes back what became of an action that was waiting", () => {
    withApp(game(), (app) => {
      app.tick(DELTA);
      // No such coin: the tick that applies it will refuse it.
      app.enqueue(Take, { by: "ada", coin: 77 as Entity });
      const moment = captured(app);
      const entry = () => moves(app.actionLog).at(-1)!;
      expect(entry().refused).toBeUndefined();
      const logged = app.actionLog.length;
      app.tick(DELTA);
      expect(entry().refused).toBeDefined();
      expect(app.actionLog.length).toBeGreaterThan(logged);
      Timeline.rewind(app, moment);
      // Not yet applied, so not yet refused, and the log is as long as it was.
      expect(entry().refused).toBeUndefined();
      expect(app.actionLog.length).toBe(logged);
      app.tick(DELTA);
      expect(entry().refused).toBeDefined();
    });
  });

  it("puts back the events that were waiting, and everyone's place in them", () => {
    const Rang = Event.define("rw/Rang", Schema.Struct({ n: Schema.Int }));
    const heard: number[][] = [];
    // Listed before the system that emits: it hears each event a tick late.
    const Listen = System.make("rw/Listen", function* () {
      heard.push((yield* Rang).read().map((rang) => rang.n));
    });
    const Ring = System.make("rw/Ring", function* () {
      (yield* Rang).emit({ n: (yield* Time).tick });
    });
    withApp(App.make(App.define({ systems: [Listen, Ring] })), (app) => {
      app.tick(DELTA);
      app.tick(DELTA);
      const moment = captured(app);
      app.tick(DELTA);
      app.tick(DELTA);
      expect(heard).toEqual([[], [1], [2], [3]]);
      Timeline.rewind(app, moment);
      heard.length = 0;
      app.tick(DELTA);
      app.tick(DELTA);
      // Each once, from where it was: 2 was waiting, and 3 is rung again.
      expect(heard).toEqual([[2], [3]]);
    });
  });

  it("has what draws start over, and the simulation go on from where it was", () => {
    const Dot = Component.define("rw/Dot", { x: Field.f32 });
    const NewDots = Query.all(Dot).pipe(Query.added(Dot));
    const seen = { tick: [] as number[], frame: [] as number[] };
    const Count = System.make("rw/Count", function* () {
      seen.tick.push((yield* NewDots).entities().length);
    });
    const Draw = System.make("rw/Draw", function* () {
      seen.frame.push((yield* NewDots).entities().length);
    }).pipe(System.inStage("frame"));
    const Grow = System.make("rw/Grow", function* () {
      (yield* Commands).spawn(Dot.of({ x: 1 }));
    });
    withApp(App.make(App.define({ systems: [Count, Draw, Grow] })), (app) => {
      for (let i = 0; i < 3; i++) {
        app.tick(DELTA);
        app.frame(0);
      }
      const moment = captured(app);
      app.tick(DELTA);
      app.frame(0);
      expect(seen).toEqual({ tick: [0, 1, 1, 1], frame: [1, 1, 1, 1] });
      Timeline.rewind(app, moment);
      seen.tick.length = 0;
      seen.frame.length = 0;
      app.tick(DELTA);
      app.frame(0);
      // The system of the tick sees the one dot it had yet to see. What
      // draws sees every dot again: all four are new to it.
      expect(seen).toEqual({ tick: [1], frame: [4] });
    });
  });

  it("runs what was waiting to resume in the game it gives up", () => {
    withApp(game(), (app) => {
      app.tick(DELTA);
      const moment = captured(app);
      const count = app.world.entityCount;
      // A fiber's work, queued for the next flush: it is of the game as it
      // is now, and not of the one the rewind brings back.
      app.dispatcher.scheduleTask(() => {
        app.world.spawn(Coin.of({ value: 7, x: 0 }));
      }, 0);
      Timeline.rewind(app, moment);
      expect(app.dispatcher.pending).toBe(0);
      app.tick(DELTA);
      expect(app.world.entityCount).toBe(count);
    });
  });

  it("throws away commands that were queued and never applied", () => {
    withApp(game(), (app) => {
      app.dispatch(Drop, { by: "ada", value: 1 });
      const moment = captured(app);
      const count = app.world.entityCount;
      const queued = app.commands.spawn(Coin.of({ value: 2, x: 0 }));
      Timeline.rewind(app, moment);
      expect(app.commands.size).toBe(0);
      expect(app.world.entityCount).toBe(count);
      expect(app.world.isAlive(queued)).toBe(false);
      app.tick(DELTA);
      expect(app.world.entityCount).toBe(count);
    });
  });

  it("is refused with a moment of another app, and in the middle of a tick", () => {
    const moment = withApp(game(), (app) => captured(app));
    withApp(game(), (app) => {
      expect(() => Timeline.rewind(app, moment)).toThrow(
        /a moment that this app did not capture.*save it and load the save/u
      );
      expect(() => Timeline.rewind(app, { tick: 0 })).toThrow(
        /did not capture/u
      );
    });
    let inside: App.Any | undefined;
    const Meddle = System.make("rw/Meddle", function* () {
      yield* Effect.sync(() => {
        if (inside !== undefined && inside.time.tick === 2) {
          Timeline.capture(inside);
        }
      });
    });
    withApp(App.make(App.define({ systems: [Meddle] })), (app) => {
      inside = app;
      app.tick(DELTA);
      expect(() => app.tick(DELTA)).toThrow(
        /Timeline\.capture\(\) was called during a tick/u
      );
    });
    const taken: Timeline.Moment[] = [];
    const Undo = System.make("rw/Undo", function* () {
      yield* Effect.sync(() => {
        if (inside !== undefined && taken.length > 0) {
          Timeline.rewind(inside, taken[0]!);
        }
      });
    });
    withApp(App.make(App.define({ systems: [Undo] })), (app) => {
      inside = app;
      app.tick(DELTA);
      taken.push(captured(app));
      expect(() => app.tick(DELTA)).toThrow(
        /Timeline\.rewind\(\) was called during a tick/u
      );
    });
  });

  it("cannot be captured with commands queued, or with a field that cannot be saved", () => {
    const Holder = Component.define("rw/Holder", {
      thing: Field.json<unknown>(),
    });
    withApp(App.make(App.define({})), (app) => {
      app.commands.spawn(Holder.of({ thing: 1 }));
      expect(Timeline.capture(app)).toEqual(
        Exit.fail(
          new Save.SaveRefused({
            message:
              "1 commands are queued and not applied. They are applied at the end of a tick: capture after one.",
          })
        )
      );
      app.commands.apply();
      expect(Exit.isSuccess(Timeline.capture(app))).toBe(true);
      app.world.spawn(Holder.of({ thing: () => 1 }));
      const refused = Timeline.capture(app);
      expect(Exit.isFailure(refused)).toBe(true);
      expect(String(Exit.isFailure(refused) ? refused.cause : "")).toMatch(
        /rw\/Holder/u
      );
    });
  });

  it("is not for an action's handler to call", () => {
    let inside: App.Any | undefined;
    const Back = Action.define("rw/Back", Schema.Struct({}));
    const taken: Timeline.Moment[] = [];
    const back = Action.handler(Back, function* () {
      yield* Effect.sync(() => Timeline.rewind(inside!, taken[0]!));
    });
    withApp(App.make(App.define({ handlers: [back] })), (app) => {
      inside = app;
      taken.push(captured(app));
      const exit = app.dispatch(Back, {});
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toMatch(
        /Timeline\.rewind\(\) was called during an action's handler/u
      );
    });
  });
});

describe("the input stage across a rewind and a save", () => {
  // The stage issues one shot each time it runs, and the tick applies it.
  const Fire = Action.define("rw/Fire", Schema.Struct({}));
  const pressing = () => {
    const fired: number[] = [];
    const fire = Action.handler(Fire, function* () {
      yield* Effect.sync(() => fired.push(1));
    });
    const Press = System.make("rw/Press", function* () {
      (yield* Action.Actions).enqueue(Fire, {});
    }).pipe(System.inStage("input"));
    return {
      fired,
      game: App.define({ systems: [Press], handlers: [fire] }),
    };
  };

  it("runs again for a tick it ran for after the moment", () => {
    const { fired, game: Pressed } = pressing();
    withApp(App.make(Pressed), (app) => {
      app.tick(DELTA);
      fired.length = 0;
      const moment = captured(app);
      // What the stage issues now is taken back with the rest.
      app.input();
      Timeline.rewind(app, moment);
      app.tick(DELTA);
      expect(fired).toEqual([1]);
    });
  });

  it("does not run again for a tick it ran for before the moment", () => {
    const { fired, game: Pressed } = pressing();
    withApp(App.make(Pressed), (app) => {
      app.tick(DELTA);
      fired.length = 0;
      // The moment holds what the stage issued, and that it ran.
      app.input();
      const moment = captured(app);
      Timeline.rewind(app, moment);
      app.tick(DELTA);
      expect(fired).toEqual([1]);
    });
  });

  it("does not run again in a game loaded from a save taken after it ran", () => {
    const { fired, game: Pressed } = pressing();
    const saved = withApp(App.make(Pressed), (app) => {
      app.tick(DELTA);
      app.input();
      const save = app.save();
      if (Exit.isFailure(save)) {
        throw new Error("the game could not be saved");
      }
      return save.value;
    });
    fired.length = 0;
    withApp(Effect.orDie(App.make(Pressed, { save: saved })), (app) => {
      app.tick(DELTA);
      expect(fired).toEqual([1]);
    });
  });

  it("leaves the hash as it was: that the devices were heard is no part of the game", () => {
    const Idle = System.make("rw/Idle", function* () {}).pipe(
      System.inStage("input")
    );
    withApp(App.make(App.define({ systems: [Idle] })), (app) => {
      const before = app.world.hash();
      app.input();
      expect(app.world.hash()).toBe(before);
      // A save holds that it ran, all the same.
      const save = app.save();
      if (Exit.isFailure(save)) {
        throw new Error("the game could not be saved");
      }
      expect(readSnapshot(save.value.world).stores).toEqual([
        { name: Action.INTAKE, data: { queued: [], heard: true } },
      ]);
    });
  });
});

describe("what the stages between ticks hear across a rewind", () => {
  const Rang = Event.define("rw/Rang", Schema.Struct({ n: Schema.Int }));
  const Bell = Component.define("rw/Bell", { extra: Field.i32 });
  const Bells = Query.all(Bell);
  const Louder = Action.define("rw/Louder", Schema.Struct({ by: Schema.Int }));
  const louder = Action.handler(Louder, function* ({ by }) {
    (yield* Commands).spawn(Bell.of({ extra: by }));
  });
  // A number that says nothing of the tick it is chimed on.
  const Chimed = Event.define("rw/Chimed", Schema.Struct({ n: Schema.Int }));
  const Chime = Action.define("rw/Chime", Schema.Struct({ n: Schema.Int }));
  const chime = Action.handler(Chime, function* ({ n }) {
    (yield* Chimed).emit({ n });
  });
  // Each tick rings its number twice, and once more for each bell.
  const Ring = System.make("rw/Ring", function* () {
    const rang = yield* Rang;
    const { tick } = yield* Time;
    rang.emit({ n: tick });
    rang.emit({ n: tick });
    (yield* Bells).each((bell) => rang.emit({ n: tick * 100 + bell.extra }));
  });
  /** A game whose stages between ticks listen to one of the two events. */
  const listening = (to: typeof Rang = Rang) => {
    const heard = { frame: [] as number[], input: [] as number[] };
    const Draw = System.make("rw/Draw", function* () {
      heard.frame.push(...(yield* to).read().map((rang) => rang.n));
    }).pipe(System.inStage("frame"));
    const Keys = System.make("rw/Keys", function* () {
      heard.input.push(...(yield* to).read().map((rang) => rang.n));
    }).pipe(System.inStage("input"));
    return {
      heard,
      make: App.make(
        App.define({ systems: [Ring, Draw, Keys], handlers: [louder, chime] })
      ),
    };
  };

  describe("to run the same ticks again, as a session does", () => {
    it("hear each event once, and what the ticks run again do otherwise", () => {
      const { heard, make } = listening();
      withApp(make, (app) => {
        const session = steered(app);
        session.tick(DELTA);
        app.frame(0);
        const back = session.capture();
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([1, 1, 2, 2, 3, 3]);
        heard.frame.length = 0;
        heard.input.length = 0;
        // Run again with a bell that rings on tick 3: only that is new.
        session.rewind(back);
        session.tick(DELTA);
        app.enqueue(Louder, { by: 7 });
        session.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([307]);
        // Past where the game had got to, every event is new again. The input
        // stage runs before each tick, so it had not heard the third tick's
        // events before the rewind, and hears them now, before the fourth.
        session.tick(DELTA);
        app.frame(0);
        expect(heard).toEqual({ frame: [307, 4, 4, 407], input: [3, 3, 307] });
      });
    });

    it("hear once what they heard of ticks whose events were dropped since", () => {
      const { heard, make } = listening();
      withApp(make, (app) => {
        const session = steered(app);
        session.tick(DELTA);
        app.frame(0);
        const back = session.capture();
        // Every stage hears each tick, so each tick drops the one before.
        for (let i = 0; i < 4; i++) {
          session.tick(DELTA);
          app.frame(0);
        }
        expect(app.events.pending(Rang)).toBe(2);
        heard.frame.length = 0;
        session.rewind(back);
        for (let i = 0; i < 4; i++) {
          session.tick(DELTA);
          app.frame(0);
        }
        expect(heard.frame).toEqual([]);
      });
    });

    it("hear again none of what they heard before a moment was taken", () => {
      const { heard, make } = listening();
      withApp(make, (app) => {
        const session = steered(app);
        // Taken before anything between ticks has run.
        const back = session.capture();
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame(0);
        const first = [...heard.frame];
        session.rewind(back);
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame(0);
        expect(first).toEqual([1, 1, 2, 2]);
        expect(heard.frame).toEqual([1, 1, 2, 2]);
        // The input stage runs before each tick, and heard what came before
        // the second, once.
        expect(heard.input).toEqual([1, 1]);
      });
    });

    it("hear the events of ticks they never heard, after a rewind further back", () => {
      const { heard, make } = listening();
      withApp(make, (app) => {
        const session = steered(app);
        session.tick(DELTA);
        app.frame(0);
        const back = session.capture();
        // Ticks run with no frame: the frame stage heard none of them.
        session.tick(DELTA);
        session.tick(DELTA);
        session.rewind(back);
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([1, 1, 2, 2, 3, 3]);
      });
    });

    it("hear an event a later tick now emits, though an earlier one emitted the same", () => {
      const { heard, make } = listening(Chimed);
      withApp(make, (app) => {
        const session = steered(app);
        session.tick(DELTA);
        const back = session.capture();
        // As predicted: the chime on the second tick.
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([5]);
        // As it was: the second tick has none, and the third rings the same.
        session.rewind(back);
        session.tick(DELTA);
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([5, 5]);
      });
    });

    it("hear an event an earlier tick now emits, though a later one emitted the same", () => {
      const { heard, make } = listening(Chimed);
      withApp(make, (app) => {
        const session = steered(app);
        session.tick(DELTA);
        const back = session.capture();
        // As predicted: the chime on the third tick.
        session.tick(DELTA);
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([5]);
        // As it was: on the second, which is not the tick it was heard of.
        session.rewind(back);
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([5, 5]);
      });
    });

    it("leave the game as one that never went back", () => {
      const one = listening();
      const other = listening();
      withApp(one.make, (back) =>
        withApp(other.make, (straight) => {
          const session = steered(back);
          session.tick(DELTA);
          back.frame(0);
          const at = session.capture();
          session.tick(DELTA);
          back.frame(0);
          session.rewind(at);
          session.tick(DELTA);
          back.frame(0);
          for (let i = 0; i < 2; i++) {
            straight.tick(DELTA);
            straight.frame(0);
          }
          expect(back.world.hash()).toBe(straight.world.hash());
          expect(back.save()).toEqual(straight.save());
          expect(one.heard.frame).toEqual(other.heard.frame);
        })
      );
    });
  });

  describe("to play on from there, as an undo does", () => {
    it("hear every event that follows, one they heard before the rewind among them", () => {
      const { heard, make } = listening(Chimed);
      withApp(make, (app) => {
        app.tick(DELTA);
        const back = captured(app);
        app.enqueue(Chime, { n: 5 });
        app.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([5]);
        // The move is undone, and made again: it is a new one.
        Timeline.rewind(app, back);
        app.enqueue(Chime, { n: 5 });
        app.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([5, 5]);
        // Between two ticks as well.
        Timeline.rewind(app, back);
        app.dispatch(Chime, { n: 5 });
        app.frame(0);
        expect(heard.frame).toEqual([5, 5, 5]);
      });
    });

    it("hear nothing of the future that was given up before they had heard it", () => {
      const { heard, make } = listening();
      withApp(make, (app) => {
        app.tick(DELTA);
        app.frame(0);
        const back = captured(app);
        // Run ahead with no frame, as a search does, and come back.
        app.tick(DELTA);
        app.tick(DELTA);
        Timeline.rewind(app, back);
        app.frame(0);
        expect(heard.frame).toEqual([1, 1]);
        app.tick(DELTA);
        app.frame(0);
        expect(heard.frame).toEqual([1, 1, 2, 2]);
      });
    });
  });
});

describe("Rollback.syncTest", () => {
  const Mark = Component.define("vr/Mark", { n: Field.i32 });
  const Marks = Query.all(Mark);
  const Steady = System.make("vr/Steady", function* () {
    (yield* Commands).spawn(Mark.of({ n: (yield* Time).tick }));
  });
  const failure = (run: () => void): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("it did not throw");
  };

  it("names the system that keeps what it reads outside the world", () => {
    let outside = 0;
    const Leaky = System.make("vr/Leaky", function* () {
      outside++;
      (yield* Commands).spawn(Mark.of({ n: outside }));
    });
    const After = System.make("vr/After", function* () {
      (yield* Commands).spawn(Mark.of({ n: 0 }));
    });
    withApp(
      App.make(App.define({ systems: [Steady, Leaky, After] })),
      (app) => {
        const test = Rollback.syncTest(app);
        const error = failure(() => test.tick(DELTA));
        expect(error).toBeInstanceOf(Rollback.RewindDiverged);
        expect(error).toMatchObject({ tick: 1, system: "vr/Leaky" });
        expect(String((error as Error).message)).toContain(
          'after system "vr/Leaky" ran'
        );
      }
    );
  });

  it("finds it before the first system, in a handler", () => {
    let outside = 0;
    const Bump = Action.define("vr/Bump", Schema.Struct({}));
    const bump = Action.handler(Bump, function* () {
      outside++;
      (yield* Commands).spawn(Mark.of({ n: outside }));
    });
    withApp(
      App.make(App.define({ systems: [Steady], handlers: [bump] })),
      (app) => {
        const test = Rollback.syncTest(app);
        test.tick(DELTA);
        app.enqueue(Bump, {});
        const error = failure(() => test.tick(DELTA));
        expect(error).toMatchObject({ tick: 2, system: undefined });
      }
    );
  });

  it("names the system that fails on one run and not the other", () => {
    let runs = 0;
    const Once = System.make("vr/Once", function* () {
      runs++;
      if (runs === 2) {
        return yield* Effect.fail("the second time");
      }
    });
    withApp(App.make(App.define({ systems: [Steady, Once] })), (app) => {
      const error = failure(() => Rollback.syncTest(app).tick(DELTA));
      expect(error).toMatchObject({ tick: 1, system: "vr/Once" });
    });
  });

  it("leaves a game that keeps everything in the world as it would be", () => {
    const played = (checked: boolean) =>
      withApp(game(5, 1), (app) => {
        const test = checked
          ? Rollback.syncTest(app)
          : { tick: (delta: number) => app.tick(delta), checked: 0 };
        const dice = new EcsWorld({ seed: 11 }).random;
        const hashes: number[] = [];
        for (let i = 0; i < 40; i++) {
          if (dice.int(1, 3) === 1) {
            app.enqueue(Drop, { by: "ada", value: dice.int(1, 9) });
          }
          test.tick(DELTA);
          hashes.push(app.world.hash());
        }
        return {
          hashes,
          recording: Journal.encode(app.record()),
          checked: test.checked,
        };
      });
    const checked = played(true);
    const plain = played(false);
    expect(checked.checked).toBe(40);
    expect({ ...checked, checked: 0 }).toEqual(plain);
  });

  it("has the stages between ticks see each tick once", () => {
    const Rang = Event.define("vr/Rang", Schema.Struct({ n: Schema.Int }));
    const New = Query.all(Mark).pipe(Query.added(Mark));
    const seen = { heard: [] as number[], added: [] as number[] };
    const keys: number[] = [];
    const Ring = System.make("vr/Ring", function* () {
      (yield* Rang).emit({ n: (yield* Time).tick });
    });
    const Draw = System.make("vr/Draw", function* () {
      seen.heard.push(...(yield* Rang).read().map((rang) => rang.n));
      seen.added.push((yield* New).entities().length);
    }).pipe(System.inStage("frame"));
    const Keys = System.make("vr/Keys", function* () {
      keys.push(...(yield* Rang).read().map((rang) => rang.n));
    }).pipe(System.inStage("input"));
    withApp(
      App.make(App.define({ systems: [Steady, Ring, Draw, Keys] })),
      (app) => {
        const test = Rollback.syncTest(app);
        for (let i = 0; i < 3; i++) {
          test.tick(DELTA);
          test.frame(0);
        }
        expect(seen).toEqual({ heard: [1, 2, 3], added: [1, 1, 1] });
        // The input stage runs before each tick: it has heard the first two.
        expect(keys).toEqual([1, 2]);
        expect(app.world.view(Marks).entities().length).toBe(3);
      }
    );
  });

  it("fails with the refusal of a game it can't capture, and takes the app over", () => {
    const Held = Component.define("vr/Held", {
      thing: Field.json<unknown>(),
    });
    const Hold = System.make("vr/Hold", function* () {
      (yield* Commands).spawn(Held.of({ thing: () => 1 }));
    });
    withApp(App.make(App.define({ systems: [Hold] })), (app) => {
      const test = Rollback.syncTest(app);
      expect(() => app.tick(DELTA)).toThrow(/taken over/u);
      test.tick(DELTA);
      const exit = test.tickExit(DELTA);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toMatch(
        /vr\/Held/u
      );
      expect(app.time.tick).toBe(1);
    });
  });
});
