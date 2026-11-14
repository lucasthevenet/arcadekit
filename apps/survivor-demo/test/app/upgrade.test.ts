import { readFileSync } from "node:fs";

import { ContentSource } from "arcadekit/content";
import * as Game from "arcadekit/game/browser";
import { ManualFrames } from "arcadekit/game/testing";
import { Effect, Fiber, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { GameContent, Survivors, SurvivorsContent } from "#survivors";
import { SurvivorsEngine } from "#survivors/browser";

import { PickUpgrade } from "../../src/app/commands";
import { Message } from "../../src/app/message";

// The upgrade pick, from the app's Command to the genre's rules and back. `PickUpgrade` sends the
// genre's `ChooseUpgrade` and waits for the rules' answer, and however the send ends it reports
// that it is done. The rules and the content are the game's own; nothing is drawn, and a frame
// runs when the test runs it.

const contentDir = new URL("../../public/content/", import.meta.url);
const fileSource = ContentSource.make((file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) =>
      new ContentSource.ContentError({ message: String(cause), cause }),
  })
);

const shipped = await Effect.runPromise(SurvivorsContent.read(fileSource));

/** The game's content with its first level one kill away and its second out of reach: a run has one offer. */
const content = Schema.decodeUnknownSync(GameContent.GameContent)({
  ...shipped,
  rules: { ...shipped.rules, xpToLevel2: 1, xpGrowth: 1000 },
});

/**
 * Survivors' rules as an engine that draws nothing, whose hero walks a slow circle: what stands
 * in for the app's engine, which needs WebGL to attach.
 */
class HeadlessEngine extends Game.Engine("HeadlessEngine", {
  simulation: Survivors,
  view: () => ({ render: () => {}, dispose: () => {} }),
  input: () => ({
    ...Game.soloInput({
      read: (step) => ({
        moveX: Math.cos(step / 200),
        moveZ: Math.sin(step / 200),
      }),
    }),
    dispose: () => {},
  }),
}) {}

const element = {} as HTMLElement;

/** A run of the first hero, played to its first level-up: its offer is open and the run frozen. */
interface Offered {
  /** The open offer's number. */
  readonly offer: number;
  /** The run's clock, as the HUD last showed it. */
  readonly time: () => number;
  /** Runs frames for `ms` of the frame clock, a step's time at a go. */
  readonly play: (ms: number) => void;
  /** Runs the app's Command for a pick, with one frame for the rules to answer in. */
  readonly pick: (index: number, offer?: number) => Effect.Effect<Message>;
  /** Runs the app's Command for a pick and then `act`, with no frame in between. */
  readonly pickThen: (
    act: (engine: SurvivorsEngine["Service"]) => Effect.Effect<void>
  ) => Effect.Effect<Message>;
}

const offered = async (
  drive: (run: Offered) => Effect.Effect<void, never, Scope.Scope>
) => {
  const frames = ManualFrames.make();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* HeadlessEngine;
        const offers: number[] = [];
        let time = 0;
        yield* engine.listen(
          Survivors.match({
            Hud: (hud) => {
              ({ time } = hud);
            },
            LeveledUp: ({ offer }) => {
              offers.push(offer);
            },
            HeroLeft: () => {},
            RunEnded: () => {},
          })
        );
        yield* Effect.forkScoped(engine.attach(element), {
          startImmediately: true,
        });
        yield* engine.start(
          { content, heroIds: [content.heroes[0]!.id] },
          { seed: 1 }
        );
        const play = (ms: number) => {
          const until = frames.now() + ms;
          while (frames.now() < until) {
            ManualFrames.runFrameAt(frames, frames.now() + 1000 / 60);
          }
        };
        while (offers.length === 0 && frames.now() < 60_000) {
          play(100);
        }
        const [opened] = offers;
        if (opened === undefined) {
          return yield* Effect.die("The run reached no level-up in a minute");
        }
        // The HUD is read every 100 ms: let it catch up with the frozen run.
        play(200);
        const send = (index: number, numbered: number) =>
          PickUpgrade({ offer: numbered, index }).effect.pipe(
            Effect.provideService(SurvivorsEngine, engine)
          );
        return yield* drive({
          offer: opened,
          time: () => time,
          play,
          pick: (index, numbered = opened) =>
            Effect.gen(function* () {
              const sent = yield* Effect.forkChild(send(index, numbered), {
                startImmediately: true,
              });
              play(1000 / 60);
              return yield* Fiber.join(sent);
            }),
          pickThen: (act) =>
            Effect.gen(function* () {
              const sent = yield* Effect.forkChild(send(0, opened), {
                startImmediately: true,
              });
              yield* act(engine);
              return yield* Fiber.join(sent);
            }),
        });
      })
    ).pipe(
      Effect.provide(
        HeadlessEngine.layer.pipe(
          Layer.provide(Layer.succeed(Game.Frames, frames))
        )
      )
    )
  );
};

const done = Message.CompletedEngineCommand();

describe("the upgrade pick", () => {
  it("is taken by the rules at the next step, and the run goes on", async () => {
    await offered(({ time, play, pick }) =>
      Effect.gen(function* () {
        const frozenAt = time();
        play(500);
        expect(time()).toBe(frozenAt);
        expect(yield* pick(0)).toStrictEqual(done);
        play(500);
        expect(time()).toBeGreaterThan(frozenAt);
      })
    );
  });

  it("ends the same way when the rules refuse it, and the offer stays open", async () => {
    await offered(({ offer, time, play, pick }) =>
      Effect.gen(function* () {
        const frozenAt = time();
        // Another offer's number, then a choice the offer doesn't have.
        expect(yield* pick(0, offer + 1)).toStrictEqual(done);
        expect(yield* pick(99)).toStrictEqual(done);
        play(500);
        expect(time()).toBe(frozenAt);
        expect(yield* pick(0)).toStrictEqual(done);
        play(500);
        expect(time()).toBeGreaterThan(frozenAt);
      })
    );
  });

  it("ends the same way when the run ends before a step takes it", async () => {
    await offered(({ pickThen }) =>
      Effect.gen(function* () {
        expect(yield* pickThen((engine) => engine.stop)).toStrictEqual(done);
      })
    );
  });
});
