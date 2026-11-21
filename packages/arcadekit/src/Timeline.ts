/**
 * Going back in a game: a moment captures it as it is, in memory, and a
 * rewind puts the same app back to that moment, in place.
 *
 *   const moment = Timeline.capture(app)  // Exit<Timeline.Moment, Save.SaveRefused>
 *   app.tick(1 / 60)
 *   Timeline.rewind(app, moment.value)    // the same app, as it was
 *
 * A moment holds what a save holds: the world, with its time, the actions
 * queued for the next tick and the events waiting to be read, every reader's
 * position in those events and in what change queries haven't visited, and
 * the length of the log. It isn't a save: it holds the queued actions and the
 * events as they are, so none of them needs a schema, and it belongs to one
 * app in one run of the program. Rewinding gives up what came after the
 * moment: the log is truncated, and the ticks after it are run again or not
 * at all.
 *
 * It is what predicting a tick and running it again is built on: `Lockstep`
 * captures before each tick it isn't sure of, and `Rollback.syncTest` before
 * every tick. An undo is an array of moments the game keeps itself.
 */
import type { Exit } from "effect";

import type { Any } from "./App";
import type { SaveRefused } from "./Save";

/**
 * A game at one moment, held in memory: what `Timeline.capture` returns and
 * `Timeline.rewind` takes. It says which tick it is of; the rest is the app's.
 *
 * @category Models
 */
export interface Moment {
  /** The number of ticks run when it was captured. */
  readonly tick: number;
}

/**
 * Captures the game as it is, in memory, to come back to with
 * `Timeline.rewind`: the world with its time, the actions queued for the next
 * tick and the events waiting to be read, every reader's position, what change
 * queries haven't visited yet, and the length of the log. Only between ticks.
 *
 * **When to use**
 *
 * Use to go back within a run of the program: before a tick that may have to
 * run again, or for an undo. Use `app.save()` instead for a game to keep, send
 * or load in another run.
 *
 * **Gotchas**
 *
 * - It fails with `SaveRefused` when the world can't be snapshotted: a field
 *   holds a value that can't be saved, or commands are queued but not
 *   applied.
 * - It throws during a tick, a frame or the input stage.
 *
 * @category Constructors
 */
export const capture = (app: Any): Exit.Exit<Moment, SaveRefused> =>
  app._timeline.capture();

/**
 * Puts the game back, in place, to when `moment` was captured: the same app,
 * world and services, holding what they held then. The log is truncated to its
 * length at that time. Only between ticks, and only with a moment of this app.
 *
 * **Details**
 *
 * The frame and input stages don't hear an event twice: until the game has
 * run again the ticks it had run before the rewind, an event of theirs that a
 * stage heard then, the same payload, is heard once. An event the ticks run
 * again emit otherwise, or a payload that changed, is heard as new.
 *
 * **Gotchas**
 *
 * - A moment holds what a save holds, and no more. State held by your game's
 *   own services is left as is: `Rollback.syncTest` finds a tick that reads
 *   it.
 * - A `transient` field is undefined afterwards.
 * - What runs between ticks starts over: frame-stage and input-stage change
 *   queries visit everything again.
 * - It throws during a tick, a frame or the input stage, from a handler, and
 *   for a moment another app captured.
 *
 * @category Running
 */
export const rewind = (app: Any, moment: Moment): void => {
  app._timeline.rewind(moment);
};
