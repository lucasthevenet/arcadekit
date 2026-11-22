/**
 * What arcadekit refuses of a program: the mistakes it finds in how it is
 * used, each a class with a tag.
 *
 *   try {
 *     app.dispatch(Fire, {})
 *   } catch (error) {
 *     if (error instanceof Defect.WrongPhase) {
 *       error.call   // "dispatch"
 *       error.phase  // "tick"
 *     }
 *   }
 *
 * A defect is a bug in the program, and is not a failure to handle: nothing
 * in the package recovers from one, and none is in the error channel of an
 * Effect. Synchronous code throws it, and Effect code dies with it. The class
 * and its fields say which mistake it was, for a test, a tool or a game's own
 * error reports, and the message says what to do instead. A message may be
 * reworded in any release; a tag and its fields are kept.
 *
 * What a correct program still has to expect is something else: a move the
 * rules refuse, a payload that doesn't match its schema, a save that won't
 * load. Each of those is a failure with a class of its own, in the error
 * channel of what returns it.
 */
import { Data } from "effect";

import type { Phase } from "./App";

/**
 * Something was called, read or done while the app was running what must not
 * do it: `dispatch` during a tick, a save from an action's handler, `Frame`
 * read by a system of the tick, a sound played by the simulation.
 *
 * @category Errors
 */
export class WrongPhase extends Data.TaggedError("WrongPhase")<{
  /** What was called, read or done: `"dispatch"`, `"App.tick"`, `"Frame"`. */
  readonly call: string;
  /**
   * What the app was running: a phase of `app.phase`, or `"setup"` for a
   * plugin's setup, which runs before there is an app to ask. Undefined
   * where what refuses can only tell that it was not the phase it is for: a
   * sound, a view or an asset used outside the frame and input stages.
   */
  readonly phase: Phase | "setup" | undefined;
  /** Why it is refused there, and what to do instead. */
  readonly message: string;
}> {}

/**
 * What a program defines or configures can't be a game: two systems of one
 * name, a hook in the frame stage, an ordering that goes round in a circle,
 * a state that starts in a value it doesn't have, a version that is not a
 * whole number.
 *
 * @category Errors
 */
export class InvalidDefinition extends Data.TaggedError("InvalidDefinition")<{
  /**
   * The kind of thing that is defined or configured: `"system"`, `"event"`,
   * `"plugin"`, `"handler"`, `"state"`, `"view"`, `"query"`, `"option"`.
   */
  readonly kind: string;
  /** Its name: a system's, an event's, an option's. */
  readonly named: string;
  /** What is wrong with it, and what to write instead. */
  readonly message: string;
}> {}

/**
 * A call was given what it can't take, as the program is running: a moment
 * another app captured, a save this app didn't make, an action nobody
 * handles, a value a state doesn't have.
 *
 * @category Errors
 */
export class InvalidArgument extends Data.TaggedError("InvalidArgument")<{
  /** What was called: `"Timeline.rewind"`, `"record"`, `"enqueue"`. */
  readonly call: string;
  /** What it was given that it can't take, and what to give it instead. */
  readonly message: string;
}> {}

/**
 * An app that a session has taken over was stepped or changed directly, on
 * this machine alone, where its peers would not follow.
 *
 * @category Errors
 */
export class TakenOver extends Data.TaggedError("TakenOver")<{
  /** What was called: `"App.tick"`, `"dispatch"`, `"divert"`. */
  readonly call: string;
  /** Why the session has to do it, and what to call instead. */
  readonly message: string;
}> {}

/**
 * Something was used after the scope it lives in had closed: a layer that
 * listens, to a page's devices or to a socket, lasts as long as what it is
 * provided to.
 *
 * @category Errors
 */
export class ScopeClosed extends Data.TaggedError("ScopeClosed")<{
  /** What was used: `"Browser.layer"`, a transport's name. */
  readonly what: string;
  /** What it would do now, and where to provide it instead. */
  readonly message: string;
}> {}

/**
 * A game's code did not end within the run that started it: a system that
 * waits, a handler that sleeps, a fiber that outlives its tick. It would
 * change the game later, at a moment no replay repeats.
 *
 * @category Errors
 */
export class NotSynchronous extends Data.TaggedError("NotSynchronous")<{
  /** What was running: `"Tick 12"`, `The handler for "Fire"`. */
  readonly what: string;
  /** What it did, and where work that takes longer than a tick belongs. */
  readonly message: string;
}> {}

/**
 * Says an error in a few words, for a message that passes it on: its own
 * message, its name when it has none, or the value itself when it is not an
 * error at all.
 *
 * @category Utilities
 */
export const said = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);
