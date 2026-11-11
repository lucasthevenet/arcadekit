import { readFileSync, readdirSync } from "node:fs";

import { defaultAudioSettings } from "arcadekit/audio";
import { LobbyChanged } from "arcadekit/net/browser";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { ChooseUpgrade, PlayClick, SaveAudioSettings } from "./commands";
import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";
import {
  AUDIO_SETTINGS_KEY,
  SoundSettings,
  SoundSettingsLayer,
  soundList,
  survivorsSounds,
} from "./sound";
import { subscriptions } from "./subscriptions";
import { init, update } from "./update";

const soundsDir = new URL("../../public/sounds/", import.meta.url);
const weapons = JSON.parse(
  readFileSync(
    new URL("../../public/content/weapons.json", import.meta.url),
    "utf-8"
  )
) as readonly { readonly sound?: string }[];

describe("the sound list", () => {
  it("names each file in public/sounds by its id, and nothing else", () => {
    const files = readdirSync(soundsDir).filter((name) =>
      name.endsWith(".wav")
    );
    const ids = Object.keys(soundList);
    expect({
      ids: ids.toSorted(),
      files: ids.map((id) => soundList[id]!.file.split("/").at(-1)).toSorted(),
    }).toStrictEqual({
      ids: files.map((name) => name.replace(/\.wav$/u, "")).toSorted(),
      files: files.toSorted(),
    });
  });

  it("has every sound the cue table and the weapons name", () => {
    const named = [
      ...Object.values(survivorsSounds),
      ...weapons.flatMap((weapon) => weapon.sound ?? []),
    ];
    expect(named.filter((id) => !Object.hasOwn(soundList, id))).toStrictEqual(
      []
    );
  });
});

const soundOf = (model: Model) =>
  subscriptions.sound.modelToDependencies(model);
const menu: Model = { ...init().model, phase: Phase.Menu() };

const at = (phase: Phase) => {
  const { music, ducked } = soundOf({ ...menu, phase });
  return { music, ducked };
};

describe("music and ducking", () => {
  it("plays the menu's music on menus and the run's during a run, ducked while paused", () => {
    expect([
      at(Phase.Menu()),
      at(Phase.Playing()),
      at(Phase.Paused()),
      at(Phase.LevelUp({ offer: 1, choices: [] })),
      at(
        Phase.GameOver({
          summary: {
            won: true,
            heroId: "",
            heroName: "",
            time: 0,
            kills: 0,
            level: 1,
          },
        })
      ),
      at(
        Phase.CoopLobby({
          lobby: new LobbyChanged({
            role: "host",
            code: "",
            self: "",
            players: [],
            maxPlayers: 4,
            canStart: false,
          }),
        })
      ),
      at(Phase.CoopPlaying()),
    ]).toStrictEqual([
      { music: "menu", ducked: false },
      { music: "run", ducked: false },
      { music: "run", ducked: true },
      { music: "run", ducked: false },
      { music: "menu", ducked: false },
      { music: "menu", ducked: false },
      { music: "run", ducked: false },
    ]);
  });

  it("ducks a co-op run while anyone holds it paused", () => {
    const coop: Model = { ...menu, phase: Phase.CoopPlaying() };
    const pausedByMe = { ...coop, coop: { ...coop.coop, paused: true } };
    const pausedByOther = {
      ...coop,
      hud: {
        ...coop.hud,
        heroes: coop.hud.heroes.map((hero) => ({ ...hero, paused: true })),
      },
    };
    expect([
      soundOf(pausedByMe).ducked,
      soundOf(pausedByOther).ducked,
    ]).toStrictEqual([true, true]);
  });
});

describe("the audio settings", () => {
  it("start at the defaults and take in the saved ones", () => {
    const saved = { master: 0.5, sfx: 0.2, music: 0, muted: true };
    Story.story(
      update,
      Story.given(menu),
      Story.model((model) =>
        expect(model.audio).toStrictEqual(defaultAudioSettings)
      ),
      Story.message(Message.LoadedAudioSettings({ settings: saved })),
      Story.model((model) =>
        expect(soundOf(model)).toMatchObject({
          master: 0.5,
          sfx: 0.2,
          musicVolume: 0,
          muted: true,
        })
      )
    );
  });

  it("saves a volume change, clamped", () => {
    const settings = { ...defaultAudioSettings, sfx: 1 };
    Story.story(
      update,
      Story.given(menu),
      Story.message(Message.ChangedVolume({ bus: "sfx", volume: 1.4 })),
      Story.model((model) => expect(model.audio).toStrictEqual(settings)),
      Story.Command.expectExact(SaveAudioSettings({ settings })),
      Story.Command.resolve(SaveAudioSettings, Message.CompletedAudioCommand())
    );
  });

  it("toggles mute with M, during a run too, and saves it", () => {
    const muted = { ...defaultAudioSettings, muted: true };
    Story.story(
      update,
      Story.given({ ...menu, phase: Phase.Playing() }),
      Story.message(Message.PressedMute()),
      Story.model((model) => expect(model.audio.muted).toBe(true)),
      Story.Command.expectExact(SaveAudioSettings({ settings: muted })),
      Story.Command.resolve(SaveAudioSettings, Message.CompletedAudioCommand())
    );
  });

  it("are stored under their own key, and read back", async () => {
    const settings = { master: 0.3, sfx: 0.4, music: 0.5, muted: true };
    const result = await Effect.gen(function* () {
      const store = yield* SoundSettings;
      yield* store.save(settings);
      return [
        yield* store.load,
        yield* (yield* KeyValueStore.KeyValueStore).get(AUDIO_SETTINGS_KEY),
      ];
    }).pipe(
      Effect.provide(
        SoundSettingsLayer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
      ),
      Effect.orDie,
      Effect.runPromise
    );
    expect(result).toStrictEqual([settings, JSON.stringify(settings)]);
  });
});

describe("clicks", () => {
  it("play on menu buttons and upgrade picks", () => {
    Story.story(
      update,
      Story.given({ ...menu, phase: Phase.LevelUp({ offer: 1, choices: [] }) }),
      Story.message(Message.ClickedUpgrade({ index: 0 })),
      // The pick names the offer on screen.
      Story.Command.expectExact(
        ChooseUpgrade({ offer: 1, index: 0 }),
        PlayClick()
      ),
      Story.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
      Story.Command.resolve(ChooseUpgrade, Message.CompletedEngineCommand()),
      Story.model((model) => expect(model.phase._tag).toBe("Playing"))
    );
  });

  it("don't play on what isn't a click", () => {
    Story.story(
      update,
      Story.given(menu),
      Story.message(Message.ChangedVolume({ bus: "music", volume: 0.2 })),
      Story.Command.expectExact(
        SaveAudioSettings({ settings: { ...defaultAudioSettings, music: 0.2 } })
      ),
      Story.Command.resolve(SaveAudioSettings, Message.CompletedAudioCommand()),
      Story.model((model) => expect(model.audio.music).toBe(0.2))
    );
  });
});
