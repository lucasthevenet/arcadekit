import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import {
  SurvivorsContent,
  survivorsContentDefinition,
} from "@arcadekit/survivors";
import {
  SurvivorsEngine,
  missingSpriteTags,
} from "@arcadekit/survivors/browser";
import type { SurvivorsEngineLoader } from "@arcadekit/survivors/browser";
import { defaultAudioSettings } from "arcadekit/audio";
import { ContentError, loadContent } from "arcadekit/content";
import type { ContentSource } from "arcadekit/content";
import {
  SpriteSheetError,
  decodeSpriteSheet,
  makeSpriteSheet,
} from "arcadekit/render-three";
import type { SpriteSheetData } from "arcadekit/render-three";
import { Effect, Layer } from "effect";
import { Scene } from "foldkit";
import { describe, expect, it } from "vitest";

import type { CoopClient } from "../coop/client";
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
import { makeCoop } from "./coop";
import { Message } from "./message";
import { emptyRecords } from "./save";
import { init, update } from "./update";
import { view } from "./view";

// The sprite sheet in public/sprites, checked against the content that names its tags, and what
// a sheet that can't load does: the loading screen shows it, and nothing that reaches the engine
// dies. No WebGL: the sheet's image is a stand-in.

const publicDir = new URL("../../public/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, publicDir));

const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () => JSON.parse(read(`content/${file}`).toString()) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content = await Effect.runPromise(
  loadContent({ ...survivorsContentDefinition, source: fileSource })
);
const sheet = await Effect.runPromise(
  decodeSpriteSheet(
    "survivors.json",
    JSON.parse(read("sprites/survivors.json").toString()) as unknown
  )
);

/** PNG's Paeth predictor: whichever of left, up and up-left is nearest left + up - up-left. */
const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};

/**
 * The alpha of every pixel of an 8-bit RGBA PNG, row by row, undoing each row's filter. Enough
 * for the sheets in public/sprites; anything else throws.
 */
const pngAlpha = (bytes: Buffer): { width: number; alpha: Uint8Array } => {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) {
    throw new Error("Only 8-bit RGBA PNGs without interlacing are read here.");
  }
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("ascii", at + 4, at + 8) === "IDAT") {
      chunks.push(bytes.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[y * stride + i - 4]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4]! : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      pixels[y * stride + i] =
        (raw[y * (stride + 1) + 1 + i]! + predictor) & 255;
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = pixels[i * 4 + 3]!;
  }
  return { width, alpha };
};

/**
 * The names of frames with partly transparent pixels, leaving out tags drawn blended. The
 * views draw sprites opaque, cutting out pixels below half alpha and drawing the rest solid,
 * so art drawn that way should be fully opaque or fully clear.
 */
const framesWithSoftAlpha = (
  data: SpriteSheetData,
  png: Buffer,
  blended: readonly string[]
): string[] => {
  const { width, alpha } = pngAlpha(png);
  const skip = new Set<number>();
  for (const name of blended) {
    const tag = data.tags.get(name);
    if (tag !== undefined) {
      for (let f = tag.from; f <= tag.to; f++) {
        skip.add(f);
      }
    }
  }
  return data.frames.flatMap((frame, index) => {
    if (skip.has(index)) {
      return [];
    }
    for (let { y } = frame; y < frame.y + frame.height; y++) {
      for (let { x } = frame; x < frame.x + frame.width; x++) {
        const a = alpha[y * width + x]!;
        if (a !== 0 && a !== 255) {
          return [frame.name];
        }
      }
    }
    return [];
  });
};

describe("the sprite sheet", () => {
  it("has every tag the view draws for the demo's content", () => {
    expect(missingSpriteTags(sheet, content)).toStrictEqual([]);
  });

  it("names its PNG, and the PNG is the size the JSON says", () => {
    const png = read(`sprites/${sheet.image}`);
    expect({
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    }).toStrictEqual({ width: sheet.width, height: sheet.height });
  });

  it("has no partly transparent pixels but in the aura and shadow, which are drawn blended", () => {
    const png = read(`sprites/${sheet.image}`);
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

/** An engine loader whose every load fails, as when the sheet can't be fetched. */
const failingLoader: SurvivorsEngineLoader = { load: Effect.fail(sheetError) };

/** Runs `effect` with the real content and `loader` as the engine's. */
const runWith = <A, E>(
  effect: Effect.Effect<A, E, SurvivorsContent | SurvivorsEngine>,
  loader: SurvivorsEngineLoader
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SurvivorsContent, { load: Effect.succeed(content) }),
          Layer.succeed(SurvivorsEngine, loader)
        )
      )
    )
  );

/** An engine that would fail the test if anything used it. */
const unusedEngine = {
  attach: () => Effect.die("attach is never called"),
  listen: () => Effect.die("listen is never called"),
  start: () => Effect.die("start is never called"),
  modify: () => Effect.die("modify is never called"),
  setPaused: () => Effect.die("setPaused is never called"),
  stop: Effect.die("stop is never called"),
} satisfies SurvivorsEngineLoader["load"] extends Effect.Effect<
  { readonly engine: infer Engine },
  unknown
>
  ? Engine
  : never;

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
    const message = await runWith(LoadContent().effect, {
      load: Effect.succeed({
        engine: unusedEngine,
        assets: { sheet: makeSpriteSheet(sheet, image) },
      }),
    });
    expect(message._tag).toBe("LoadedContent");
  });

  it("shows a sheet that can't load on the loading screen, like content", async () => {
    const message = await runWith(LoadContent().effect, failingLoader);
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

  it("reports a failed load from the engine Commands instead of dying", async () => {
    const failed = Message.FailedToStartRun({ error: sheetError.message });
    const messages = await runWith(
      Effect.all([
        StartRun({ heroId: content.heroes[0]!.id }).effect,
        EndRun().effect,
        SetPaused({ paused: true }).effect,
        ChooseUpgrade({ index: 0 }).effect,
      ]),
      failingLoader
    );
    expect(messages).toStrictEqual([failed, failed, failed, failed]);
  });

  it("fails co-op's attach with the sheet's error, drawing nothing", async () => {
    const attached: HTMLElement[] = [];
    const client = {
      attach: (element: HTMLElement) =>
        Effect.suspend(() => {
          attached.push(element);
          return Effect.never;
        }),
      // A failed attach leaves co-op too.
      leave: Effect.void,
    } as unknown as CoopClient;
    const error = await Effect.runPromise(
      Effect.flip(makeCoop(client, failingLoader).attach({} as HTMLElement))
    );
    expect(error._tag).toBe("SpriteSheetError");
    expect(attached).toStrictEqual([]);
  });
});
