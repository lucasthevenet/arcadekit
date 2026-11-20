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
  Query,
  Save,
  System,
  Ticks,
  Time,
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

const captured = (app: App.Any): App.Moment => {
  const moment = app.capture();
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
        app.rewind(moment);
        stretch(app, seed + 20, 45);
        expect(app.world.hash()).not.toBe(first.at(-1));
        app.rewind(moment);
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
      app.rewind(moment);
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
      app.rewind(moment);
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
    withApp(App.make({ systems: [Clock] }), (app) => {
      app.tick(DELTA);
      expect(app.settled).toBe(false);
      const moment = captured(app);
      app.tick(DELTA);
      app.tick(DELTA);
      expect(app.settled).toBe(true);
      app.rewind(moment);
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
      app.rewind(moment);
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
      app.rewind(moment);
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
    withApp(App.make({ systems: [Listen, Ring] }), (app) => {
      app.tick(DELTA);
      app.tick(DELTA);
      const moment = captured(app);
      app.tick(DELTA);
      app.tick(DELTA);
      expect(heard).toEqual([[], [1], [2], [3]]);
      app.rewind(moment);
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
    withApp(App.make({ systems: [Count, Draw, Grow] }), (app) => {
      for (let i = 0; i < 3; i++) {
        app.tick(DELTA);
        app.frame(0);
      }
      const moment = captured(app);
      app.tick(DELTA);
      app.frame(0);
      expect(seen).toEqual({ tick: [0, 1, 1, 1], frame: [1, 1, 1, 1] });
      app.rewind(moment);
      seen.tick.length = 0;
      seen.frame.length = 0;
      app.tick(DELTA);
      app.frame(0);
      // The system of the tick sees the one dot it had yet to see. What
      // draws sees every dot again: all four are new to it.
      expect(seen).toEqual({ tick: [1], frame: [4] });
    });
  });

  it("throws away commands that were queued and never applied", () => {
    withApp(game(), (app) => {
      app.dispatch(Drop, { by: "ada", value: 1 });
      const moment = captured(app);
      const count = app.world.entityCount;
      const queued = app.commands.spawn(Coin.of({ value: 2, x: 0 }));
      app.rewind(moment);
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
      expect(() => app.rewind(moment)).toThrow(
        /a moment that this app did not capture.*save it and load the save/u
      );
      expect(() => app.rewind({ tick: 0 })).toThrow(/did not capture/u);
    });
    let inside: App.Any | undefined;
    const Meddle = System.make("rw/Meddle", function* () {
      yield* Effect.sync(() => {
        if (inside !== undefined && inside.time.tick === 2) {
          inside.capture();
        }
      });
    });
    withApp(App.make({ systems: [Meddle] }), (app) => {
      inside = app;
      app.tick(DELTA);
      expect(() => app.tick(DELTA)).toThrow(
        /capture\(\) was called during a tick/u
      );
    });
    const taken: App.Moment[] = [];
    const Undo = System.make("rw/Undo", function* () {
      yield* Effect.sync(() => {
        if (inside !== undefined && taken.length > 0) {
          inside.rewind(taken[0]!);
        }
      });
    });
    withApp(App.make({ systems: [Undo] }), (app) => {
      inside = app;
      app.tick(DELTA);
      taken.push(captured(app));
      expect(() => app.tick(DELTA)).toThrow(
        /rewind\(\) was called during a tick/u
      );
    });
  });

  it("cannot be captured with commands queued, or with a field that cannot be saved", () => {
    const Holder = Component.define("rw/Holder", {
      thing: Field.json<unknown>(),
    });
    withApp(App.make({}), (app) => {
      app.commands.spawn(Holder.of({ thing: 1 }));
      expect(app.capture()).toEqual(
        Exit.fail(
          new Save.SaveRefused({
            message:
              "1 commands are queued and not applied. They are applied at the end of a tick: capture after one.",
          })
        )
      );
      app.commands.apply();
      expect(Exit.isSuccess(app.capture())).toBe(true);
      app.world.spawn(Holder.of({ thing: () => 1 }));
      const refused = app.capture();
      expect(Exit.isFailure(refused)).toBe(true);
      expect(String(Exit.isFailure(refused) ? refused.cause : "")).toMatch(
        /rw\/Holder/u
      );
    });
  });

  it("is not for an action's handler to call", () => {
    let inside: App.Any | undefined;
    const Back = Action.define("rw/Back", Schema.Struct({}));
    const taken: App.Moment[] = [];
    const back = Action.handler(Back, function* () {
      yield* Effect.sync(() => inside!.rewind(taken[0]!));
    });
    withApp(App.make({ handlers: [back] }), (app) => {
      inside = app;
      taken.push(captured(app));
      const exit = app.dispatch(Back, {});
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toMatch(
        /rewind\(\) was called from the handler of "rw\/Back"/u
      );
    });
  });
});

describe("App.Rewound", () => {
  /** A frame-stage and an input-stage system that note what they hear of it. */
  const listeners = () => {
    const heard = { frame: [] as unknown[], input: [] as unknown[] };
    const Draw = System.make("rw/Draw", function* () {
      heard.frame.push(...(yield* App.Rewound).read());
    }).pipe(System.inStage("frame"));
    const Keys = System.make("rw/Keys", function* () {
      heard.input.push(...(yield* App.Rewound).read());
    }).pipe(System.inStage("input"));
    return { heard, systems: [Draw, Keys] as const };
  };
  const Dot = Component.define("rw/Dot", { x: Field.f32 });
  const Grow = System.make("rw/Grow", function* () {
    (yield* Commands).spawn(Dot.of({ x: (yield* Time).tick }));
  });

  it("tells the stages between ticks, once each, where the game went back from and to", () => {
    const { heard, systems } = listeners();
    withApp(App.make({ systems: [Grow, ...systems] }), (app) => {
      app.tick(DELTA);
      app.frame(0);
      const moment = captured(app);
      app.tick(DELTA);
      app.tick(DELTA);
      app.frame(0);
      app.rewind(moment);
      // A session resimulates before anything hears it.
      app.tick(DELTA);
      app.tick(DELTA);
      app.frame(0);
      app.tick(DELTA);
      app.frame(0);
      expect(heard).toEqual({
        frame: [{ from: 3, to: 1 }],
        input: [{ from: 3, to: 1 }],
      });
    });
  });

  it("leaves the game as one that never went back: its save, its hash and its log", () => {
    const one = listeners();
    const other = listeners();
    withApp(App.make({ systems: [Grow, ...one.systems] }), (back) =>
      withApp(App.make({ systems: [Grow, ...other.systems] }), (straight) => {
        back.tick(DELTA);
        const moment = captured(back);
        back.tick(DELTA);
        back.rewind(moment);
        straight.tick(DELTA);
        // Just after the rewind, and after the tick that follows it.
        for (let i = 0; i < 2; i++) {
          expect(back.world.hash()).toBe(straight.world.hash());
          expect(back.save()).toEqual(straight.save());
          expect(back.actionLog).toEqual(straight.actionLog);
          expect(back.settled).toBe(straight.settled);
          back.tick(DELTA);
          straight.tick(DELTA);
        }
      })
    );
  });

  it("isn't held by a moment, so going back again doesn't tell of an earlier rewind twice", () => {
    const { heard, systems } = listeners();
    withApp(App.make({ systems: [Grow, ...systems] }), (app) => {
      app.tick(DELTA);
      const first = captured(app);
      app.tick(DELTA);
      app.rewind(first);
      // Taken while the rewind is still to be heard.
      const second = captured(app);
      app.frame(0);
      app.tick(DELTA);
      app.rewind(second);
      app.frame(0);
      expect(heard.frame).toEqual([
        { from: 2, to: 1 },
        { from: 2, to: 1 },
      ]);
    });
  });

  it("is refused to a system of the tick and to a handler, and to whoever emits it", () => {
    const Peek = System.make("rw/Peek", function* () {
      (yield* App.Rewound).read();
    });
    withApp(App.make({ systems: [Peek] }), (app) => {
      expect(() => app.tick(DELTA)).toThrow(
        /The event "App\.Rewound" was read by "rw\/Peek", which runs in the tick\..*System\.inStage\("frame"\)/u
      );
    });

    const Ask = Action.define("rw/Ask", Schema.Struct({}));
    const ask = Action.handler(Ask, function* () {
      (yield* App.Rewound).read();
    });
    withApp(App.make({ handlers: [ask] }), (app) => {
      const exit = app.dispatch(Ask, {});
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toMatch(
        /The event "App\.Rewound" was read by "action:rw\/Ask"/u
      );

      expect(() => app.events.emit(App.Rewound, { from: 1, to: 0 })).toThrow(
        /The event "App\.Rewound" was emitted\. The app announces it/u
      );
      expect(() =>
        app.events.handle(App.Rewound).emit({ from: 1, to: 0 })
      ).toThrow(/The event "App\.Rewound" was emitted/u);
    });
  });
});
