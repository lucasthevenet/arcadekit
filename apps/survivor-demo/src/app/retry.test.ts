import { readFileSync } from "node:fs";

import { SurvivorsContent } from "@arcadekit/survivors";
import { makeSurvivorsEngineLayer } from "@arcadekit/survivors/browser";
import { SilentAudioLayer, defaultAudioSettings } from "arcadekit/audio";
import { ContentError } from "arcadekit/content";
import type { ContentSource } from "arcadekit/content";
import {
  SpriteSheetError,
  decodeSpriteSheet,
  makeSpriteSheet,
} from "arcadekit/render-three";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Scene } from "foldkit";
import { afterEach, describe, expect, it } from "vitest";

import {
  FocusRetry,
  LoadAudioSettings,
  LoadContent,
  LoadSave,
  LoadSounds,
  PlayClick,
  StartRun,
} from "./commands";
import { Message } from "./message";
import type { Model } from "./model";
import { emptyRecords } from "./save";
import { survivorsSounds } from "./sound";
import { init, update } from "./update";
import { view } from "./view";

// The load-error screen's "Try again": it runs LoadContent again through the app's real loaders,
// which fetch again only what failed, and a load that succeeds goes to the menu. No WebGL:
// the sheet's image is a stand-in.

const publicDir = new URL("../../public/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, publicDir), "utf-8");

const sheetData = await Effect.runPromise(
  decodeSpriteSheet(
    "survivors.json",
    JSON.parse(read("sprites/survivors.json")) as unknown
  )
);
/** Reads a content file, after a moment. */
const readFile = (file: string) =>
  Effect.sleep("5 millis").pipe(
    Effect.andThen(
      Effect.try({
        try: () => JSON.parse(read(`content/${file}`)) as unknown,
        catch: (cause) => new ContentError({ message: String(cause) }),
      })
    )
  );

const image = { width: 1, height: 1 } as unknown as TexImageSource;

/** The runtimes the tests opened, disposed after each test. */
const opened: { readonly dispose: () => Promise<void> }[] = [];
/**
 * The app's resources as main.ts makes them, but with a sheet load and a content source that
 * fail their first `failures.sheet` and `failures.content` loads, each with its own error, and
 * count every load. A load that succeeds takes a moment and a failure doesn't, as a 404 beside a
 * file that loads: the failure comes while the other load is still running.
 */
const flakyResources = (failures: {
  readonly sheet: number;
  readonly content: number;
}) => {
  const runs = { sheet: 0, content: 0 };
  const sheet = Effect.suspend(() => {
    runs.sheet += 1;
    return runs.sheet <= failures.sheet
      ? Effect.fail(
          new SpriteSheetError({
            file: "sprites/survivors.json",
            message: `The sheet can't be loaded (try ${runs.sheet})`,
          })
        )
      : Effect.sleep("5 millis").pipe(
          Effect.as(makeSpriteSheet(sheetData, image))
        );
  });
  // A content load reads every file; heroes.json stands for the load, and fails.
  const source: ContentSource = (file) =>
    Effect.suspend(() => {
      if (file !== "heroes.json") {
        return readFile(file);
      }
      runs.content += 1;
      return runs.content <= failures.content
        ? Effect.fail(
            new ContentError({
              message: `The heroes can't be loaded (try ${runs.content})`,
            })
          )
        : readFile(file);
    });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeSurvivorsEngineLayer({ sheet, sounds: survivorsSounds }),
      SurvivorsContent.layer(source)
    ).pipe(Layer.provide(SilentAudioLayer))
  );
  opened.push(runtime);
  return {
    runs,
    loadContent: () => runtime.runPromise(LoadContent().effect),
  };
};

/** A Scene step that leaves init's Commands pending, as at startup. */
const withInitCommands = <M, Msg, Out>(
  simulation: Scene.SceneSimulation<M, Msg, Out>
): Scene.SceneSimulation<M, Msg, Out> => ({
  ...simulation,
  commands: init().commands ?? [],
});

/** Startup with its first LoadContent answered by `loaded`, and init's other Commands done. */
const startup = (
  loaded: Message
): readonly Scene.SceneStep<Model, Message, undefined>[] => [
  Scene.given(init().model),
  withInitCommands,
  Scene.Mount.resolve({ name: "GameViewport" }, Message.MountedViewport()),
  Scene.Command.resolve(LoadContent, loaded),
  Scene.Command.resolve(
    LoadSave,
    Message.LoadedSave({ records: emptyRecords })
  ),
  Scene.Command.resolve(
    LoadAudioSettings,
    Message.LoadedAudioSettings({ settings: defaultAudioSettings })
  ),
  Scene.Command.resolve(LoadSounds, Message.CompletedAudioCommand()),
];

const tryAgain = Scene.role("button", { name: "Try again" });

describe("Try again", () => {
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((runtime) => runtime.dispose()));
  });

  it.each(["sheet", "content"] as const)(
    "loads again only the %s that failed, then shows the menu",
    async (failing) => {
      const app = flakyResources({
        sheet: failing === "sheet" ? 1 : 0,
        content: failing === "content" ? 1 : 0,
      });
      const failed = await app.loadContent();
      const loaded = await app.loadContent();
      expect({
        failed: failed._tag,
        loaded: loaded._tag,
        runs: app.runs,
      }).toStrictEqual({
        failed: "FailedToLoadContent",
        loaded: "LoadedContent",
        // What loaded the first time is kept; only what failed is fetched again.
        runs: {
          sheet: failing === "sheet" ? 2 : 1,
          content: failing === "content" ? 2 : 1,
        },
      });
      expect(() =>
        Scene.scene(
          { update, view },
          ...startup(failed),
          Scene.expect(Scene.text("Something went wrong")).toExist(),
          // The screen focuses its button, so Enter retries.
          Scene.Command.resolve(FocusRetry, Message.CompletedFocusCommand()),
          Scene.click(tryAgain),
          Scene.expect(Scene.text("Loading…")).toExist(),
          Scene.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
          Scene.Command.resolve(LoadContent, loaded),
          Scene.expect(Scene.text("Survivor Kit")).toExist(),
          Scene.expect(tryAgain).not.toExist()
        )
      ).not.toThrow();
    }
  );

  it("shows the new error when the load fails again", async () => {
    const app = flakyResources({ sheet: 2, content: 0 });
    const first = await app.loadContent();
    const second = await app.loadContent();
    expect(second).toStrictEqual(
      Message.FailedToLoadContent({
        error: "The sheet can't be loaded (try 2)",
      })
    );
    expect(() =>
      Scene.scene(
        { update, view },
        ...startup(first),
        Scene.expect(Scene.text("The sheet can't be loaded (try 1)")).toExist(),
        Scene.Command.resolve(FocusRetry, Message.CompletedFocusCommand()),
        Scene.click(tryAgain),
        Scene.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
        Scene.Command.resolve(LoadContent, second),
        Scene.expect(Scene.text("The sheet can't be loaded (try 2)")).toExist(),
        Scene.expect(
          Scene.text("The sheet can't be loaded (try 1)")
        ).not.toExist(),
        Scene.expect(tryAgain).toExist(),
        Scene.Command.resolve(FocusRetry, Message.CompletedFocusCommand())
      )
    ).not.toThrow();
  });

  it("after a run that couldn't start, loads again and goes back to the menu", async () => {
    const app = flakyResources({ sheet: 0, content: 0 });
    const loaded = await app.loadContent();
    expect(() =>
      Scene.scene(
        { update, view },
        ...startup(loaded),
        Scene.click(Scene.role("button", { name: "Start run" })),
        Scene.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
        Scene.Command.resolve(
          StartRun,
          Message.FailedToStartRun({ error: "The run can't start" })
        ),
        Scene.expect(Scene.text("The run can't start")).toExist(),
        Scene.Command.resolve(FocusRetry, Message.CompletedFocusCommand()),
        Scene.click(tryAgain),
        Scene.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
        Scene.Command.resolve(LoadContent, loaded),
        Scene.expect(Scene.role("button", { name: "Start run" })).toExist()
      )
    ).not.toThrow();
  });
});
