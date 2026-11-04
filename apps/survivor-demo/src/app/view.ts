import { gameViewport } from "@gamekit/foldkit";
import type { HudSample, RunSummary, UpgradeChoice } from "@gamekit/survivors";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { playerName } from "../coop/lobby";
import { Message } from "./message";
import { Phase } from "./model";
import type { CoopPlayer, Model } from "./model";
import type { HeroRecord } from "./save";

type H = HtmlBuilder<Message>;

export const view = (model: Model, h: H): Document => ({
  title: "Survivor Kit",
  body: h.div(
    [h.Class("app")],
    [
      // The engine draws here. Rendered on every screen, so the canvas is never recreated.
      gameViewport(h, {
        mounted: Message.MountedViewport(),
        unmounted: Message.UnmountedViewport(),
      }),
      h.div([h.Key("overlay"), h.Class("overlay")], [overlay(model, h)]),
    ]
  ),
});

const overlay = (model: Model, h: H): Html =>
  Phase.match(model.phase, {
    Loading: () => panel(h, [h.p([], ["Loading content…"])]),
    LoadFailed: ({ error }) =>
      panel(h, [
        h.h2([], ["Something went wrong"]),
        h.p([h.Class("error")], [error]),
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
    CoopLobby: (lobby) => coopLobby(model, lobby, h),
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

const recordText = (record: HeroRecord) =>
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
  ]);

const hud = (data: HudSample, h: H): Html => {
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
  choices: readonly UpgradeChoice[],
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

const choiceTag = (choice: UpgradeChoice) =>
  choice.kind === "heal"
    ? "Heal"
    : `${choice.kind === "weapon" ? "Weapon" : "Passive"} · ${choice.level === 1 ? "New" : `Level ${choice.level}`}`;

const gameOver = (summary: RunSummary, h: H): Html =>
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

const coopLobby = (
  model: Model,
  lobby: {
    readonly role: "host" | "guest";
    readonly code: string;
    readonly self: string;
    readonly players: readonly CoopPlayer[];
  },
  h: H
): Html => {
  const canStart =
    lobby.players.length >= 2 &&
    lobby.players.every((player) => player.heroId !== "");
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
            `${playerName(player.id)}${player.id === lobby.self ? " (you)" : ""} · ${heroName(model, player.heroId)}`,
          ]
        )
      )
    ),
    heroPicker(model, h, false),
    lobby.role === "host"
      ? h.button(
          [
            h.Class("primary big"),
            h.Disabled(!canStart),
            h.OnClick(Message.ClickedStartCoop()),
          ],
          [canStart ? "Start run" : "Waiting for players…"]
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
  const { slot, players } = model.coop;
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
          h.span([h.Class("muted")], ["Esc to pause"]),
        ]
      ),
      h.div(
        [h.Class("stats")],
        data.heroes.map((other, index) =>
          h.span(
            [h.Key(`player-${index}`)],
            [
              `${players[index] ?? "?"}${index === slot ? " (you)" : ""}: ${
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

const coopPlaying = (model: Model, h: H): Html => {
  const { waitingFor, choosing, paused, slot, players } = model.coop;
  const pausedBy = model.hud.heroes
    .map((hero, index) =>
      hero.paused && index !== slot ? players[index] : undefined
    )
    .filter((name) => name !== undefined);
  const banner = coopBanner(waitingFor, choosing, pausedBy);
  return h.div(
    [],
    [
      coopHud(model, h),
      banner === undefined ? h.empty : h.div([h.Class("banner")], [banner]),
      paused
        ? panel(h, [
            h.h2([], ["Paused"]),
            h.p(
              [h.Class("muted")],
              ["The run is paused for everyone until you resume."]
            ),
            h.div(
              [h.Class("row")],
              [
                h.button(
                  [h.Class("primary"), h.OnClick(Message.ClickedCoopResume())],
                  ["Resume"]
                ),
                h.button(
                  [h.OnClick(Message.ClickedLeaveCoop())],
                  ["Leave run"]
                ),
              ]
            ),
          ])
        : h.empty,
    ]
  );
};

const formatTime = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
