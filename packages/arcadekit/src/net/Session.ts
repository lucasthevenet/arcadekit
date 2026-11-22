/**
 * Sessions: multiplayer games with each player on their own machine.
 *
 * Every peer runs the same simulation, and peers only exchange the actions
 * their players issue, each stamped with the tick it applies on, so all of
 * them apply the same actions on the same ticks in the same order, and stay
 * in the same game.
 *
 *   const session = yield* Session.make(Duel, {
 *     seed: 1,
 *     peer: "ada",
 *     peers: ["ada", "grace"],
 *     delta: 1 / 60,
 *   })
 *
 *   session.app.enqueue(Move, { player: "ada", dx: 1 }) // applied on every peer
 *
 *   // Carrying messages is not the session's job:
 *   session.receive(message)                  // a message from another peer
 *   session.tick()                            // true if the tick ran, false if it waits
 *   for (const message of session.outgoing()) send(message)
 *
 * A session makes its app and steps it. Everything that enters the app from
 * outside goes through the session: `session.app.enqueue`, a key bound to an
 * action, a UI button. Each goes into this peer's message for the tick
 * `delay` ticks ahead, and is applied on that tick by every peer, including
 * this one. Your game therefore issues input exactly as a single-player game
 * does. What the simulation issues itself with `Actions`, such as a bot's
 * move, isn't sent: every peer's simulation issues it.
 *
 * `session.app` is an `App.Steered`: it has no `tick` and no `dispatch`,
 * since either would advance this peer's game alone.
 *
 * A session runs each tick without waiting for the network, up to `ahead`
 * ticks past what every peer has sent, predicting that the peers it hasn't
 * heard from did nothing, which is true of most ticks. When a message
 * arrives for a tick that already ran, and it contains actions, the session
 * rewinds to before that tick and resimulates with what it now knows. With
 * `ahead: 0` it predicts nothing and runs a tick only once every peer has
 * sent its actions for it: lockstep.
 *
 * Every peer ends on the same game: each applies every action on the tick it
 * is stamped with, whenever it heard of it. Along the way, a peer that runs
 * ahead may see a move accepted that is later refused, once the message it
 * was missing arrives.
 *
 * Rewinding goes back to a moment `Timeline.capture` took before each
 * uncertain tick, with the rewind that runs the same ticks again, so that the
 * frame and input stages hear an event once however often its tick is run. A
 * rewind restores only what a save holds: see `Timeline.rewind`. A tick that
 * reads anything else runs differently when it is resimulated, and the peers
 * drift apart. `Session.syncTest` finds such a tick in a test, with no
 * second peer.
 *
 * `Peer` is the session without its app, `Message` what the peers say to
 * each other, and `Drift` how they find that they have drifted apart.
 */
import { Cause, Data, Effect, Exit } from "effect";
import type { Scope } from "effect";

import type * as App from "../App";
import { build } from "../Build";
import type { Reins } from "../Build";
import type * as Plugin from "../Plugin";
import type * as Save from "../Save";
import * as Timeline from "../Timeline";
import * as Peer from "./Peer";

/**
 * Options for a session: how its game starts, as `App.make` takes it, this
 * peer, every peer, and how far it sends and runs ahead.
 *
 * @category Options
 */
export interface Options<
  SV extends Save.Save | undefined = undefined,
> extends App.StartOptions<SV> {
  /** This peer's name. */
  readonly peer: string;
  /**
   * Every peer of the game, including this one. Every peer is given the same
   * names, in any order.
   */
  readonly peers: readonly string[];
  /** The seconds a tick simulates, the same on every peer. */
  readonly delta: number;
  /**
   * How many ticks pass between issuing an action and applying it: a
   * non-negative integer, which may differ from peer to peer. A message has
   * that long to reach the other peers before they have to wait for it, or to
   * go back for it.
   *
   * Defaults to 0 for a session that runs ahead, so a player's own move is
   * applied on the very next tick: a delay of a tick or two spares the other
   * peers a rewind for every move, at the cost of that much input lag for the
   * local player. Defaults to 2 for a session whose `ahead` is 0, which would
   * otherwise wait for the network on every tick.
   */
  readonly delay?: number;
  /**
   * How many ticks the session may run past what every peer has sent.
   * Defaults to 8. A peer that far ahead waits. It is also the furthest a
   * rewind may go back, and the most moments kept for it. With 0 the session
   * never runs ahead, never captures and never rewinds: lockstep.
   */
  readonly ahead?: number;
}

/**
 * One peer of a multiplayer game, with its app. A driver steps it as it steps
 * an app: `Driver.frames(session, { hz })`. `Peer.Peer` documents what it
 * receives, sends and reports.
 *
 * `E` is what a tick of its app can fail with, and `HU` the actions its
 * handlers accept.
 *
 * @category Models
 */
export interface Session<E = never, HU = never> extends Peer.Peer<E> {
  /**
   * The session's app, which the session steps: its world to read, its
   * `enqueue` for what this peer's player does, its saves and its recordings.
   */
  readonly app: App.Steered<E, HU>;
}

/**
 * Makes a session, and the app it steps: a peer of a game that every peer
 * makes alike, with the same game, the same seed or save, the same `delta`
 * and the same names.
 *
 * The session begins at whatever tick its app does, so a game can continue
 * from a save every peer loaded. It fails with what `App.make` fails with.
 *
 * **Gotchas**
 *
 * - It throws when the options can't describe a game: a peer not among `peers`,
 *   two peers with the same name, a `delay` or an `ahead` that isn't a whole
 *   number of ticks, or a `delta` that isn't greater than 0.
 * - A payload its schema rejects has no JSON form to send: it is refused on the
 *   issuing peer only, and the others never see it.
 * - Each peer is given its own game, seed, `delta` and names, and none of
 *   these is compared directly, only the worlds they produce. A different
 *   `delta` or list of names is detected once it has changed a world, and a
 *   list that leaves a peer out is never detected.
 *
 * @category Constructors
 */
export const make = <
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
  SV extends Save.Save | undefined = undefined,
>(
  game: App.Game<S, H, P>,
  options: Options<SV>
): Effect.Effect<
  Session<App.TickError<S, P>, App.AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | (SV extends Save.Save ? Save.LoadRefused : never),
  Scope.Scope | App.External<S, H, P>
> =>
  Effect.map(
    build(game, options),
    ({ app, take }): Session<App.TickError<S, P>, App.AllHandlers<H, P>> => {
      const ahead = options.ahead ?? 8;
      return Peer.build(app, take, {
        peer: options.peer,
        peers: options.peers,
        delta: options.delta,
        // A session that predicts nothing would wait for the network on
        // every tick with no delay.
        delay: options.delay ?? (ahead === 0 ? 2 : 0),
        ahead,
      });
    }
  );

/**
 * A tick did not run the same twice from the same moment, as found by
 * `Session.syncTest`. It is a defect: the tick read something a rewind doesn't
 * put back, so a session that runs ahead would resimulate it differently
 * from how its peers ran it.
 *
 * @category Errors
 */
export class RewindDiverged extends Data.TaggedError("RewindDiverged")<{
  /** The tick that ran differently. */
  readonly tick: number;
  /**
   * The system after which the world's hash first differed. Undefined when it
   * differed before the first system ran: in the handler of an action queued
   * for the tick, or in a hook of a state.
   */
  readonly system: string | undefined;
}> {
  override get message(): string {
    const where =
      this.system === undefined
        ? "before its first system ran, in the handler of an action queued for it or in a hook of a state"
        : `after system "${this.system}" ran`;
    return `Tick ${this.tick} ran differently the second time from the same moment: the world's hash was not the same ${where}. It read something a rewind doesn't put back, so a session that runs ahead would run it again differently from its peers. Look for state kept outside the world, in a service, a plugin's own variable or a module, or for a value from outside the game, such as Date.now() or Math.random(). Keep it in the world: in a component, a singleton or a state.`;
  }
}

/**
 * A session of one that runs each tick twice, from `Session.syncTest`, with
 * its app. It is stepped by hand or by a driver.
 *
 * `E` is what a tick of its app can fail with, and `HU` the actions its
 * handlers accept.
 *
 * @category Models
 */
export interface SyncTest<E = never, HU = never> {
  /** The app it steps, as a session's is. */
  readonly app: App.Steered<E, HU>;
  /**
   * Runs the input stage, then the tick twice from the same moment, and fails
   * with `Save.SaveRefused` when the game can't be captured before it, in which
   * case the tick doesn't run. Throws `RewindDiverged` when the two runs differ.
   */
  readonly tickExit: (delta: number) => Exit.Exit<void, E | Save.SaveRefused>;
  /** Like `tickExit`, but throws what it fails with. */
  readonly tick: (delta: number) => void;
  /** The app's frame stage. */
  readonly frame: (alpha: number, delta?: number) => void;
  /** How many ticks it has run twice. */
  readonly checked: number;
}

/** Steps an app that was taken over, each tick twice. */
const twice = <E, HU>(
  app: App.App<E, HU>,
  reins: Reins<E>
): SyncTest<E, HU> => {
  let checked = 0;
  const tickExit = (delta: number): Exit.Exit<void, E | Save.SaveRefused> => {
    const heard = app.inputExit();
    if (Exit.isFailure(heard)) {
      return heard;
    }
    const moment = Timeline.capture(app, { stages: true });
    if (Exit.isFailure(moment)) {
      return Exit.failCause(moment.cause);
    }
    // The world's hash before the first system, and after each one, by
    // where it was taken. A run that failed has none from there on.
    const run = (): {
      readonly exit: Exit.Exit<void, E>;
      readonly hashes: number[];
      readonly systems: (string | undefined)[];
    } => {
      const hashes: number[] = [];
      const systems: (string | undefined)[] = [];
      const exit = reins.tickExit(delta, (system) => {
        hashes.push(app.world.hash());
        systems.push(system);
      });
      return { exit, hashes, systems };
    };
    const first = run();
    Timeline.rewind(app, moment.value, { again: true });
    const second = run();
    const once = first.hashes;
    const again = second.hashes;
    const length = Math.min(once.length, again.length);
    let at = 0;
    while (at < length && once[at] === again[at]) {
      at++;
    }
    if (at < length || once.length !== again.length) {
      throw new RewindDiverged({
        tick: app.time.tick,
        // Where the two first differ, or where the run that went further
        // went on to and the other did not.
        system: (once.length > again.length ? first : second).systems[at],
      });
    }
    checked++;
    return second.exit;
  };
  return {
    app,
    tickExit,
    tick(delta) {
      const exit = tickExit(delta);
      if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
      }
    },
    frame: app.frame,
    get checked() {
      return checked;
    },
  };
};

/**
 * Makes a session of one that checks that each tick of a game runs the same
 * when a rewind runs it again, as a session that runs ahead does. Each tick
 * is run, rewound and run again from the same moment, and the world's hash is
 * compared before the first system and after each one. `tick` throws
 * `RewindDiverged`, naming the first system after which they differ.
 *
 * This finds, in one app, what a tick reads that a rewind doesn't put back:
 * state kept in a service, a plugin or a module, or a value from outside the
 * game. In a real session it shows only once two peers drift apart.
 *
 * The rest of the game sees each tick once: the frame and input stages hear
 * each event once and see each change once, and the action log and the
 * recording hold the tick once. An action enqueued on `test.app` is queued
 * for the next tick, as in an app no one steps for it.
 *
 * It costs a capture of the game, a rewind, a second run of the tick and a
 * world hash per system, each tick, so use it in tests.
 *
 *   const test = yield* Session.syncTest(Duel, { seed: 1 })
 *   for (let i = 0; i < 600; i++) test.tick(1 / 60)
 *
 * @category Constructors
 */
export const syncTest = <
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
  SV extends Save.Save | undefined = undefined,
>(
  game: App.Game<S, H, P>,
  start?: App.StartOptions<SV>
): Effect.Effect<
  SyncTest<App.TickError<S, P>, App.AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | (SV extends Save.Save ? Save.LoadRefused : never),
  Scope.Scope | App.External<S, H, P>
> => {
  const given: App.StartOptions<SV> = start ?? {};
  return Effect.map(build(game, given), ({ app, take }) => {
    // What is enqueued from outside is queued for the next tick, as it was.
    const reins: Reins<App.TickError<S, P>> = take((name, payload) => {
      reins.deliver(name, payload);
    });
    return twice(app, reins);
  });
};
