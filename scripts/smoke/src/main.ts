// The smoke test's tiny game in the browser: input, a pixel stage drawing sprites from a sheet,
// sound, a save and content, run by the Effect engine. Vite builds it from the packed packages.
import { Audio, makeAudioSettingsStore } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import { BrowserAudioLayer } from "arcadekit/audio/browser";
import { loadContent, memorySource } from "arcadekit/content";
import type { AttachableEngine } from "arcadekit/foldkit";
import type * as Game from "arcadekit/game";
import { InputController, MOVE_AXES } from "arcadekit/input";
import { createMemoryNetwork, hostLockstep } from "arcadekit/net";
import type { LockstepSession } from "arcadekit/net";
import type { RoomOptions } from "arcadekit/net/browser";
import {
  InstancedSprites,
  Stage,
  frameAt,
  loadSpriteSheet,
} from "arcadekit/render-three";
import type {
  InstancedSpritesOptions,
  SpriteSheet,
} from "arcadekit/render-three";
import { combineViews, makeGameEngine } from "arcadekit/runtime/browser";
import type {
  AttachError,
  GameCrashed,
  GameDefinition,
  GameEngine,
  GameView,
  InputSource,
} from "arcadekit/runtime/browser";
import { makeSaveStore } from "arcadekit/save";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Effect, Layer, Schema } from "effect";

import { DotsTogether, Nudge, dotsSimulation, replay } from "./simulation";
import type { Dots, DotsConfig, DotsEvent, DotsInput } from "./simulation";

const createInput = (surface: HTMLElement): InputSource<DotsInput> => {
  const controller = new InputController(surface, { axes: MOVE_AXES });
  const input = { moveX: 0, moveY: 0 };
  return {
    read: () => {
      input.moveX = controller.axis("moveX");
      input.moveY = controller.axis("moveY");
      return input;
    },
    endStep: () => controller.consumePresses(),
    endFrame: () => controller.endFrame(),
    dispose: () => controller.dispose(),
  };
};

const SPRITE_OPTIONS: InstancedSpritesOptions = { capacity: 256, layer: 1 };

class DotsView implements GameView<Dots> {
  private readonly stage: Stage<"pixel">;
  private readonly sprites: InstancedSprites;

  constructor(container: HTMLElement, sheet: SpriteSheet) {
    this.stage = new Stage(container, { camera: "pixel", pixelsPerUnit: 16 });
    this.sprites = new InstancedSprites(sheet, SPRITE_OPTIONS);
    this.stage.scene.add(this.sprites.mesh);
  }

  render(state: Dots | null, timeSeconds: number): void {
    const tag = this.sprites.sheet.data.tags.get("dot");
    if (state !== null && tag !== undefined) {
      const frame = frameAt(this.sprites.sheet.data, tag, timeSeconds);
      const { x, z } = state.dots.fields;
      for (let i = 0; i < state.dots.count; i++) {
        this.sprites.set(i, x[i]!, z[i]!, frame);
      }
      this.sprites.commit(state.dots.count);
      this.stage.camera.follow(state.playerX, state.playerZ);
    }
    this.stage.render();
  }

  dispose(): void {
    this.sprites.dispose();
    this.stage.dispose();
  }
}

const soundView = (audio: AudioSystem): GameView<Dots> => ({
  render: (state) => audio.setLoop("hum", state === null ? 0 : 0.5),
  dispose: () => audio.setLoop("hum", 0),
});

const makeDotsGame = (
  sheet: SpriteSheet,
  audio: AudioSystem
): GameDefinition<DotsConfig, Dots, DotsInput, DotsEvent> => ({
  ...dotsSimulation,
  createInput,
  createView: (container) =>
    combineViews(new DotsView(container, sheet), soundView(audio)),
});

const Settings = Schema.Struct({ dots: Schema.Int, speed: Schema.Finite });

const BestRecord = Schema.Struct({ near: Schema.Int });

const program = Effect.gen(function* () {
  const settings = yield* loadContent({
    schema: Schema.Struct({ settings: Settings }),
    files: { settings: "settings.json" },
    source: memorySource({ "settings.json": { dots: 128, speed: 6 } }),
  });
  const save = yield* makeSaveStore({
    key: "smoke/dots/save",
    field: "runs",
    record: BestRecord,
    mergeRecord: (a, b) => (a.near >= b.near ? a : b),
  });
  const audioSettings = yield* makeAudioSettingsStore("smoke/dots/settings");
  yield* audioSettings.load;
  yield* save.merge({ first: { near: replay(1, 60) } });

  const audio = yield* Audio;
  const sheet = yield* loadSpriteSheet("sprites/dots.json");
  const engine: GameEngine<DotsConfig, Dots, DotsEvent> = makeGameEngine(
    makeDotsGame(sheet, audio)
  );
  const attachable: AttachableEngine<DotsEvent, AttachError | GameCrashed> =
    engine;
  const element = document.querySelector<HTMLElement>("#game");
  if (element === null) {
    return;
  }
  yield* attachable.listen((event) => console.log(event));
  yield* engine.start(settings.settings);
  // Draws until the page closes. Fails if the view can't be made or the game crashes.
  return yield* attachable.attach(element);
});

// Lockstep over the in-memory network: one player, a few steps, and a command the rules answer.
const network = createMemoryNetwork({ seed: 1 });
const session: LockstepSession<
  Dots,
  Game.EventOf<typeof DotsTogether>,
  Game.CommandOf<typeof DotsTogether>,
  Game.RefusalsOf<readonly [typeof Nudge]>
> = hostLockstep(
  {
    simulation: DotsTogether,
    config: { dots: 8, speed: 4 },
    contentHash: "smoke",
    transport: network.connect("host"),
    local: { read: () => ({ moveX: 0, moveY: 0 }) },
    hash: (state) => state.playerX,
    inputDelay: 2,
    hashEvery: 30,
    peers: [],
    seed: 7,
  },
  0
);
session.send(new Nudge({ by: 1 }), (outcome) => {
  console.log(outcome?._tag ?? "nudged");
});
session.tick(16);
session.dispose();

const signalling: Partial<RoomOptions> = {};
console.log(signalling);

Effect.runFork(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(BrowserAudioLayer, BrowserSaveStorage))
  )
);
