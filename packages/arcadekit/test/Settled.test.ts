import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

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
  Singleton,
  State,
  System,
  Ticks,
  View,
} from "../src/index";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

// --- a game that moves when its player does ----------------------------------------
// A board of pieces. A move slides them, and a piece lands a tick after it
// was moved.
const Piece = Component.define("st/Piece", { x: Field.i32 });
const Pieces = Query.all(Piece).pipe(Query.writes(Piece));
const Score = Singleton.define("st/Score", { moves: Field.i32 }, { moves: 0 });
const Phase = State.define("st/Phase", ["title", "playing"]);

const Begin = Action.define("st/Begin", Schema.Struct({}));
const Move = Action.define("st/Move", Schema.Struct({ by: Schema.Int }));
const Moved = Event.define("st/Moved", Schema.Struct({ by: Schema.Int }));
const Landed = Event.define("st/Landed", Schema.Struct({}));

/** Counts the moves it hears of. It is listed before the system that says so. */
const Tally = System.make("st/Tally", function* () {
  const heard = (yield* Landed).read();
  if (heard.length > 0) {
    (yield* Score).moves += heard.length;
  }
});
/** Says that a piece has landed, a tick after it was moved. */
const Land = System.make("st/Land", function* () {
  if ((yield* Moved).read().length > 0) {
    (yield* Landed).emit({});
  }
});
const entered: string[] = [];
const Opening = System.make("st/Opening", function* () {
  entered.push("playing");
  (yield* Commands).spawn(Piece.of({ x: 0 }));
}).pipe(State.onEnter(Phase, "playing"));

const Rules = Plugin.make("st/Rules", {
  systems: [Tally, Land, Opening],
  handlers: [
    Action.handler(Begin, function* () {
      (yield* Phase).set("playing");
    }),
    Action.handler(Move, function* ({ by }) {
      (yield* Pieces).each((piece) => {
        piece.x += by;
      });
      (yield* Moved).emit({ by });
    }),
  ],
});

describe("app.settled", () => {
  it("is true of a game with nothing waiting, once it has ticked, and stays so however it is ticked", () => {
    const app = run(App.make({ checkpointEvery: 0 }));
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
    const app = run(App.make({ plugins: [Rules] }));
    // The state it starts in is entered by its first tick.
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
    app.dispatch(Begin, {});
    expect(app.settled).toBe(false);
    expect(entered).toEqual([]);
    app.tick(1);
    expect(entered).toEqual(["playing"]);
    expect(app.settled).toBe(true);
  });

  it("is false while an action waits to be applied", () => {
    const app = run(App.make({ plugins: [Rules] }));
    app.tick(1);
    entered.length = 0;
    app.enqueue(Begin, {});
    expect(app.settled).toBe(false);
    // Applied at the start of the tick, and the state it asked for is
    // entered by the same tick: nothing is left waiting.
    app.tick(1);
    expect(entered).toEqual(["playing"]);
    expect(app.settled).toBe(true);
  });

  it("is false while an event waits that a system has not had its chance at, and no longer", () => {
    const app = run(App.make({ plugins: [Rules] }));
    app.dispatch(Begin, {});
    app.tick(1);
    app.tick(1);
    expect(app.settled).toBe(true);
    // A handler's event is heard by every system of the tick that
    // applies it: nothing waits after that tick but what a system said.
    app.enqueue(Move, { by: 2 });
    app.tick(1);
    // Land said Landed, which Tally, listed before it, has yet to hear.
    expect(app.world.singleton(Score).moves).toBe(0);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.world.singleton(Score).moves).toBe(1);
    expect(app.settled).toBe(true);
    // One emitted from outside, between two ticks, waits too.
    app.events.emit(Landed, {});
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
    expect(app.world.singleton(Score).moves).toBe(2);
    // Of whichever kind: this one, and then the one it sets off.
    app.events.emit(Moved, { by: 1 });
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
    expect(app.world.singleton(Score).moves).toBe(3);
  });

  it("does not wait for what draws: an event kept for the frame stage is nothing a tick is needed for", () => {
    const heard: number[] = [];
    const Watch = System.make("st/Watch", function* () {
      heard.push((yield* Moved).read().length + (yield* Landed).read().length);
    }).pipe(System.inStage("frame"));
    const app = run(App.make({ plugins: [Rules], systems: [Watch] }));
    app.dispatch(Begin, {});
    app.tick(1);
    app.enqueue(Move, { by: 1 });
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
    const app = run(App.make({}));
    app.tick(1);
    expect(app.settled).toBe(true);
    const ran: string[] = [];
    // As a fiber a system forked leaves the rest of itself, when what it
    // waited for arrives between two ticks: it runs when the next tick lets
    // fibers run.
    app.dispatcher.scheduleTask(() => ran.push("ran"), 0);
    expect(ran).toEqual([]);
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(ran).toEqual(["ran"]);
    expect(app.settled).toBe(true);
  });

  it("is not changed by looking, nor by the stages between ticks", () => {
    const app = run(App.make({ plugins: [Rules], checkpointEvery: 1 }));
    const before = app.world.hash();
    for (let i = 0; i < 3; i++) {
      expect(app.settled).toBe(false);
    }
    app.frame(0);
    app.input();
    expect(app.settled).toBe(false);
    expect(app.world.hash()).toBe(before);
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
    (yield* Pieces).each((piece) => {
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
  const play = () => {
    frames = 0;
    const ui = View.makeBridge();
    const source = Input.makeManualSource();
    const app = run(
      App.make({ plugins: [Game], checkpointEvery: 1, seed: 5 }).pipe(
        Effect.provide(View.layer(ui)),
        Effect.provideService(Input.Source, source)
      )
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
    const again = run(
      App.make({ plugins: [Game], checkpointEvery: 1, seed: 5 })
    );
    App.replay(again, app.actionLog, {
      delta: 1 / 60,
      ticks: app.time.tick,
    });
    expect(again.world.hash()).toBe(app.world.hash());
    expect(again.time.tick).toBe(app.time.tick);
    expect(again.world.singleton(Score).moves).toBe(2);
  });
});

// --- a system with work of its own -------------------------------------------------
// A clock that is wound by an action and runs down a tenth of a second a
// tick. Nothing an app can see is waiting while it runs: no action, no
// state, no event. The system says so itself.
const Clock = Singleton.define("st/Clock", { left: Field.i32 }, { left: 0 });
const Wind = Action.define("st/Wind", Schema.Struct({ ticks: Schema.Int }));
const wind = Action.handler(Wind, function* ({ ticks }) {
  (yield* Clock).left = ticks;
});
const windAndSay = Action.handler(Wind, function* ({ ticks }) {
  (yield* Clock).left = ticks;
  // A handler may say so too: it is the tick's.
  (yield* Ticks).more();
});
let ran = 0;
const RunDown = System.make("st/RunDown", function* () {
  ran++;
  const clock = yield* Clock;
  if (clock.left > 0) {
    clock.left -= 1;
    (yield* Ticks).more();
  }
});
/** The same clock, kept by a system that does not say it has more to do. */
const RunDownSilently = System.make("st/RunDown", function* () {
  const clock = yield* Clock;
  if (clock.left > 0) {
    clock.left -= 1;
  }
});

describe("a system that has more to do", () => {
  const options = { handlers: [wind] };

  it("says so with Ticks.more, each tick it has: the app is not settled until a tick in which nobody did", () => {
    const app = run(App.make({ ...options, systems: [RunDown] }));
    app.tick(1);
    expect(app.settled).toBe(true);
    // The action waits; applied, the clock runs, and each tick asks.
    app.enqueue(Wind, { ticks: 3 });
    expect(app.settled).toBe(false);
    const settled: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      app.tick(1);
      settled.push(app.settled);
    }
    // Three ticks with more to do; the fourth finds it run down.
    expect(settled).toEqual([false, false, false, true, true]);
    expect(app.world.singleton(Clock).left).toBe(0);
    // Looking does not change it, and nor do the stages between ticks.
    app.dispatch(Wind, { ticks: 1 });
    expect(app.settled).toBe(true);
    app.tick(1);
    for (let i = 0; i < 3; i++) {
      app.frame(0);
      app.input();
      expect(app.settled).toBe(false);
    }
  });

  it("keeps a game that ticks when it is needed going for as long as it asks, and no longer", () => {
    ran = 0;
    const app = run(App.make({ ...options, systems: [RunDown] }));
    const advance = Driver.fixedStep(app, { hz: 10, ticks: "whenNeeded" });
    const frames = (count: number): void => {
      for (let i = 0; i < count; i++) {
        advance(0.1);
      }
    };
    // A new game runs a tick to be asked in, and the one after it.
    frames(50);
    expect(app.time.tick).toBe(2);
    app.enqueue(Wind, { ticks: 20 });
    frames(10);
    // Half way down, and still going: a tick a frame.
    expect(app.world.singleton(Clock).left).toBe(10);
    expect(app.time.tick).toBe(12);
    frames(100);
    // Twenty ticks of the clock, the one that found it at nothing, and the
    // one that follows the last; then rest.
    expect(app.world.singleton(Clock).left).toBe(0);
    expect(app.time.tick).toBe(2 + 20 + 2);
    expect(ran).toBe(app.time.tick);

    // The same clock kept by a system that does not say: the action is
    // applied, one tick follows it, and the game rests with the clock
    // still wound.
    const silent = run(App.make({ ...options, systems: [RunDownSilently] }));
    const step = Driver.fixedStep(silent, { hz: 10, ticks: "whenNeeded" });
    step(0.1);
    step(0.1);
    silent.enqueue(Wind, { ticks: 20 });
    for (let i = 0; i < 100; i++) {
      step(0.1);
    }
    expect(silent.world.singleton(Clock).left).toBe(18);
  });

  it("is heard from a handler, and changes nothing of a game that ticks in real time", () => {
    const app = run(App.make({ handlers: [windAndSay], systems: [] }));
    app.tick(1);
    expect(app.settled).toBe(true);
    // Dispatched between two ticks, the handler has run: the game is
    // asked for a tick though nothing waits.
    app.dispatch(Wind, { ticks: 1 });
    expect(app.settled).toBe(false);
    app.tick(1);
    expect(app.settled).toBe(true);
    // In real time every tick runs whoever asks: the same game, tick for
    // tick, as one whose system says nothing.
    const said = run(
      App.make({ ...options, systems: [RunDown], checkpointEvery: 1 })
    );
    const unsaid = run(
      App.make({ ...options, systems: [RunDownSilently], checkpointEvery: 1 })
    );
    for (const one of [said, unsaid]) {
      one.enqueue(Wind, { ticks: 4 });
      Driver.fixedStep(one, { hz: 10 })(1);
    }
    expect(said.time.tick).toBe(5);
    expect(said.world.hash()).toBe(unsaid.world.hash());
    expect(said.actionLog).toEqual(unsaid.actionLog);
  });

  it("is asked again of a game that was loaded: the first tick of an app is always run", () => {
    const made = App.make({ ...options, systems: [RunDown] });
    const app = run(made);
    app.enqueue(Wind, { ticks: 6 });
    app.tick(1);
    app.tick(1);
    expect(app.world.singleton(Clock).left).toBe(4);
    const save = app.save();
    expect(save._tag).toBe("Success");
    if (save._tag !== "Success") {
      return;
    }
    // Loaded in the middle of the clock's run. What the system asked is
    // not in the save; the first tick asks it afresh.
    const loaded = run(
      App.load(save.value, { ...options, systems: [RunDown] })
    );
    expect(loaded.settled).toBe(false);
    const advance = Driver.fixedStep(loaded, { hz: 10, ticks: "whenNeeded" });
    for (let i = 0; i < 50; i++) {
      advance(0.1);
    }
    expect(loaded.world.singleton(Clock).left).toBe(0);
    expect(loaded.time.tick).toBe(2 + 4 + 2);
  });

  it("is the tick's to say: between ticks it throws, and says where it belongs", () => {
    for (const stage of ["frame", "input", "preFrame", "postFrame"] as const) {
      const Pushy = System.make("st/Pushy", function* () {
        (yield* Ticks).more();
      }).pipe(System.inStage(stage));
      const app = run(App.make({ systems: [Pushy] }));
      app.tick(1, { input: false });
      const between = (): void =>
        stage === "input" ? app.input() : app.frame(0);
      expect(between, stage).toThrow(
        "Ticks.more was called in the frame stage or the input stage"
      );
      // And nothing came of it.
      expect(app.settled, stage).toBe(true);
    }
  });
});
