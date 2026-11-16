/**
 * Sound: a service that plays a named cue, driven by events.
 *
 *   // The simulation says what happened. It knows nothing of sound.
 *   const Collided = Event.define("physics/Collided", Schema.Struct({ speed: Schema.Finite }))
 *
 *   // What it sounds like: a system of the frame stage.
 *   const Cues = Sound.cues("game/Cues",
 *     Sound.on(Scored, "coin"),
 *     Sound.on(Collided, ({ speed }) => ({ cue: "thud", volume: Math.min(1, speed / 10) }))
 *   )
 *
 *   const Game = Plugin.make("Game", {
 *     plugins: [Sound.plugin],
 *     systems: [Physics, Cues],
 *   })
 *
 *   // Where it goes: in a page, the files of the cues.
 *   Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), {
 *     sounds: { coin: "/coin.wav", thud: "/thud.wav" },
 *   })
 *
 * Sound follows real time, so it is no part of the simulation. A tick
 * emits events; a system of the frame stage, which hears every event
 * once however many ticks ran since the last frame, plays what they sound
 * like. The simulation never calls the player: in the tick, playing
 * throws. A replay and a server, which run no frame stage, play nothing,
 * and the game they run is the same game.
 */
import { Context, Effect, Layer } from "effect";

import type * as Event from "./Event";
import * as Plugin from "./Plugin";
import { World } from "./Services";
import type { Events } from "./Services";
import * as System from "./System";

// --- where sound goes ------------------------------------------------------------

export interface OutputShape {
  /**
   * Starts a cue now: at `volume`, where 1 is the cue as it was recorded,
   * and `rate` times its own speed, which is its pitch too.
   */
  readonly play: (cue: string, volume: number, rate: number) => void;
}

const silent: OutputShape = { play() {} };

/**
 * Where sound goes. A `Context.Reference` whose default is nowhere, which
 * is what a server, a replay and most tests want. A page provides its
 * own: `Browser.layerSound(files)`, or the `sounds` of `Browser.runMain`.
 * A test provides one that notes what it was asked, `Sound.makeRecorder()`.
 */
export const Output: Context.Reference<OutputShape> =
  Context.Reference<OutputShape>("arcadekit/Sound.Output", {
    defaultValue: () => silent,
  });

/** Provides an output to the game: `Effect.provide(Sound.layer(output))`. */
export const layer = (output: OutputShape): Layer.Layer<never> =>
  Layer.succeed(Output, output) as Layer.Layer<never>;

/** A cue that was played, as a recorder notes it. */
export interface Played {
  readonly cue: string;
  readonly volume: number;
  readonly rate: number;
}

export interface Recorder extends OutputShape {
  /** Every cue it was asked to play, oldest first. */
  readonly played: Played[];
}

/**
 * An output that plays nothing and notes what it was asked to, for a test
 * or a tool:
 *
 *   const sound = Sound.makeRecorder()
 *   const app = yield* App.make({ plugins: [Game] }).pipe(
 *     Effect.provide(Sound.layer(sound))
 *   )
 *   app.tick(1 / 60)
 *   app.frame(0)
 *   sound.played   // [{ cue: "coin", volume: 1, rate: 1 }]
 */
export const makeRecorder = (): Recorder => {
  const played: Played[] = [];
  return {
    played,
    play(cue, volume, rate) {
      played.push({ cue, volume, rate });
    },
  };
};

// --- the player ------------------------------------------------------------------

/** How a cue is played. */
export interface Options {
  /** How loud: 1, the cue as it was recorded, when left out. Not below 0. */
  readonly volume?: number;
  /** How fast, and so how high: 1, its own speed, when left out. */
  readonly rate?: number;
}

export interface PlayerShape {
  /** Whether sound goes anywhere. False on a server, in a replay, in most tests. */
  readonly audible: boolean;
  /**
   * Plays a cue, by its name, now. For the stages between ticks: in the
   * tick it throws, since the simulation does not play.
   */
  readonly play: (cue: string, options?: Options) => void;
}

/**
 * An app's player of cues. `Sound.plugin` provides it and `Sound.cues`
 * works it. A system of the frame stage can play through it too, for a
 * sound that no event stands for: `(yield* Sound.Player).play("click")`.
 */
export class Player extends Context.Service<Player, PlayerShape>()(
  "arcadekit/Sound.Player"
) {}

const playerLayer = Layer.effect(
  Player,
  Effect.gen(function* () {
    const output = yield* Output;
    // Between ticks an app's world is frozen: that is how the stages that
    // may play are told from the tick.
    const world = yield* World;
    return {
      audible: output !== silent,
      play(cue, options) {
        if (!world.frozen) {
          throw new Error(
            `The cue "${cue}" was played in the tick. Sound follows real time and is no part of the game: a replay and a server play nothing, and a tick must not depend on whether anything is heard. Emit an event for what happened, and play what it sounds like from a system of the frame stage, which Sound.cues makes.`
          );
        }
        output.play(cue, Math.max(0, options?.volume ?? 1), options?.rate ?? 1);
      },
    };
  })
);

/**
 * Gives an app a player of cues, which plays to the output the app was
 * given. A plugin whose systems are made with `Sound.cues` lists it in
 * `plugins`.
 */
export const plugin = Plugin.make("arcadekit/Sound", { layer: playerLayer });

// --- cues: from the game's events to what they sound like ---------------------------

/** A cue with how to play it. */
export interface Cue extends Options {
  readonly cue: string;
}

/**
 * What an event sounds like: a cue's name, a cue with how to play it, or
 * how to make either of the event, which may be nothing.
 */
export type CueOf<P> =
  | string
  | Cue
  | ((payload: P) => string | Cue | undefined);

/** One line of `Sound.cues`: when this event happens, play that cue. */
export interface Line {
  /** @internal */
  readonly event: Event.EventDef<any>;
  /** @internal */
  readonly pick: (payload: any) => string | Cue | undefined;
}

/**
 * Plays a cue each time an event happens.
 *
 *   Sound.on(Scored, "coin")
 *   Sound.on(Collided, ({ speed }) => ({ cue: "thud", volume: Math.min(1, speed / 10) }))
 *   Sound.on(Landed, ({ hard }) => (hard ? "crash" : undefined))
 *
 * The cue is a name, a name with a volume and a rate, or a function of
 * the event's payload that gives either, or nothing.
 */
export const on = <P>(event: Event.EventDef<P>, cue: CueOf<P>): Line => ({
  event,
  pick: typeof cue === "function" ? cue : () => cue,
});

/**
 * Makes a system of the frame stage out of lines: each frame it plays what
 * the events since the last frame sound like.
 *
 *   const Cues = Sound.cues("game/Cues",
 *     Sound.on(Scored, "coin"),
 *     Sound.on(Collided, "thud")
 *   )
 *
 * - It hears every event once, whatever order the systems run in and
 *   however many ticks ran since the last frame, as any frame system
 *   does.
 * - A cue that several events of one frame ask for is played once, as
 *   the loudest of them asked: forty coins caught in one tick are one
 *   sound, not forty on top of each other.
 * - Cues are played in the order they were first asked for.
 * - Where sound goes nowhere it reads nothing and plays nothing.
 * - It needs `Sound.plugin`, and takes `System.runIf` like any system.
 */
export const cues = (
  name: string,
  ...lines: readonly Line[]
): System.System<never, Player | Events> =>
  System.make(name, function* () {
    const player = yield* Player;
    if (!player.audible) {
      return;
    }
    // Made only in a frame that has something to play.
    let asked: Map<string, { volume: number; rate: number }> | undefined;
    for (const line of lines) {
      const heard = (yield* line.event).read();
      for (const payload of heard) {
        const picked = line.pick(payload);
        if (picked === undefined) {
          continue;
        }
        const cue = typeof picked === "string" ? picked : picked.cue;
        const volume = typeof picked === "string" ? 1 : (picked.volume ?? 1);
        const rate = typeof picked === "string" ? 1 : (picked.rate ?? 1);
        asked ??= new Map();
        const already = asked.get(cue);
        if (already === undefined) {
          asked.set(cue, { volume, rate });
        } else if (volume > already.volume) {
          already.volume = volume;
          already.rate = rate;
        }
      }
    }
    if (asked !== undefined) {
      for (const [cue, how] of asked) {
        player.play(cue, how);
      }
    }
  }).pipe(System.inStage("frame"));
