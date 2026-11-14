/**
 * The app's `view`: Foldkit's contract.
 *
 * Plain on purpose: `view` is a pure function of the Model (Foldkit's contract). The viewport is
 * rendered on every screen, so the engine's canvas is never made again.
 */
import type { Hud } from "@arcadekit/push-puzzle";
import type { AudioSettings, AudioSystem } from "arcadekit/audio";
import { Viewport } from "arcadekit/foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";

type H = HtmlBuilder<Message>;

/** The id of the load-error screen's "Try again" button, which FocusRetry focuses so Enter retries. */
export const retryButtonId = "retry";

/** The page for a Model: the viewport the engine draws in, and the screen over it. */
export const view = (model: Model, h: H): Document => ({
  title: "Push Puzzle",
  body: h.div(
    [h.Class("app")],
    [
      // The engine draws here. Rendered on every screen, so the canvas is never recreated.
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
        "Push every box onto a goal. A box pushed into a hole fills it. Move with arrows, WASD, the d-pad or a swipe; undo with Z, Backspace or B; R restarts; M mutes.",
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
    soundPanel(model.audio, h),
  ]);

const BUS_LABELS: readonly (readonly [AudioSystem.Bus, string])[] = [
  ["master", "Volume"],
  ["sfx", "Effects"],
  ["music", "Music"],
];

/** A slider per bus and a mute switch. Each change is applied and saved at once. */
const soundPanel = (settings: AudioSettings.AudioSettings, h: H): Html =>
  h.div(
    [h.Key("sound"), h.Class("sound")],
    [
      ...BUS_LABELS.map(([bus, label]) =>
        h.label(
          [h.Key(bus), h.Class("slider")],
          [
            h.span([], [label]),
            h.input([
              h.Type("range"),
              h.Min("0"),
              h.Max("1"),
              h.Step("0.05"),
              h.Value(String(settings[bus])),
              h.OnInput((value) =>
                Message.ChangedVolume({ bus, volume: Number(value) })
              ),
            ]),
          ]
        )
      ),
      h.label(
        [h.Key("mute"), h.Class("mute")],
        [
          h.input([
            h.Type("checkbox"),
            h.Checked(settings.muted),
            h.OnChange(() => Message.ToggledMute()),
          ]),
          h.span([], ["Mute (M)"]),
        ]
      ),
    ]
  );

const hud = (name: string, data: Hud, h: H): Html =>
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
