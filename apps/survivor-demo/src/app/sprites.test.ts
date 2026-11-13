import { readFileSync } from "node:fs";

import { SurvivorsContent } from "@arcadekit/survivors";
import {
  SurvivorsCueTable,
  SurvivorsEngine,
  SurvivorsSheet,
  wantedTags,
} from "@arcadekit/survivors/browser";
import { SilentAudioLayer, defaultAudioSettings } from "arcadekit/audio";
import { ContentError } from "arcadekit/content";
import type { ContentSource } from "arcadekit/content";
import {
  SpriteSheetError,
  decodeSpriteSheet,
  makeSpriteSheet,
  resolveTags,
} from "arcadekit/render-three";
import type { SpriteSheet } from "arcadekit/render-three";
import { framesWithSoftAlpha, pngSize } from "arcadekit/render-three/testing";
import { Effect, Layer } from "effect";
import { Scene } from "foldkit";
import { describe, expect, it } from "vitest";

import {
  ChooseUpgrade,
  EndRun,
  FocusRetry,
  LoadAudioSettings,
  LoadContent,
  LoadSave,
  LoadSounds,
  SetPaused,
  StartRun,
} from "./commands";
import { Message } from "./message";
import { emptyRecords } from "./save";
import { survivorsSounds } from "./sound";
import { init, update } from "./update";
import { view } from "./view";

// The sprite sheet in public/sprites, checked against the content that names its tags, and what
// a sheet that can't load does: the loading screen shows it, and the engine's Commands go on
// working. No WebGL: the sheet's image is a stand-in.

const publicDir = new URL("../../public/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, publicDir));

const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () => JSON.parse(read(`content/${file}`).toString()) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content = await Effect.runPromise(SurvivorsContent.read(fileSource));

/** A content file's JSON with no entry's `sprite`: each then draws its generic sprite. */
const withoutSprites = (json: unknown): unknown =>
  JSON.parse(JSON.stringify(json), (key, value: unknown) =>
    key === "sprite" ? undefined : value
  );
const sheet = await Effect.runPromise(
  decodeSpriteSheet(
    "survivors.json",
    JSON.parse(read("sprites/survivors.json").toString()) as unknown
  )
);

describe("the sprite sheet", () => {
  it("has every tag the view draws for the demo's content", () => {
    expect(resolveTags(sheet, wantedTags(content)).missing).toStrictEqual([]);
  });

  it("has the generic sprites the view draws for an entry that names none", async () => {
    // The demo's content names a sprite for each (below), and a choice after the one found
    // is not tried: so this asks for the same content with no sprite named.
    const unnamed = await Effect.runPromise(
      SurvivorsContent.read((file) =>
        fileSource(file).pipe(Effect.map(withoutSprites))
      )
    );
    expect({
      named: [...unnamed.heroes, ...unnamed.enemies, ...unnamed.weapons].filter(
        (def) => def.sprite !== undefined
      ),
      missing: resolveTags(sheet, wantedTags(unnamed)).missing,
    }).toStrictEqual({ named: [], missing: [] });
  });

  it("names its PNG, and the PNG is the size the JSON says", () => {
    expect(pngSize(read(`sprites/${sheet.image}`))).toStrictEqual({
      width: sheet.width,
      height: sheet.height,
    });
  });

  it("has no partly transparent pixels but in the aura and shadow, which are drawn blended", () => {
    const png = read(`sprites/${sheet.image}`);
    // The view draws the rest opaque, cutting out pixels below half alpha and drawing what
    // is left solid, so art drawn that way should be fully opaque or fully clear.
    expect(
      framesWithSoftAlpha(sheet, png, ["aura/ring", "shadow"])
    ).toStrictEqual([]);
  });

  it("gives every hero, enemy and bolt weapon its own sprite", () => {
    expect({
      heroes: content.heroes.filter((def) => def.sprite === undefined),
      enemies: content.enemies.filter((def) => def.sprite === undefined),
      bolts: content.weapons.filter(
        (def) => def.behavior.kind === "bolt" && def.sprite === undefined
      ),
    }).toStrictEqual({ heroes: [], enemies: [], bolts: [] });
  });
});

const sheetError = new SpriteSheetError({
  file: "sprites/survivors.json",
  message:
    "The sprite sheet file sprites/survivors.json can't be loaded: HTTP 404",
});

/** Runs `effect` with the real content and `load` as the sheet's. */
const runWithSheet = <A, E>(
  effect: Effect.Effect<A, E, SurvivorsContent | SurvivorsSheet>,
  load: Effect.Effect<SpriteSheet, SpriteSheetError>
) =>
  effect.pipe(
    Effect.provideService(SurvivorsSheet, { load }),
    Effect.provideService(SurvivorsContent, { load: Effect.succeed(content) }),
    Effect.runPromise
  );

/** A Scene step that leaves init's Commands pending, as at startup. */
const withInitCommands = <M, Msg, Out>(
  simulation: Scene.SceneSimulation<M, Msg, Out>
): Scene.SceneSimulation<M, Msg, Out> => ({
  ...simulation,
  commands: init().commands ?? [],
});

describe("loading", () => {
  it("loads the content and the sprite sheet together", async () => {
    const image = { width: 1, height: 1 } as unknown as TexImageSource;
    const message = await runWithSheet(
      LoadContent().effect,
      Effect.succeed(makeSpriteSheet(sheet, image))
    );
    expect(message._tag).toBe("LoadedContent");
  });

  it("shows a sheet that can't load on the loading screen, like content", async () => {
    const message = await runWithSheet(
      LoadContent().effect,
      Effect.fail(sheetError)
    );
    expect(message).toStrictEqual(
      Message.FailedToLoadContent({ error: sheetError.message })
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
        Scene.expect(Scene.text(sheetError.message)).toExist(),
        Scene.Command.resolve(FocusRetry, Message.CompletedFocusCommand()),
        Scene.Command.resolve(
          LoadSave,
          Message.LoadedSave({ records: emptyRecords })
        ),
        Scene.Command.resolve(
          LoadAudioSettings,
          Message.LoadedAudioSettings({ settings: defaultAudioSettings })
        ),
        Scene.Command.resolve(LoadSounds, Message.CompletedAudioCommand())
      )
    ).not.toThrow();
  });

  it("leaves the engine's Commands working: the engine needs the sheet only to draw", async () => {
    const done = Message.CompletedEngineCommand();
    const messages = await Effect.all([
      StartRun({ heroId: content.heroes[0]!.id }).effect,
      SetPaused({ paused: true }).effect,
      SetPaused({ paused: false }).effect,
      EndRun().effect,
      // With no run, the pick is dropped at once.
      ChooseUpgrade({ offer: 1, index: 0 }).effect,
    ]).pipe(
      Effect.provide(
        Layer.mergeAll(
          SurvivorsEngine.layer,
          Layer.succeed(SurvivorsContent, { load: Effect.succeed(content) })
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              SurvivorsSheet.layer(Effect.fail(sheetError)),
              SurvivorsCueTable.layer(survivorsSounds),
              SilentAudioLayer
            )
          )
        )
      ),
      Effect.runPromise
    );
    // The run starts, pauses, resumes and ends. The viewport's attach is what fails, and
    // `engineEntry`'s onError reports it.
    expect(messages).toStrictEqual([
      Message.StartedRun(),
      done,
      done,
      done,
      done,
    ]);
  });
});
