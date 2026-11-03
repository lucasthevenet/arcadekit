import { gameViewport } from "@gamekit/foldkit";
import type { HudSample, RunSummary, UpgradeChoice } from "@gamekit/survivors";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";

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
      h.div([], [hud(model.hud, h), levelUp(choices, h)]),
    GameOver: ({ summary }) => gameOver(summary, h),
  });

const panel = (h: H, children: readonly (Html | string)[]): Html =>
  h.div(
    [h.Class("panel-backdrop")],
    [h.div([h.Class("panel")], [...children])]
  );

const menu = (model: Model, h: H): Html =>
  panel(h, [
    h.h1([], ["Survivor Kit"]),
    h.p(
      [h.Class("muted")],
      ["Pick a hero. Move with WASD, arrows, a gamepad, or drag on the screen."]
    ),
    h.div(
      [h.Class("heroes")],
      model.heroes.map((hero) =>
        h.button(
          [
            h.Key(hero.id),
            h.Class(
              hero.id === model.selectedHeroId ? "hero selected" : "hero"
            ),
            h.OnClick(Message.SelectedHero({ heroId: hero.id })),
          ],
          [
            h.span(
              [h.Class("swatch"), h.Style({ background: hero.color })],
              []
            ),
            h.strong([], [hero.name]),
            h.small([], [hero.description]),
          ]
        )
      )
    ),
    h.button(
      [h.Class("primary big"), h.OnClick(Message.ClickedStart())],
      ["Start run"]
    ),
  ]);

const hud = (data: HudSample, h: H): Html =>
  h.div(
    [h.Class("hud")],
    [
      bar(
        h,
        "hp",
        data.hp / data.maxHp,
        `${Math.ceil(data.hp)} / ${Math.round(data.maxHp)}`
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

const levelUp = (choices: readonly UpgradeChoice[], h: H): Html =>
  panel(h, [
    h.h2([], ["Level up! Choose one"]),
    h.div(
      [h.Class("choices")],
      choices.map((choice, index) =>
        h.button(
          [
            h.Key(`${choice.id}-${index}`),
            h.Class("choice"),
            h.OnClick(Message.ClickedUpgrade({ index })),
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

const formatTime = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
