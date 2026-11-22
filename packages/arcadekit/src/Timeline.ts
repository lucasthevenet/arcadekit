/**
 * Going back in a game: a moment of it, captured in memory, and the rewind
 * that puts the same app back to it.
 *
 *   const moment = Timeline.capture(app)          // Exit<Moment, SaveRefused>
 *   app.tick(1 / 60)
 *   Timeline.rewind(app, moment.value)            // the same app, as it was
 *
 * It is what an undo, a search ahead or a rewind mechanic keeps, and what a
 * rollback session goes back with. A game that never goes back imports none
 * of it.
 *
 * A moment holds what a save holds, and no more: the world, which holds the
 * game's time, the actions queued for the next tick and the events waiting to
 * be read, and what change queries haven't visited yet. It isn't a save. It
 * holds the queued actions and the events as they are, so none of them is put
 * through its schema, and it belongs to one app in one run of the program.
 */
import { Exit } from "effect";

import type * as App from "./App";
import type { SavedChanges } from "./ecs/changes";
import { SnapshotError } from "./ecs/snapshot";
import type { World, Moment as WorldMoment } from "./ecs/world";
import type { Told } from "./Outbox";
import * as Save from "./Save";
import { READER } from "./Stage";

/**
 * A game at one moment, held in memory: what `Timeline.capture` returns and
 * `Timeline.rewind` takes. It exposes its tick; the rest is the module's own.
 *
 * @category Models
 */
export interface Moment {
  /** The number of ticks run when it was captured. */
  readonly tick: number;
}

/**
 * What capturing and rewinding need of an app. Every app provides it.
 *
 * @category Type-level
 */
export type Game = Pick<
  App.Any,
  "commands" | "dispatcher" | "events" | "phase" | "time" | "world"
>;

/**
 * What a moment holds beyond its tick. Only `capture` makes one, so a moment
 * that is one of these was captured here.
 */
class Held implements Moment {
  constructor(
    readonly tick: number,
    /** The world it is of: a moment goes back to no other. */
    readonly of: World,
    readonly world: WorldMoment,
    /** Where the game was in what the stages between ticks were told. */
    readonly told: Told,
    readonly changes: SavedChanges[]
  ) {}
}

/** Refuses a call made while the app is running something. */
const between = (app: Game, call: string, rule: string): void => {
  const { phase } = app;
  if (phase !== "idle") {
    throw new Error(
      `Timeline.${call}() was called during ${phase === "input" ? "a run of the input stage" : phase === "handler" ? "an action's handler" : `a ${phase}`}. ${rule}`
    );
  }
};

/**
 * Captures a game as it is, to return to with `rewind`. Only between ticks.
 *
 * With `stages`, the moment also holds the place of the frame and input
 * stages in what changed, for a rewind that comes before they run again:
 * `Rollback.syncTest` runs each tick twice that way. Without it, their change
 * queries visit everything again after the rewind.
 *
 * Fails with `SaveRefused` when the world can't be captured: a field holds a
 * value that can't be saved, or commands are queued but not applied.
 *
 * @category Running
 */
export const capture = (
  app: Game,
  options?: { readonly stages?: boolean }
): Exit.Exit<Moment, Save.SaveRefused> => {
  between(app, "capture", "A game is captured between ticks.");
  const { commands, events, time, world } = app;
  const refused = (message: string): Exit.Exit<never, Save.SaveRefused> =>
    Exit.fail(new Save.SaveRefused({ message }));
  if (commands.size > 0) {
    return refused(
      `${commands.size} commands are queued and not applied. They are applied at the end of a tick: capture after one.`
    );
  }
  let of: WorldMoment;
  try {
    of = world._capture();
  } catch (error) {
    if (error instanceof SnapshotError) {
      return refused(error.message);
    }
    throw error;
  }
  return Exit.succeed(
    new Held(
      time.tick,
      world,
      of,
      events.mark(),
      // What runs between ticks has everything still to draw, unless it is
      // to draw nothing before the game comes back here.
      world.saveChanges(
        options?.stages === true
          ? undefined
          : (reader) => !reader.startsWith(READER)
      )
    )
  );
};

/**
 * Puts a game back, in place, to a moment `capture` took of it: the same
 * app, world and services, holding what they held then. Its log is taken
 * back to the length it had. Only between ticks, and only with a moment of
 * this app.
 *
 * The game plays on from there, as a new one would. The frame and input
 * stages hear every event it emits from then on, one they heard before the
 * rewind among them, and nothing of the future that was given up before
 * they had read it.
 *
 * With `again`, the game goes back to run the same ticks again with what is
 * now known of them, as a rollback session does. The two stages then hear
 * each event once: one a tick emits again, with the same payload, isn't heard
 * twice, and only what the tick now does otherwise is.
 *
 * **Gotchas**
 *
 * - State held by your game's own services is left as it is:
 *   `Rollback.syncTest` finds a tick that reads it.
 * - A `transient` field is undefined afterwards.
 *
 * @category Running
 */
export const rewind = (
  app: Game,
  moment: Moment,
  options?: { readonly again?: boolean }
): void => {
  between(app, "rewind", "A game is put back between ticks.");
  const { commands, dispatcher, events, world } = app;
  if (!(moment instanceof Held) || moment.of !== world) {
    throw new Error(
      "Timeline.rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
    );
  }
  dispatcher.flush();
  // What is queued on the buffer was never part of the world.
  commands.rollback(0);
  world._rewind(moment.world);
  events.rewound(moment.told, options?.again === true);
  world.restoreChanges(moment.changes);
  commands.apply();
};
