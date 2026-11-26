/**
 * A game under test: its app, made with a stand-in for each thing a page
 * provides, handed back beside it to drive and to read.
 *
 *   it.effect("plays a turn", () =>
 *     Effect.gen(function*() {
 *       const game = yield* Test.make(Rogue, { seed: 7, files: { "/one.json": level } })
 *       game.input.press("KeyW")
 *       yield* game.step()           // the input stage, one tick, the frame stage
 *       yield* game.rest()           // steps until the app is settled
 *       game.sound.played            // [{ cue: "step", volume: 1, rate: 1 }]
 *       game.ui.get(Hud).hp          // 10
 *     }))
 *
 * The devices are a source the test drives, `Input.makeManualSource()`, the
 * sound goes to a recorder, `Sound.makeRecorder()`, the files come from
 * memory, `Assets.makeMemory(files)`, and a game with `View.plugin` hands its
 * bridge to the test. What else the game needs from outside, such as a
 * renderer, the test provides around `Test.make`. Each stand-in can be
 * provided by hand instead, with its module's `layer`.
 */
import { Effect, Layer } from "effect";

import type * as Action from "./Action.ts";
import * as App from "./App.ts";
import * as Assets from "./Assets.ts";
import * as Input from "./Input.ts";
import { Ui } from "./internal/view.ts";
import type * as Plugin from "./Plugin.ts";
import type * as Save from "./Save.ts";
import * as Sound from "./Sound.ts";
import type * as View from "./View.ts";

/**
 * Options for a game under test: how its app starts, as `App.make` takes them,
 * the files it loads, and how long a step's tick is.
 *
 * @category Options
 */
export interface Options<
  SV extends Save.Save | undefined = undefined,
> extends App.StartOptions<SV> {
  /**
   * The files the game loads, by URL, as `Assets.makeMemory` serves them. A
   * URL not among them fails to load. Defaults to none.
   */
  readonly files?: Readonly<Record<string, Uint8Array | string>>;
  /** The seconds a tick of `step` and `rest` simulates. Defaults to 1 / 60. */
  readonly delta?: number;
}

type ActionOf<HU> = HU extends Action.AnyHandler ? HU["action"] : never;

/**
 * The bridge a game's app hands its UI, for a game with `View.plugin`, and
 * `undefined` for one without.
 *
 * @category Type-level
 */
export type UiOf<H extends App.Handlers, P extends App.Plugins> = [
  View.Port,
] extends [Plugin.ProvidedOf<P[number]>]
  ? View.Bridge<ActionOf<App.AllHandlers<H, P>>>
  : undefined;

/**
 * A game under test, as `Test.make` makes it: the app, and the stand-ins it
 * was made with.
 *
 * @typeParam E what a tick of its app can fail with
 * @typeParam HU its app's handlers
 * @typeParam U its bridge, or `undefined` for a game without `View.plugin`
 *
 * @category Models
 */
export interface Test<E = never, HU = never, U = undefined> {
  /** The app, which the test also steps, reads and closes as any other. */
  readonly app: App.App<E, HU>;
  /** The devices, which the test presses, releases and moves. */
  readonly input: Input.ManualSource;
  /** What the game played: its cues, and what its channels were told. */
  readonly sound: Sound.Recorder;
  /** Where the game's files come from. */
  readonly files: Assets.LoaderShape;
  /** The bridge the app handed its UI, to read views and send actions. */
  readonly ui: U;
  /**
   * Runs one frame of a driver that ticks every frame: the input stage, one
   * tick of `delta` seconds, then the frame stage, which plays the sound and
   * publishes the views. It fails with what the tick or a stage fails with.
   */
  readonly step: (delta?: number) => Effect.Effect<void, E>;
  /**
   * Steps until the app is settled, as a driver that ticks only when needed
   * would, then runs the frame stage, and succeeds with the number of ticks it
   * ran. A new app has not settled, so it ticks at least once. It dies after
   * `limit` ticks, 1000 by default, with a game that never settles.
   */
  readonly rest: (limit?: number) => Effect.Effect<number, E>;
}

/**
 * Makes the app of a game with a stand-in for each thing a page provides, and
 * hands them back beside it. It takes how the app starts as `App.make` does,
 * the files the game loads, and how long a step's tick is.
 *
 *   const game = yield* Test.make(Duel, { seed: 1 })
 *   yield* game.app.enqueue(Strike, { damage: 3 })
 *   yield* game.step()
 *
 * **When to use**
 *
 * Use in a test of a game. To give an app one stand-in alone, or one of your
 * own, provide it to `App.make` with its module's `layer`, as
 * `Input.layer(Input.makeManualSource())`.
 *
 * **Details**
 *
 * - It fails as `App.make` does, and requires what the game needs from
 *   outside beside the stand-ins, such as `Three.Renderer`.
 * - The app has a scope of its own, as any app, which `game.app.close` closes.
 *   The stand-ins hold nothing, so a test need not close it.
 *
 * @category Constructors
 */
export const make = <
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
  SV extends Save.Save | undefined = undefined,
>(
  game: App.Game<S, H, P>,
  options?: Options<SV>
): Effect.Effect<
  Test<App.TickError<S, P>, App.AllHandlers<H, P>, UiOf<H, P>>,
  Plugin.ErrorOf<P[number]> | (SV extends Save.Save ? Save.LoadRefused : never),
  App.External<S, H, P>
> =>
  // Each run makes stand-ins of its own, so two apps never share a device.
  Effect.suspend(() => {
    const { delta = 1 / 60, files = {}, ...start } = options ?? {};
    const input = Input.makeManualSource();
    const sound = Sound.makeRecorder();
    const loader = Assets.makeMemory(files);
    const handed: unknown[] = [];
    const standIns = Layer.mergeAll(
      Input.layer(input),
      Sound.layer(sound),
      Assets.layer(loader),
      Layer.succeed(Ui, (bridge) => {
        handed.push(bridge);
      })
    );
    return Effect.map(
      App.make(game, start).pipe(Effect.provide(standIns)),
      (app) => {
        const step = Effect.fnUntraced(function* (seconds: number = delta) {
          yield* app.input();
          yield* app.tick(seconds);
          yield* app.frame();
        });
        const rest = Effect.fnUntraced(function* (limit: number = 1000) {
          let ticks = 0;
          for (;;) {
            yield* app.input();
            if (app.settled) {
              break;
            }
            if (ticks === limit) {
              return yield* Effect.die(
                new Error(
                  `The game did not settle in ${limit} ticks: some system writes the world every tick, or an action, a state's transition or an event is always waiting. Step it a number of times with game.step(), or give rest a larger limit.`
                )
              );
            }
            yield* app.tick(delta);
            ticks++;
          }
          yield* app.frame();
          return ticks;
        });
        return {
          app,
          input,
          sound,
          files: loader,
          ui: handed[0] as UiOf<H, P>,
          step,
          rest,
        };
      }
    );
  });
