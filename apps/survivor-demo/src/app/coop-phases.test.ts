import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { LeaveCoop, PlayClick } from "./commands";
import { Message } from "./message";
import { Phase, emptyCoopRun } from "./model";
import type { Model } from "./model";
import { init, update } from "./update";

// What the co-op client reports counts only on the screen it belongs to. Its events can still be
// queued when the player leaves, so one that arrives on another screen changes nothing.

const at = (phase: Phase): Model => ({ ...init().model, phase });

const lobby = Phase.CoopLobby({
  role: "guest",
  code: "K7MQ2X",
  self: "guest-1",
  players: [
    { id: "host", name: "Host", pick: "spark" },
    { id: "guest-1", name: "Guest 1", pick: "ember" },
  ],
  maxPlayers: 4,
  canStart: true,
});

const started = Message.GotCoopStarted({
  slot: 1,
  names: ["Host", "Guest 1"],
});

const waiting = Message.GotCoopWaiting({ waitingFor: ["Host"], choosing: [] });

describe("co-op events on the wrong screen", () => {
  it("starts the run from the lobby only", () => {
    Story.story(
      update,
      Story.given(at(lobby)),
      Story.message(started),
      Story.model((model) =>
        expect([model.phase._tag, model.coop]).toStrictEqual([
          "CoopPlaying",
          { ...emptyCoopRun, slot: 1, names: ["Host", "Guest 1"] },
        ])
      )
    );
    for (const phase of [
      Phase.Menu(),
      Phase.CoopMenu({ joinCode: "" }),
      Phase.CoopFailed({ error: "The host left." }),
    ]) {
      Story.story(
        update,
        Story.given(at(phase)),
        Story.message(started),
        Story.model((model) => expect(model).toStrictEqual(at(phase)))
      );
    }
  });

  it("shows who the run waits on while it runs only", () => {
    Story.story(
      update,
      Story.given(at(Phase.CoopPlaying())),
      Story.message(waiting),
      Story.model((model) =>
        expect(model.coop.waitingFor).toStrictEqual(["Host"])
      )
    );
    for (const phase of [
      Phase.Menu(),
      lobby,
      Phase.CoopFailed({ error: "The host left." }),
    ]) {
      Story.story(
        update,
        Story.given(at(phase)),
        Story.message(waiting),
        Story.model((model) => expect(model).toStrictEqual(at(phase)))
      );
    }
  });

  it("leaves to the menu, where a start queued behind the leave changes nothing", () => {
    Story.story(
      update,
      Story.given(at(lobby)),
      Story.message(Message.ClickedLeaveCoop()),
      Story.Command.expectExact(LeaveCoop(), PlayClick()),
      Story.Command.resolve(LeaveCoop, Message.CompletedEngineCommand()),
      Story.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
      Story.message(started),
      Story.message(waiting),
      Story.model((model) =>
        expect([model.phase._tag, model.coop]).toStrictEqual([
          "Menu",
          emptyCoopRun,
        ])
      )
    );
  });
});
