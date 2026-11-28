/**
 * Going back in a game: a moment of it, captured in memory, and the rewind
 * that puts the same app back to it.
 *
 *   const moment = yield* Timeline.capture(app)   // fails with Save.Refused
 *   yield* app.tick(1 / 60)
 *   yield* Timeline.rewind(app, moment)           // the same app, as it was
 *
 * An undo, a search ahead or a rewind mechanic keeps moments, and a session
 * that runs ahead rewinds to them. A game that never goes back imports none
 * of it. An undo keeps the game's turns with `Timeline.keep`, and goes back
 * one with `Timeline.undo`, or from the game's keys and UI with the action
 * `Timeline.Undo`:
 *
 *   yield* Timeline.keep(app)                     // in Driver.run's ready
 *   yield* Timeline.undo(app)                     // the game before its last turn
 *
 * A moment holds what a save holds, and no more: the world, with the game's
 * time, the actions queued for the next tick and the events waiting to be
 * read, and what change queries haven't visited yet. It isn't a save. It
 * holds the queued actions and the events as they are, without encoding
 * them, and it belongs to one app in one run of the program.
 */
import { Cause, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";

import * as Action from "./Action.ts";
import type * as App from "./App.ts";
import type { SavedChanges } from "./ecs/changes.ts";
import type { World, Moment as WorldMoment } from "./ecs/world.ts";
import * as Event from "./Event.ts";
import { said } from "./internal/intake.ts";
import type { Log, Since } from "./internal/log.ts";
import type { Told } from "./internal/outbox.ts";
import { moved, partsOf } from "./internal/parts.ts";
import { taking } from "./internal/save.ts";
import { GameTime, READER } from "./internal/stage.ts";
import * as Plugin from "./Plugin.ts";
import * as Save from "./Save.ts";

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
    readonly stages: boolean,
    /** Where the game was in its log, which goes back with it. */
    readonly since: Since
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
 * Captures a game as it is, to return to with `rewind`. Run it between
 * ticks: it dies during a tick, a stage or a handler.
 *
 * With `stages`, the moment also holds where the change queries of the frame
 * and input stages had got to, for a rewind that comes before those stages
 * run again. `Session.syncTest` runs each tick twice that way. Without it,
 * their change queries visit everything again after a rewind, unless the
 * rewind is to run the same ticks again.
 *
 * Fails with `Save.Refused` when the world can't be captured: a field
 * holds a value that can't be saved, or commands are queued but not applied.
 *
 * @category Running
 */
export const capture = (
  app: Game,
  options?: { readonly stages?: boolean }
): Effect.Effect<Moment, Save.Refused> =>
  Effect.suspend(() => {
    between(app, "capture", "A game is captured between ticks.");
    return held(app, options?.stages === true);
  });

/** Captures a game as it is, between ticks, as `capture` does. */
const held = (app: Game, stages: boolean): Exit.Exit<Held, Save.Refused> => {
  const { time } = app;
  const { commands, events, log, world } = partsOf(app);
  return Exit.map(
    taking(commands, "capture", () => world._capture()),
    (of) =>
      new Held(
        time.tick,
        world,
        of,
        events.mark(),
        // What runs between ticks has everything still to draw, unless it
        // is to draw nothing before the game comes back here.
        world.saveChanges(
          stages ? undefined : (reader) => !reader.startsWith(READER)
        ),
        stages,
        log.capture()
      )
  );
};

/**
 * Puts a game back, in place, to a moment `capture` took of it. The app, its
 * world and its services stay the same objects, and hold what they held
 * then. Its log goes back to the length it had. Run it between ticks, with
 * a moment of this app captured since it last loaded a save with `app.load`:
 * it dies otherwise.
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
 * - A `transient` field keeps its value where, since the moment, no loop or
 *   `set` wrote its component and no entity joined or left its table, as in
 *   a table no system touched. Elsewhere it is undefined.
 *
 * @category Running
 */
export const rewind = (
  app: Game,
  moment: Moment,
  options?: { readonly again?: boolean }
): Effect.Effect<void> =>
  Effect.suspend(() => {
    between(app, "rewind", "A game is put back between ticks.");
    const again = options?.again === true;
    const parts = partsOf(app);
    const turns = kept.get(parts.world);
    // The game it leaves, in case the rewind is itself a turn.
    turns?.arriving();
    putBack(app, moment, again);
    if (again) {
      // A game put back to run the same ticks again has not gone anywhere yet.
      return Effect.void;
    }
    if (turns !== undefined) {
      turns.ahead.length = 0;
    }
    return moved(parts) ?? Effect.void;
  });

/** Puts a game back to a moment, between ticks, as `rewind` does. */
const putBack = (app: Game, moment: Moment, again: boolean): void => {
  const { commands, dispatcher, events, log, undrawn, world } = partsOf(app);
  if (!(moment instanceof Held) || moment.of !== world) {
    throw new Error(
      "Timeline.rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
    );
  }
  const refused = log.refuses(moment.since);
  if (refused !== undefined) {
    throw new Error(`Timeline.rewind() was given a moment ${refused}`);
  }
  dispatcher.flush();
  // What is queued on the buffer was never part of the world.
  commands.rollback(0);
  world._rewind(
    moment.world,
    moment.changes,
    again && !moment.stages ? (reader) => reader.startsWith(READER) : undefined
  );
  events.rewound(moment.told, again);
  undrawn.rewound(world.singleton(GameTime).tick, again);
  commands.apply();
};

// --- turns: what an undo goes back to, and a redo forward to ------------------------

/**
 * Asks to go back a turn, in a game whose app `Timeline.keep` keeps. It is an
 * action like any other: a key bound to it in the input stage, or a UI that
 * sends it, issues it, and the rules may enqueue it. The tick that applies it
 * runs, and the app then goes back to where the game was before its last
 * turn. A game lists `Timeline.plugin` to handle it.
 *
 *   ui.send(Timeline.Undo)
 *
 * @category Actions
 */
export const Undo = Action.define("arcadekit/Timeline.Undo");

/**
 * Asks to go forward again a turn that `Timeline.Undo` went back, as
 * `Timeline.redo` does, after the tick that applies it.
 *
 * @category Actions
 */
export const Redo = Action.define("arcadekit/Timeline.Redo");

/** What the rules asked of the app that keeps the game's turns. */
interface Asking {
  readonly to: "undo" | "redo";
}
const Asked = Event.define(
  "arcadekit/Timeline.Asked",
  Schema.Struct({ to: Schema.Literals(["undo", "redo"]) })
);

/**
 * Handles `Timeline.Undo` and `Timeline.Redo`, so that a game's keys, its UI
 * and its rules can ask for them. A game that lists it and whose app nothing
 * keeps, as a replay or a server, applies them and changes nothing.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Timeline", {
  handlers: [
    Action.handler(Undo, function* () {
      (yield* Event.Emitter(Asked)).emit({ to: "undo" });
    }),
    Action.handler(Redo, function* () {
      (yield* Event.Emitter(Asked)).emit({ to: "redo" });
    }),
  ],
});

/**
 * What keeping a game's turns needs of an app: an app that ticks by itself.
 * An app a session steps has no `tick`, and a turn it went back would be this
 * machine's alone.
 *
 * @category Type-level
 */
export type Kept = Pick<App.Any, "phase" | "time" | "tick">;

/** The turns of an app that `keep` keeps. */
class Turns {
  /** The game before each turn, the last one last. */
  readonly back: Held[] = [];
  /** The game after each turn that was gone back, the next one last. */
  readonly ahead: Held[] = [];
  /**
   * The game where it last stood still, between two ticks, once it was
   * captured: when something from outside arrived since, or the game went
   * back or forward to it. A tick at rest captures nothing.
   */
  private standing: Held | undefined;
  /** How long the log was, and how many saves it had loaded, when it stood still. */
  private logLength: number;
  private loads: number;

  private readonly app: Kept;
  private readonly log: Log;
  private readonly last: number;
  private readonly asked: { readonly read: () => readonly Asking[] };

  constructor(
    app: Kept,
    last: number,
    asked: { readonly read: () => readonly Asking[] }
  ) {
    this.app = app;
    this.log = partsOf(app).log;
    this.last = last;
    this.asked = asked;
    this.standing = this.take();
    this.logLength = this.standing.since.logLength;
    this.loads = this.standing.since.loads;
  }

  /** Captures the game where it stands, before something from outside arrives. */
  arriving(): void {
    this.standing ??= this.take();
  }

  private take(): Held {
    const taken = held(this.app, false);
    if (Exit.isFailure(taken)) {
      throw new Error(
        `Timeline.keep could not keep a turn of the game: ${said(Cause.squash(taken.cause))} A game whose turns are kept holds only what can be saved.`
      );
    }
    return taken.value;
  }

  /** Goes back or forward a turn, and says whether there was one to go to. */
  go(to: "undo" | "redo"): boolean {
    const [from, into] =
      to === "undo" ? [this.back, this.ahead] : [this.ahead, this.back];
    const next = from.pop();
    if (next === undefined) {
      return false;
    }
    into.push(this.standing ?? this.take());
    putBack(this.app, next, false);
    this.standing = next;
    this.logLength = next.since.logLength;
    return true;
  }

  /**
   * The game has moved, by a tick, a dispatched action, a load or a rewind:
   * it goes where the rules asked, or, for a turn of moves from outside, the
   * game as it stood before the turn is kept to go back to and the turns
   * ahead are given up. A load gives up every turn, and a tick with no move
   * none.
   */
  moved(): void {
    let went = false;
    for (const { to } of this.asked.read()) {
      went = this.go(to) || went;
    }
    if (went) {
      return;
    }
    const { log } = this;
    if (this.loads !== log.loads) {
      this.back.length = 0;
      this.ahead.length = 0;
    } else if (
      // A move arrived from outside, which captured the game before it.
      this.standing !== undefined &&
      log.entries
        .slice(this.logLength)
        .some(
          (entry) =>
            !Action.isHashCheck(entry) &&
            entry.name !== Undo.name &&
            entry.name !== Redo.name
        )
    ) {
      this.back.push(this.standing);
      if (this.back.length > this.last) {
        this.back.shift();
      }
      this.ahead.length = 0;
    }
    this.standing = undefined;
    this.logLength = log.entries.length;
    this.loads = log.loads;
  }
}

/** The turns kept of each app's world. */
const kept = new WeakMap<object, Turns>();

/** The turns `keep` keeps of an app, or a defect that says it keeps none. */
const turnsOf = (app: Game, call: string): Turns => {
  const turns = kept.get(partsOf(app).world);
  if (turns === undefined) {
    throw new Error(
      `Timeline.${call}() was called on an app whose turns nothing keeps. Keep them with Timeline.keep(app), as Driver.run's ready can.`
    );
  }
  return turns;
};

/**
 * Keeps the turns of a game, for an undo: the game as it was before each
 * turn, for as long as the scope it runs in lasts. A turn is what a tick or a
 * dispatched action did with what came from outside: a move of the player's,
 * by a key, a UI or `app.enqueue`.
 *
 *   Driver.run(Puzzle, { hz: 60, ticks: "whenNeeded", ready: (app) => Timeline.keep(app) })
 *   yield* Timeline.undo(app)          // or, from the game's keys and UI, Timeline.Undo
 *
 * **Details**
 *
 * - It captures the game as `Timeline.capture` would when a move arrives,
 *   before the tick or the dispatch that applies it, which costs what
 *   changed since the last capture. A tick with no move captures nothing.
 * - It keeps the `last` turns, 100 by default, and lets go of older ones.
 * - Going back a turn keeps the game as it was, for `Timeline.redo` to go
 *   forward to, until the next move: a move, a load or a rewind gives up
 *   every turn ahead. A tick with no move gives up none, so a game that ticks
 *   by itself keeps its redo as a game that ticks only when needed does.
 * - `app.load` gives up every turn kept, since they are of the game the load
 *   replaced.
 *
 * **Gotchas**
 *
 * - An app a session steps can't be kept: it has no `tick`, and going back
 *   would move this machine's game alone.
 * - A redo goes to the game as it was at the undo, and gives up the ticks
 *   run since, as an undo gives up those run since the turn. What moves at
 *   rest, such as a running timer, is as it was at the undo.
 *
 * @category Running
 */
export const keep = (
  app: Kept,
  options?: { readonly last?: number }
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    between(
      app,
      "keep",
      "The turns of a game are kept from between two ticks."
    );
    const { after, before, events, world } = partsOf(app);
    if (kept.has(world)) {
      throw new Error(
        "Timeline.keep() was called on an app whose turns are kept already. Keep them once."
      );
    }
    const last = options?.last ?? 100;
    if (!Number.isSafeInteger(last) || last < 1) {
      throw new Error(
        `Timeline.keep() was given ${last} turns to keep: a whole number from 1 up.`
      );
    }
    const turns = new Turns(app, last, events.handle(Asked));
    const step = (): undefined => {
      turns.moved();
    };
    const arriving = () => {
      turns.arriving();
    };
    kept.set(world, turns);
    after.add(step);
    before.add(arriving);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        after.delete(step);
        before.delete(arriving);
        kept.delete(world);
      })
    );
  });

/**
 * Goes back a turn of a game whose turns `Timeline.keep` keeps: the game is
 * as it was before its last turn, in place, and succeeds with whether there
 * was a turn to go back. Run it between ticks: it dies anywhere else, and on
 * an app whose turns nothing keeps.
 *
 * It goes back as `Timeline.rewind` does, and the log goes back with it, so a
 * recording holds the turns that are left and replays to the game as it is.
 * A game's keys and its UI ask for it with `Timeline.Undo`.
 *
 * @category Running
 */
export const undo = (app: Game): Effect.Effect<boolean> =>
  Effect.sync(() => {
    between(app, "undo", "A turn is gone back between ticks.");
    return turnsOf(app, "undo").go("undo");
  });

/**
 * Goes forward again a turn that `Timeline.undo` went back, and succeeds with
 * whether there was one: the game is as it was before the undo, its time
 * and its log with it, and the ticks run since are given up. Run it between
 * ticks, before the next move: a move, a load or a rewind gives up every
 * turn ahead, and a tick with no move gives up none.
 *
 * @category Running
 */
export const redo = (app: Game): Effect.Effect<boolean> =>
  Effect.sync(() => {
    between(app, "redo", "A turn is gone forward between ticks.");
    return turnsOf(app, "redo").go("redo");
  });
