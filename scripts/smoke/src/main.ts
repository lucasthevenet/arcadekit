// The smoke test's tiny game in the browser: input, a pixel stage drawing sprites from a sheet,
// sound, a save and content, run by its declared engine. Vite builds it from the packed packages.
import { Audio, AudioSettings, defaultAudioSettings } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import { BrowserAudioLayer } from "arcadekit/audio/browser";
import { Asset, Content, memorySource } from "arcadekit/content";
import type { AttachableEngine } from "arcadekit/foldkit";
import * as Game from "arcadekit/game/browser";
import { InputController } from "arcadekit/input";
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
  SpriteSheetError,
} from "arcadekit/render-three";
import { Save, Setting } from "arcadekit/save";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Effect, Layer, Schema } from "effect";

import { Dots, DotsTogether, Nudge, replay } from "./simulation";
import type { DotsInput, Field } from "./simulation";

const createInput = (surface: HTMLElement): Game.InputSource<DotsInput> => {
  const controller = InputController.make(surface, {
    axes: InputController.moveAxes,
  });
  const input = { moveX: 0, moveY: 0 };
  return {
    read: () => {
      input.moveX = InputController.axis(controller, "moveX");
      input.moveY = InputController.axis(controller, "moveY");
      return input;
    },
    endStep: () => InputController.consumePresses(controller),
    endFrame: () => InputController.endFrame(controller),
    dispose: () => InputController.dispose(controller),
  };
};

const SPRITE_OPTIONS: InstancedSpritesOptions = { capacity: 256, layer: 1 };

class DotsView implements Game.View<Field> {
  private readonly stage: Stage<"pixel">;
  private readonly sprites: InstancedSprites;

  constructor(container: HTMLElement, sheet: SpriteSheet) {
    this.stage = new Stage(container, { camera: "pixel", pixelsPerUnit: 16 });
    this.sprites = new InstancedSprites(sheet, SPRITE_OPTIONS);
    this.stage.scene.add(this.sprites.mesh);
  }

  render(field: Field | null, timeSeconds: number): void {
    const tag = this.sprites.sheet.data.tags.get("dot");
    if (field !== null && tag !== undefined) {
      const frame = frameAt(this.sprites.sheet.data, tag, timeSeconds);
      const { x, z } = field.dots.fields;
      this.sprites.begin();
      for (let i = 0; i < field.dots.count; i++) {
        this.sprites.push(x[i]!, z[i]!, frame);
      }
      this.sprites.end();
      this.stage.camera.follow(field.playerX, field.playerZ);
    }
    this.stage.render();
  }

  dispose(): void {
    this.sprites.dispose();
    this.stage.dispose();
  }
}

const soundView = (audio: AudioSystem): Game.View<Field> => ({
  render: (field) => audio.setLoop("hum", field === null ? 0 : 0.5),
  dispose: () => audio.setLoop("hum", 0),
});

/** The sheet the dots are drawn from. The app says where it is, and frees it at its end. */
class DotsSheet extends Asset<SpriteSheet, SpriteSheetError>()("DotsSheet", {
  release: (sheet) => sheet.dispose(),
}) {}

/** The game in the browser: its rules, drawn from the app's sheet and heard through its audio. */
class DotsEngine extends Game.Engine("DotsEngine", {
  simulation: Dots,
  uses: { sheet: DotsSheet.load, audio: Audio },
  view: (container, { sheet, audio }) =>
    Game.combineViews(new DotsView(container, sheet), soundView(audio)),
  input: createInput,
}) {}

const Settings = Schema.Struct({ dots: Schema.Int, speed: Schema.Finite });

/** What a run is played with: one file, checked by its Schema. The app says where it is. */
class DotsContent extends Content("DotsContent", {
  schema: Schema.Struct({ settings: Settings }),
  files: { settings: "settings.json" },
}) {}

/** What the game keeps between sessions: the most dots near the cursor, by run. */
class DotsSave extends Save("DotsSave", {
  storageKey: "smoke/dots/save",
  field: "runs",
  record: Schema.Struct({ near: Schema.Int }),
  mergeRecord: (a, b) => (a.near >= b.near ? a : b),
}) {}

/** The player's volume and mute, under their own key. */
class DotsAudioSettings extends Setting("DotsAudioSettings", {
  storageKey: "smoke/dots/settings",
  schema: AudioSettings,
  default: defaultAudioSettings,
}) {}

const program = Effect.gen(function* () {
  const settings = yield* DotsContent.load;
  const save = yield* DotsSave;
  yield* (yield* DotsAudioSettings).read;
  yield* save.write({ first: { near: replay(1, 60) } });

  const engine: Game.EngineOf<typeof Dots, SpriteSheetError> =
    yield* DotsEngine;
  // What a Foldkit app's `engineEntry` takes: the engine's `attach` and `listen`.
  const attachable: AttachableEngine<
    Game.EventOf<typeof Dots>,
    Game.AttachError | Game.GameCrashed | SpriteSheetError
  > = engine;
  const element = document.querySelector<HTMLElement>("#game");
  if (element === null) {
    return;
  }
  yield* attachable.listen(
    Dots.match({
      Started: ({ dots }) => console.log(`${dots} dots`),
      Hud: ({ near }) => console.log(`${near} near`),
    })
  );
  yield* engine.start(settings.settings);
  // Draws until the page closes. Fails if the sheet can't be loaded, the view can't be made or
  // the game crashes.
  return yield* attachable.attach(element);
});

// Lockstep over the in-memory network: one player, a few steps, and a command the rules answer.
const network = createMemoryNetwork({ seed: 1 });
const session: LockstepSession<
  Field,
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
    hash: (field) => field.playerX,
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
    Effect.provide(
      DotsEngine.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            BrowserAudioLayer,
            Layer.mergeAll(DotsSave.layer, DotsAudioSettings.layer).pipe(
              Layer.provide(BrowserSaveStorage)
            ),
            DotsSheet.layer(loadSpriteSheet("sprites/dots.json")),
            DotsContent.layer(
              memorySource({ "settings.json": { dots: 128, speed: 6 } })
            )
          )
        )
      )
    )
  )
);
