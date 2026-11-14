// The smoke test's tiny game in the browser: input, a pixel stage drawing sprites from a sheet,
// sound, a save and content, run by its declared engine. Vite builds it from the packed packages.
import { AudioSettings, AudioSystem } from "arcadekit/audio";
import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { Asset, Content, ContentSource } from "arcadekit/content";
import type { EngineEntry } from "arcadekit/foldkit";
import * as Game from "arcadekit/game/browser";
import { InputController } from "arcadekit/input";
import { LockstepSession, MemoryNetwork } from "arcadekit/net";
import type { SignallingRoom } from "arcadekit/net/browser";
import {
  InstancedSprites,
  PixelCamera,
  SpriteSheet,
  Stage,
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

const SPRITE_OPTIONS: InstancedSprites.Options = { capacity: 256, layer: 1 };

class DotsView implements Game.View<Field> {
  private readonly stage: Stage.Stage<"pixel">;
  private readonly sprites: InstancedSprites.InstancedSprites;

  constructor(container: HTMLElement, sheet: SpriteSheet.SpriteSheet) {
    this.stage = Stage.make(container, { camera: "pixel", pixelsPerUnit: 16 });
    this.sprites = InstancedSprites.make(sheet, SPRITE_OPTIONS);
    this.stage.scene.add(this.sprites.mesh);
  }

  render(field: Field | null, timeSeconds: number): void {
    const tag = this.sprites.sheet.data.tags.get("dot");
    if (field !== null && tag !== undefined) {
      const frame = SpriteSheet.frameAt(
        this.sprites.sheet.data,
        tag,
        timeSeconds
      );
      const { x, z } = field.dots.fields;
      InstancedSprites.begin(this.sprites);
      for (let i = 0; i < field.dots.count; i++) {
        InstancedSprites.push(this.sprites, x[i]!, z[i]!, frame);
      }
      InstancedSprites.end(this.sprites);
      PixelCamera.follow(this.stage.camera, field.playerX, field.playerZ);
    }
    Stage.render(this.stage);
  }

  dispose(): void {
    InstancedSprites.dispose(this.sprites);
    Stage.dispose(this.stage);
  }
}

const soundView = (audio: AudioSystem.AudioSystem): Game.View<Field> => ({
  render: (field) => audio.setLoop("hum", field === null ? 0 : 0.5),
  dispose: () => audio.setLoop("hum", 0),
});

/** The sheet the dots are drawn from. The app says where it is, and frees it at its end. */
class DotsSheet extends Asset<
  SpriteSheet.SpriteSheet,
  SpriteSheet.SpriteSheetError
>()("DotsSheet", { release: SpriteSheet.dispose }) {}

/** The game in the browser: its rules, drawn from the app's sheet and heard through its audio. */
class DotsEngine extends Game.Engine("DotsEngine", {
  simulation: Dots,
  uses: { sheet: DotsSheet.load, audio: AudioSystem.AudioSystem },
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
  record: Schema.Struct({ near: Schema.Int }),
  mergeRecord: (a, b) => (a.near >= b.near ? a : b),
}) {}

/** The player's volume and mute, under their own key. */
class DotsAudioSettings extends Setting("DotsAudioSettings", {
  storageKey: "smoke/dots/settings",
  schema: AudioSettings.AudioSettings,
  default: AudioSettings.defaults,
}) {}

const program = Effect.gen(function* () {
  const settings = yield* DotsContent.load;
  const save = yield* DotsSave;
  yield* (yield* DotsAudioSettings).read;
  yield* save.write({ first: { near: replay(1, 60) } });

  const engine: Game.EngineOf<typeof Dots, SpriteSheet.SpriteSheetError> =
    yield* DotsEngine;
  // What a Foldkit app's engine entry takes: the engine's `attach` and `listen`.
  const attachable: EngineEntry.Attachable<
    Game.EventOf<typeof Dots>,
    Game.AttachError | Game.GameCrashed | SpriteSheet.SpriteSheetError
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
const network = MemoryNetwork.make({ seed: 1 });
const session: LockstepSession.LockstepSession<
  Field,
  Game.EventOf<typeof DotsTogether>,
  Game.CommandOf<typeof DotsTogether>,
  Game.RefusalsOf<readonly [typeof Nudge]>
> = LockstepSession.host(
  {
    simulation: DotsTogether,
    config: { dots: 8, speed: 4 },
    contentHash: "smoke",
    transport: MemoryNetwork.connect(network, "host"),
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

const signalling: Partial<SignallingRoom.Options> = {};
console.log(signalling);

Effect.runFork(
  program.pipe(
    Effect.scoped,
    Effect.provide(
      DotsEngine.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            BrowserAudioSystem.layer,
            Layer.mergeAll(DotsSave.layer, DotsAudioSettings.layer).pipe(
              Layer.provide(BrowserSaveStorage.layer)
            ),
            DotsSheet.layer(SpriteSheet.fromUrl("sprites/dots.json")),
            DotsContent.layer(
              ContentSource.fromRecord({
                "settings.json": { dots: 128, speed: 6 },
              })
            )
          )
        )
      )
    )
  )
);
