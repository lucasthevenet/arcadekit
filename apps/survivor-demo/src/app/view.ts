/**
 * The app's `view`: Foldkit's contract.
 *
 * Plain on purpose: `view` is a pure function of the Model (Foldkit's contract). The viewport is
 * rendered on every screen, so moving between the screens of one mode keeps what is attached to
 * it, and its canvas: the engine on the menu and a single-player run's screens, the co-op client
 * on co-op's. Moving between the modes detaches one and attaches the other, and a "Try again"
 * after a failure attaches the engine anew.
 */
import type { AudioSettings, AudioSystem } from "arcadekit/audio";
import { Viewport } from "arcadekit/foldkit";
import type { CoopEvent } from "arcadekit/net/browser";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import type { Hero, Hud, Offer } from "#survivors";

import type * as HeroRecords from "./hero-records";
import { Message } from "./message";
import { Phase, isLocalHeroDown } from "./model";
import type { Model } from "./model";

type H = HtmlBuilder<Message>;

/** The id of the load-error screen's "Try again" button, which FocusRetry focuses so Enter retries. */
export const retryButtonId = "retry";

/** The page for a Model: the viewport the engine or the co-op client draws in, and the screen over it. */
export const view = (model: Model, h: H): Document => ({
  title: "Survivor Kit",
  body: h.div(
    [h.Class("app")],
    [
      // The engine or the co-op client draws here. Rendered on every screen, so it stays.
      Viewport.make(h, {
        mounted: Message.MountedViewport(),
        unmounted: Message.UnmountedViewport(),
      }),
      h.div([h.Key("overlay"), h.Class("overlay")], [overlay(model, h)]),
    ]
  ),
});

const overlay = (model: Model, h: H): Html =>
  Phase.match(model.phase, {
    Loading: () => panel(h, [h.p([], ["Loading…"])]),
    LoadFailed: ({ error }) =>
      panel(h, [
        h.h2([], ["Something went wrong"]),
        h.p([h.Class("error")], [error]),
        h.button(
          [
            h.Id(retryButtonId),
            h.Class("primary"),
            h.OnClick(Message.ClickedRetry()),
          ],
          ["Try again"]
        ),
      ]),
    Menu: () => menu(model, h),
    Starting: () => h.empty,
    Playing: () => hud(model.hud, h),
    Paused: () =>
      h.div(
        [],
        [
          hud(model.hud, h),
          panel(h, [
            h.h2([], ["Paused"]),
            h.div(
              [h.Class("row")],
              [
                h.button(
                  [h.Class("primary"), h.OnClick(Message.ClickedResume())],
                  ["Resume"]
                ),
                h.button([h.OnClick(Message.ClickedQuit())], ["Quit to menu"]),
              ]
            ),
            soundPanel(model.audio, h),
          ]),
        ]
      ),
    LevelUp: ({ choices }) =>
      h.div(
        [],
        [
          hud(model.hud, h),
          levelUp(choices, h, (index) => Message.ClickedUpgrade({ index })),
        ]
      ),
    GameOver: ({ summary }) => gameOver(summary, h),

    CoopMenu: ({ joinCode }) => coopMenu(joinCode, h),
    CoopConnecting: () =>
      panel(h, [
        h.p([], ["Connecting…"]),
        h.button([h.OnClick(Message.ClickedLeaveCoop())], ["Cancel"]),
      ]),
    CoopLobby: ({ lobby }) => coopLobby(model, lobby, h),
    CoopPlaying: () => coopPlaying(model, h),
    CoopLevelUp: ({ choices }) =>
      h.div(
        [],
        [
          coopHud(model, h),
          levelUp(choices, h, (index) => Message.ClickedCoopUpgrade({ index })),
        ]
      ),
    CoopGameOver: ({ summary }) =>
      panel(h, [
        h.h2([], [summary.won ? "You survived!" : "Defeated"]),
        h.p(
          [],
          [
            `Your ${summary.heroName} saw the team to ${formatTime(summary.time)}, level ${summary.level} and ${summary.kills} enemies defeated.`,
          ]
        ),
        h.button(
          [h.Class("primary"), h.OnClick(Message.ClickedLeaveCoop())],
          ["Back to menu"]
        ),
      ]),
    CoopFailed: ({ error }) =>
      panel(h, [
        h.h2([], ["Co-op stopped"]),
        h.p([h.Class("error coop-error")], [error]),
        h.button([h.OnClick(Message.ClickedLeaveCoop())], ["Back to menu"]),
      ]),
  });

const panel = (h: H, children: readonly (Html | string)[]): Html =>
  h.div(
    [h.Class("panel-backdrop")],
    [h.div([h.Class("panel")], [...children])]
  );

const savedRecord = (model: Model, heroId: string) =>
  Object.hasOwn(model.records, heroId) ? model.records[heroId] : undefined;

const recordText = (record: HeroRecords.HeroRecord) =>
  `${record.won ? "Won · " : ""}Best ${formatTime(record.bestTime)} · ${record.mostKills} defeated`;

const heroPicker = (model: Model, h: H, withRecords: boolean): Html =>
  h.div(
    [h.Class("heroes")],
    model.heroes.map((hero) => {
      const record = withRecords ? savedRecord(model, hero.id) : undefined;
      return h.button(
        [
          h.Key(hero.id),
          h.Class(hero.id === model.selectedHeroId ? "hero selected" : "hero"),
          h.OnClick(Message.SelectedHero({ heroId: hero.id })),
        ],
        [
          h.span([h.Class("swatch"), h.Style({ background: hero.color })], []),
          h.strong([], [hero.name]),
          h.small([], [hero.description]),
          record === undefined
            ? h.empty
            : h.small([h.Class("record")], [recordText(record)]),
        ]
      );
    })
  );

const menu = (model: Model, h: H): Html =>
  panel(h, [
    h.h1([], ["Survivor Kit"]),
    h.p(
      [h.Class("muted")],
      ["Pick a hero. Move with WASD, arrows, a gamepad, or drag on the screen."]
    ),
    heroPicker(model, h, true),
    h.div(
      [h.Class("stack")],
      [
        h.button(
          [h.Class("primary big"), h.OnClick(Message.ClickedStart())],
          ["Start run"]
        ),
        h.button([h.Class("big"), h.OnClick(Message.ClickedCoop())], ["Co-op"]),
      ]
    ),
    soundPanel(model.audio, h),
  ]);

const BUSES: readonly {
  readonly bus: AudioSystem.Bus;
  readonly label: string;
}[] = [
  { bus: "master", label: "Volume" },
  { bus: "sfx", label: "Effects" },
  { bus: "music", label: "Music" },
];

/** The volume sliders and mute, on the menu and pause screens. M toggles mute anywhere. */
const soundPanel = (audio: AudioSettings.AudioSettings, h: H): Html =>
  h.div(
    [h.Class("sound")],
    [
      ...BUSES.map(({ bus, label }) =>
        h.label(
          [h.Key(bus), h.Class("slider")],
          [
            h.span([], [label]),
            h.input([
              h.Type("range"),
              h.Name(`volume-${bus}`),
              h.Min("0"),
              h.Max("1"),
              h.Step("0.05"),
              h.Value(String(audio[bus])),
              h.Disabled(audio.muted),
              h.OnInput((value) =>
                Message.ChangedVolume({ bus, volume: Number(value) })
              ),
            ]),
          ]
        )
      ),
      h.button(
        [
          h.Class(audio.muted ? "mute on" : "mute"),
          h.AriaPressed(String(audio.muted)),
          h.OnClick(Message.ClickedMute()),
        ],
        [audio.muted ? "Unmute (M)" : "Mute (M)"]
      ),
    ]
  );

const hud = (data: Hud, h: H): Html => {
  // A single-player run's hero is the first.
  const hero = data.heroes[0] ?? { hp: 0, maxHp: 1 };
  return h.div(
    [h.Class("hud")],
    [
      bar(
        h,
        "hp",
        hero.hp / hero.maxHp,
        `${Math.ceil(hero.hp)} / ${Math.round(hero.maxHp)}`
      ),
      bar(h, "xp", data.xp / data.xpNext, `Level ${data.level}`),
      h.div(
        [h.Class("stats")],
        [
          h.span(
            [],
            [`${formatTime(data.time)} / ${formatTime(data.runLength)}`]
          ),
          h.span([], [`${data.kills} defeated`]),
          h.span(
            [h.Class("muted")],
            [`${data.enemies} on screen · Esc to pause`]
          ),
        ]
      ),
    ]
  );
};

const bar = (h: H, kind: string, fraction: number, label: string): Html =>
  h.div(
    [h.Class(`bar ${kind}`)],
    [
      h.div(
        [
          h.Class("fill"),
          h.Style({ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }),
        ],
        []
      ),
      h.span([h.Class("label")], [label]),
    ]
  );

const levelUp = (
  choices: readonly Offer.Choice[],
  h: H,
  picked: (index: number) => Message
): Html =>
  panel(h, [
    h.h2([], ["Level up! Choose one"]),
    h.div(
      [h.Class("choices")],
      choices.map((choice, index) =>
        h.button(
          [
            h.Key(`${choice.id}-${index}`),
            h.Class("choice"),
            h.OnClick(picked(index)),
          ],
          [
            h.small([h.Class("muted")], [choiceTag(choice)]),
            h.strong([], [choice.name]),
            h.span([], [choice.description]),
          ]
        )
      )
    ),
  ]);

const choiceTag = (choice: Offer.Choice) =>
  choice.kind === "heal"
    ? "Heal"
    : `${choice.kind === "weapon" ? "Weapon" : "Passive"} · ${choice.level === 1 ? "New" : `Level ${choice.level}`}`;

const gameOver = (summary: Hero.Summary, h: H): Html =>
  panel(h, [
    h.h2([], [summary.won ? "You survived!" : "Defeated"]),
    h.p(
      [],
      [
        `${summary.heroName} lasted ${formatTime(summary.time)}, reached level ${summary.level} and defeated ${summary.kills} enemies.`,
      ]
    ),
    h.div(
      [h.Class("row")],
      [
        h.button(
          [h.Class("primary"), h.OnClick(Message.ClickedPlayAgain())],
          ["Play again"]
        ),
        h.button([h.OnClick(Message.ClickedQuit())], ["Back to menu"]),
      ]
    ),
  ]);

const coopMenu = (joinCode: string, h: H): Html =>
  panel(h, [
    h.h1([], ["Co-op"]),
    h.p(
      [h.Class("muted")],
      [
        "2 to 4 players, each in their own browser. One hosts and reads out the join code; the others join with it.",
      ]
    ),
    h.div(
      [h.Class("stack")],
      [
        h.button(
          [h.Class("primary big"), h.OnClick(Message.ClickedHostCoop())],
          ["Host a run"]
        ),
        h.form(
          [h.Class("join"), h.OnSubmit(Message.ClickedJoinCoop())],
          [
            h.input([
              h.Name("join-code"),
              h.Value(joinCode),
              h.Placeholder("Join code"),
              h.Autocomplete("off"),
              h.OnInput((code) => Message.ChangedJoinCode({ code })),
            ]),
            h.button([h.Type("submit")], ["Join"]),
          ]
        ),
        h.button([h.OnClick(Message.ClickedLeaveCoop())], ["Back"]),
      ]
    ),
  ]);

const heroName = (model: Model, heroId: string) =>
  model.heroes.find((hero) => hero.id === heroId)?.name ?? "choosing…";

const coopLobby = (model: Model, lobby: CoopEvent.LobbyChanged, h: H): Html => {
  const startable = lobby.canStart;
  return panel(h, [
    lobby.role === "host"
      ? h.div(
          [],
          [
            h.p([h.Class("muted")], ["Join code"]),
            h.p([h.Class("join-code")], [lobby.code]),
            h.p(
              [h.Class("muted")],
              ["Read it out: your friends pick Co-op, then join with it."]
            ),
          ]
        )
      : h.h2([], [`Joined ${lobby.code}`]),
    h.ul(
      [h.Class("players")],
      lobby.players.map((player) =>
        h.li(
          [h.Key(player.id)],
          [
            `${player.name}${player.id === lobby.self ? " (you)" : ""} · ${heroName(model, player.pick)}`,
          ]
        )
      )
    ),
    heroPicker(model, h, false),
    lobby.role === "host"
      ? h.button(
          [
            h.Class("primary big"),
            h.Disabled(!startable),
            h.OnClick(Message.ClickedStartCoop()),
          ],
          [startable ? "Start run" : "Waiting for players…"]
        )
      : h.p([h.Class("muted")], ["Waiting for the host to start…"]),
    h.div(
      [h.Class("row")],
      [h.button([h.OnClick(Message.ClickedLeaveCoop())], ["Leave"])]
    ),
  ]);
};

const coopHud = (model: Model, h: H): Html => {
  const data = model.hud;
  const { slot, names } = model.coop;
  const hero = data.heroes[slot] ?? { hp: 0, maxHp: 1 };
  return h.div(
    [h.Class("hud")],
    [
      bar(
        h,
        "hp",
        hero.hp / hero.maxHp,
        `${Math.ceil(hero.hp)} / ${Math.round(hero.maxHp)}`
      ),
      bar(h, "xp", data.xp / data.xpNext, `Level ${data.level}`),
      h.div(
        [h.Class("stats")],
        [
          h.span(
            [],
            [`${formatTime(data.time)} / ${formatTime(data.runLength)}`]
          ),
          h.span([], [`${data.kills} defeated`]),
          // A hero that is down holds no pause: Escape is then the menu alone.
          h.span(
            [h.Class("muted")],
            [isLocalHeroDown(model) ? "Esc for the menu" : "Esc to pause"]
          ),
        ]
      ),
      h.div(
        [h.Class("stats")],
        data.heroes.map((other, index) =>
          h.span(
            [h.Key(`player-${index}`)],
            [
              `${names[index] ?? "?"}${index === slot ? " (you)" : ""}: ${
                other.status === "playing"
                  ? `${Math.ceil(other.hp)} HP${other.paused ? ", paused" : ""}`
                  : other.status
              }`,
            ]
          )
        )
      ),
    ]
  );
};

/** Why the run isn't moving, if it isn't: lockstep waiting on a player, a level-up, a pause. */
const coopBanner = (
  waitingFor: readonly string[],
  choosing: readonly string[],
  pausedBy: readonly string[]
): string | undefined => {
  if (waitingFor.length > 0) {
    return `Waiting for ${waitingFor.join(", ")}…`;
  }
  if (choosing.length > 0) {
    return `Waiting for ${choosing.join(", ")} to pick an upgrade…`;
  }
  if (pausedBy.length > 0) {
    return `Paused by ${pausedBy.join(", ")}`;
  }
  return undefined;
};

/**
 * A co-op run's menu, which Escape opens: the way to leave the run, and the sound controls.
 * While it is up the local player holds the run paused for everyone, if the run took the pause
 * (`paused`). It takes none from a hero that is down, and then the menu says the run plays on.
 */
const coopMenuPanel = (model: Model, h: H): Html => {
  const { paused } = model.coop;
  return panel(h, [
    h.h2([], [paused ? "Paused" : "Menu"]),
    h.p(
      [h.Class("muted")],
      [
        paused
          ? "The run is paused for everyone until you resume."
          : "The run plays on: a hero that is down can't pause it.",
      ]
    ),
    h.div(
      [h.Class("row")],
      [
        h.button(
          [h.Class("primary"), h.OnClick(Message.ClickedCoopResume())],
          [paused ? "Resume" : "Back to the run"]
        ),
        h.button([h.OnClick(Message.ClickedLeaveCoop())], ["Leave run"]),
      ]
    ),
    soundPanel(model.audio, h),
  ]);
};

/**
 * The other players whose hero the HUD flags: who the run waits on to pick an upgrade
 * (`choosing`), and who holds it paused (`paused`). The genre says both, in its sample.
 */
const others = (model: Model, flag: "choosing" | "paused"): string[] => {
  const { slot, names } = model.coop;
  return model.hud.heroes.flatMap((hero, index) => {
    const name = names[index];
    return hero[flag] && index !== slot && name !== undefined ? [name] : [];
  });
};

const coopPlaying = (model: Model, h: H): Html => {
  const banner = coopBanner(
    model.coop.waitingFor,
    others(model, "choosing"),
    others(model, "paused")
  );
  return h.div(
    [],
    [
      coopHud(model, h),
      banner === undefined ? h.empty : h.div([h.Class("banner")], [banner]),
      model.coop.menu ? coopMenuPanel(model, h) : h.empty,
    ]
  );
};

const formatTime = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
