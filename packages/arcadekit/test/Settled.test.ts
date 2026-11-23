import { Effect, Layer, Scheduler, Schema } from "effect";
import type { Scope } from "effect";
import { assert, describe, expect, it } from "vitest";

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
  Journal,
  Plugin,
  Query,
  Singleton,
  State,
  System,
  View,
  World,
} from "../src/index";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));
/** The world of an app, as `app.read(World)` gives it. */
const worldOf = (app: Pick<App.Any, "read">) => Effect.runSync(app.read(World));

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
  it("is true of a game with nothing waiting, once it has ticked, and stays so however it is ticked", () => {
    const app = run(App.make(App.define({}), { checkpointEvery: 0 }));
    // A game that has not ticked yet has not been asked whether it has
    // anything to do.
    expect(app.settled).toBe(false);
    app.frame(0);
    app.input();
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
    app.tick(1);
    app.frame(0);
    app.input();
    expect(app.settled).toBe(true);
  });

  it("is false while a state waits to be entered: the one a game starts in, and one that was asked for", () => {
    entered.length = 0;
    const app = run(App.make(App.define({ plugins: [Rules] })));
    // The state it starts in is entered by its first tick, which changes
    // the game: the next finds nothing to do.
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
    app.dispatch(Begin, {});
    expect(app.settled).toBe(false);
    expect(entered).toEqual([]);
    app.tick(1);
    expect(entered).toEqual(["playing"]);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
  });

  it("is false while an action waits to be applied", () => {
    const app = run(App.make(App.define({ plugins: [Rules] })));
    expect(app.settled).toBe(false);
    app.tick(1);
    entered.length = 0;
    app.enqueue(Begin, {});
    expect(app.settled).toBe(false);
    // Applied at the start of the tick, and the state it asked for is
    // entered by the same tick: nothing is left waiting, and the tick after
    // finds nothing to do.
    app.tick(1);
    expect(entered).toEqual(["playing"]);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
  });

  it("is false while an event waits that a system has not had its chance at, and no longer", () => {
    const app = run(App.make(App.define({ plugins: [Rules] })));
    const world = worldOf(app);
    expect(app.settled).toBe(false);
    app.dispatch(Begin, {});
    app.tick(1);
    app.tick(1);
    expect(app.settled).toBe(true);
    // A handler's event is heard by every system of the tick that
    // applies it: nothing waits after that tick but what a system said.
    app.enqueue(Move, { by: 2 });
    app.tick(1);
    // Land said Landed, which Tally, listed before it, has yet to hear.
    expect(world.singleton(Score).moves).toBe(0);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(world.singleton(Score).moves).toBe(1);
    // Nothing waits, and the tick that counted it changed the score.
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
    // One an action emitted between two ticks waits too.
    app.dispatch(Declare, { landed: true });
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(world.singleton(Score).moves).toBe(2);
    app.tick(1);
    expect(app.settled).toBe(true);
    // Of whichever kind: this one, and then the one it sets off.
    app.dispatch(Declare, { landed: false });
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(world.singleton(Score).moves).toBe(3);
    app.tick(1);
    expect(app.settled).toBe(true);
  });

  it("does not wait for what draws: an event kept for the frame stage is nothing a tick is needed for", () => {
    const heard: number[] = [];
    const Watch = System.frame("st/Watch", function* () {
      heard.push((yield* Moved).read().length + (yield* Landed).read().length);
    });
    const app = run(
      App.make(App.define({ plugins: [Rules], systems: [Watch] }))
    );
    expect(app.settled).toBe(false);
    app.dispatch(Begin, {});
    app.tick(1);
    app.enqueue(Move, { by: 1 });
    app.tick(1);
    app.tick(1);
    app.tick(1);
    // No frame has been drawn: both events are still kept for the system
    // that draws, and the game is at rest all the same.
    expect(app.settled).toBe(true);
    app.frame(0);
    expect(heard).toEqual([2]);
    expect(app.settled).toBe(true);
  });

  it("is false while work is queued for the next tick", () => {
    const kept: Scheduler.SchedulerDispatcher[] = [];
    // What the game's fibers are dispatched by.
    const Keep = System.tick("st/Keep", function* () {
      kept.push((yield* Scheduler.Scheduler).makeDispatcher());
    });
    const app = run(App.make(App.define({ systems: [Keep] })));
    expect(app.settled).toBe(false);
    app.tick(1);
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
    app.tick(1);
    expect(ran).toEqual(["ran"]);
    expect(app.settled).toBe(true);
  });

  it("is not changed by looking, nor by the stages between ticks", () => {
    const app = run(
      App.make(App.define({ plugins: [Rules] }), { checkpointEvery: 1 })
    );
    const world = worldOf(app);
    const before = world.hash();
    for (let i = 0; i < 3; i++) {
      expect(app.settled).toBe(false);
    }
    app.frame(0);
    app.input();
    expect(app.settled).toBe(false);
    expect(world.hash()).toBe(before);
  });
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
  const Keys = Input.bind(
    "st/Keys",
    Input.onPress("ArrowRight", Move, { by: 1 })
  );
  const Game = Plugin.make("st/Game", {
    plugins: [Rules, View.plugin],
    systems: [Show, Keys],
  });
  const Played = App.define({ plugins: [Game] });
  const play = () => {
    frames = 0;
    const ui = View.makeBridge();
    const source = Input.makeManualSource();
    const app = run(
      App.make(Played, {
        checkpointEvery: 1,
        seed: 5,
      }).pipe(Effect.provide(Layer.merge(View.layer(ui), Input.layer(source))))
    );
    const advance = Driver.fixedStep(app, { hz: 60, ticks: "whenNeeded" });
    /** Frames at the screen's rate, sixty a second. */
    const frame = (count = 1): number => {
      let ticks = 0;
      for (let i = 0; i < count; i++) {
        ticks += advance(1 / 60);
      }
      return ticks;
    };
    return { app, ui, source, frame };
  };

  it("enters the state it starts in, then stands still: frames are drawn and time does not pass", () => {
    const { app, frame, ui } = play();
    // The first tick, which enters the title, and one more after it.
    expect(frame(10)).toBe(2);
    expect(app.time.tick).toBe(2);
    const { elapsed } = app.time;
    expect(frame(600)).toBe(0);
    expect(app.time.tick).toBe(2);
    expect(app.time.elapsed).toBe(elapsed);
    // Drawn all the while, all the way to its last tick.
    expect(frames).toBe(610);
    expect(lastAlpha).toBe(1);
    expect(ui.get(Shown)).toEqual({ x: 0, moves: 0, phase: "title" });
  });

  it("ticks for a move from the UI or a key until everything that follows from it is done, and rests again", () => {
    const { app, frame, source, ui } = play();
    frame(10);
    // A button: the tick that applies it enters the state it asked for.
    ui.send(Begin, {});
    expect(ui.get(Shown).phase).toBe("title");
    expect(frame()).toBe(1);
    expect(ui.get(Shown).phase).toBe("playing");
    // And one more, after which nothing runs.
    expect(frame()).toBe(1);
    expect(frame(100)).toBe(0);
    const rested = app.time.tick;
    // A key: the move, the tick in which it is heard to have landed, and
    // one more.
    source.tap("ArrowRight");
    expect(frame()).toBe(1);
    expect(ui.get(Shown)).toEqual({ x: 1, moves: 0, phase: "playing" });
    expect(frame()).toBe(1);
    expect(ui.get(Shown)).toEqual({ x: 1, moves: 1, phase: "playing" });
    expect(frame()).toBe(1);
    expect(frame(100)).toBe(0);
    expect(app.time.tick).toBe(rested + 3);
    // Two moves in one frame, by both: one tick applies both.
    ui.send(Move, { by: 10 });
    source.tap("ArrowRight");
    expect(frame()).toBe(1);
    expect(ui.get(Shown).x).toBe(12);
    frame(100);
    // Two pieces moved and one landing said, in the one tick.
    expect(ui.get(Shown).moves).toBe(2);
    expect(app.time.tick).toBe(rested + 6);
  });

  it("replays from its log, given how many ticks it ran: resting is no part of the game", () => {
    const { app, frame, source, ui } = play();
    frame(30);
    ui.send(Begin, {});
    frame(45);
    source.tap("ArrowRight");
    frame(7);
    ui.send(Move, { by: -4 });
    frame(200);
    expect(ui.get(Shown)).toEqual({ x: -3, moves: 2, phase: "playing" });
    // The same game with no UI, no devices and no rest: tick after tick.
    const played = app.record();
    const again = run(
      Journal.replay(played, (start) =>
        App.make(Played, { ...start, checkpointEvery: 1 })
      )
    );
    const replayed = worldOf(again);
    expect(replayed.hash()).toBe(worldOf(app).hash());
    expect(again.time.tick).toBe(app.time.tick);
    expect(replayed.singleton(Score).moves).toBe(2);
  });
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
  const options = { handlers: [wind] };

  it("is not settled after a tick that changed more than its time, and is after one that did not", () => {
    const app = run(App.make(App.define({ ...options, systems: [RunDown] })));
    // Asked once, the app watches from then on.
    expect(app.settled).toBe(false);
    app.tick(1);
    app.tick(1);
    expect(app.settled).toBe(true);
    // The action waits; applied, the clock runs down a tick at a time.
    app.enqueue(Wind, { ticks: 3 });
    expect(app.settled).toBe(false);
    const settled: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      app.tick(1);
      settled.push(app.settled);
    }
    // Three ticks that change it; the fourth finds it run down.
    expect(settled).toEqual([false, false, false, true, true]);
    expect(worldOf(app).singleton(Clock).left).toBe(0);
    // Looking does not change it, and nor do the stages between ticks.
    for (let i = 0; i < 3; i++) {
      app.frame(0);
      app.input();
      expect(app.settled).toBe(true);
    }
  });

  it("keeps a game that ticks when it is needed going while it changes, and no longer", () => {
    ran = 0;
    const app = run(App.make(App.define({ ...options, systems: [RunDown] })));
    const world = worldOf(app);
    const advance = Driver.fixedStep(app, { hz: 10, ticks: "whenNeeded" });
    const frames = (count: number): void => {
      for (let i = 0; i < count; i++) {
        advance(0.1);
      }
    };
    // A new game runs a tick, which finds nothing to change.
    frames(50);
    expect(app.time.tick).toBe(1);
    app.enqueue(Wind, { ticks: 20 });
    frames(10);
    // Half way down, and still going: a tick a frame.
    expect(world.singleton(Clock).left).toBe(10);
    expect(app.time.tick).toBe(11);
    frames(100);
    // Twenty ticks of the clock, and the one that found it at nothing;
    // then rest.
    expect(world.singleton(Clock).left).toBe(0);
    expect(app.time.tick).toBe(1 + 20 + 1);
    expect(ran).toBe(app.time.tick);
  });

  it("is not settled after an action dispatched between ticks, for the tick that follows it up", () => {
    const app = run(App.make(App.define({ ...options, systems: [] })));
    expect(app.settled).toBe(false);
    app.tick(1);
    app.tick(1);
    expect(app.settled).toBe(true);
    app.dispatch(Wind, { ticks: 1 });
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
  });

  it("is settled still after an action that was refused, which changed nothing", () => {
    const Ask = Action.define(
      "st/Ask",
      Schema.Struct({ refuse: Schema.Boolean })
    );
    const ask = Action.handler(Ask, function* ({ refuse }) {
      (yield* Clock.writes).left = 9;
      if (refuse) {
        return yield* Effect.fail("refused" as const);
      }
    });
    const app = run(App.make(App.define({ handlers: [ask] })));
    expect(app.settled).toBe(false);
    app.tick(1);
    app.tick(1);
    expect(app.settled).toBe(true);
    app.dispatch(Ask, { refuse: true });
    expect(app.settled).toBe(true);
    app.dispatch(Ask, { refuse: false });
    expect(app.settled).toBe(false);
  });

  it("runs the first tick of a game that was loaded, and goes on while it changes", () => {
    const made = App.make(App.define({ ...options, systems: [RunDown] }));
    const app = run(made);
    app.enqueue(Wind, { ticks: 6 });
    app.tick(1);
    app.tick(1);
    expect(worldOf(app).singleton(Clock).left).toBe(4);
    const save = app.save();
    expect(save._tag).toBe("Success");
    if (save._tag !== "Success") {
      return;
    }
    const loaded = run(
      App.make(App.define({ ...options, systems: [RunDown] }), {
        save: save.value,
      })
    );
    expect(loaded.settled).toBe(false);
    const advance = Driver.fixedStep(loaded, { hz: 10, ticks: "whenNeeded" });
    for (let i = 0; i < 50; i++) {
      advance(0.1);
    }
    expect(worldOf(loaded).singleton(Clock).left).toBe(0);
    expect(loaded.time.tick).toBe(2 + 4 + 1);
  });
});
