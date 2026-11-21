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
import { Exit } from "effect";

import type * as Action from "./Action";
import type { Any } from "./App";
import { SnapshotError } from "./ecs/snapshot";
import type { SavedChanges, Moment as WorldMoment } from "./ecs/world";
import { FRAME_READER } from "./Event";
import type { EventsMoment } from "./Event";
import { SaveRefused } from "./Save";

/**
 * A game at one moment, held in memory: what `Timeline.capture` returns and
 * `Timeline.rewind` takes. It says which tick it is of; Timeline holds the
 * rest, for as long as the moment is kept.
 *
 * @category Models
 */
export interface Moment {
  /** The number of ticks run when it was captured. */
  readonly tick: number;
}

/**
 * What an app keeps of its run beside its world, its events and its commands,
 * which a moment captures and a rewind puts back. The app hands it over as it
 * is: Timeline reads and writes it in place.
 *
 * @internal
 */
export interface Run {
  /** What entered the game from outside, and the checkpoints: `app.actionLog`. */
  readonly log: Action.LogEntry[];
  /** The delta of every tick run, by tick, for a recording. */
  readonly deltas: { readonly tick: number; readonly delta: number }[];
  /** The actions queued for the next tick, each with its log entry, if any. */
  readonly queued: Iterable<{
    readonly entry: { refused?: string } | undefined;
  }>;
  /** Whether the first action or tick has fixed the state the game starts from. */
  started: boolean;
  /** Whether the game asked for its next tick. */
  wanted: boolean;
  /** Whether the input stage has run since the last tick. */
  heard: boolean;
  /**
   * Throws unless the app is between ticks, naming `call`: during a tick, a
   * frame or the input stage, and with `handler`, from an action's handler.
   */
  readonly between: (call: string, handler: boolean) => void;
}

/** What a moment holds beyond its tick, and whose it is. */
interface Held {
  readonly run: Run;
  readonly world: WorldMoment;
  readonly events: EventsMoment;
  readonly changes: SavedChanges[];
  readonly logLength: number;
  readonly started: boolean;
  readonly wanted: boolean;
}

// Every moment captured, with what it holds: a moment isn't kept alive by it,
// and `rewind` takes no other.
const held = new WeakMap<Moment, Held>();

/**
 * Captures the game, between ticks. `unseen` is for a moment the stages
 * between ticks will not run after before it is rewound to: their place in
 * what changed is kept too.
 *
 * @internal
 */
export const take = (
  app: Any,
  unseen: boolean
): Exit.Exit<Moment, SaveRefused> => {
  const refused = (message: string): Exit.Exit<never, SaveRefused> =>
    Exit.fail(new SaveRefused({ message }));
  const { commands, events, world } = app;
  if (commands.size > 0) {
    return refused(
      `${commands.size} commands are queued and not applied. They are applied at the end of a tick: capture after one.`
    );
  }
  let snapshot: WorldMoment;
  try {
    snapshot = world._capture();
  } catch (error) {
    if (error instanceof SnapshotError) {
      return refused(error.message);
    }
    throw error;
  }
  const run = app._run;
  const moment: Moment = { tick: app.time.tick };
  held.set(moment, {
    run,
    world: snapshot,
    events: events.capture(),
    // What runs between ticks has everything still to draw, unless it has
    // drawn nothing since.
    changes: world.saveChanges(
      unseen ? () => true : (reader) => !reader.startsWith(FRAME_READER)
    ),
    logLength: run.log.length,
    started: run.started,
    wanted: run.wanted,
  });
  return Exit.succeed(moment);
};

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
export const capture = (app: Any): Exit.Exit<Moment, SaveRefused> => {
  app._run.between("Timeline.capture()", false);
  return take(app, false);
};

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
  const run = app._run;
  run.between("Timeline.rewind()", true);
  const was = held.get(moment);
  if (was?.run !== run) {
    throw new Error(
      "Timeline.rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
    );
  }
  const { commands, events, world } = app;
  app.dispatcher.flush();
  // What is queued on the buffer was never part of the world.
  commands.rollback(0);
  // Before the world: the bus reads what the world's lists hold of the future
  // it gives up, and the app's time is still where the game was.
  events.rewind(was.events, app.time.tick, moment.tick);
  world._rewind(was.world);
  for (const action of run.queued) {
    // It is waiting again: what became of it has not happened.
    if (action.entry !== undefined) {
      delete action.entry.refused;
    }
  }
  world.restoreChanges(was.changes);
  run.log.length = was.logLength;
  while ((run.deltas.at(-1)?.tick ?? -1) >= moment.tick) {
    run.deltas.pop();
  }
  run.started = was.started;
  run.wanted = was.wanted;
  run.heard = false;
  commands.apply();
};
