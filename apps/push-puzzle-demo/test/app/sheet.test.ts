import { readFileSync } from "node:fs";

import { AudioSettings, AudioSystem } from "arcadekit/audio";
import { ContentSource } from "arcadekit/content";
import { SpriteSheet } from "arcadekit/render-three";
import { Png } from "arcadekit/render-three/testing";
import { Effect, Layer, Schema } from "effect";
import { Scene, Story } from "foldkit";
import { describe, expect, it } from "vitest";

import {
  EndRun,
  FocusRetry,
  LoadAudioSettings,
  LoadContent,
  LoadSave,
  LoadSounds,
  StartLevel,
} from "../../src/app/commands";
import * as LevelRecords from "../../src/app/level-records";
import { Message } from "../../src/app/message";
import * as Sheet from "../../src/app/sheet";
import * as Sounds from "../../src/app/sounds";
import { init, update } from "../../src/app/update";
import { view } from "../../src/app/view";
import {
  Art,
  PushPuzzleCueTable,
  PushPuzzleEngine,
  PushPuzzleSheet,
} from "../../src/push-puzzle/browser/index";
import { PushPuzzleContent, PuzzleContent } from "../../src/push-puzzle/index";

// The sheet this game ships, and what a failed sheet load does to startup. Loading and
// parsing sheets in general is arcadekit/render-three's tests.

const spritesDir = new URL("../../public/sprites/", import.meta.url);

describe("the push-puzzle sheet", () => {
  it("has every tag the view draws, and an image the size its JSON says", async () => {
    const data = await Effect.runPromise(
      SpriteSheet.decode(
        "push-puzzle.json",
        JSON.parse(
          readFileSync(new URL("push-puzzle.json", spritesDir), "utf-8")
        ) as unknown
      )
    );
    const image = Png.size(readFileSync(new URL(data.image, spritesDir)));
    expect({
      url: Sheet.url.endsWith("/sprites/push-puzzle.json"),
      missing: SpriteSheet.resolveTags(data, Art.tags).missing,
      image,
    }).toStrictEqual({
      url: true,
      missing: [],
      image: { width: data.width, height: data.height },
    });
  });

  it("has no partly transparent pixels, as every sprite is drawn opaque", async () => {
    const data = await Effect.runPromise(
      SpriteSheet.decode(
        "push-puzzle.json",
        JSON.parse(
          readFileSync(new URL("push-puzzle.json", spritesDir), "utf-8")
        ) as unknown
      )
    );
    const png = readFileSync(new URL(data.image, spritesDir));
    // The view draws every sprite opaque, cutting out pixels below half alpha and drawing
    // the rest solid, so art drawn that way should be fully opaque or fully clear.
    expect(Png.framesWithSoftAlpha(png, data)).toStrictEqual([]);
  });
});

const failed = new SpriteSheet.SpriteSheetError({
  file: "sprites/push-puzzle.json",
  message: "The sprite sheet file sprites/push-puzzle.json can't be loaded",
});

/** Runs `effect` with a sheet whose every load fails, and `levels` as the content's load. */
const runWithFailedSheet = <A, E>(
  effect: Effect.Effect<A, E, PushPuzzleContent | PushPuzzleSheet>,
  levels: PushPuzzleContent["Service"]["load"]
) =>
  effect.pipe(
    Effect.provideService(PushPuzzleSheet, { load: Effect.fail(failed) }),
    Effect.provideService(PushPuzzleContent, { load: levels }),
    Effect.runPromise
  );

/** A Scene step that leaves init's Commands pending, as at startup. */
const withInitCommands = <M, Msg, Out>(
  simulation: Scene.SceneSimulation<M, Msg, Out>
): Scene.SceneSimulation<M, Msg, Out> => ({
  ...simulation,
  commands: init().commands ?? [],
});

describe("a sheet that fails to load", () => {
  it("stops startup with its error on the loading screen, like content that fails to load", async () => {
    // The two loads run side by side: the levels load, and the sheet's failure is reported.
    const levels = { levels: [] } as unknown as Effect.Success<
      PushPuzzleContent["Service"]["load"]
    >;
    const message = await runWithFailedSheet(
      LoadContent().effect,
      Effect.succeed(levels)
    );
    expect(message).toStrictEqual(
      Message.FailedToLoadContent({ error: failed.message })
    );
    Story.story(
      update,
      Story.given(init().model),
      Story.message(message),
      Story.Command.resolve(FocusRetry, Message.CompletedFocusCommand()),
      Story.model((model) =>
        expect(model.phase).toStrictEqual({
          _tag: "LoadFailed",
          error: failed.message,
        })
      )
    );
    expect(() =>
      Scene.scene(
        { update, view },
        // Startup as init leaves it: its Model, and its Commands pending.
        Scene.given(init().model),
        withInitCommands,
        Scene.expect(Scene.text("Loading…")).toExist(),
        Scene.Mount.resolve(
          { name: "GameViewport" },
          Message.MountedViewport()
        ),
        Scene.Command.resolve(LoadContent, message),
        Scene.expect(Scene.text(failed.message)).toExist(),
        Scene.Command.resolve(FocusRetry, Message.CompletedFocusCommand()),
        Scene.Command.resolve(
          LoadSave,
          Message.LoadedSave({ records: LevelRecords.empty })
        ),
        Scene.Command.resolve(
          LoadAudioSettings,
          Message.LoadedAudioSettings({ settings: AudioSettings.defaults })
        ),
        Scene.Command.resolve(LoadSounds, Message.CompletedAudioCommand())
      )
    ).not.toThrow();
  });

  it("leaves the engine's Commands working: the engine needs the sheet only to draw", async () => {
    const levels = [
      { id: "one", name: "One", rows: ["#####", "#@$.#", "#####"] },
    ];
    expect(Schema.is(PuzzleContent.PuzzleContent)({ levels })).toBe(true);
    const messages = await Effect.all([
      StartLevel({ levelId: "one" }).effect,
      EndRun().effect,
    ]).pipe(
      Effect.provide(
        Layer.mergeAll(
          PushPuzzleEngine.layer,
          PushPuzzleContent.layer(
            ContentSource.fromRecord({ "levels.json": levels })
          )
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              PushPuzzleSheet.layer(Effect.fail(failed)),
              PushPuzzleCueTable.layer(Sounds.byCue),
              AudioSystem.layerSilent
            )
          )
        )
      ),
      Effect.runPromise
    );
    // The run starts and ends. The viewport's attach is what fails, and the engine entry's
    // onError reports it.
    expect(messages).toStrictEqual([
      Message.StartedRun(),
      Message.CompletedEngineCommand(),
    ]);
  });
});
