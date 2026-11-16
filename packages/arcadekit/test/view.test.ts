import { Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Field,
  Plugin,
  Query,
  Singleton,
  State,
  System,
  Time,
  View,
} from "../src/index";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

// --- a game with a heads-up display and a menu -------------------------------------
const Coin = Component.define("vw/Coin", { value: Field.i32 });
const Coins = Query.all(Coin);
const Purse = Singleton.define("vw/Purse", { gold: Field.i32 }, { gold: 0 });
const Phase = State.define("vw/Phase", ["title", "playing"]);

// What the UI may see.
const Hud = View.define("vw/Hud", { gold: 0, coins: 0 });
const Menu = View.define("vw/Menu", { phase: "title" as "title" | "playing" });
// What it may ask for.
const Start = Action.define("vw/Start", Schema.Struct({}));
const Buy = Action.define("vw/Buy", Schema.Struct({ price: Schema.Int }));
const Ping = Action.define<void>()("vw/Ping");

class TooPoor extends Data.TaggedError("TooPoor")<{}> {}

/** How often each view was worked out. */
const worked = { hud: 0, menu: 0 };
const ShowHud = View.publish(Hud, function* () {
  worked.hud++;
  return { gold: (yield* Purse).gold, coins: (yield* Coins).count() };
});
const ShowMenu = View.publish(Menu, function* () {
  worked.menu++;
  return { phase: (yield* Phase).value };
});

/** A coin is worth one more gold each tick it is kept, while the game is played. */
const Earn = System.make("vw/Earn", function* () {
  const purse = yield* Purse;
  let earned = 0;
  (yield* Coins).each((coin) => {
    earned += coin.value;
  });
  if (earned > 0) {
    purse.gold += earned;
  }
}).pipe(System.runIf(State.is(Phase, "playing")));

let pings = 0;
const Game = Plugin.make("vw/Game", {
  plugins: [View.plugin],
  components: [Coin, Purse, Phase],
  systems: [Earn, ShowHud, ShowMenu],
  handlers: [
    Action.handler(Start, function* () {
      (yield* Phase).set("playing");
    }),
    Action.handler(Buy, function* ({ price }) {
      const purse = yield* Purse;
      if (purse.gold < price) {
        return yield* Effect.fail(new TooPoor());
      }
      purse.gold -= price;
      (yield* Commands).spawn(Coin.of({ value: 1 }));
    }),
    Action.handler(Ping, function* () {
      pings++;
    }),
  ],
});

const play = (ui: View.Bridge | undefined, seed = 1) => {
  worked.hud = 0;
  worked.menu = 0;
  const made = App.make({ plugins: [Game], seed, checkpointEvery: 1 });
  return run(
    ui === undefined ? made : made.pipe(Effect.provide(View.layer(ui)))
  );
};

/** A UI that only notes what it is told. */
const listen = <A>(ui: View.Bridge, view: View.View<A>) => {
  const heard: A[] = [];
  const stop = ui.subscribe(view, (value) => {
    heard.push(value);
  });
  return { heard, stop };
};

describe("a view", () => {
  it("has its initial value until the game publishes, and then what the game last said", () => {
    const ui = View.makeBridge();
    // A UI can be there before the game is.
    expect(ui.get(Hud)).toEqual({ gold: 0, coins: 0 });
    expect(ui.get(Hud)).toBe(Hud.initial);
    expect(ui.get(Menu)).toEqual({ phase: "title" });
    const app = play(ui);
    app.world.spawn(Coin.of({ value: 5 }));
    // Making the app publishes nothing: a frame does.
    expect(ui.get(Hud)).toBe(Hud.initial);
    app.frame(0);
    expect(ui.get(Hud)).toEqual({ gold: 0, coins: 1 });
    expect(ui.get(Menu)).toEqual({ phase: "title" });
    app.dispatch(Start, {});
    app.tick(1);
    // A tick publishes nothing either.
    expect(ui.get(Hud)).toEqual({ gold: 0, coins: 1 });
    app.frame(0);
    expect(ui.get(Hud)).toEqual({ gold: 5, coins: 1 });
    expect(ui.get(Menu)).toEqual({ phase: "playing" });
  });

  it("is published once per frame, and only when it changed: a value that did not change costs the UI nothing", () => {
    const ui = View.makeBridge();
    const hud = listen(ui, Hud);
    const menu = listen(ui, Menu);
    const app = play(ui);
    app.world.spawn(Coin.of({ value: 2 }));
    app.frame(0);
    // The menu is as it was at first: nobody is told. The display is not.
    expect(menu.heard).toEqual([]);
    expect(hud.heard).toEqual([{ gold: 0, coins: 1 }]);
    const shown = ui.get(Hud);
    const first = ui.get(Menu);
    // Frames, and ticks of a game that is not played yet: nothing changes.
    for (let i = 0; i < 20; i++) {
      app.tick(1);
      app.frame(0);
      app.frame(0.5);
    }
    expect(hud.heard.length).toBe(1);
    expect(menu.heard.length).toBe(0);
    // What the UI holds is the very object it held: `===` tells it so.
    expect(ui.get(Hud)).toBe(shown);
    expect(ui.get(Menu)).toBe(first);
    expect(first).toBe(Menu.initial);
    // The game worked each out every frame; that is all it cost.
    expect(worked).toEqual({ hud: 41, menu: 41 });
    app.dispatch(Start, {});
    // Several ticks, then one frame: told once, of the latest.
    app.tick(1);
    app.tick(1);
    app.tick(1);
    app.frame(0);
    expect(hud.heard).toEqual([
      { gold: 0, coins: 1 },
      { gold: 6, coins: 1 },
    ]);
    expect(menu.heard).toEqual([{ phase: "playing" }]);
    expect(ui.get(Hud)).not.toBe(shown);
    // And once more, nothing.
    app.frame(0.3);
    app.frame(0.6);
    expect(hud.heard.length).toBe(2);
    expect(menu.heard.length).toBe(1);
  });

  it("is compared as data, however deep, and not by the object that holds it", () => {
    const Board = View.define("vw/Board", {
      rows: [[0, 0]] as number[][],
      turn: { player: 1, note: undefined as string | undefined },
    });
    const ui = View.makeBridge();
    const { heard } = listen(ui, Board);
    const values = [
      { rows: [[0, 0]], turn: { player: 1, note: undefined } },
      { rows: [[0, 0]], turn: { player: 1, note: undefined } },
      { rows: [[0, 1]], turn: { player: 1, note: undefined } },
      { rows: [[0, 1]], turn: { player: 1, note: undefined } },
      { rows: [[0, 1], []], turn: { player: 1, note: undefined } },
      { rows: [[0, 1], []], turn: { player: 2, note: undefined } },
      { rows: [[0, 1], []], turn: { player: 2, note: "check" } },
      { rows: [[0, 1], []], turn: { player: 2, note: "check" } },
    ];
    let frame = 0;
    const Show = View.publish(Board, function* () {
      return values[frame]!;
    });
    const app = run(
      App.make({ plugins: [View.plugin], systems: [Show] }).pipe(
        Effect.provide(View.layer(ui))
      )
    );
    for (frame = 0; frame < values.length; frame++) {
      app.frame(0);
    }
    expect(heard).toEqual([values[2], values[4], values[5], values[6]]);
    expect(heard[0]).toBe(values[2]);
    expect(ui.get(Board)).toBe(values[6]);
  });

  it("is told to every listener there is, and to none that has stopped", () => {
    const ui = View.makeBridge();
    const a = listen(ui, Hud);
    const b = listen(ui, Hud);
    const app = play(ui);
    const coin = app.world.spawn(Coin.of({ value: 1 }));
    app.frame(0);
    expect(a.heard).toEqual([{ gold: 0, coins: 1 }]);
    expect(b.heard).toEqual(a.heard);
    a.stop();
    // Stopping twice is stopping once.
    a.stop();
    app.world.despawn(coin);
    app.frame(0);
    expect(a.heard.length).toBe(1);
    expect(b.heard).toEqual([
      { gold: 0, coins: 1 },
      { gold: 0, coins: 0 },
    ]);
    // A listener that stops itself, or another, while being told.
    const order: string[] = [];
    const stopOnce = ui.subscribe(Hud, () => {
      order.push("once");
      stopOnce();
      stopLater();
    });
    const stopLater = ui.subscribe(Hud, () => {
      order.push("later");
    });
    app.world.spawn(Coin.of({ value: 1 }));
    app.frame(0);
    app.world.spawn(Coin.of({ value: 1 }));
    app.frame(0);
    expect(order).toEqual(["once"]);
    expect(b.heard.length).toBe(4);
  });

  it("fails the frame with what a listener threw, once every other listener was told", () => {
    const ui = View.makeBridge();
    ui.subscribe(Hud, () => {
      throw new Error("the label is gone");
    });
    const after = listen(ui, Hud);
    // A second one that throws: it is the first that the frame fails with.
    ui.subscribe(Hud, () => {
      throw new Error("and so is the button");
    });
    const app = play(ui);
    app.world.spawn(Coin.of({ value: 1 }));
    expect(() => app.frame(0)).toThrow("the label is gone");
    expect(after.heard).toEqual([{ gold: 0, coins: 1 }]);
    // The value was published: the next frame has nothing new to say.
    expect(ui.get(Hud)).toEqual({ gold: 0, coins: 1 });
    app.frame(0);
    expect(after.heard.length).toBe(1);
  });

  it("is not worked out at all where there is no UI", () => {
    const app = play(undefined);
    app.world.spawn(Coin.of({ value: 1 }));
    for (let i = 0; i < 5; i++) {
      app.tick(1);
      app.frame(0);
    }
    expect(worked).toEqual({ hud: 0, menu: 0 });
    // With one, once per frame.
    const withUi = play(View.makeBridge());
    withUi.frame(0);
    withUi.frame(0);
    expect(worked).toEqual({ hud: 2, menu: 2 });
  });

  it("keeps the value it had while the system that publishes it does not run", () => {
    const Shown = View.publish(Hud, function* () {
      return { gold: (yield* Purse).gold, coins: 0 };
    }).pipe(System.runIf(State.is(Phase, "playing")));
    const Rules = Plugin.make("vw/Gated", {
      plugins: [View.plugin],
      components: [Purse, Phase],
      systems: [Shown],
      handlers: [
        Action.handler(Start, function* () {
          (yield* Phase).set("playing");
        }),
      ],
    });
    const ui = View.makeBridge();
    const { heard } = listen(ui, Hud);
    const app = run(
      App.make({ plugins: [Rules] }).pipe(Effect.provide(View.layer(ui)))
    );
    app.world.singleton(Purse).gold = 9;
    app.frame(0);
    expect(heard).toEqual([]);
    expect(ui.get(Hud)).toBe(Hud.initial);
    app.dispatch(Start, {});
    app.tick(1);
    app.frame(0);
    expect(heard).toEqual([{ gold: 9, coins: 0 }]);
    expect(Shown.name).toBe("View.publish(vw/Hud)");
    expect(Shown.stage).toBe("frame");
  });

  it("can be published by a frame system of the game's own, through the port, and not from the tick", () => {
    const told: boolean[] = [];
    const Own = System.make("vw/Own", function* () {
      const port = yield* View.Port;
      const { tick } = yield* Time;
      told.push(port.publish(Hud, { gold: tick, coins: 0 }));
    }).pipe(System.inStage("frame"));
    const ui = View.makeBridge();
    const { heard } = listen(ui, Hud);
    const app = run(
      App.make({ plugins: [View.plugin], systems: [Own] }).pipe(
        Effect.provide(View.layer(ui))
      )
    );
    app.frame(0);
    app.tick(1);
    app.frame(0);
    app.frame(0);
    // Whether each was news: the first is what the view was at first.
    expect(told).toEqual([false, true, false]);
    expect(heard).toEqual([{ gold: 1, coins: 0 }]);

    const InTick = System.make("vw/InTick", function* () {
      (yield* View.Port).publish(Hud, { gold: 1, coins: 1 });
    });
    const other = View.makeBridge();
    const wrong = run(
      App.make({ plugins: [View.plugin], systems: [InTick] }).pipe(
        Effect.provide(View.layer(other))
      )
    );
    expect(() => wrong.tick(1)).toThrow(
      'The view "vw/Hud" was published in the tick'
    );
    expect(other.get(Hud)).toBe(Hud.initial);
  });

  it("is known by its name: a bridge refuses two different views with one", () => {
    const ui = View.makeBridge();
    const twin = View.define("vw/Hud", { gold: 0, coins: 0 });
    ui.get(Hud);
    expect(() => ui.get(twin)).toThrow(
      'Two different views are both named "vw/Hud"'
    );
    expect(() => ui.subscribe(twin, () => {})).toThrow("vw/Hud");
    // On another bridge it is the first of its name.
    expect(View.makeBridge().get(twin)).toBe(twin.initial);
  });
});

describe("what the UI sends", () => {
  it("is issued before the next tick, in the order it was sent, and is in the log like any input", () => {
    const ui = View.makeBridge();
    const app = play(ui);
    app.world.singleton(Purse).gold = 5;
    ui.send(Buy, { price: 3 });
    ui.send(Start, {});
    ui.send(Buy, { price: 4 });
    // Nothing happens until the game takes it.
    expect(
      app.actionLog.filter((entry) => !Action.isCheckpoint(entry))
    ).toEqual([]);
    expect(app.world.singleton(Purse).gold).toBe(5);
    app.input();
    expect(
      app.actionLog.filter((entry) => !Action.isCheckpoint(entry))
    ).toEqual([
      { tick: 0, name: "vw/Buy", payload: { price: 3 }, queued: true },
      { tick: 0, name: "vw/Start", payload: {}, queued: true },
      { tick: 0, name: "vw/Buy", payload: { price: 4 }, queued: true },
    ]);
    // Applied by the tick: the second purchase is refused by the rules.
    app.tick(1);
    expect(app.world.view(Coins).count()).toBe(1);
    // Three spent, and one earned by the coin it bought, once the game began.
    expect(app.world.singleton(Purse).gold).toBe(3);
    app.frame(0);
    expect(ui.get(Menu)).toEqual({ phase: "playing" });
    const logged = app.actionLog.filter(
      (entry): entry is Action.Logged => !Action.isCheckpoint(entry)
    );
    expect(logged.map((entry) => entry.refused)).toEqual([
      undefined,
      undefined,
      "TooPoor",
    ]);
    // Taken once: the next run of the stage has nothing to issue.
    app.input();
    app.tick(1);
    expect(
      app.actionLog.filter((entry) => !Action.isCheckpoint(entry)).length
    ).toBe(3);
  });

  it("needs no payload for an action that takes none", () => {
    const ui = View.makeBridge();
    const app = play(ui);
    pings = 0;
    ui.send(Ping);
    ui.send(Ping, undefined);
    app.input();
    app.tick(1);
    expect(pings).toBe(2);
    // @ts-expect-error Buy needs its price
    ui.send(Buy);
    // @ts-expect-error and of the right type
    ui.send(Buy, { price: "three" });
  });

  it("waits for a game: a UI mounted first is heard when the game is made", () => {
    const ui = View.makeBridge();
    ui.send(Start, {});
    const app = play(ui);
    const menu = listen(ui, Menu);
    app.input();
    app.tick(1);
    app.frame(0);
    expect(menu.heard).toEqual([{ phase: "playing" }]);
  });

  it("is issued by a driver before each tick, so a button is as good as a key", () => {
    const ui = View.makeBridge();
    const app = play(ui);
    const advance = Driver.fixedStep(app, { hz: 10 });
    const menu = listen(ui, Menu);
    advance(0.1);
    expect(menu.heard).toEqual([]);
    ui.send(Start, {});
    // A frame in which no tick is due issues nothing, and loses nothing.
    advance(0.01);
    expect(menu.heard).toEqual([]);
    advance(0.1);
    expect(menu.heard).toEqual([{ phase: "playing" }]);
  });

  it("replays with no UI: the log holds what it sent, and the game goes the same way", () => {
    const ui = View.makeBridge();
    const app = play(ui, 11);
    app.world.spawn(Coin.of({ value: 1 }));
    const hashes: number[] = [];
    const step = (): void => {
      app.input();
      app.tick(1);
      app.frame(0);
      hashes.push(app.world.hash());
    };
    step();
    ui.send(Start, {});
    step();
    step();
    ui.send(Buy, { price: 2 });
    ui.send(Buy, { price: 50 });
    step();
    step();
    expect(app.world.view(Coins).count()).toBe(2);

    // No bridge, no input stage and no frame: a server, or a replay.
    const again = play(undefined, 11);
    again.world.spawn(Coin.of({ value: 1 }));
    App.replay(again, app.actionLog, { delta: 1, ticks: 5 });
    expect(again.world.hash()).toBe(hashes.at(-1));
    expect(again.world.view(Coins).count()).toBe(2);
    // And the same game with no UI at all, given nothing, differs.
    const idle = play(undefined, 11);
    idle.world.spawn(Coin.of({ value: 1 }));
    for (let i = 0; i < 5; i++) {
      idle.input();
      idle.tick(1);
      idle.frame(0);
    }
    expect(idle.world.hash()).not.toBe(hashes.at(-1));
  });

  it("is a bug when the game has no handler for it: the input stage throws", () => {
    const Unknown = Action.define("vw/Unknown", Schema.Struct({}));
    const ui = View.makeBridge();
    const app = play(ui);
    ui.send(Unknown, {});
    expect(() => app.input()).toThrow('No handler for action "vw/Unknown"');
  });

  it("cannot be sent to the bridge that stands for no UI", () => {
    const seen: View.Bridge[] = [];
    const Spy = System.make("vw/Spy", function* () {
      seen.push(yield* View.Bridge);
    }).pipe(System.inStage("frame"));
    const app = run(App.make({ plugins: [View.plugin], systems: [Spy] }));
    app.frame(0);
    const none = seen[0]!;
    expect(none.get(Hud)).toBe(Hud.initial);
    none.subscribe(Hud, () => {
      throw new Error("never told");
    })();
    expect(() => none.send(Start, {})).toThrow("stands for no UI");
  });
});

describe("the bridge", () => {
  it("leaves the game as it found it: with a UI or with none, the game is the same game", () => {
    const ui = View.makeBridge();
    listen(ui, Hud);
    const seen = App.make({
      plugins: [Game],
      seed: 4,
      checkpointEvery: 1,
      verifyFrames: true,
    }).pipe(Effect.provide(View.layer(ui)));
    const watched = run(seen);
    const alone = play(undefined, 4);
    for (const app of [watched, alone]) {
      app.world.spawn(Coin.of({ value: 3 }));
      app.dispatch(Start, {});
    }
    for (let i = 0; i < 30; i++) {
      watched.input();
      watched.tick(1);
      watched.frame(0.5);
      alone.tick(1);
      expect(watched.world.hash()).toBe(alone.world.hash());
    }
    expect(watched.actionLog).toEqual(alone.actionLog);
    const saves = [watched.save(), alone.save()].map((save) =>
      Exit.isSuccess(save) ? save.value : undefined
    );
    expect(saves[0]).toBeDefined();
    expect(saves[0]).toEqual(saves[1]);
    expect(ui.get(Hud)).toEqual({ gold: 90, coins: 1 });
  });

  it("is what a plugin's systems need: a game that publishes and leaves out View.plugin does not compile", () => {
    const made = App.make({ systems: [ShowHud], components: [Purse] });
    // @ts-expect-error View.Port is still needed: View.plugin provides it
    const complete: Effect.Effect<unknown, never, Scope.Scope> = made;
    const withPlugin: Effect.Effect<unknown, never, Scope.Scope> = App.make({
      plugins: [View.plugin],
      systems: [ShowHud],
      components: [Purse],
    });
    expect(complete).toBe(made);
    expect(withPlugin).not.toBe(made);
  });
});
