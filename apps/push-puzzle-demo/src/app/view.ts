import { gameViewport } from "@gamekit/foldkit";
import type { HudSample } from "@gamekit/push-puzzle";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";

type H = HtmlBuilder<Message>;

export const view = (model: Model, h: H): Document => ({
  title: "Push Puzzle",
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
    Loading: () => panel(h, [h.p([], ["Loading levels…"])]),
    LoadFailed: ({ error }) =>
      panel(h, [
        h.h2([], ["Something went wrong"]),
        h.p([h.Class("error")], [error]),
      ]),
    LevelSelect: () => levelSelect(model, h),
    Starting: () => h.empty,
    Playing: () => hud(levelName(model), model.hud, h),
    Solved: ({ moves, isNewBest }) =>
      solved(levelName(model), moves, isNewBest, h),
  });

const levelName = (model: Model) =>
  model.levels.find((level) => level.id === model.levelId)?.name ?? "";

const panel = (h: H, children: readonly (Html | string)[]): Html =>
  h.div(
    [h.Class("panel-backdrop")],
    [h.div([h.Class("panel")], [...children])]
  );

const savedRecord = (model: Model, levelId: string) =>
  Object.hasOwn(model.records, levelId) ? model.records[levelId] : undefined;

const levelSelect = (model: Model, h: H): Html =>
  panel(h, [
    h.h1([], ["Push Puzzle"]),
    h.p(
      [h.Class("muted")],
      [
        "Push every box onto a goal. A box pushed into a hole fills it. Move with arrows, WASD, the d-pad or a swipe; undo with Z, Backspace or B; R restarts.",
      ]
    ),
    h.div(
      [h.Class("levels")],
      model.levels.map((level, index) => {
        const record = savedRecord(model, level.id);
        return h.button(
          [
            h.Key(level.id),
            h.Class(record?.solved ? "level solved" : "level"),
            h.OnClick(Message.ClickedLevel({ levelId: level.id })),
          ],
          [
            h.small([h.Class("muted")], [`Level ${index + 1}`]),
            h.strong([], [level.name]),
            record?.solved
              ? h.small(
                  [h.Class("record")],
                  [`✓ Best: ${movesText(record.bestMoves)}`]
                )
              : h.empty,
          ]
        );
      })
    ),
  ]);

const hud = (name: string, data: HudSample, h: H): Html =>
  h.div(
    [h.Class("hud")],
    [
      h.strong([], [name]),
      h.div(
        [h.Class("stats")],
        [
          h.span([], [`${data.moves} moves`]),
          h.span([], [`${data.boxesLeft} to place`]),
          h.span([h.Class("muted")], ["Z undo · R restart · Esc levels"]),
        ]
      ),
    ]
  );

const movesText = (moves: number) =>
  `${moves} ${moves === 1 ? "move" : "moves"}`;

const solved = (name: string, moves: number, isNewBest: boolean, h: H): Html =>
  panel(h, [
    h.h2([], ["Solved!"]),
    h.p([], [`${name} in ${movesText(moves)}.`]),
    isNewBest ? h.p([h.Class("record")], ["New best!"]) : h.empty,
    h.div(
      [h.Class("row")],
      [
        h.button(
          [h.Class("primary"), h.OnClick(Message.ClickedReplay())],
          ["Replay"]
        ),
        h.button([h.OnClick(Message.ClickedLevelSelect())], ["Level select"]),
      ]
    ),
  ]);
