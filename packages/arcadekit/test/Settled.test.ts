import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Scheduler, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Event,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Replay,
  Save,
  Singleton,
  State,
  System,
  Test,
  View,
  World,
} from "../src/index.ts";

/** The world of an app, as `app.read(World)` gives it. */
const worldOf = (app: Pick<App.Any, "read">) => app.read(World);

// --- a game that moves when its player does ----------------------------------------
// A board of pieces. A move slides them, and a piece lands a tick after it
// was moved.
const Piece = Component.define("st/Piece", { x: Field.i32 });
const Pieces = Query.all(Piece).pipe(Query.writes(Piece));
const Seen = Query.all(Piece);
const Score = Singleton.define("st/Score", { moves: Field.i32 }, { moves: 0 });
const Phase = State.define("st/Phase", ["title", "playing"]);

const Begin = Action.define("st/Begin", Schema.Struct({}));
const Move = Action.define("st/Move", Schema.Struct({ by: Schema.Int }));
const Moved = Event.define("st/Moved", Schema.Struct({ by: Schema.Int }));
const Landed = Event.define("st/Landed", Schema.Struct({}));

/** Counts the moves it hears of. It is listed before the system that says so. */
const Tally = System.tick("st/Tally", function* () {
  const heard = (yield* Landed).read();
  if (heard.length > 0) {
    (yield* Score.writes).moves += heard.length;
  }
});
/** Says that a piece has landed, a tick after it was moved. */
const Land = System.tick("st/Land", function* () {
  if ((yield* Moved).read().length > 0) {
    (yield* Landed.emits).emit({});
  }
});
const entered: string[] = [];
const Opening = State.onEnter(Phase, "playing", "st/Opening", function* () {
  entered.push("playing");
  (yield* Commands.spawns(Piece)).spawn(Piece.of({ x: 0 }));
});

/** Says that a piece has landed, or has moved, with no piece doing either. */
const Declare = Action.define(
  "st/Declare",
  Schema.Struct({ landed: Schema.Boolean })
);
const declare = Action.handler(Declare, function* ({ landed }) {
  if (landed) {
    (yield* Landed.emits).emit({});
  } else {
    (yield* Moved.emits).emit({ by: 1 });
  }
});

const Rules = Plugin.make("st/Rules", {
  systems: [Tally, Land, Opening],
  handlers: [
    declare,
    Action.handler(Begin, function* () {
      (yield* Phase.sets).set("playing");
    }),
    Action.handler(Move, function* ({ by }) {
      (yield* Pieces).each((piece) => {
        piece.x += by;
      });
      (yield* Moved.emits).emit({ by });
    }),
  ],
});

describe("app.settled", () => {
  it.effect(
    "is true of a game with nothing waiting, once it has ticked, and stays so however it is ticked",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(App.define({}), { hashEvery: 0 });
        // A game that has not ticked yet has not been asked whether it has
        // anything to do.
        expect(app.settled).toBe(false);
        yield* app.frame();
        yield* app.input();
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        yield* app.tick(1);
        yield* app.frame();
        yield* app.input();
        expect(app.settled).toBe(true);
      })
  );

  it.effect(
    "is false while a state waits to be entered: the one a game starts in, and one that was asked for",
    () =>
      Effect.gen(function* () {
        entered.length = 0;
        const app = yield* App.make(App.define({ plugins: [Rules] }));
        // The state it starts in is entered by its first tick, which changes
        // the game: the next finds nothing to do.
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        yield* app.dispatch(Begin, {});
        expect(app.settled).toBe(false);
        expect(entered).toEqual([]);
        yield* app.tick(1);
        expect(entered).toEqual(["playing"]);
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
      })
  );

  it.effect("is false while an action waits to be applied", () =>
    Effect.gen(function* () {
      const app = yield* App.make(App.define({ plugins: [Rules] }));
      expect(app.settled).toBe(false);
      yield* app.tick(1);
      entered.length = 0;
      yield* app.enqueue(Begin, {});
      expect(app.settled).toBe(false);
      // Applied at the start of the tick, and the state it asked for is
      // entered by the same tick: nothing is left waiting, and the tick after
      // finds nothing to do.
      yield* app.tick(1);
      expect(entered).toEqual(["playing"]);
      expect(app.settled).toBe(false);
      yield* app.tick(1);
      expect(app.settled).toBe(true);
    })
  );

  it.effect(
    "is false while an event waits that a system has not had its chance at, and no longer",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Rules] }));
        const world = yield* worldOf(app);
        expect(app.settled).toBe(false);
        yield* app.dispatch(Begin, {});
        yield* app.tick(1);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        // A handler's event is heard by every system of the tick that
        // applies it: nothing waits after that tick but what a system said.
        yield* app.enqueue(Move, { by: 2 });
        yield* app.tick(1);
        // Land said Landed, which Tally, listed before it, has yet to hear.
        expect(world.singleton(Score).moves).toBe(0);
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(world.singleton(Score).moves).toBe(1);
        // Nothing waits, and the tick that counted it changed the score.
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        // One an action emitted between two ticks waits too.
        yield* app.dispatch(Declare, { landed: true });
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(world.singleton(Score).moves).toBe(2);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        // Of whichever kind: this one, and then the one it sets off.
        yield* app.dispatch(Declare, { landed: false });
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(world.singleton(Score).moves).toBe(3);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
      })
  );

  it.effect(
    "does not wait for what draws: an event kept for the frame stage is nothing a tick is needed for",
    () =>
      Effect.gen(function* () {
        const heard: number[] = [];
        const Watch = System.frame("st/Watch", function* () {
          heard.push(
            (yield* Moved).read().length + (yield* Landed).read().length
          );
        });
        const app = yield* App.make(
          App.define({ plugins: [Rules], systems: [Watch] })
        );
        expect(app.settled).toBe(false);
        yield* app.dispatch(Begin, {});
        yield* app.tick(1);
        yield* app.enqueue(Move, { by: 1 });
        yield* app.tick(1);
        yield* app.tick(1);
        yield* app.tick(1);
        // No frame has been drawn: both events are still kept for the system
        // that draws, and the game is at rest all the same.
        expect(app.settled).toBe(true);
        yield* app.frame();
        expect(heard).toEqual([2]);
        expect(app.settled).toBe(true);
      })
  );

  it.effect("is false while work is queued for the next tick", () =>
    Effect.gen(function* () {
      const kept: Scheduler.SchedulerDispatcher[] = [];
      // What the game's fibers are dispatched by.
      const Keep = System.tick("st/Keep", function* () {
        kept.push((yield* Scheduler.Scheduler).makeDispatcher());
      });
      const app = yield* App.make(App.define({ systems: [Keep] }));
      expect(app.settled).toBe(false);
      yield* app.tick(1);
      expect(app.settled).toBe(true);
      const [dispatcher] = kept;
      assert(dispatcher !== undefined);
      const ran: string[] = [];
      // As a fiber a system forked leaves the rest of itself, when what it
      // waited for arrives between two ticks: it runs when the next tick lets
      // fibers run.
      dispatcher.scheduleTask(() => ran.push("ran"), 0);
      expect(ran).toEqual([]);
      expect(app.settled).toBe(false);
      yield* app.tick(1);
      expect(ran).toEqual(["ran"]);
      expect(app.settled).toBe(true);
    })
  );

  it.effect("is not changed by looking, nor by the stages between ticks", () =>
    Effect.gen(function* () {
      const app = yield* App.make(App.define({ plugins: [Rules] }), {
        hashEvery: 1,
      });
      const world = yield* worldOf(app);
      const before = world.hash();
      for (let i = 0; i < 3; i++) {
        expect(app.settled).toBe(false);
      }
      yield* app.frame();
      yield* app.input();
      expect(app.settled).toBe(false);
      expect(world.hash()).toBe(before);
    })
  );
});

describe("a game that ticks when its player moves", () => {
  // Drawn every frame, heard from through a UI and a key, and at rest in between.
  const Shown = View.define("st/Shown", { x: 0, moves: 0, phase: "title" });
  let frames = 0;
  let lastAlpha = Number.NaN;
  const Show = View.publish(Shown, function* () {
    frames++;
    lastAlpha = (yield* Frame).alpha;
    let x = 0;
    (yield* Seen).each((piece) => {
      ({ x } = piece);
    });
    return {
      x,
      moves: (yield* Score).moves,
      phase: (yield* Phase).value as string,
    };
  });
  const Step = Input.button("st/Step", ["ArrowRight"]);
  const Keys = System.input("st/Keys", function* () {
    if ((yield* Step).pressed) {
      (yield* Action.Actions).enqueue(Move, { by: 1 });
    }
  });
  const Game = Plugin.make("st/Game", {
    plugins: [Rules, View.plugin, Input.controls("st/Controls", [Step])],
    systems: [Show, Keys],
  });
  const Played = App.define({ plugins: [Game] });
  const play = Effect.fnUntraced(function* () {
    frames = 0;
    const handed: View.Bridge<typeof Begin | typeof Move>[] = [];
    const source = Input.makeManualSource();
    const app = yield* App.make(Played, {
      hashEvery: 1,
      seed: 5,
    }).pipe(
      Effect.provide(
        Layer.merge(
          View.mount(Played, (ui) => {
            handed.push(ui);
            ui.subscribe(Shown, () => {});
          }),
          Input.layer(source)
        )
      )
    );
    const ui = handed[0]!;
    const advance = Driver.fixedStep(app, { hz: 60, ticks: "whenNeeded" });
    /** Frames at the screen's rate, sixty a second. */
    const frame = Effect.fnUntraced(function* (count = 1) {
      let ticks = 0;
      for (let i = 0; i < count; i++) {
        ticks += yield* advance(1 / 60);
      }
      return ticks;
    });
    return { app, ui, source, frame };
  });

  it.effect(
    "enters the state it starts in, then stands still: frames are drawn and time does not pass",
    () =>
      Effect.gen(function* () {
        const { app, frame, ui } = yield* play();
        // The first tick, which enters the title, and one more after it.
        expect(yield* frame(10)).toBe(2);
        expect(app.time.tick).toBe(2);
        const { elapsed } = app.time;
        expect(yield* frame(600)).toBe(0);
        expect(app.time.tick).toBe(2);
        expect(app.time.elapsed).toBe(elapsed);
        // Drawn all the while, all the way to its last tick.
        expect(frames).toBe(610);
        expect(lastAlpha).toBe(1);
        expect(ui.get(Shown)).toEqual({ x: 0, moves: 0, phase: "title" });
      })
  );

  it.effect(
    "ticks for a move from the UI or a key until everything that follows from it is done, and rests again",
    () =>
      Effect.gen(function* () {
        const { app, frame, source, ui } = yield* play();
        yield* frame(10);
        // A button: the tick that applies it enters the state it asked for.
        ui.send(Begin, {});
        expect(ui.get(Shown).phase).toBe("title");
        expect(yield* frame()).toBe(1);
        expect(ui.get(Shown).phase).toBe("playing");
        // And one more, after which nothing runs.
        expect(yield* frame()).toBe(1);
        expect(yield* frame(100)).toBe(0);
        const rested = app.time.tick;
        // A key: the move, the tick in which it is heard to have landed, and
        // one more.
        source.tap("ArrowRight");
        expect(yield* frame()).toBe(1);
        expect(ui.get(Shown)).toEqual({ x: 1, moves: 0, phase: "playing" });
        expect(yield* frame()).toBe(1);
        expect(ui.get(Shown)).toEqual({ x: 1, moves: 1, phase: "playing" });
        expect(yield* frame()).toBe(1);
        expect(yield* frame(100)).toBe(0);
        expect(app.time.tick).toBe(rested + 3);
        // Two moves in one frame, by both: one tick applies both.
        ui.send(Move, { by: 10 });
        source.tap("ArrowRight");
        expect(yield* frame()).toBe(1);
        expect(ui.get(Shown).x).toBe(12);
        yield* frame(100);
        // Two pieces moved and one landing said, in the one tick.
        expect(ui.get(Shown).moves).toBe(2);
        expect(app.time.tick).toBe(rested + 6);
      })
  );

  it.effect(
    "replays from its log, given how many ticks it ran: resting is no part of the game",
    () =>
      Effect.gen(function* () {
        const { app, frame, source, ui } = yield* play();
        yield* frame(30);
        ui.send(Begin, {});
        yield* frame(45);
        source.tap("ArrowRight");
        yield* frame(7);
        ui.send(Move, { by: -4 });
        yield* frame(200);
        expect(ui.get(Shown)).toEqual({ x: -3, moves: 2, phase: "playing" });
        // The same game with no UI, no devices and no rest: tick after tick.
        const played = yield* Replay.record(app);
        const again = yield* Replay.verify(played, Played, {
          hashEvery: 1,
        });
        const replayed = yield* worldOf(again);
        expect(replayed.hash()).toBe((yield* worldOf(app)).hash());
        expect(again.time.tick).toBe(app.time.tick);
        expect(replayed.singleton(Score).moves).toBe(2);
      })
  );
});

// --- a system with work of its own -------------------------------------------------
// A clock that is wound by an action and runs down a tenth of a second a
// tick. Nothing an app can see is waiting while it runs: no action, no
// state, no event. The system says so itself.
const Clock = Singleton.define("st/Clock", { left: Field.i32 }, { left: 0 });
const Wind = Action.define("st/Wind", Schema.Struct({ ticks: Schema.Int }));
const wind = Action.handler(Wind, function* ({ ticks }) {
  (yield* Clock.writes).left = ticks;
});
let ran = 0;
/** A clock that runs down a tick at a time, and says nothing of it. */
const RunDown = System.tick("st/RunDown", function* () {
  ran++;
  const clock = yield* Clock.writes;
  if (clock.left > 0) {
    clock.left -= 1;
  }
});

describe("a game that changes", () => {
  const options = { handlers: [wind] } as const;

  it.effect(
    "is not settled after a tick that changed more than its time, and is after one that did not",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(
          App.define({ ...options, systems: [RunDown] })
        );
        // Asked once, the app watches from then on.
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        // The action waits; applied, the clock runs down a tick at a time.
        yield* app.enqueue(Wind, { ticks: 3 });
        expect(app.settled).toBe(false);
        const settled: boolean[] = [];
        for (let i = 0; i < 5; i++) {
          yield* app.tick(1);
          settled.push(app.settled);
        }
        // Three ticks that change it; the fourth finds it run down.
        expect(settled).toEqual([false, false, false, true, true]);
        expect((yield* worldOf(app)).singleton(Clock).left).toBe(0);
        // Looking does not change it, and nor do the stages between ticks.
        for (let i = 0; i < 3; i++) {
          yield* app.frame();
          yield* app.input();
          expect(app.settled).toBe(true);
        }
      })
  );

  it.effect(
    "keeps a game that ticks when it is needed going while it changes, and no longer",
    () =>
      Effect.gen(function* () {
        ran = 0;
        const app = yield* App.make(
          App.define({ ...options, systems: [RunDown] })
        );
        const world = yield* worldOf(app);
        const advance = Driver.fixedStep(app, { hz: 10, ticks: "whenNeeded" });
        const frames = Effect.fnUntraced(function* (count: number) {
          for (let i = 0; i < count; i++) {
            yield* advance(0.1);
          }
        });
        // A new game runs a tick, which finds nothing to change.
        yield* frames(50);
        expect(app.time.tick).toBe(1);
        yield* app.enqueue(Wind, { ticks: 20 });
        yield* frames(10);
        // Half way down, and still going: a tick a frame.
        expect(world.singleton(Clock).left).toBe(10);
        expect(app.time.tick).toBe(11);
        yield* frames(100);
        // Twenty ticks of the clock, and the one that found it at nothing;
        // then rest.
        expect(world.singleton(Clock).left).toBe(0);
        expect(app.time.tick).toBe(1 + 20 + 1);
        expect(ran).toBe(app.time.tick);
      })
  );

  it.effect(
    "is not settled after an action dispatched between ticks, for the tick that follows it up",
    () =>
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ ...options, systems: [] }));
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        yield* app.dispatch(Wind, { ticks: 1 });
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
      })
  );

  it.effect(
    "is settled still after an action that was refused, which changed nothing",
    () =>
      Effect.gen(function* () {
        class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}
        const Ask = Action.define(
          "st/Ask",
          Schema.Struct({ refuse: Schema.Boolean }),
          { error: Refused }
        );
        const ask = Action.handler(Ask, function* ({ refuse }) {
          (yield* Clock.writes).left = 9;
          if (refuse) {
            return yield* Refused.make({});
          }
        });
        const app = yield* App.make(App.define({ handlers: [ask] }));
        expect(app.settled).toBe(false);
        yield* app.tick(1);
        yield* app.tick(1);
        expect(app.settled).toBe(true);
        yield* Effect.exit(app.dispatch(Ask, { refuse: true }));
        expect(app.settled).toBe(true);
        yield* Effect.exit(app.dispatch(Ask, { refuse: false }));
        expect(app.settled).toBe(false);
      })
  );

  it.effect(
    "runs the first tick of a game that was loaded, and goes on while it changes",
    () =>
      Effect.gen(function* () {
        const made = App.make(App.define({ ...options, systems: [RunDown] }));
        const app = yield* made;
        yield* app.enqueue(Wind, { ticks: 6 });
        yield* app.tick(1);
        yield* app.tick(1);
        expect((yield* worldOf(app)).singleton(Clock).left).toBe(4);
        const save = yield* Effect.exit(Save.make(app));
        expect(save._tag).toBe("Success");
        if (save._tag !== "Success") {
          return;
        }
        const loaded = yield* App.make(
          App.define({ ...options, systems: [RunDown] }),
          {
            save: save.value,
          }
        );
        expect(loaded.settled).toBe(false);
        const advance = Driver.fixedStep(loaded, {
          hz: 10,
          ticks: "whenNeeded",
        });
        for (let i = 0; i < 50; i++) {
          yield* advance(0.1);
        }
        expect((yield* worldOf(loaded)).singleton(Clock).left).toBe(0);
        expect(loaded.time.tick).toBe(2 + 4 + 1);
      })
  );

  it.effect(
    "is settled when it was made from a save of a game at rest, or had one loaded, and goes on from it tick for tick",
    () =>
      Effect.gen(function* () {
        const Game = App.define({ plugins: [Rules] });
        const game = yield* Test.make(Game);
        yield* game.app.enqueue(Begin, {});
        yield* game.rest();
        yield* game.app.enqueue(Move, { by: 2 });
        yield* game.rest();
        expect(game.app.settled).toBe(true);
        const save = yield* Save.make(game.app);
        // Made from the save, and loaded into an app at rest that had played
        // a game of its own, with a tick more than the saved one.
        const made = yield* Test.make(Game, { save });
        const loadedInto = yield* Test.make(Game);
        yield* loadedInto.app.enqueue(Begin, {});
        yield* loadedInto.rest();
        yield* loadedInto.app.enqueue(Move, { by: 5 });
        yield* loadedInto.rest();
        yield* loadedInto.app.tick(1 / 60);
        yield* loadedInto.rest();
        yield* Save.load(loadedInto.app, save);
        for (const loaded of [made, loadedInto]) {
          expect(loaded.app.settled).toBe(true);
          // A driver that ticks when needed runs no tick before an action.
          const advance = Driver.fixedStep(loaded.app, {
            hz: 10,
            ticks: "whenNeeded",
          });
          for (let i = 0; i < 20; i++) {
            yield* advance(0.1);
          }
          expect(loaded.app.time.tick).toBe(game.app.time.tick);
        }
        for (const one of [game, made, loadedInto]) {
          yield* one.app.enqueue(Move, { by: 1 });
          yield* one.rest();
        }
        const hash = (yield* worldOf(game.app)).hash();
        for (const loaded of [made, loadedInto]) {
          expect(loaded.app.time.tick).toBe(game.app.time.tick);
          expect((yield* worldOf(loaded.app)).hash()).toBe(hash);
        }
        // A save of a game that was not asked whether it rests holds no rest,
        // and a game made from it or loaded with it rests after as many ticks.
        const busy = yield* App.make(Game);
        yield* busy.tick(1);
        yield* busy.tick(1);
        const unrested = yield* Save.make(busy);
        const again = yield* Test.make(Game, { save: unrested });
        yield* Save.load(loadedInto.app, unrested);
        expect([again.app.settled, loadedInto.app.settled]).toEqual([
          false,
          false,
        ]);
        const ticks = yield* again.rest();
        expect(ticks).toBeGreaterThan(0);
        expect(yield* loadedInto.rest()).toBe(ticks);
      })
  );
});
