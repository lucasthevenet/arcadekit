import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  Action,
  App,
  Assets,
  Event,
  Field,
  Input,
  Plugin,
  Singleton,
  Sound,
  System,
  Test,
  View,
} from "../src/index.ts";
import { thrown } from "./checks.ts";

const Score = Singleton.define(
  "ts/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Scored = Event.define("ts/Scored");
const Add = Action.define("ts/Add", Schema.Struct({ points: Schema.Int }));
const add = Action.handler(Add, function* ({ points }) {
  (yield* Score.writes).points += points;
  (yield* Scored.emits).emit(undefined);
});
const Hud = View.define("ts/Hud", { points: 0 });
const Sfx = Sound.sheet("ts/Sfx", { coin: "/coin.wav" });

const Rules = Plugin.make("ts/Rules", { handlers: [add] });
const Coin = Input.button("ts/Coin", ["KeyW"]);
const Game = App.define({
  plugins: [
    Rules,
    Sound.plugin,
    View.plugin,
    Plugin.make("ts/Looks", {
      plugins: [Input.controls("ts/Controls", [Coin])],
      systems: [
        System.input("ts/Keys", function* () {
          if ((yield* Coin).pressed) {
            (yield* Action.Actions).enqueue(Add, { points: 1 });
          }
        }),
        Sound.cues("ts/Cues", Sfx, ({ coin }) => [Sound.on(Scored, coin)]),
        View.publish(Hud, function* () {
          return { points: (yield* Score).points };
        }),
      ],
    }),
  ],
});

describe("a game under test", () => {
  it.effect(
    "hears a key, ticks, and plays and publishes what the tick did, in one step",
    () =>
      Effect.gen(function* () {
        const game = yield* Test.make(Game, { seed: 7 });
        const seen: { readonly points: number }[] = [];
        game.ui.subscribe(Hud, (hud) => seen.push(hud));
        game.input.press("KeyW");
        yield* game.step();
        expect((yield* game.app.read(Score)).points).toBe(1);
        expect(game.sound.played).toEqual([
          { cue: "coin", volume: 1, rate: 1 },
        ]);
        expect(game.ui.get(Hud)).toEqual({ points: 1 });
        // As it was when the UI subscribed, then what the step published.
        expect(seen).toEqual([{ points: 0 }, { points: 1 }]);
        // The bridge sends what the game handles, as a UI's button does.
        game.ui.send(Add, { points: 2 });
        yield* game.step();
        expect(game.ui.get(Hud)).toEqual({ points: 3 });
        expect(game.app.time.tick).toBe(2);
      })
  );

  it.effect("makes stand-ins of its own each time it runs", () =>
    Effect.gen(function* () {
      const making = Test.make(Game);
      const one = yield* making;
      const two = yield* making;
      one.input.press("KeyW");
      yield* one.step();
      yield* two.step();
      expect((yield* one.app.read(Score)).points).toBe(1);
      expect((yield* two.app.read(Score)).points).toBe(0);
      expect(two.sound.played).toEqual([]);
    })
  );

  it.effect(
    "rests: it steps until the app is settled, and says how many ticks that took",
    () =>
      Effect.gen(function* () {
        const game = yield* Test.make(Game);
        // A new app has not settled.
        expect(yield* game.rest()).toBe(1);
        expect(yield* game.rest()).toBe(0);
        yield* game.app.enqueue(Add, { points: 5 });
        expect(yield* game.rest()).toBeGreaterThan(0);
        expect((yield* game.app.read(Score)).points).toBe(5);
        expect(game.app.settled).toBe(true);
      })
  );

  it.effect("dies on a game that never settles, and says what to do", () =>
    Effect.gen(function* () {
      const Clock = Singleton.define(
        "ts/Clock",
        { ticks: Field.i32 },
        { ticks: 0 }
      );
      const Count = System.tick("ts/Count", function* () {
        (yield* Clock.writes).ticks += 1;
      });
      const game = yield* Test.make(App.define({ systems: [Count] }));
      expect(yield* thrown(game.rest(5))).toThrow(
        "The game did not settle in 5 ticks: some system writes the world every tick, or an action, a state's transition or an event is always waiting. Step it a number of times with game.step(), or give rest a larger limit."
      );
      expect(game.app.time.tick).toBe(5);
    })
  );

  it.effect(
    "loads the files it is given, and fails on any other, as a page would",
    () =>
      Effect.gen(function* () {
        const game = yield* Test.make(App.define({ plugins: [Rules] }), {
          files: { "/level.json": '{"rocks":3}' },
        });
        expect(
          new TextDecoder().decode(yield* game.files.bytes("/level.json"))
        ).toBe('{"rocks":3}');
        expect(yield* Effect.exit(game.files.bytes("/other.json"))).toEqual(
          Exit.fail(
            new Assets.Failed({
              url: "/other.json",
              message: "There is no such file.",
            })
          )
        );
      })
  );

  it.effect("has no bridge for a game without View.plugin", () =>
    Effect.gen(function* () {
      const game = yield* Test.make(App.define({ plugins: [Rules] }));
      expect(game.ui).toBeUndefined();
      // @ts-expect-error a game without View.plugin hands out no bridge
      void (() => game.ui.get(Hud));
      yield* game.step(1 / 30);
      expect(game.app.time.elapsed).toBeCloseTo(1 / 30);
    })
  );
});
