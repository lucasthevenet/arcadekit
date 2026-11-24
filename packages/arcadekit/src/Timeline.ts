/**
 * Going back in a game: a moment of it, captured in memory, and the rewind
 * that puts the same app back to it.
 *
 *   const moment = yield* Timeline.capture(app)   // fails with Save.SaveRefused
 *   app.tick(1 / 60)
 *   Timeline.rewind(app, moment)                  // the same app, as it was
 *
 * An undo, a search ahead or a rewind mechanic keeps moments, and a session
 * that runs ahead rewinds to them. A game that never goes back imports none
 * of it.
 *
 * A moment holds what a save holds, and no more: the world, with the game's
 * time, the actions queued for the next tick and the events waiting to be
 * read, and what change queries haven't visited yet. It isn't a save. It
 * holds the queued actions and the events as they are, without encoding
 * them, and it belongs to one app in one run of the program.
 */
import { Exit } from "effect";

import type * as App from "./App";
import { partsOf } from "./app/parts";
import { READER } from "./app/Stage";
import type { SavedChanges } from "./ecs/changes";
import type { World, Moment as WorldMoment } from "./ecs/world";
import type { Told } from "./event/Outbox";
import * as Save from "./Save";

/**
 * A game at one moment, held in memory, which `Timeline.capture` returns and
 * `Timeline.rewind` takes. Only its tick is public.
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
export type Game = Pick<App.Any, "phase" | "time">;

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
    readonly changes: SavedChanges[],
    /** Whether `changes` holds the frame and input stages' places too. */
    readonly stages: boolean
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
 * Captures a game as it is, to return to with `rewind`. Call it between
 * ticks: it throws during a tick, a stage or a handler.
 *
 * With `stages`, the moment also holds where the change queries of the frame
 * and input stages had got to, for a rewind that comes before those stages
 * run again. `Session.syncTest` runs each tick twice that way. Without it,
 * their change queries visit everything again after a rewind, unless the
 * rewind is to run the same ticks again.
 *
 * Fails with `Save.SaveRefused` when the world can't be captured: a field
 * holds a value that can't be saved, or commands are queued but not applied.
 *
 * @category Running
 */
export const capture = (
  app: Game,
  options?: { readonly stages?: boolean }
): Exit.Exit<Moment, Save.SaveRefused> => {
  between(app, "capture", "A game is captured between ticks.");
  const { time } = app;
  const { commands, events, world } = partsOf(app);
  return Exit.map(
    Save.taking(commands, "capture", () => world._capture()),
    (of) =>
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
        ),
        options?.stages === true
      )
  );
};

/**
 * Puts a game back, in place, to a moment `capture` took of it. The app, its
 * world and its services stay the same objects, and hold what they held
 * then. Its log goes back to the length it had. Call it between ticks, with
 * a moment of this app: it throws otherwise.
 *
 * The game plays on from there. The frame and input stages, and code outside
 * the game that reads an event, hear every event it emits from then on,
 * including one they heard before the rewind. Of the future the rewind gives
 * up, they hear nothing they hadn't read already.
 *
 * With `again`, the game goes back to run the same ticks again with what is
 * now known of them, as a session that runs ahead does. Each of them then
 * hears each event once. An event a tick emits again with the same payload
 * isn't heard twice, and only what the tick now does differently is heard.
 * The two stages' change queries visit what they had yet to visit, and the
 * entities that the future given up or the ticks run again change, spawn or
 * despawn, and no other.
 *
 * **Gotchas**
 *
 * - State kept outside the world, such as a module's variable that a system
 *   reads, stays as it is. `Session.syncTest` finds a tick that reads such
 *   state.
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
  const { commands, dispatcher, events, world } = partsOf(app);
  if (!(moment instanceof Held) || moment.of !== world) {
    throw new Error(
      "Timeline.rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
    );
  }
  dispatcher.flush();
  // What is queued on the buffer was never part of the world.
  commands.rollback(0);
  const again = options?.again === true;
  world._rewind(
    moment.world,
    moment.changes,
    again && !moment.stages ? (reader) => reader.startsWith(READER) : undefined
  );
  events.rewound(moment.told, again);
  commands.apply();
};
