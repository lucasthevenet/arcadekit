import { Cause, Effect, Exit, Schema, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Assets,
  Event,
  Field,
  Plugin,
  Singleton,
  Sound,
  State,
  System,
} from "../src/index";
import type { BuiltIn } from "../src/Services";

// --- a game of levels, which knows nothing of sound ---------------------------------
const Level = State.define("mu/Level", ["menu", "forest", "cave"]);
/** Whether the game is hushed: paused, say. */
const Hush = Singleton.define("mu/Hush", { on: Field.u8 }, { on: 0 });
const Stepped = Event.define(
  "mu/Stepped",
  Schema.Struct({ hard: Schema.Boolean })
);

const Go = Action.define(
  "mu/Go",
  Schema.Struct({ to: Schema.Literals(["menu", "forest", "cave"]) })
);
const SetHush = Action.define(
  "mu/SetHush",
  Schema.Struct({ on: Schema.Boolean })
);
const Step = Action.define("mu/Step", Schema.Struct({ hard: Schema.Boolean }));

const Rules = Plugin.make("mu/Rules", {
  components: [Level, Hush],
  handlers: [
    Action.handler(Go, function* ({ to }) {
      (yield* Level).set(to);
    }),
    Action.handler(SetHush, function* ({ on }) {
      (yield* Hush).on = on ? 1 : 0;
    }),
    Action.handler(Step, function* ({ hard }) {
      (yield* Stepped).emit({ hard });
    }),
  ],
});

// --- what it sounds like -------------------------------------------------------------
/** How often the score was asked what should be playing. */
let asked = 0;
const Score = Sound.music(
  "mu/Score",
  function* () {
    asked++;
    const level = (yield* Level).value;
    if (level === "menu") {
      return undefined;
    }
    if ((yield* Hush).on === 1) {
      return { track: "theme", volume: 0.2 };
    }
    // The cave has a track of its own, quieter and slower to come.
    return level === "forest"
      ? "theme"
      : { track: "drip", volume: 0.5, fade: 2 };
  },
  { fade: 1 }
);

/** An app in a scope of its own, which the test closes when it likes. */
const start = <A, E, R>(
  make: Effect.Effect<A, E, R>,
  output?: Sound.OutputShape
) => {
  const scope = Scope.makeUnsafe();
  const provided =
    output === undefined
      ? make
      : make.pipe(Effect.provide(Sound.layer(output)));
  const app = Effect.runSync(
    provided.pipe(Scope.provide(scope)) as Effect.Effect<A, E>
  );
  return {
    app,
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
  };
};

const play = (
  systems: readonly System.System<
    never,
    BuiltIn | Sound.Player | Assets.Store
  >[],
  output?: Sound.OutputShape
) => {
  asked = 0;
  const { app, close } = start(
    App.make({
      plugins: [Rules, Sound.plugin, Assets.plugin],
      systems,
      checkpointEvery: 1,
    }),
    output
  );
  return {
    app,
    close,
    /** The game does something, a tick applies it, and a frame is heard. */
    step: (action: Action.AnyActionDef, payload: unknown): void => {
      app.dispatch(action as never, payload as never);
      app.tick(0.1);
      app.frame(0);
    },
  };
};

describe("Sound.music", () => {
  it("keeps a channel playing what the game, as it is, should sound like", () => {
    const sound = Sound.makeRecorder();
    const { app, step } = play([Score], sound);
    // The menu is silent, and a channel that was told nothing is not told so.
    app.tick(0.1);
    app.frame(0);
    app.frame(0);
    expect(sound.scored).toEqual([]);
    expect(asked).toBe(2);

    step(Go, { to: "forest" });
    expect(sound.scored).toEqual([
      { channel: "music", track: "theme", volume: 1, fade: 1 },
    ]);
    expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });
    // It goes on, and nothing is said again, however many frames and ticks.
    for (let i = 0; i < 5; i++) {
      app.tick(0.1);
      app.frame(0);
      app.frame(0.5);
    }
    expect(sound.scored.length).toBe(1);

    // The same track, softer.
    step(SetHush, { on: true });
    expect(sound.scored.slice(1)).toEqual([
      { channel: "music", track: "theme", volume: 0.2, fade: 1 },
    ]);
    step(SetHush, { on: false });
    // Another track, with a volume and a fade of its own.
    step(Go, { to: "cave" });
    expect(sound.scored.slice(2)).toEqual([
      { channel: "music", track: "theme", volume: 1, fade: 1 },
      { channel: "music", track: "drip", volume: 0.5, fade: 2 },
    ]);
    expect(Object.fromEntries(sound.playing)).toEqual({ music: "drip" });

    // And silence, said once.
    step(Go, { to: "menu" });
    app.frame(0);
    app.frame(0);
    expect(sound.scored.slice(4)).toEqual([
      { channel: "music", track: undefined, volume: 0, fade: 1 },
    ]);
    expect(sound.playing.size).toBe(0);
    // Nothing of it was a cue.
    expect(sound.played).toEqual([]);
  });

  it("takes half a second over a change unless told otherwise, and is never below silence or back in time", () => {
    const sound = Sound.makeRecorder();
    let wanted: Sound.TrackOf = "a";
    const Plain = Sound.music("mu/Plain", function* () {
      yield* Level;
      return wanted;
    });
    const { app } = play([Plain], sound);
    app.frame(0);
    wanted = { track: "a", volume: -3 };
    app.frame(0);
    wanted = { track: "b", fade: -1 };
    app.frame(0);
    wanted = { track: "b", volume: 0.25, fade: 0 };
    app.frame(0);
    wanted = undefined;
    app.frame(0);
    expect(sound.scored).toEqual([
      { channel: "music", track: "a", volume: 1, fade: 0.5 },
      { channel: "music", track: "a", volume: 0, fade: 0.5 },
      { channel: "music", track: "b", volume: 1, fade: 0 },
      { channel: "music", track: "b", volume: 0.25, fade: 0 },
      { channel: "music", track: undefined, volume: 0, fade: 0.5 },
    ]);
  });

  it("plays a track once when the body says so, and not again while it says the same", () => {
    const sound = Sound.makeRecorder();
    // A fanfare in the cave, for as long as the game is there; hushed, the
    // same piece goes round and round, softly.
    const Fanfare = Sound.music("mu/Fanfare", function* () {
      if ((yield* Level).value !== "cave") {
        return undefined;
      }
      return (yield* Hush).on === 1
        ? { track: "fanfare", volume: 0.5 }
        : { track: "fanfare", once: true };
    });
    const { app, step } = play([Fanfare], sound);
    step(Go, { to: "cave" });
    expect(sound.scored).toEqual([
      {
        channel: "music",
        track: "fanfare",
        volume: 1,
        fade: 0.5,
        once: true,
      },
    ]);
    // However long after: it has ended by now, and is not begun again.
    for (let i = 0; i < 20; i++) {
      app.tick(0.1);
      app.frame(0);
    }
    expect(sound.scored.length).toBe(1);
    // Over and over is another thing to be told, of the same track.
    step(SetHush, { on: true });
    expect(sound.scored.slice(1)).toEqual([
      { channel: "music", track: "fanfare", volume: 0.5, fade: 0.5 },
    ]);
    // Once again, at the same volume, is told too.
    const Twice = Sound.music("mu/Twice", function* () {
      return (yield* Hush).on === 1
        ? { track: "fanfare", once: true }
        : "fanfare";
    });
    const other = Sound.makeRecorder();
    const second = play([Twice], other);
    second.app.frame(0);
    second.step(SetHush, { on: true });
    expect(other.scored.map((one) => one.once)).toEqual([undefined, true]);
    // Left and come back to, it plays again from its start.
    step(Go, { to: "menu" });
    step(SetHush, { on: false });
    step(Go, { to: "cave" });
    expect(sound.scored.slice(2)).toEqual([
      { channel: "music", track: undefined, volume: 0, fade: 0.5 },
      {
        channel: "music",
        track: "fanfare",
        volume: 1,
        fade: 0.5,
        once: true,
      },
    ]);
  });

  it("is worked out from the game and kept nowhere in it: a game that is loaded has its music from its first frame, and is the same game as one with none", () => {
    const sound = Sound.makeRecorder();
    const heard = play([Score], sound);
    // The rules alone: no output, and no system that plays.
    const deaf = start(App.make({ plugins: [Rules], checkpointEvery: 1 }));
    for (const app of [heard.app, deaf.app]) {
      app.dispatch(Go, { to: "cave" });
      app.dispatch(SetHush, { on: true });
      app.tick(0.1);
    }
    heard.app.frame(0);
    expect(heard.app.world.hash()).toBe(deaf.app.world.hash());
    expect(heard.app.actionLog).toEqual(deaf.app.actionLog);
    const saves = [heard.app.save(), deaf.app.save()].map((save) =>
      Exit.isSuccess(save) ? save.value : undefined
    );
    expect(saves[0]).toBeDefined();
    expect(saves[0]).toEqual(saves[1]);

    // Loaded elsewhere, it is in the cave and hushed, and sounds like it.
    const again = Sound.makeRecorder();
    const loaded = start(
      App.load(saves[0]!, { plugins: [Rules, Sound.plugin], systems: [Score] }),
      again
    );
    expect(again.scored).toEqual([]);
    loaded.app.frame(0);
    expect(again.scored).toEqual([
      { channel: "music", track: "theme", volume: 0.2, fade: 1 },
    ]);
    // And a replay, which runs no frame, is silent.
    const replayed = Sound.makeRecorder();
    const other = play([Score], replayed);
    App.replay(other.app, heard.app.actionLog, { delta: 0.1, ticks: 1 });
    expect(other.app.world.hash()).toBe(heard.app.world.hash());
    expect(replayed.scored).toEqual([]);
  });

  it("is one score, of which the system that has something to play is heard, and a track both play goes on", () => {
    // A menu's music and a level's, each a system of its own that runs
    // while the game is there: two that are meant as one score.
    const MenuScore = Sound.music("mu/MenuScore", function* () {
      yield* Level;
      return "theme";
    }).pipe(System.runIf(State.is(Level, "menu")));
    const LevelScore = Sound.music("mu/LevelScore", function* () {
      return (yield* Level).value === "forest" ? "theme" : "drip";
    }).pipe(System.runIf(State.is(Level, "forest", "cave")));
    // Whichever of the two is listed first: silence gives way to a track.
    for (const systems of [
      [MenuScore, LevelScore],
      [LevelScore, MenuScore],
    ]) {
      const sound = Sound.makeRecorder();
      const { app, step } = play(systems, sound);
      app.frame(0);
      expect(sound.scored).toEqual([
        { channel: "music", track: "theme", volume: 1, fade: 0.5 },
      ]);
      // Into the forest, whose track is the menu's: it goes on, and the
      // output is told nothing.
      step(Go, { to: "forest" });
      expect(sound.scored.length).toBe(1);
      step(Go, { to: "cave" });
      step(Go, { to: "menu" });
      expect(sound.scored.slice(1)).toEqual([
        { channel: "music", track: "drip", volume: 1, fade: 0.5 },
        { channel: "music", track: "theme", volume: 1, fade: 0.5 },
      ]);
      expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });
    }
  });

  it("is a bug when two systems of one channel say two things in one frame, which the frame says", () => {
    const sound = Sound.makeRecorder();
    // The first to speak says another thing when the game is hushed.
    const One = Sound.music("mu/One", function* () {
      return (yield* Hush).on === 1 ? "calm" : "theme";
    });
    let other: Sound.TrackOf = "wind";
    const Two = Sound.music("mu/Two", function* () {
      return (yield* Hush).on === 1 ? undefined : other;
    });
    const { app, step } = play([One, Two], sound);
    const refused = (first: string, second: string) =>
      `The channel "music" was told to play two things in one frame: ${first} and ${second}. A channel plays one track at a time. The systems made with Sound.music share the channel "music" unless they name another: they are one score, of which one says what plays. For two that play together, music and the wind, give one a channel of its own: Sound.music(name, body, { channel: "wind" }).`;
    expect(() => app.frame(0)).toThrow(refused('"theme"', '"wind"'));
    // One track at two volumes is two things, and so is once and over and over.
    other = { track: "theme", volume: 0.2 };
    expect(() => app.frame(0)).toThrow(refused('"theme"', '"theme" at 0.2'));
    other = { track: "theme", once: true };
    expect(() => app.frame(0)).toThrow(refused('"theme"', '"theme", once'));
    other = Sound.clip("/theme.ogg");
    expect(() => app.frame(0)).toThrow(refused('"theme"', '"/theme.ogg"'));
    // Nothing of it reached the output.
    expect(sound.scored).toEqual([]);
    // Put right, the next frame is heard, and what the failed one said is
    // not held against it.
    step(SetHush, { on: true });
    expect(sound.scored).toEqual([
      { channel: "music", track: "calm", volume: 1, fade: 0.5 },
    ]);
    // The same thing said by both is said once.
    other = { track: "theme", fade: 3 };
    step(SetHush, { on: false });
    expect(sound.scored.slice(1)).toEqual([
      { channel: "music", track: "theme", volume: 1, fade: 0.5 },
    ]);
  });

  it("plays beside the score on a channel of its own, which several systems can share too", () => {
    const sound = Sound.makeRecorder();
    const Wind = Sound.music(
      "mu/Wind",
      function* () {
        return (yield* Level).value === "menu"
          ? undefined
          : { track: "wind", volume: 0.3 };
      },
      { channel: "wind" }
    );
    // Another of the wind's channel, which only the menu hears.
    const Breeze = Sound.music(
      "mu/Breeze",
      function* () {
        return (yield* Level).value === "menu" ? "breeze" : undefined;
      },
      { channel: "wind", fade: 4 }
    );
    const { app, step } = play([Score, Wind, Breeze], sound);
    app.frame(0);
    expect(sound.scored).toEqual([
      { channel: "wind", track: "breeze", volume: 1, fade: 4 },
    ]);
    step(Go, { to: "forest" });
    expect(Object.fromEntries(sound.playing)).toEqual({
      music: "theme",
      wind: "wind",
    });
    // Channels are told in the order they were first heard of.
    expect(sound.scored.slice(1)).toEqual([
      { channel: "wind", track: "wind", volume: 0.3, fade: 0.5 },
      { channel: "music", track: "theme", volume: 1, fade: 1 },
    ]);
  });

  it("is one channel per name, and several play together", () => {
    const sound = Sound.makeRecorder();
    const Wind = Sound.music(
      "mu/Wind",
      function* () {
        return (yield* Level).value === "menu"
          ? undefined
          : { track: "wind", volume: 0.3 };
      },
      { channel: "mu/Wind" }
    );
    const { step } = play([Score, Wind], sound);
    step(Go, { to: "forest" });
    expect(Object.fromEntries(sound.playing)).toEqual({
      music: "theme",
      "mu/Wind": "wind",
    });
    expect(sound.scored.length).toBe(2);
    // The score changes, and the wind is not told anything.
    step(Go, { to: "cave" });
    expect(sound.scored.slice(2)).toEqual([
      { channel: "music", track: "drip", volume: 0.5, fade: 2 },
    ]);
    expect(Object.fromEntries(sound.playing)).toEqual({
      music: "drip",
      "mu/Wind": "wind",
    });
  });

  it("works nothing out where sound goes nowhere", () => {
    const { app, step } = play([Score]);
    step(Go, { to: "forest" });
    app.frame(0);
    expect(asked).toBe(0);
    // Somewhere to go, it is asked each frame.
    const heard = play([Score], Sound.makeRecorder());
    heard.app.frame(0);
    heard.app.frame(0);
    expect(asked).toBe(2);
  });

  it("is silent while its system does not run, as if the body had said so, and says what plays when it runs again", () => {
    const sound = Sound.makeRecorder();
    const Gated = Score.pipe(
      System.runIf(Effect.map(Hush, (hush) => hush.on === 0))
    );
    const { app, step } = play([Gated], sound);
    step(Go, { to: "forest" });
    expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });
    // Hushed, the system is not run: its music stops, with the fade it
    // was given, and the body, which would have said a volume of 0.2, is
    // not asked.
    const before = asked;
    step(SetHush, { on: true });
    app.frame(0);
    app.frame(0);
    expect(asked).toBe(before);
    expect(sound.scored).toEqual([
      { channel: "music", track: "theme", volume: 1, fade: 1 },
      { channel: "music", track: undefined, volume: 0, fade: 1 },
    ]);
    expect(sound.playing.size).toBe(0);
    // Run again, it says what is so now.
    step(SetHush, { on: false });
    expect(sound.scored.slice(2)).toEqual([
      { channel: "music", track: "theme", volume: 1, fade: 1 },
    ]);
    // A system that was never run has nothing to stop.
    const other = Sound.makeRecorder();
    const never = play(
      [Score.pipe(System.runIf(Effect.succeed(false)))],
      other
    );
    never.step(Go, { to: "forest" });
    expect(other.scored).toEqual([]);
    // And where nothing is heard, nothing is said.
    const deaf = play([Gated]);
    deaf.step(SetHush, { on: true });
    expect(asked).toBe(0);
  });

  it("leaves nothing playing when the app goes: every channel that was playing is told silence, at once", () => {
    const sound = Sound.makeRecorder();
    const Wind = Sound.music(
      "mu/Wind",
      function* () {
        return (yield* Level).value === "cave" ? undefined : "wind";
      },
      { channel: "wind" }
    );
    const Never = Sound.music(
      "mu/Never",
      function* () {
        yield* Level;
        return undefined;
      },
      { channel: "never" }
    );
    const { close, step } = play([Score, Wind, Never], sound);
    step(Go, { to: "forest" });
    // The wind stops of itself in the cave; the score is still playing.
    step(Go, { to: "cave" });
    const before = sound.scored.length;
    close();
    expect(sound.scored.slice(before)).toEqual([
      { channel: "music", track: undefined, volume: 0, fade: 0 },
    ]);
    expect(sound.playing.size).toBe(0);
  });

  it("gives a track or nothing, and needs Sound.plugin: anything else does not compile", () => {
    // @ts-expect-error a number is no track
    Sound.music("mu/Wrong", function* () {
      yield* Level;
      return 3;
    });
    const made = App.make({ plugins: [Rules], systems: [Score] });
    // @ts-expect-error the app still needs the player, which Sound.plugin gives
    void (() => Effect.runSync(Effect.scoped(made)));
    expect(Score.name).toBe("mu/Score");
    expect(Score.stage).toBe("frame");
  });
});

describe("Sound.Player.music", () => {
  it("is never called by the simulation: in the tick it throws", () => {
    const Loud = System.make("mu/Loud", function* () {
      (yield* Sound.Player).music("mu/Loud", "theme");
    });
    const sound = Sound.makeRecorder();
    const { app } = start(
      App.make({ plugins: [Sound.plugin], systems: [Loud] }),
      sound
    );
    expect(() => app.tick(0.1)).toThrow(
      'The music of "mu/Loud" was set in the tick'
    );
    expect(sound.scored).toEqual([]);
    // Nor by an action's handler, which is the simulation too.
    const Bang = Action.define("mu/Bang", Schema.Struct({}));
    const other = start(
      App.make({
        plugins: [Sound.plugin],
        handlers: [
          Action.handler(Bang, function* () {
            (yield* Sound.Player).music("mu/Bang", undefined);
          }),
        ],
      }),
      sound
    );
    const exit = other.app.dispatch(Bang, {});
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
      'The music of "mu/Bang" was set in the tick'
    );
    expect(sound.scored).toEqual([]);
  });

  it("makes one thing of what a frame says of a channel: a track over silence, and the fade of the one that is heard", () => {
    const sound = Sound.makeRecorder();
    let says: (readonly [string, string | undefined, Sound.MusicOptions?])[] =
      [];
    const Say = System.make("mu/Say", function* () {
      const player = yield* Sound.Player;
      for (const [channel, track, options] of says) {
        player.music(channel, track, options);
      }
    }).pipe(System.inStage("frame"));
    const { app } = start(
      App.make({ plugins: [Sound.plugin], systems: [Say] }),
      sound
    );
    const frame = (...said: typeof says) => {
      says = said;
      const before = sound.scored.length;
      app.frame(0);
      return sound.scored.slice(before);
    };
    // Silence first or last, the track is what the channel plays, as the
    // one that said it would have it: its volume, its fade.
    expect(
      frame(
        ["a", undefined, { fade: 9 }],
        ["a", "hum", { volume: 0.4, fade: 2 }],
        ["b", "buzz", { fade: 3 }],
        ["b", undefined, { fade: 9 }],
        ["a", undefined]
      )
    ).toEqual([
      { channel: "a", track: "hum", volume: 0.4, fade: 2 },
      { channel: "b", track: "buzz", volume: 1, fade: 3 },
    ]);
    // Said twice the same, with whatever fade, it is said once: the first.
    expect(
      frame(
        ["a", "drone", { fade: 1 }],
        ["a", "drone", { fade: 7 }],
        ["b", "buzz"]
      )
    ).toEqual([{ channel: "a", track: "drone", volume: 1, fade: 1 }]);
    // Silence from all who speak is silence, with the fade of the first.
    expect(
      frame(["a", undefined, { fade: 6 }], ["a", undefined, { fade: 1 }])
    ).toEqual([{ channel: "a", track: undefined, volume: 0, fade: 6 }]);
    // A channel nobody speaks of plays on.
    expect(frame()).toEqual([]);
    expect(Object.fromEntries(sound.playing)).toEqual({ b: "buzz" });
    // Two things of one channel throw where the second is said, and name
    // it; the other channel is not held up by it next frame.
    expect(() => frame(["b", "buzz"], ["b", "hiss"], ["a", "hum"])).toThrow(
      'The channel "b" was told to play two things in one frame: "buzz" and "hiss".'
    );
    expect(frame(["b", "hiss"])).toEqual([
      { channel: "b", track: "hiss", volume: 1, fade: 0.5 },
    ]);
    // On a channel that is playing, too: silence first, and the track's
    // own fade is the one that is used.
    expect(
      frame(["b", undefined, { fade: 9 }], ["b", "buzz", { fade: 3 }])
    ).toEqual([{ channel: "b", track: "buzz", volume: 1, fade: 3 }]);
    // What a refused frame said first is not told later, when nobody
    // speaks of the channel: it plays on as it was.
    expect(() => frame(["b", "hiss"], ["b", "drone"])).toThrow(
      '"hiss" and "drone"'
    );
    expect(frame()).toEqual([]);
    expect(frame(["a", "hum"])).toEqual([
      { channel: "a", track: "hum", volume: 1, fade: 0.5 },
    ]);
    expect(Object.fromEntries(sound.playing)).toEqual({ a: "hum", b: "buzz" });
  });

  it("is heard in the same frame as the frame's cues, each as it was asked", () => {
    const sound = Sound.makeRecorder();
    let on = false;
    const Both = System.make("mu/Both", function* () {
      const player = yield* Sound.Player;
      player.play("click", { volume: 0.5 });
      player.music("ui", on ? "hum" : undefined);
    }).pipe(System.inStage("frame"));
    const { app } = start(
      App.make({ plugins: [Sound.plugin], systems: [Both] }),
      sound
    );
    // A cue alone, while the channel has never played.
    app.frame(0);
    expect(sound.played).toEqual([{ cue: "click", volume: 0.5, rate: 1 }]);
    expect(sound.scored).toEqual([]);
    // A cue and a track; and a cue while the track goes on.
    on = true;
    app.frame(0);
    app.frame(0);
    expect(sound.played.length).toBe(3);
    expect(sound.scored).toEqual([
      { channel: "ui", track: "hum", volume: 1, fade: 0.5 },
    ]);
  });

  it("tells the output of a change and of nothing else, for a system of the frame stage or the input stage", () => {
    const sound = Sound.makeRecorder();
    const said: (readonly [string | undefined, Sound.MusicOptions?])[] = [];
    let next: readonly [string | undefined, Sound.MusicOptions?] | undefined;
    const Hum = System.make("mu/Hum", function* () {
      if (next !== undefined) {
        said.push(next);
        (yield* Sound.Player).music("ui", next[0], next[1]);
      }
    });
    const { app } = start(
      App.make({
        plugins: [Sound.plugin],
        systems: [Hum.pipe(System.inStage("input"))],
      }),
      sound
    );
    const say = (
      track: string | undefined,
      options?: Sound.MusicOptions
    ): number => {
      next = options === undefined ? [track] : [track, options];
      const before = sound.scored.length;
      app.input();
      // Said in the input stage, it is heard with the frame that follows.
      expect(sound.scored.length).toBe(before);
      next = undefined;
      app.frame(0);
      return sound.scored.length - before;
    };
    // Silence, said to a channel that never played, is said to nobody.
    expect(say(undefined)).toBe(0);
    expect(say("hum", { volume: 0.3, fade: 0 })).toBe(1);
    // The same again, and the same with another fade, are no change.
    expect(say("hum", { volume: 0.3, fade: 0 })).toBe(0);
    expect(say("hum", { volume: 0.3, fade: 9 })).toBe(0);
    expect(say("hum", { volume: 0.6 })).toBe(1);
    expect(say("buzz", { volume: 0.6 })).toBe(1);
    expect(say(undefined, { fade: 2 })).toBe(1);
    expect(say(undefined)).toBe(0);
    expect(say("buzz")).toBe(1);
    // Once, and over and over, are two things to be told of one track;
    // each said again is no change, and silence is neither.
    expect(say("buzz", { once: true })).toBe(1);
    expect(say("buzz", { once: true })).toBe(0);
    expect(say("buzz", { once: false })).toBe(1);
    expect(say("buzz")).toBe(0);
    expect(say(undefined, { once: true })).toBe(1);
    expect(say(undefined)).toBe(0);
    expect(sound.scored).toEqual([
      { channel: "ui", track: "hum", volume: 0.3, fade: 0 },
      { channel: "ui", track: "hum", volume: 0.6, fade: 0.5 },
      { channel: "ui", track: "buzz", volume: 0.6, fade: 0.5 },
      { channel: "ui", track: undefined, volume: 0, fade: 2 },
      { channel: "ui", track: "buzz", volume: 1, fade: 0.5 },
      { channel: "ui", track: "buzz", volume: 1, fade: 0.5, once: true },
      { channel: "ui", track: "buzz", volume: 1, fade: 0.5 },
      { channel: "ui", track: undefined, volume: 0, fade: 0.5 },
    ]);
    expect(said.length).toBe(15);
  });
});

// --- a level's own sounds -------------------------------------------------------------

/** A forest whose sounds are clips, each loading a clip of its own. */
const makeForest = () => {
  const clips: Sound.Clip[] = [];
  const clipAt = (url: string) =>
    Assets.make(url, (_bytes, at) =>
      Effect.sync(() => {
        const clip = Sound.clip(at, { loaded: clips.length });
        clips.push(clip);
        return clip;
      })
    );
  const Forest = Assets.bundle("mu/Forest", {
    creak: clipAt("/creak.wav"),
    wind: clipAt("/wind.ogg"),
  });
  const Keep = Assets.during(State.is(Level, "forest"), Forest);
  return { Forest, Keep, clips };
};
const files = Assets.layerMemory({ "/creak.wav": "c", "/wind.ogg": "w" });

describe("a clip", () => {
  it("is played wherever a cue's name is, and is the sound it is, whatever it is called", () => {
    const sound = Sound.makeRecorder();
    const creak = Sound.clip("creak");
    const other = Sound.clip("creak");
    const Cues = Sound.cues(
      "mu/Cues",
      Sound.on(Stepped, ({ hard }) =>
        hard ? { cue: creak, volume: 0.9, rate: 2 } : creak
      ),
      Sound.on(Stepped, ({ hard }) => (hard ? other : undefined)),
      Sound.on(Stepped, "tap")
    );
    const { app } = play([Cues], sound);
    app.dispatch(Step, { hard: false });
    app.dispatch(Step, { hard: false });
    app.tick(0.1);
    app.frame(0);
    // Two steps of one frame are one creak and one tap.
    expect(sound.played).toEqual([
      { cue: "creak", volume: 1, rate: 1, clip: creak },
      { cue: "tap", volume: 1, rate: 1 },
    ]);
    expect(sound.played[0]!.clip).toBe(creak);
    sound.played.length = 0;
    app.dispatch(Step, { hard: true });
    app.dispatch(Step, { hard: false });
    app.tick(0.1);
    app.frame(0);
    // The louder of the two asks for the one clip wins; another clip of
    // the same name is another sound.
    expect(sound.played.map((one) => [one.clip, one.volume, one.rate])).toEqual(
      [
        [creak, 1, 1],
        [other, 1, 1],
        [undefined, 1, 1],
      ]
    );
    expect(sound.played[1]!.clip).toBe(other);
  });

  it("is named when it is played or set in the tick, which throws as for any sound", () => {
    const Loud = System.make("mu/LoudClip", function* () {
      (yield* Sound.Player).play(Sound.clip("/bang.wav"));
    });
    const { app } = start(
      App.make({ plugins: [Sound.plugin], systems: [Loud] }),
      Sound.makeRecorder()
    );
    expect(() => app.tick(0.1)).toThrow(
      'The cue "/bang.wav" was played in the tick'
    );
  });
});

describe("a level's cues", () => {
  it("are made of what its bundle holds, once each time it is loaded, and play nothing while it is not", () => {
    const sound = Sound.makeRecorder();
    const { Forest, Keep, clips } = makeForest();
    let made = 0;
    const ForestCues = Sound.cues("mu/ForestCues", Forest, ({ creak }) => {
      made++;
      return [
        Sound.on(Stepped, ({ hard }) => ({
          cue: creak,
          volume: hard ? 1 : 0.4,
        })),
      ];
    });
    asked = 0;
    const { app } = start(
      App.make({
        plugins: [Rules, Sound.plugin, Assets.plugin],
        // Listed after the cues it is for: it is of an earlier stage.
        systems: [ForestCues, Keep],
      }).pipe(Effect.provide(files)),
      sound
    );
    const step = (action: Action.AnyActionDef, payload: unknown): void => {
      app.dispatch(action as never, payload as never);
      app.tick(0.1);
      app.frame(0);
    };
    // In the menu the forest's sounds are not loaded.
    step(Step, { hard: true });
    expect(sound.played).toEqual([]);
    expect(made).toBe(0);
    // A step in the very tick the forest is entered is heard: by the frame
    // after, its sounds are there.
    app.dispatch(Step, { hard: true });
    step(Go, { to: "forest" });
    expect(made).toBe(1);
    expect(clips.length).toBe(2);
    expect(sound.played).toEqual([
      { cue: "/creak.wav", volume: 1, rate: 1, clip: clips[0] },
    ]);
    step(Step, { hard: false });
    app.frame(0);
    app.frame(0);
    expect(sound.played.slice(1)).toEqual([
      { cue: "/creak.wav", volume: 0.4, rate: 1, clip: clips[0] },
    ]);
    expect(made).toBe(1);

    // Left: nothing of the forest is played, and what happened meanwhile
    // is not played when it is entered again.
    step(Go, { to: "cave" });
    step(Step, { hard: true });
    expect(sound.played.length).toBe(2);
    step(Go, { to: "forest" });
    expect(sound.played.length).toBe(2);
    expect(made).toBe(2);
    // Loaded again, its lines are made of what is loaded now.
    step(Step, { hard: true });
    expect(clips.length).toBe(4);
    expect(sound.played.at(-1)!.clip).toBe(clips[2]);
    expect(sound.played.length).toBe(3);
  });

  it("are made anew in the frame the bundle is found loaded afresh, though it was never seen gone", () => {
    const sound = Sound.makeRecorder();
    const { Forest, clips } = makeForest();
    let made = 0;
    const ForestCues = Sound.cues("mu/ForestCues", Forest, ({ creak }) => {
      made++;
      return [Sound.on(Stepped, creak)];
    });
    // A system of the game's own keeps the forest, and can load it afresh.
    let afresh = false;
    const Keep = System.make("mu/Keep", function* () {
      const store = yield* Assets.Store;
      if (afresh) {
        afresh = false;
        store.drop(Forest, "mu/Keep");
      }
      store.hold(Forest, "mu/Keep");
    }).pipe(System.inStage("frame"), System.before(ForestCues));
    const { app } = start(
      App.make({
        plugins: [Rules, Sound.plugin, Assets.plugin],
        systems: [Keep, ForestCues],
      }).pipe(Effect.provide(files)),
      sound
    );
    app.dispatch(Step, { hard: true });
    app.tick(0.1);
    app.frame(0);
    expect(made).toBe(1);
    expect(sound.played.at(-1)!.clip).toBe(clips[0]);
    // Between two frames the creak became another creak: the lines that
    // held the old one are not the ones that play.
    afresh = true;
    app.dispatch(Step, { hard: true });
    app.tick(0.1);
    app.frame(0);
    expect(made).toBe(2);
    expect(clips.length).toBe(4);
    expect(sound.played.at(-1)!.clip).toBe(clips[2]);
    expect(sound.played.length).toBe(2);
  });

  it("need the app's assets, which their type says, and lines that are there do not", () => {
    const { Forest } = makeForest();
    const Plain = Sound.cues("mu/Plain", Sound.on(Stepped, "tap"));
    const From = Sound.cues("mu/From", Forest, ({ creak }) => [
      Sound.on(Stepped, creak),
    ]);
    Sound.cues("mu/Wrong", Forest, ({ creak }) => [
      // @ts-expect-error the forest has no growl
      Sound.on(Stepped, creak.growl),
    ]);
    // @ts-expect-error the store of assets is one thing more to need
    const also: typeof Plain = From;
    expect(also.name).toBe("mu/From");
    // An app with cues that are there needs no Assets.plugin.
    const sound = Sound.makeRecorder();
    const { app } = start(
      App.make({ plugins: [Rules, Sound.plugin], systems: [Plain] }),
      sound
    );
    app.dispatch(Step, { hard: true });
    app.tick(0.1);
    app.frame(0);
    expect(sound.played).toEqual([{ cue: "tap", volume: 1, rate: 1 }]);
  });
});

describe("a level's music", () => {
  it("is a clip of its bundle, played while the bundle is loaded, and anew when it is loaded again", () => {
    const sound = Sound.makeRecorder();
    const { Forest, Keep, clips } = makeForest();
    const Ambience = Sound.music("mu/Ambience", function* () {
      const forest = yield* Forest;
      return forest._tag === "Ready"
        ? { track: forest.assets.wind, volume: 0.4 }
        : undefined;
    });
    const { app } = start(
      App.make({
        plugins: [Rules, Sound.plugin, Assets.plugin],
        systems: [Ambience, Keep],
      }).pipe(Effect.provide(files)),
      sound
    );
    const go = (to: "menu" | "forest" | "cave"): void => {
      app.dispatch(Go, { to });
      app.tick(0.1);
      app.frame(0);
    };
    app.frame(0);
    expect(sound.scored).toEqual([]);
    go("forest");
    app.frame(0);
    expect(sound.scored).toEqual([
      {
        channel: "music",
        track: "/wind.ogg",
        volume: 0.4,
        fade: 0.5,
        clip: clips[1],
      },
    ]);
    expect(Object.fromEntries(sound.playing)).toEqual({
      music: "/wind.ogg",
    });
    go("menu");
    expect(sound.scored.at(-1)).toEqual({
      channel: "music",
      track: undefined,
      volume: 0,
      fade: 0.5,
    });
    // The forest again is other wind, though of the same file: it starts.
    go("forest");
    expect(sound.scored.length).toBe(3);
    expect(sound.scored.at(-1)!.clip).toBe(clips[3]);
    expect(clips[3]).not.toBe(clips[1]);
  });

  it("is a clip as it is, where nothing more is to be said of it", () => {
    const sound = Sound.makeRecorder();
    const hum = Sound.clip("hum");
    const Hum = Sound.music("mu/Hum", function* () {
      return (yield* Level).value === "menu" ? hum : undefined;
    });
    const { app, step } = play([Hum], sound);
    app.frame(0);
    expect(sound.scored).toEqual([
      { channel: "music", track: "hum", volume: 1, fade: 0.5, clip: hum },
    ]);
    expect(sound.scored[0]!.clip).toBe(hum);
    step(Go, { to: "cave" });
    expect(sound.playing.size).toBe(0);
  });
});

describe("Sound.makeRecorder", () => {
  it("notes what each channel was told, oldest first, and what each is playing now", () => {
    const sound = Sound.makeRecorder();
    const wind = Sound.clip("wind", { samples: 3 });
    sound.music("a", "theme", 1, 0.5);
    sound.music("b", wind, 0.2, 0);
    expect(Object.fromEntries(sound.playing)).toEqual({
      a: "theme",
      b: "wind",
    });
    sound.music("a", undefined, 0, 2);
    sound.music("c", "fanfare", 1, 0, true);
    sound.music("c", wind, 1, 0, true);
    sound.music("c", "fanfare", 1, 0, false);
    sound.music("c", undefined, 0, 0, true);
    expect(sound.scored).toEqual([
      { channel: "a", track: "theme", volume: 1, fade: 0.5 },
      { channel: "b", track: "wind", volume: 0.2, fade: 0, clip: wind },
      { channel: "a", track: undefined, volume: 0, fade: 2 },
      { channel: "c", track: "fanfare", volume: 1, fade: 0, once: true },
      {
        channel: "c",
        track: "wind",
        volume: 1,
        fade: 0,
        clip: wind,
        once: true,
      },
      { channel: "c", track: "fanfare", volume: 1, fade: 0 },
      // Silence is not once or over and over.
      { channel: "c", track: undefined, volume: 0, fade: 0 },
    ]);
    expect(sound.scored[1]!.clip).toBe(wind);
    expect(wind.data).toEqual({ samples: 3 });
    expect(Object.fromEntries(sound.playing)).toEqual({ b: "wind" });
    // Its cues are apart from its music, and each recorder is its own.
    expect(sound.played).toEqual([]);
    expect(Sound.makeRecorder().scored).toEqual([]);
  });
});
