import { Data, Effect, Exit, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Driver,
  Field,
  Journal,
  Plugin,
  Query,
  Singleton,
  State,
  System,
  Time,
  View,
  World,
} from "../src/index";

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
const Ping = Action.define("vw/Ping");

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
const Earn = System.tick("vw/Earn", function* () {
  const purse = yield* Purse.writes;
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
  systems: [Earn, ShowHud, ShowMenu],
  handlers: [
    Action.handler(Start, function* () {
      (yield* Phase.sets).set("playing");
    }),
    Action.handler(Buy, function* ({ price }) {
      const purse = yield* Purse.writes;
      if (purse.gold < price) {
        return yield* new TooPoor();
      }
      purse.gold -= price;
      (yield* Commands.spawns(Coin)).spawn(Coin.of({ value: 1 }));
    }),
    Action.handler(Ping, function* () {
      pings++;
    }),
  ],
});
/** The game a UI is made for: `play` begins it as it is told. */
const Played = App.define({ plugins: [Game] });

/** What a game begins with: coins of these values, and gold in the purse. */
interface Begun {
  readonly coins?: readonly number[];
  readonly gold?: number;
}
const begun = ({ coins = [], gold }: Begun) =>
  Plugin.make("vw/Begun", {
    setup: Effect.gen(function* () {
      const commands = yield* Commands.spawns(Coin);
      for (const value of coins) {
        commands.spawn(Coin.of({ value }));
      }
      if (gold !== undefined) {
        (yield* Purse.writes).gold = gold;
      }
    }),
  });

const play = (
  ui: View.Bridge | undefined,
  { seed = 1, ...start }: Begun & { readonly seed?: number } = {}
) => {
  worked.hud = 0;
  worked.menu = 0;
  const made = App.make(App.define({ plugins: [Game, begun(start)] }), {
    seed,
    checkpointEvery: 1,
  });
  return Effect.runSync(
    ui === undefined ? made : made.pipe(Effect.provide(View.layer(ui)))
  );
};

// What the game above has no handler for.
const Unknown = Action.define("vw/Unknown", Schema.Struct({}));

const isAction = (entry: Action.LogEntry): entry is Action.Logged =>
  !Action.isCheckpoint(entry);

const coinsOf = (app: App.Any): number =>
  Effect.runSync(app.read(Coins)).count();
const goldOf = (app: App.Any): number => Effect.runSync(app.read(Purse)).gold;
const hashOf = (app: App.Any): number => Effect.runSync(app.read(World)).hash();

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
    const ui = View.makeBridge(Played);
    // A UI can be there before the game is.
    expect(ui.get(Hud)).toEqual({ gold: 0, coins: 0 });
    expect(ui.get(Hud)).toBe(Hud.initial);
    expect(ui.get(Menu)).toEqual({ phase: "title" });
    const app = play(ui, { coins: [5] });
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
    const ui = View.makeBridge(Played);
    const hud = listen(ui, Hud);
    const menu = listen(ui, Menu);
    const app = play(ui, { coins: [2] });
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
    const Boards = App.define({ plugins: [View.plugin], systems: [Show] });
    const ui = View.makeBridge(Boards);
    const { heard } = listen(ui, Board);
    const app = Effect.runSync(
      App.make(Boards).pipe(Effect.provide(View.layer(ui)))
    );
    for (frame = 0; frame < values.length; frame++) {
      app.frame(0);
    }
    expect(heard).toEqual([values[2], values[4], values[5], values[6]]);
    expect(heard[0]).toBe(values[2]);
    expect(ui.get(Board)).toBe(values[6]);
  });

  it("is told to every listener there is, and to none that has stopped", () => {
    // A coin can be found, and every coin lost.
    const Find = Action.define("vw/Find", Schema.Struct({ value: Schema.Int }));
    const Lose = Action.define("vw/Lose", Schema.Struct({}));
    const Chance = Plugin.make("vw/Chance", {
      handlers: [
        Action.handler(Find, function* ({ value }) {
          (yield* Commands.spawns(Coin)).spawn(Coin.of({ value }));
        }),
        Action.handler(Lose, function* () {
          const commands = yield* Commands;
          for (const coin of (yield* Coins).entities()) {
            commands.despawn(coin);
          }
        }),
      ],
    });
    const Lucky = App.define({ plugins: [Game, Chance] });
    const ui = View.makeBridge(Lucky);
    const a = listen(ui, Hud);
    const b = listen(ui, Hud);
    const app = Effect.runSync(
      App.make(Lucky).pipe(Effect.provide(View.layer(ui)))
    );
    app.dispatch(Find, { value: 1 });
    app.frame(0);
    expect(a.heard).toEqual([{ gold: 0, coins: 1 }]);
    expect(b.heard).toEqual(a.heard);
    a.stop();
    // Stopping twice is stopping once.
    a.stop();
    app.dispatch(Lose, {});
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
    app.dispatch(Find, { value: 1 });
    app.frame(0);
    app.dispatch(Find, { value: 1 });
    app.frame(0);
    expect(order).toEqual(["once"]);
    expect(b.heard.length).toBe(4);
  });

  it("fails the frame with what a listener threw, once every other listener was told", () => {
    const ui = View.makeBridge(Played);
    ui.subscribe(Hud, () => {
      throw new Error("the label is gone");
    });
    const after = listen(ui, Hud);
    // A second one that throws: it is the first that the frame fails with.
    ui.subscribe(Hud, () => {
      throw new Error("and so is the button");
    });
    const app = play(ui, { coins: [1] });
    expect(() => app.frame(0)).toThrow("the label is gone");
    expect(after.heard).toEqual([{ gold: 0, coins: 1 }]);
    // The value was published: the next frame has nothing new to say.
    expect(ui.get(Hud)).toEqual({ gold: 0, coins: 1 });
    app.frame(0);
    expect(after.heard.length).toBe(1);
  });

  it("is not worked out at all where there is no UI", () => {
    const app = play(undefined, { coins: [1] });
    for (let i = 0; i < 5; i++) {
      app.tick(1);
      app.frame(0);
    }
    expect(worked).toEqual({ hud: 0, menu: 0 });
    // With one, once per frame.
    const withUi = play(View.makeBridge(Played));
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
      systems: [Shown],
      handlers: [
        Action.handler(Start, function* () {
          (yield* Phase.sets).set("playing");
        }),
      ],
    });
    const Gated = App.define({ plugins: [Rules, begun({ gold: 9 })] });
    const ui = View.makeBridge(Gated);
    const { heard } = listen(ui, Hud);
    const app = Effect.runSync(
      App.make(Gated).pipe(Effect.provide(View.layer(ui)))
    );
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

  it("is put back to its first value while its system does not run, when the system says so", () => {
    const Quit = Action.define("vw/Quit", Schema.Struct({}));
    const Shown = View.publish(Hud, function* () {
      return { gold: (yield* Purse).gold, coins: 0 };
    }).pipe(
      System.runIf(State.is(Phase, "playing")),
      System.otherwise(View.reset(Hud))
    );
    const Rules = Plugin.make("vw/Reset", {
      plugins: [View.plugin],
      systems: [Shown],
      handlers: [
        Action.handler(Start, function* () {
          (yield* Phase.sets).set("playing");
        }),
        Action.handler(Quit, function* () {
          (yield* Phase.sets).set("title");
        }),
      ],
    });
    const Reset = App.define({ plugins: [Rules, begun({ gold: 9 })] });
    const ui = View.makeBridge(Reset);
    const { heard } = listen(ui, Hud);
    const made = App.make(Reset);
    const app = Effect.runSync(made.pipe(Effect.provide(View.layer(ui))));
    const step = (action?: typeof Start | typeof Quit): void => {
      if (action !== undefined) {
        app.dispatch(action, {});
      }
      app.tick(1);
      app.frame(0);
    };
    // At the title it is what it was defined as, and nobody is told so.
    step();
    step();
    expect(heard).toEqual([]);
    step(Start);
    expect(heard).toEqual([{ gold: 9, coins: 0 }]);
    // The game goes back to the title: the gold of the game that was left
    // is not left on the screen. Told once, however long it stays there.
    step(Quit);
    step();
    step();
    expect(heard).toEqual([{ gold: 9, coins: 0 }, Hud.initial]);
    expect(ui.get(Hud)).toBe(Hud.initial);
    step(Start);
    expect(heard.at(-1)).toEqual({ gold: 9, coins: 0 });
    // Where no UI is there, it publishes to nobody and asks nothing more
    // than the port.
    const alone = Effect.runSync(made);
    alone.dispatch(Start, {});
    alone.tick(1);
    alone.frame(0);
    alone.dispatch(Quit, {});
    alone.tick(1);
    alone.frame(0);
    const needs: Effect.Effect<void, never, View.Port> = View.reset(Hud);
    expect(Effect.isEffect(needs)).toBe(true);
  });

  it("can be published by a frame system of the game's own, through the port, and not from the tick", () => {
    const told: boolean[] = [];
    const Own = System.frame("vw/Own", function* () {
      const port = yield* View.Port;
      const { tick } = yield* Time;
      told.push(port.publish(Hud, { gold: tick, coins: 0 }));
    });
    const Owned = App.define({ plugins: [View.plugin], systems: [Own] });
    const ui = View.makeBridge(Owned);
    const { heard } = listen(ui, Hud);
    const app = Effect.runSync(
      App.make(Owned).pipe(Effect.provide(View.layer(ui)))
    );
    app.frame(0);
    app.tick(1);
    app.frame(0);
    app.frame(0);
    // Whether each was news: the first is what the view was at first.
    expect(told).toEqual([false, true, false]);
    expect(heard).toEqual([{ gold: 1, coins: 0 }]);

    System.tick(
      "vw/InTick",
      // @ts-expect-error a view is published from the frame
      function* () {
        (yield* View.Port).publish(Hud, { gold: 1, coins: 1 });
      }
    );
  });

  it("is known by its name: a bridge refuses two different views with one", () => {
    const ui = View.makeBridge(Played);
    const twin = View.define("vw/Hud", { gold: 0, coins: 0 });
    ui.get(Hud);
    expect(() => ui.get(twin)).toThrow(
      'Two different views are both named "vw/Hud"'
    );
    expect(() => ui.subscribe(twin, () => {})).toThrow("vw/Hud");
    // On another bridge it is the first of its name.
    expect(View.makeBridge(Played).get(twin)).toBe(twin.initial);
  });
});

describe("what the UI sends", () => {
  it("is heard when the input stage runs, which a tick alone does not, and by a replay not at all", () => {
    // The game, begun with gold to spend.
    const Funded = App.define({ plugins: [Game, begun({ gold: 5 })] });
    const ui = View.makeBridge(Funded);
    const app = Effect.runSync(
      App.make(Funded, { seed: 1, checkpointEvery: 1 }).pipe(
        Effect.provide(View.layer(ui))
      )
    );
    ui.send(Buy, { price: 3 });
    ui.send(Start, {});
    // A tick alone hears none of it.
    app.tick(1);
    expect(goldOf(app)).toBe(5);
    app.input();
    app.tick(1);
    expect(coinsOf(app)).toBe(1);
    expect(goldOf(app)).toBe(3);
    const recording = app.record();
    expect(
      recording.log
        .filter((entry) => !Action.isCheckpoint(entry))
        .map((entry) => (Action.isCheckpoint(entry) ? "" : entry.name))
    ).toEqual(["vw/Buy", "vw/Start"]);
    // A replay with a UI of its own that is sending things is told what
    // the log says and nothing else.
    const other = View.makeBridge(Funded);
    other.send(Buy, { price: 1 });
    other.send(Buy, { price: 1 });
    const again = Effect.runSync(
      Journal.replay(recording, Funded, { checkpointEvery: 1 }).pipe(
        Effect.provide(View.layer(other))
      )
    );
    expect(hashOf(again)).toBe(hashOf(app));
    expect(coinsOf(again)).toBe(1);
    expect(
      again.actionLog.filter((entry) => !Action.isCheckpoint(entry)).length
    ).toBe(2);
  });

  it("is issued before the next tick, in the order it was sent, and is in the log like any input", () => {
    const ui = View.makeBridge(Played);
    const app = play(ui, { gold: 5 });
    ui.send(Buy, { price: 3 });
    ui.send(Start, {});
    ui.send(Buy, { price: 4 });
    // Nothing happens until the game takes it.
    expect(
      app.actionLog.filter((entry) => !Action.isCheckpoint(entry))
    ).toEqual([]);
    expect(goldOf(app)).toBe(5);
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
    expect(coinsOf(app)).toBe(1);
    // Three spent, and one earned by the coin it bought, once the game began.
    expect(goldOf(app)).toBe(3);
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
    const ui = View.makeBridge(Played);
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
    const ui = View.makeBridge(Played);
    ui.send(Start, {});
    const app = play(ui);
    const menu = listen(ui, Menu);
    app.input();
    app.tick(1);
    app.frame(0);
    expect(menu.heard).toEqual([{ phase: "playing" }]);
  });

  it("is issued by a driver before each tick, so a button is as good as a key", () => {
    const ui = View.makeBridge(Played);
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
    // The game, begun with a coin.
    const Kept = App.define({ plugins: [Game, begun({ coins: [1] })] });
    const start = { seed: 11, checkpointEvery: 1 } as const;
    const ui = View.makeBridge(Kept);
    const app = Effect.runSync(
      App.make(Kept, start).pipe(Effect.provide(View.layer(ui)))
    );
    const hashes: number[] = [];
    const step = (): void => {
      app.input();
      app.tick(1);
      app.frame(0);
      hashes.push(hashOf(app));
    };
    step();
    ui.send(Start, {});
    step();
    step();
    ui.send(Buy, { price: 2 });
    ui.send(Buy, { price: 50 });
    step();
    step();
    expect(coinsOf(app)).toBe(2);

    // No bridge, no input stage and no frame: a server, or a replay.
    const played = app.record();
    const again = Effect.runSync(
      Journal.replay(played, Kept, { checkpointEvery: 1 })
    );
    expect(hashOf(again)).toBe(hashes.at(-1));
    expect(coinsOf(again)).toBe(2);
    // And the same game with no UI at all, given nothing, differs.
    const idle = Effect.runSync(App.make(Kept, start));
    for (let i = 0; i < 5; i++) {
      idle.input();
      idle.tick(1);
      idle.frame(0);
    }
    expect(hashOf(idle)).not.toBe(hashes.at(-1));
  });

  it("is an action its game has a handler for: any other does not compile", () => {
    const ui = View.makeBridge(Played);
    const app = play(ui);
    ui.send(Start, {});
    app.input();
    app.tick(1);
    expect(app.actionLog.filter(isAction).map((e) => e.name)).toEqual([
      "vw/Start",
    ]);
    app.frame(0);
    expect(ui.get(Menu)).toEqual({ phase: "playing" });
    // @ts-expect-error the game has no handler for vw/Unknown
    ui.send(Unknown, {});
    // Said of the action, and not of a payload it does not take.
    const Shop = App.define({
      handlers: [Action.handler(Buy, function* () {})],
    });
    View.makeBridge(Shop).send(
      // @ts-expect-error the game has no handler for vw/Ping
      Ping
    );
    // @ts-expect-error a bridge is made from its game
    View.makeBridge();
    // @ts-expect-error and from a game, not from one of its plugins
    View.makeBridge(Game);
  });

  it("from a bridge made for another game, is refused in the input stage of a game with no handler for it", () => {
    const Larger = App.define({
      plugins: [Game],
      handlers: [Action.handler(Unknown, function* () {})],
    });
    const ui = View.makeBridge(Larger);
    ui.send(Unknown, {});
    const app = play(ui);
    expect(() => app.input()).toThrow('No handler for action "vw/Unknown"');
  });

  it("is what a system can ask too: Actions.handles says whether an action can be issued", () => {
    const said: boolean[] = [];
    const Ask = (name: string, stage: "input" | "update" | "frame") => {
      const body = function* () {
        const { handles } = yield* Action.Actions;
        said.push(handles(Start), handles(Unknown));
      };
      if (stage === "input") {
        return System.input(name, body);
      }
      if (stage === "frame") {
        return System.frame(name, body);
      }
      return System.tick(name, body);
    };
    const app = Effect.runSync(
      App.make(
        App.define({
          plugins: [Game],
          systems: [
            Ask("vw/AskInput", "input"),
            Ask("vw/AskTick", "update"),
            Ask("vw/AskFrame", "frame"),
          ],
        })
      )
    );
    app.input();
    app.tick(1);
    app.frame(0);
    expect(said).toEqual([true, false, true, false, true, false]);
  });

  it("does not compile on the bridge that stands for no UI, which throws if a cast sends to it", () => {
    const seen: View.Bridge[] = [];
    const Spy = System.frame("vw/Spy", function* () {
      seen.push(yield* View.Bridge);
    });
    const app = Effect.runSync(
      App.make(App.define({ plugins: [View.plugin], systems: [Spy] }))
    );
    app.frame(0);
    const none = seen[0]!;
    expect(none.get(Hud)).toBe(Hud.initial);
    none.subscribe(Hud, () => {
      throw new Error("never told");
    })();
    expect(() =>
      // @ts-expect-error the bridge that stands for no UI sends nothing
      none.send(Start, {})
    ).toThrow("stands for no UI");
  });
});

describe("the bridge", () => {
  it("leaves the game as it found it: with a UI or with none, the game is the same game", () => {
    const Watched = App.define({ plugins: [Game, begun({ coins: [3] })] });
    const ui = View.makeBridge(Watched);
    listen(ui, Hud);
    const seen = App.make(Watched, {
      seed: 4,
      checkpointEvery: 1,
      verifyFrames: true,
    }).pipe(Effect.provide(View.layer(ui)));
    const watched = Effect.runSync(seen);
    const alone = play(undefined, { seed: 4, coins: [3] });
    for (const app of [watched, alone]) {
      app.dispatch(Start, {});
    }
    for (let i = 0; i < 30; i++) {
      watched.input();
      watched.tick(1);
      watched.frame(0.5);
      alone.tick(1);
      expect(hashOf(watched)).toBe(hashOf(alone));
    }
    expect(watched.actionLog).toEqual(alone.actionLog);
    const saves = [watched.save(), alone.save()].map((save) =>
      Exit.isSuccess(save) ? save.value : undefined
    );
    expect(saves[0]).toBeDefined();
    expect(saves[0]).toEqual(saves[1]);
    expect(ui.get(Hud)).toEqual({ gold: 90, coins: 1 });
  });

  it("is handed to a UI only from a game that handles every action the UI sends, and with no actions only reads", () => {
    const ui = View.makeBridge(Played);
    const app = play(ui);
    // The UI names what it sends; the game may handle more.
    const mountMenu = (menu: View.Bridge<typeof Start | typeof Ping>): void => {
      menu.send(Ping);
    };
    pings = 0;
    mountMenu(ui);
    app.input();
    app.tick(1);
    expect(pings).toBe(1);
    const mountShop = (shop: View.Bridge<typeof Buy | typeof Unknown>) => shop;
    // @ts-expect-error the game has no handler for vw/Unknown
    mountShop(ui);
    // A bridge with no actions reads the views, and sends nothing.
    const reads: View.Bridge = ui;
    expect(reads.get(Menu)).toEqual({ phase: "title" });
    // @ts-expect-error it sends nothing
    reads.send(Start, {});
  });

  it("is what a plugin's systems need: a game that publishes and leaves out View.plugin does not compile", () => {
    // View.Port is still needed: View.plugin provides it.
    expectTypeOf(App.make(App.define({ systems: [ShowHud] }))).not.toExtend<
      Effect.Effect<unknown, never>
    >();
    expectTypeOf(
      App.make(App.define({ plugins: [View.plugin], systems: [ShowHud] }))
    ).toExtend<Effect.Effect<unknown, never>>();
  });
});
