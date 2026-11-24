import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { Effect, Exit, Schema } from "effect";
import { assert, describe, expect, it } from "vitest";

import { entityOf, idOf } from "../src/ecs/component";
import type { ReadingEvents } from "../src/Event";
import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  Event,
  Events,
  Field,
  Journal,
  Query,
  Singleton,
  System,
  Time,
  Timeline,
  World,
  readSnapshot,
} from "../src/index";
import type { Entity, JsonValue } from "../src/index";
import * as Build from "../src/internal/build";
import { partsOf } from "../src/internal/parts";
import { Session } from "../src/net/index";
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
} from "./peers";
import type { Game, SteeredGame } from "./peers";

/** Runs `use` with what `make` makes: a build, a sync test. */
const withMade = <T, A>(
  make: Effect.Effect<T, never>,
  use: (made: T) => A
): A => Effect.runSync(Effect.map(make, use));

/** A stretch of a game, played by a seed: the same moves for the same seed. */
const stretch = (app: Game, seed: number, ticks: number): number[] => {
  const dice = new EcsWorld({ seed }).random;
  const world = Effect.runSync(app.read(World));
  const lying = Effect.runSync(app.read(Lying));
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const roll = dice.int(1, 5);
    if (roll <= 2) {
      app.enqueue(Drop, { by: "ada", value: dice.int(1, 9) });
    } else if (roll === 3) {
      const [oldest, ...rest] = lying.entities();
      if (oldest !== undefined) {
        app.enqueue(Take, { by: "grace", coin: dice.pick([oldest, ...rest]) });
        // And once more, which is refused: the coin is gone by then.
        app.enqueue(Take, { by: "ada", coin: oldest });
      }
    }
    app.tick(DELTA);
    hashes.push(world.hash());
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
      withApp(game(), (app, world) => {
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
        expect(world.hash()).not.toBe(first.at(-1));
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
    // A clock that runs down for two ticks.
    const Left = Singleton.define("rw/Left", { ticks: Field.u8 }, { ticks: 2 });
    const Clock = System.tick("rw/Clock", function* () {
      const left = yield* Left.writes;
      if (left.ticks > 0) {
        left.ticks -= 1;
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
      // The clock had changed in the tick before, and is owed the next again.
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
      app.enqueue(Take, { by: "ada", coin: entityOf(77) });
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
    const Listen = System.tick("rw/Listen", function* () {
      heard.push((yield* Rang).read().map((rang) => rang.n));
    });
    const Ring = System.tick("rw/Ring", function* () {
      (yield* Rang.emits).emit({ n: (yield* Time).tick });
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
    withApp(App.make(game), (app) => {
      for (let i = 0; i < 3; i++) {
        app.tick(DELTA);
        app.frame();
      }
      const moment = captured(app);
      app.tick(DELTA);
      app.frame();
      expect(seen).toEqual({ tick: [0, 1, 1, 1], frame: [1, 1, 1, 1] });
      Timeline.rewind(app, moment);
      seen.tick.length = 0;
      seen.frame.length = 0;
      app.tick(DELTA);
      app.frame();
      // The system of the tick sees the one dot it had yet to see. What
      // draws sees every dot again: all four are new to it.
      expect(seen).toEqual({ tick: [1], frame: [4] });
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
    const Meddle = System.tick("rw/Meddle", function* () {
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
    const Undo = System.tick("rw/Undo", function* () {
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

  it("cannot be captured with a field that cannot be saved", () => {
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
    withApp(App.make(App.define({ handlers: [hold] })), (app) => {
      expect(Exit.isSuccess(Timeline.capture(app))).toBe(true);
      app.dispatch(Hold, {});
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

  it("is taken back by a rewind to a moment before the stage ran", () => {
    const { fired, game: Pressed } = pressing();
    withApp(App.make(Pressed), (app) => {
      app.tick(DELTA);
      fired.length = 0;
      const moment = captured(app);
      app.input();
      Timeline.rewind(app, moment);
      app.tick(DELTA);
      expect(fired).toEqual([]);
    });
  });

  it("is kept by a moment taken after the stage ran", () => {
    const { fired, game: Pressed } = pressing();
    withApp(App.make(Pressed), (app) => {
      app.tick(DELTA);
      fired.length = 0;
      app.input();
      const moment = captured(app);
      Timeline.rewind(app, moment);
      app.tick(DELTA);
      expect(fired).toEqual([1]);
    });
  });

  it("is kept by a save taken after the stage ran", () => {
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

  it("is all the stage leaves: a stage that issues nothing changes neither the hash nor a save", () => {
    const Idle = System.input("rw/Idle", function* () {});
    withApp(App.make(App.define({ systems: [Idle] })), (app, world) => {
      const before = world.hash();
      app.input();
      expect(world.hash()).toBe(before);
      const save = app.save();
      if (Exit.isFailure(save)) {
        throw new Error("the game could not be saved");
      }
      expect(readSnapshot(save.value.world).stores).toEqual([]);
    });
  });
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
    it("hear each event once, and what the ticks run again do otherwise", () => {
      const { heard, game: Ringing } = listening();
      withMade(Build.build(Ringing, {}), (built) => {
        const session = steered(built);
        const { app } = session;
        session.tick(DELTA);
        app.frame();
        const back = session.capture();
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([1, 1, 2, 2, 3, 3]);
        heard.frame.length = 0;
        heard.input.length = 0;
        // Run again with a bell that rings on tick 3: only that is new.
        session.rewind(back);
        session.tick(DELTA);
        app.enqueue(Louder, { by: 7 });
        session.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([307]);
        // Past where the game had got to, every event is new again. The input
        // stage runs before each tick, so it had not heard the third tick's
        // events before the rewind, and hears them now, before the fourth.
        session.tick(DELTA);
        app.frame();
        expect(heard).toEqual({ frame: [307, 4, 4, 407], input: [3, 3, 307] });
      });
    });

    it("hear once what they heard of ticks whose events were dropped since", () => {
      const { heard, game: Ringing } = listening();
      withMade(Build.build(Ringing, {}), (built) => {
        const session = steered(built);
        const { app } = session;
        session.tick(DELTA);
        app.frame();
        const back = session.capture();
        // Every stage hears each tick, so each tick drops the one before.
        for (let i = 0; i < 4; i++) {
          session.tick(DELTA);
          app.frame();
        }
        expect(app.inspect().stores[Event.STORE]).toEqual({
          "rw/Rang": [{ n: 5 }, { n: 5 }],
        });
        heard.frame.length = 0;
        session.rewind(back);
        for (let i = 0; i < 4; i++) {
          session.tick(DELTA);
          app.frame();
        }
        expect(heard.frame).toEqual([]);
      });
    });

    it("hear again none of what they heard before a moment was taken", () => {
      const { heard, game: Ringing } = listening();
      withMade(Build.build(Ringing, {}), (built) => {
        const session = steered(built);
        const { app } = session;
        // Taken before anything between ticks has run.
        const back = session.capture();
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame();
        const first = [...heard.frame];
        session.rewind(back);
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame();
        expect(first).toEqual([1, 1, 2, 2]);
        expect(heard.frame).toEqual([1, 1, 2, 2]);
        // The input stage runs before each tick, and heard what came before
        // the second, once.
        expect(heard.input).toEqual([1, 1]);
      });
    });

    it("hear the events of ticks they never heard, after a rewind further back", () => {
      const { heard, game: Ringing } = listening();
      withMade(Build.build(Ringing, {}), (built) => {
        const session = steered(built);
        const { app } = session;
        session.tick(DELTA);
        app.frame();
        const back = session.capture();
        // Ticks run with no frame: the frame stage heard none of them.
        session.tick(DELTA);
        session.tick(DELTA);
        session.rewind(back);
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([1, 1, 2, 2, 3, 3]);
      });
    });

    it("hear an event a later tick now emits, though an earlier one emitted the same", () => {
      const { heard, game: Chiming } = listening(Chimed);
      withMade(Build.build(Chiming, {}), (built) => {
        const session = steered(built);
        const { app } = session;
        session.tick(DELTA);
        const back = session.capture();
        // As predicted: the chime on the second tick.
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([5]);
        // As it was: the second tick has none, and the third rings the same.
        session.rewind(back);
        session.tick(DELTA);
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([5, 5]);
      });
    });

    it("hear an event an earlier tick now emits, though a later one emitted the same", () => {
      const { heard, game: Chiming } = listening(Chimed);
      withMade(Build.build(Chiming, {}), (built) => {
        const session = steered(built);
        const { app } = session;
        session.tick(DELTA);
        const back = session.capture();
        // As predicted: the chime on the third tick.
        session.tick(DELTA);
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([5]);
        // As it was: on the second, which is not the tick it was heard of.
        session.rewind(back);
        app.enqueue(Chime, { n: 5 });
        session.tick(DELTA);
        session.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([5, 5]);
      });
    });

    it("leave the game as one that never went back", () => {
      const one = listening();
      const other = listening();
      withMade(Build.build(one.game, {}), (built) =>
        withApp(other.make, (straight) => {
          const session = steered(built);
          const back = session.app;
          session.tick(DELTA);
          back.frame();
          const at = session.capture();
          session.tick(DELTA);
          back.frame();
          session.rewind(at);
          session.tick(DELTA);
          back.frame();
          for (let i = 0; i < 2; i++) {
            straight.tick(DELTA);
            straight.frame();
          }
          expect(Effect.runSync(back.read(World)).hash()).toBe(
            Effect.runSync(straight.read(World)).hash()
          );
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
        app.frame();
        expect(heard.frame).toEqual([5]);
        // The move is undone, and made again: it is a new one.
        Timeline.rewind(app, back);
        app.enqueue(Chime, { n: 5 });
        app.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([5, 5]);
        // Between two ticks as well.
        Timeline.rewind(app, back);
        app.dispatch(Chime, { n: 5 });
        app.frame();
        expect(heard.frame).toEqual([5, 5, 5]);
      });
    });

    it("hear nothing of the future that was given up before they had heard it", () => {
      const { heard, make } = listening();
      withApp(make, (app) => {
        app.tick(DELTA);
        app.frame();
        const back = captured(app);
        // Run ahead with no frame, as a search does, and come back.
        app.tick(DELTA);
        app.tick(DELTA);
        Timeline.rewind(app, back);
        app.frame();
        expect(heard.frame).toEqual([1, 1]);
        app.tick(DELTA);
        app.frame();
        expect(heard.frame).toEqual([1, 1, 2, 2]);
      });
    });
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

    it("hears what a tick run again does otherwise, and nothing twice", () => {
      const { game, listen } = kept();
      withMade(Build.build(game, {}), (built) => {
        const session = steered(built);
        session.tick(DELTA);
        const heard = listen();
        const back = session.capture();
        session.tick(DELTA);
        session.tick(DELTA);
        expect(heard()).toEqual([2, 2, 3, 3]);
        session.rewind(back);
        session.tick(DELTA);
        session.app.enqueue(Louder, { by: 7 });
        session.tick(DELTA);
        expect(heard()).toEqual([307]);
        session.tick(DELTA);
        expect(heard()).toEqual([4, 4, 407]);
      });
    });

    it("hears every event told after an undo, before it next reads", () => {
      const { game, listen } = kept();
      withApp(App.make(game), (app) => {
        app.tick(DELTA);
        const heard = listen();
        const back = captured(app);
        app.tick(DELTA);
        app.tick(DELTA);
        Timeline.rewind(app, back);
        app.tick(DELTA);
        expect(heard()).toEqual([2, 2]);
      });
    });
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

  it("keep nothing for a rewind once no moment of the game is held", async () => {
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const app = Effect.runSync(App.make(game));
    const { world } = partsOf(app);
    for (let x = 0; x < 20; x++) {
      app.enqueue(Act, { op: 0, pick: 0, x });
    }
    app.tick(DELTA);
    app.frame(0);
    // A moment no one keeps, as an undo point that is let go.
    captured(app);
    // A weakly held object outlives the turn it was last reached in.
    await new Promise((resolve) => setTimeout(resolve, 0));
    collect();
    for (let tick = 0; tick < 2000; tick++) {
      app.enqueue(Act, { op: 2, pick: tick, x: tick });
      app.enqueue(Act, { op: 1, pick: tick, x: 0 });
      app.enqueue(Act, { op: 0, pick: 0, x: tick });
      app.tick(DELTA);
      app.frame(0);
    }
    const held = (kind: "changed" | "removed"): number => {
      const log = world._log(Dot, kind);
      return log.end - log.base;
    };
    expect({ changed: held("changed"), removed: held("removed") }).toEqual({
      changed: 0,
      removed: 0,
    });
  });

  it("are enough to keep what they show true, through random rewinds", () => {
    const wrong: string[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const dice = new EcsWorld({ seed }).random;
      shown.clear();
      withApp(App.make(game), (app, world) => {
        const moments: Timeline.Moment[] = [];
        for (let step = 0; step < 300; step++) {
          const roll = dice.int(1, 10);
          if (roll <= 5) {
            for (let i = dice.int(0, 2); i > 0; i--) {
              app.enqueue(Act, {
                op: dice.int(0, 2),
                pick: dice.int(0, 99),
                x: dice.int(0, 999),
              });
            }
            app.tick(DELTA);
          } else if (roll <= 8) {
            moments.push(captured(app));
          } else if (moments.length > 0) {
            // To a moment of this future or of one given up, to run the
            // same ticks again or to play on.
            Timeline.rewind(app, dice.pick(moments), {
              again: roll !== 10,
            });
          }
          if (dice.int(0, 2) > 0) {
            app.frame(0);
            const dots = Effect.runSync(app.read(Dots)).entities();
            for (const dot of dots) {
              if (shown.get(dot) !== world.get(dot, Dot)?.x) {
                wrong.push(`seed ${seed}, step ${step}, dot ${idOf(dot)}`);
              }
            }
          }
        }
      });
    }
    expect(wrong).toEqual([]);
  });
});

describe("Session.syncTest", () => {
  const Mark = Component.define("vr/Mark", { n: Field.i32 });
  const Marks = Query.all(Mark);
  const Steady = System.tick("vr/Steady", function* () {
    (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: (yield* Time).tick }));
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
    const Leaky = System.tick("vr/Leaky", function* () {
      outside++;
      (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: outside }));
    });
    const After = System.tick("vr/After", function* () {
      (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: 0 }));
    });
    withMade(
      Session.syncTest(App.define({ systems: [Steady, Leaky, After] })),
      (test) => {
        const error = failure(() => test.tick(DELTA));
        expect(error).toBeInstanceOf(Session.RewindDiverged);
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
      (yield* Commands.spawns(Mark)).spawn(Mark.of({ n: outside }));
    });
    withMade(
      Session.syncTest(App.define({ systems: [Steady], handlers: [bump] })),
      (test) => {
        test.tick(DELTA);
        test.app.enqueue(Bump, {});
        const error = failure(() => test.tick(DELTA));
        expect(error).toMatchObject({ tick: 2, system: undefined });
      }
    );
  });

  it("names the system that fails on one run and not the other", () => {
    let runs = 0;
    const Once = System.tick("vr/Once", function* () {
      runs++;
      if (runs === 2) {
        return yield* Effect.fail("the second time");
      }
    });
    withMade(
      Session.syncTest(App.define({ systems: [Steady, Once] })),
      (test) => {
        const error = failure(() => test.tick(DELTA));
        expect(error).toMatchObject({ tick: 1, system: "vr/Once" });
      }
    );
  });

  it("leaves a game that keeps everything in the world as it would be", () => {
    const stepped = (test: {
      readonly app: SteeredGame;
      readonly tick: (delta: number) => void;
      readonly checked: number;
    }) => {
      const { app } = test;
      const world = Effect.runSync(app.read(World));
      const dice = new EcsWorld({ seed: 11 }).random;
      const hashes: number[] = [];
      for (let i = 0; i < 40; i++) {
        if (dice.int(1, 3) === 1) {
          app.enqueue(Drop, { by: "ada", value: dice.int(1, 9) });
        }
        test.tick(DELTA);
        hashes.push(world.hash());
      }
      return {
        hashes,
        recording: Journal.encode(app.record()),
        checked: test.checked,
      };
    };
    const played = (checked: boolean) =>
      checked
        ? withMade(
            Session.syncTest(CoinGame, { seed: 5, checkpointEvery: 1 }),
            stepped
          )
        : withApp(game(5, 1), (app) =>
            stepped({ app, tick: (delta) => app.tick(delta), checked: 0 })
          );
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
    withMade(
      Session.syncTest(App.define({ systems: [Steady, Ring, Draw, Keys] })),
      (test) => {
        for (let i = 0; i < 3; i++) {
          test.tick(DELTA);
          test.frame();
        }
        expect(seen).toEqual({ heard: [1, 2, 3], added: [1, 1, 1] });
        // The input stage runs before each tick: it has heard the first two.
        expect(keys).toEqual([1, 2]);
        expect(Effect.runSync(test.app.read(Marks)).count()).toBe(3);
      }
    );
  });

  it("fails with the refusal of a game it can't capture, and takes the app over", () => {
    const Held = Component.define("vr/Held", {
      thing: Field.json<JsonValue>(),
    });
    const Hold = System.tick("vr/Hold", function* () {
      (yield* Commands.spawns(Held)).spawn(
        // @ts-expect-error A function is not JSON.
        Held.of({ thing: () => 1 })
      );
    });
    withMade(Session.syncTest(App.define({ systems: [Hold] })), (test) => {
      expect(() =>
        // @ts-expect-error the app of a sync test has no tick: the test steps it
        test.app.tick(DELTA)
      ).toThrow(/taken over/u);
      test.tick(DELTA);
      const exit = test.tickExit(DELTA);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toMatch(
        /vr\/Held/u
      );
      expect(test.app.time.tick).toBe(1);
    });
  });
});
