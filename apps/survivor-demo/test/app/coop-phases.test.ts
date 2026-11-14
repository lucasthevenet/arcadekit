import { Hud } from "@arcadekit/survivors";
import { CoopEvent } from "arcadekit/net/browser";
import { Scene, Story } from "foldkit";
import { describe, expect, it } from "vitest";

import {
  ChooseCoopUpgrade,
  LeaveCoop,
  PlayClick,
  SetCoopPaused,
} from "../../src/app/commands";
import { Message } from "../../src/app/message";
import { Phase, emptyCoopRun, emptyHud } from "../../src/app/model";
import type { Model } from "../../src/app/model";
import { init, update } from "../../src/app/update";
import { view } from "../../src/app/view";

// What the co-op client reports counts only on the screen it belongs to. Its events can still be
// queued when the player leaves, so one that arrives on another screen changes nothing.

const at = (phase: Phase): Model => ({ ...init().model, phase });

const lobby = Phase.CoopLobby({
  lobby: new CoopEvent.LobbyChanged({
    role: "guest",
    code: "K7MQ2X",
    self: "guest-1",
    players: [
      { id: "host", name: "Host", pick: "spark" },
      { id: "guest-1", name: "Guest 1", pick: "ember" },
    ],
    maxPlayers: 4,
    canStart: true,
  }),
});

const started = Message.GotCoopStarted({
  slot: 1,
  names: ["Host", "Guest 1"],
});

const waiting = Message.GotCoopWaiting({ waitingFor: ["Host"] });

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

/** Whether the menu is up, and whether the app has the local player holding the pause. */
const menuAndPause = (model: Model) => [model.coop.menu, model.coop.paused];

// A pick and the pause are the genre's commands, sent to the run. Escape opens the run's menu,
// which asks the run for a pause. The app's own pause flag changes at once and follows the rules
// afterwards: they hold no pause for a hero that is down. The menu is the app's, and stays up.
describe("co-op commands", () => {
  const playing = at(Phase.CoopPlaying());

  it("sends the pick with the number of the offer it answers, and goes back to the run", () => {
    Story.story(
      update,
      Story.given(at(Phase.CoopLevelUp({ offer: 3, choices: [] }))),
      Story.message(Message.ClickedCoopUpgrade({ index: 1 })),
      Story.Command.expectExact(
        ChooseCoopUpgrade({ offer: 3, index: 1 }),
        PlayClick()
      ),
      Story.Command.resolve(
        ChooseCoopUpgrade,
        Message.CompletedEngineCommand()
      ),
      Story.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
      Story.model((model) => expect(model.phase._tag).toBe("CoopPlaying"))
    );
  });

  it("opens the menu and shows the pause at once, and keeps it when the run takes it", () => {
    Story.story(
      update,
      Story.given(playing),
      Story.message(Message.PressedEscape()),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([true, true])
      ),
      Story.Command.expectExact(SetCoopPaused({ paused: true })),
      Story.Command.resolve(SetCoopPaused, Message.CompletedEngineCommand()),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([true, true])
      ),
      Story.message(Message.PressedEscape()),
      Story.Command.expectExact(SetCoopPaused({ paused: false })),
      Story.Command.resolve(SetCoopPaused, Message.CompletedEngineCommand()),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([false, false])
      )
    );
  });

  it("drops its pause when the run doesn't take it, and keeps the menu up: it is the way to leave", () => {
    Story.story(
      update,
      Story.given(playing),
      Story.message(Message.PressedEscape()),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([true, true])
      ),
      Story.Command.resolve(SetCoopPaused, Message.FailedToHoldCoopPause()),
      Story.model((model) =>
        expect([model.phase._tag, menuAndPause(model)]).toStrictEqual([
          "CoopPlaying",
          [true, false],
        ])
      ),
      // Closing the menu lets go of nothing, since nothing is held: no command is sent.
      Story.message(Message.ClickedCoopResume()),
      Story.Command.expectExact(PlayClick()),
      Story.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([false, false])
      ),
      // A letting go the run didn't take leaves nothing held either.
      Story.message(Message.FailedToHoldCoopPause()),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([false, false])
      )
    );
  });
});

/** The guest's screen of a run of two, with its hero as the HUD last sampled it. */
const guestWith = (hero: "playing" | "down"): Model => ({
  ...at(Phase.CoopPlaying()),
  coop: { ...emptyCoopRun, slot: 1, names: ["Host", "Guest 1"] },
  hud: new Hud({
    ...emptyHud,
    heroes: [
      {
        heroId: "spark",
        hp: 80,
        maxHp: 80,
        status: "playing",
        paused: false,
        choosing: false,
      },
      {
        heroId: "ember",
        hp: hero === "down" ? 0 : 1,
        maxHp: 140,
        status: hero,
        paused: false,
        choosing: false,
      },
    ],
  }),
});

// Who the run waits on to pick an upgrade is the genre's to say: its HUD flags each hero, and the
// app names the others from it, as it names who holds the run paused.
/** The guest's screen, with each hero's HUD flags as the last sample had them. */
const flagged = (
  host: { readonly choosing?: boolean; readonly paused?: boolean },
  guest: { readonly choosing?: boolean; readonly paused?: boolean } = {}
): Model => {
  const model = guestWith("playing");
  const [first, second] = model.hud.heroes;
  return {
    ...model,
    hud: new Hud({
      ...model.hud,
      heroes: [
        { ...first!, ...host },
        { ...second!, ...guest },
      ],
    }),
  };
};

/** The banner over a co-op run on `model`'s screen: `banner`, or none. */
const shows = (model: Model, banner: string | undefined) =>
  Scene.scene(
    { update, view },
    Scene.given(model),
    Scene.Mount.resolve({ name: "GameViewport" }, Message.MountedViewport()),
    banner === undefined
      ? Scene.expect(Scene.selector(".banner")).not.toExist()
      : Scene.expect(Scene.text(banner)).toExist()
  );

describe("what a co-op run waits for", () => {
  it("names the other players the HUD says are choosing, and not the local player", () => {
    expect(() => {
      shows(
        flagged({ choosing: true }),
        "Waiting for Host to pick an upgrade…"
      );
      shows(
        flagged({ choosing: true }, { choosing: true }),
        "Waiting for Host to pick an upgrade…"
      );
      shows(flagged({}, { choosing: true }), undefined);
      shows(flagged({}), undefined);
    }).not.toThrow();
  });

  it("says who stepping waits on first, then who is choosing, then who holds the pause", () => {
    const waited: Model = {
      ...flagged({ choosing: true, paused: true }),
    };
    expect(() => {
      shows(
        { ...waited, coop: { ...waited.coop, waitingFor: ["Host"] } },
        "Waiting for Host…"
      );
      shows(waited, "Waiting for Host to pick an upgrade…");
      shows(flagged({ paused: true }), "Paused by Host");
    }).not.toThrow();
  });
});

// Survivors has no revive, so a player whose hero is down watches the rest of the run, and the
// rules take no pause from it. Its menu is still its way out, and where its sound controls are.
describe("a co-op player whose hero is down", () => {
  const mounted = Scene.Mount.resolve(
    { name: "GameViewport" },
    Message.MountedViewport()
  );
  const leaveRun = Scene.role("button", { name: "Leave run" });
  const pausedForEveryone = Scene.text(
    "The run is paused for everyone until you resume."
  );
  const playsOn = Scene.text(
    "The run plays on: a hero that is down can't pause it."
  );

  it("opens the menu without asking the run for a pause, and closes it", () => {
    Story.story(
      update,
      Story.given(guestWith("down")),
      Story.message(Message.PressedEscape()),
      Story.Command.expectNone(),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([true, false])
      ),
      Story.message(Message.PressedEscape()),
      Story.Command.expectNone(),
      Story.model((model) =>
        expect(menuAndPause(model)).toStrictEqual([false, false])
      )
    );
  });

  it("is offered the menu, which says the run plays on and lets the player leave", () => {
    expect(() =>
      Scene.scene(
        { update, view },
        Scene.given(guestWith("down")),
        mounted,
        Scene.expect(Scene.text("Esc for the menu")).toExist(),
        Scene.expect(Scene.text("Esc to pause")).not.toExist(),
        Scene.expect(leaveRun).not.toExist(),
        Scene.Subscription.emit(Message.PressedEscape()),
        Scene.Command.expectNone(),
        Scene.expect(playsOn).toExist(),
        Scene.expect(pausedForEveryone).not.toExist(),
        Scene.expect(Scene.role("button", { name: "Resume" })).not.toExist(),
        Scene.expect(leaveRun).toExist(),
        // The menu closes and opens again, with the way out still in it.
        Scene.click(Scene.role("button", { name: "Back to the run" })),
        Scene.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
        Scene.expect(leaveRun).not.toExist(),
        Scene.Subscription.emit(Message.PressedEscape()),
        Scene.click(leaveRun),
        Scene.Command.expectExact(LeaveCoop(), PlayClick()),
        Scene.Command.resolve(LeaveCoop, Message.CompletedEngineCommand()),
        Scene.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
        Scene.expect(Scene.role("button", { name: "Co-op" })).toExist()
      )
    ).not.toThrow();
  });

  it("still has Leave run after the run refuses a pause the HUD didn't yet rule out", () => {
    expect(() =>
      Scene.scene(
        { update, view },
        // The hero went down since the HUD's last sample, a tenth of a second old at most.
        Scene.given(guestWith("playing")),
        mounted,
        Scene.expect(Scene.text("Esc to pause")).toExist(),
        Scene.Subscription.emit(Message.PressedEscape()),
        Scene.Command.expectExact(SetCoopPaused({ paused: true })),
        Scene.expect(pausedForEveryone).toExist(),
        Scene.expect(leaveRun).toExist(),
        // The rules refuse it (NotPlaying): the screen stops saying the run is paused, and the
        // way out stays.
        Scene.Command.resolve(SetCoopPaused, Message.FailedToHoldCoopPause()),
        Scene.expect(pausedForEveryone).not.toExist(),
        Scene.expect(playsOn).toExist(),
        Scene.expect(leaveRun).toExist(),
        Scene.click(leaveRun),
        Scene.Command.expectExact(LeaveCoop(), PlayClick()),
        Scene.Command.resolve(LeaveCoop, Message.CompletedEngineCommand()),
        Scene.Command.resolve(PlayClick, Message.CompletedAudioCommand()),
        Scene.expect(Scene.role("button", { name: "Co-op" })).toExist()
      )
    ).not.toThrow();
  });
});
