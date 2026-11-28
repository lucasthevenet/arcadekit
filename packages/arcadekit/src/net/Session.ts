/**
 * A session is one peer of a game played on several machines. It makes its
 * app, steps it, and exchanges with the other peers what their players do.
 *
 * Every peer runs the same simulation, and peers exchange only the actions
 * their players issue, each stamped with the tick it applies on. Every peer
 * applies the same actions on the same ticks in the same order, so all of
 * them stay in the same game.
 *
 *   const session = yield* Session.make(Duel, {
 *     seed: 1,
 *     me: "ada",
 *     others: ["grace"],
 *     hz: 60,
 *   })
 *
 *   yield* session.app.enqueue(Move, { dx: 1 })   // applied on every peer
 *
 *   // What a transport and a driver usually do for it:
 *   session.receive(message)                  // a message from another peer
 *   yield* session.tick()                     // true if the tick ran, false if it waits
 *   for (const message of session.outgoing()) send(message)
 *
 * Everything that enters the app from outside goes through the session:
 * `session.app.enqueue`, what the input stage reads of the devices, and a UI
 * button. Each goes into this peer's message for the tick `delay` ticks
 * ahead, and every peer applies it on that tick, this one included. A game issues input as it does
 * with one player. What the simulation issues itself with `Actions`, such as
 * a bot's move, isn't sent, since every peer's simulation issues it.
 *
 * `session.app` is an `App.Steered`, with no `tick` and no `dispatch`, since
 * either would advance this peer's game alone.
 *
 * A session runs each tick without waiting for the network, up to `ahead`
 * ticks past what every peer has sent. It predicts that the peers it hasn't
 * heard from did nothing, as they do on most ticks. When a message with
 * actions arrives for a tick that already ran, the session rewinds to before
 * that tick and resimulates with what it now knows. With `ahead: 0` it
 * predicts nothing, and runs a tick only once every peer has sent its actions
 * for it. That is lockstep.
 *
 * Every peer ends on the same game, since each applies every action on the
 * tick it is stamped with, whenever it heard of it. On the way, a peer that
 * runs ahead may see a move accepted that is refused once the message it was
 * missing arrives.
 *
 * Before each uncertain tick, the session captures a moment with
 * `Timeline.capture`. It goes back with `Timeline.rewind` given
 * `{ again: true }`, so the frame and input stages hear an event once however
 * often its tick runs. What the frame stage did of a prediction stays done: a
 * sound for a move that is then refused has played, and a UI has shown its
 * score. A frame system that must show only final ticks checks
 * `session.confirmed`. After each rewind, the change queries of the frame
 * and input stages visit only the entities that the ticks given up or the
 * ticks run again changed, spawned or despawned. A rewind restores only
 * what a save holds. A tick that reads anything else runs differently when
 * it is resimulated, and the peers drift apart.
 * `Session.syncTest` finds such a tick in a test, with no second peer.
 *
 * A session holds no socket and no timer. A transport carries its messages,
 * as the bytes `Message.encode` writes, and `Transport.connect` joins the
 * two. Every message says how far its peer has heard the others, so a
 * session keeps what it sent until every other peer has heard it, and
 * `resend` returns it when a peer comes back after its socket dropped.
 *
 * A session's first message says what it was made with, `Message.Made`. A
 * session that hears another was made otherwise stops with `Drift.Unlike`,
 * and one whose world hashed differently from another's at the same tick
 * stops with `Drift.Drifted`. `Drift` says how they find it.
 */
import { Data, Effect } from "effect";

import type * as App from "../App.ts";
import type { Paced } from "../Driver.ts";
import { add, addString, finish } from "../ecs/hash.ts";
import { build } from "../internal/build.ts";
import type { Reins } from "../internal/build.ts";
import { partsOf } from "../internal/parts.ts";
import { flatten } from "../internal/plugins.ts";
import * as Plugin from "../Plugin.ts";
import type * as Save from "../Save.ts";
import * as Timeline from "../Timeline.ts";
import type * as Drift from "./Drift.ts";
import { build as buildPeer } from "./internal/peer.ts";
import type { Message } from "./Message.ts";

/**
 * Options for a session: how its game starts, as `App.make` takes it, this
 * peer, the others, and how far it sends and runs ahead.
 *
 * @typeParam Me This peer's name, as the compiler knows it, so that
 *   `Session.make` can refuse a name given twice.
 * @typeParam Others The other peers' names, as the compiler knows them.
 * @category Options
 */
export interface Options<
  SV extends Save.Save | undefined = undefined,
  Me extends string = string,
  Others extends readonly string[] = readonly string[],
> extends App.StartOptions<SV> {
  /** This peer's name. */
  readonly me: Me;
  /**
   * The names of the other peers of the game, in any order. Each peer is
   * given its own name as `me` and every other peer's here, so all of them
   * play with the same names.
   */
  readonly others: Others;
  /**
   * The ticks per second the game runs at, the same on every peer, as
   * `Driver.run` takes it for a game of one.
   */
  readonly hz: number;
  /**
   * How many ticks pass between issuing an action and applying it, a whole
   * number from 0 up. Each peer can use its own. A message has that long to
   * reach the other peers before they have to wait for it or go back for it.
   *
   * Defaults to 0 for a session that runs ahead, so a player's own move
   * applies on the next tick. A delay of a tick or two spares the other peers
   * a rewind for every move, at the cost of that much input lag for the local
   * player. Defaults to 2 for a session whose `ahead` is 0, which would
   * otherwise wait for the network on every tick.
   */
  readonly delay?: number;
  /**
   * How many ticks the session may run past what every peer has sent.
   * Defaults to 8. A peer that far ahead waits. It is also the furthest a
   * rewind may go back, and the most moments kept for it. With 0, the session
   * plays in lockstep: it never runs ahead, captures nothing and never
   * rewinds.
   */
  readonly ahead?: number;
}

// A name the compiler only knows as `string` could be any: left out.
type Named<N extends string> = string extends N ? never : N;

type Twice<
  Me extends string,
  Others extends readonly string[],
  Seen extends string,
  Found,
> = Others extends readonly [
  infer Name extends string,
  ...infer Rest extends readonly string[],
]
  ? [Name] extends [Seen]
    ? Twice<
        Me,
        Rest,
        Seen,
        | Found
        | ([Name] extends [Named<Me>]
            ? `"${Name}" is me, and among the others too. Name only the other peers in others.`
            : `"${Name}" is among the others twice. Every peer has a name of its own: name each other peer once.`)
      >
    : Twice<Me, Rest, Seen | Named<Name>, Found>
  : Found;

/**
 * The names a session is given twice, as a union of messages: this peer's
 * name among the others, or two others with one name. It is `never` when
 * every name is distinct. A name the compiler knows only as `string`, and a
 * list of others that isn't a tuple, are left out. `Session.make` refuses its
 * options with this message, at compile time.
 *
 * @internal
 */
export type Repeated<
  Me extends string,
  Others extends readonly string[],
> = Twice<Me, Others, Named<Me>, never>;

/**
 * What `Session.make` adds to its options: nothing when every name is its
 * own, and otherwise a property nobody can give, whose type is the message.
 */
type Distinct<Me extends string, Others extends readonly string[]> = [
  Repeated<Me, Others>,
] extends [never]
  ? unknown
  : { readonly names: Repeated<Me, Others> };

/**
 * One peer of a multiplayer game, with its app: what a driver steps, and
 * what a transport carries messages for. A driver steps it at its own `hz`,
 * and takes neither `hz` nor `ticks` for it:
 * `Driver.frames(yield* Transport.connect(session))`.
 *
 * @typeParam E What a tick of its app can fail with.
 * @typeParam HU The actions its handlers accept.
 * @category Models
 */
export interface Session<E = never, HU = never> extends Paced<
  E | Drift.Unlike | Drift.Drifted | Save.Refused
> {
  /**
   * The session's app, which the session steps: its world to read, its
   * `enqueue` for what this peer's player does, its saves and its recordings.
   */
  readonly app: App.Steered<E, HU>;
  /** This peer's name. */
  readonly me: string;
  /**
   * Every peer of the game, this one too, in the order their actions are
   * applied.
   */
  readonly peers: readonly string[];
  /** The ticks per second it runs at. */
  readonly hz: number;
  /** How many ticks pass between issuing an action and applying it. */
  readonly delay: number;
  /** How many ticks the session may run past what every peer has sent. */
  readonly ahead: number;
  /**
   * Receives a message from another peer. Messages may arrive in any order and
   * more than once. It drops a message it already has, and one from a name
   * that isn't a peer of the game. A message with actions for a tick that ran
   * without it makes the next tick go back and run again from there. What a
   * first message says its peer was made with is compared with what this one
   * was made with, whoever sent it.
   */
  readonly receive: (message: Message) => void;
  /**
   * Returns the messages to send to every other peer, and removes them, so
   * the next call returns only newer ones. Every message must arrive, in any
   * order.
   */
  readonly outgoing: () => readonly Message[];
  /**
   * Returns every message this peer has sent that some other peer hasn't said
   * it heard, to send again when a peer joins the room again after its socket
   * dropped, or this one does. It keeps them until every other peer has heard
   * them. A peer drops a message that arrives twice.
   */
  readonly resend: () => readonly Message[];
  /**
   * Runs the next tick if this peer has every peer's message for it, and
   * succeeds with whether it ran. First it runs the input stage, as a driver
   * does before an app's tick, and what the devices issue goes into the
   * message for the tick `delay` ticks ahead. Input issued while the session
   * waits for a peer goes into its next message.
   *
   * A session that runs ahead runs a tick before every message for it is in,
   * up to `ahead` ticks past what every peer has sent. Before that, it goes
   * back over the ticks that a message with actions has since arrived for.
   *
   * The tick simulates `1 / hz` seconds. It fails with a system's error,
   * `Drift.Unlike` once a peer has said it was made otherwise,
   * `Drift.Drifted` once the peers have drifted apart, or `Save.Refused`
   * when the game can't be captured before a tick it runs ahead. The tick
   * doesn't run then.
   */
  readonly tick: () => Effect.Effect<
    boolean,
    E | Drift.Unlike | Drift.Drifted | Save.Refused
  >;
  /** The app's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => Effect.Effect<void, E>;
  /**
   * Why the session stopped, once it has: a peer was made otherwise than this
   * one, or its world hashed differently from this one's at the same tick.
   * Every later tick fails with it.
   */
  readonly drifted: Drift.Unlike | Drift.Drifted | undefined;
  /** The peers whose message the next tick is still waiting for. */
  readonly waitingFor: readonly string[];
  /**
   * The number of final ticks: every peer's messages for them have arrived, and
   * the game has run with them. Later ticks are predictions, and may be
   * resimulated differently. The frame stage draws and plays every tick as
   * it runs, final or not: a system of it that must show only what is final
   * checks this.
   */
  readonly confirmed: number;
  /**
   * How many ticks this peer is ahead of the peer furthest behind it. It is
   * half of how far ahead this peer finds itself by that peer's last message,
   * less how far ahead that peer found itself, so that the time a message
   * takes cancels out. It is below 0 when every other peer is ahead. A driver
   * runs a session's ticks at half their rate while its lead is 2 or more, so
   * that a peer whose clock runs fast neither waits for the others nor makes
   * them go back.
   */
  readonly lead: number;
  /** What a debug overlay shows of how the session is doing. */
  readonly stats: {
    /**
     * How many messages it holds, its own among them, for ticks that haven't
     * run or aren't final yet.
     */
    readonly held: number;
    /**
     * How many moments the session holds to rewind to: one for each uncertain
     * tick it ran, so never more than `ahead`. Each is a snapshot of the whole
     * world. A tick every peer has already sent actions for isn't captured.
     */
    readonly kept: number;
    /** How many messages this peer keeps that some other peer hasn't heard. */
    readonly unheard: number;
    /**
     * How many of its hash checks are waiting for a peer's hash. A hash check
     * that is never answered, because no other peer records one at that tick,
     * is discarded after 600 ticks.
     */
    readonly unanswered: number;
    /** How many times the session has rewound. */
    readonly rewinds: number;
    /** How many ticks the session has resimulated in total. */
    readonly resimulated: number;
  };
  /**
   * Closes the session's app, as `app.close` closes an app. Whatever runs
   * the session closes it. The connection that `Transport.connect` makes
   * closes it when the connection is closed.
   */
  readonly close: Effect.Effect<void>;
}

/** Orders text by code unit, which is the same on every machine. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns a hash of what a game simulates, as `Message.Made`'s `game` says:
 * the systems of the tick in the order they run, the hooks of its states, the
 * actions it handles and its version.
 */
const simulates = (
  game: App.Game<App.Systems, App.Handlers, App.Plugins>,
  systemOrder: readonly string[]
): number => {
  const plugins = flatten(game.plugins);
  const systems = [
    ...plugins.flatMap((plugin) => plugin.systems),
    ...game.systems,
  ];
  const hooks = systems
    .filter((system) => system.trigger !== undefined)
    .map(
      ({ name, trigger }) =>
        `${name}\n${trigger!.state.name}\n${trigger!.on}\n${trigger!.value}`
    )
    .toSorted(byCode);
  const handled = [
    ...plugins.flatMap((plugin) => plugin.handlers),
    ...game.handlers,
  ]
    .map((handler) => handler.action.name)
    .toSorted(byCode);
  let h = add(0, game.version);
  for (const list of [systemOrder, hooks, handled]) {
    h = add(h, list.length);
    for (const name of list) {
      h = addString(h, name);
    }
  }
  return finish(h);
};

/**
 * Makes a session and the app it steps. Every peer of the game makes its
 * session alike: with the same game, the same seed or save, the same `hz`
 * and the same names.
 *
 * The session begins at whatever tick its app does, so a game can continue
 * from a save every peer loaded. It fails with what `App.make` fails with.
 *
 * A name given twice, as `me` and among `others` or twice among `others`,
 * does not compile, and the error says which.
 *
 * **Gotchas**
 *
 * - It throws when the options can't describe a game: a name given twice that
 *   the compiler knows only as `string`, a `delay` or an `ahead` that isn't a
 *   whole number of ticks, or an `hz` that isn't a finite number above 0.
 * - A payload its schema rejects has no JSON form to send. Only the issuing
 *   peer refuses it, and the others never see it.
 * - Each peer is given its own game, seed, `hz` and names. Its first
 *   message says what it was made with: what the game simulates, the
 *   `hz`, the names, and the tick the game begins at. A peer made
 *   otherwise stops every peer that hears it with `Drift.Unlike`, before any
 *   of them runs a tick it is sure of. What the game simulates is compared
 *   by name: the systems of the tick in the order they run, the hooks of its
 *   states, the actions it handles, and its version.
 * - Another seed, another save of the same tick, or two systems of one name
 *   that do different things are found by the worlds' hashes instead, as
 *   `Drift.Drifted`: a seed or a save at the hash check every peer takes as
 *   it begins, and a system once it has changed a world.
 *
 * @category Constructors
 */
export const make = <
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
  SV extends Save.Save | undefined = undefined,
  Me extends string = string,
  const Others extends readonly string[] = readonly string[],
>(
  game: App.Game<S, H, P>,
  options: Options<SV, Me, Others> & Distinct<Me, Others>
): Effect.Effect<
  Session<App.TickError<S, P>, App.AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | (SV extends Save.Save ? Save.LoadRefused : never),
  App.External<S, H, P>
> =>
  Effect.flatMap(build(game, options), ({ app, take }) =>
    // Options that describe no game throw, and the app made for them goes.
    Effect.onError(
      Effect.sync((): Session<App.TickError<S, P>, App.AllHandlers<H, P>> => {
        const ahead = options.ahead ?? 8;
        return buildPeer(app, take, {
          game: simulates(game, app.systemOrder),
          me: options.me,
          others: options.others,
          hz: options.hz,
          // A session that predicts nothing would wait for the network on
          // every tick with no delay.
          delay: options.delay ?? (ahead === 0 ? 2 : 0),
          ahead,
        });
      }),
      () => app.close
    )
  );

/**
 * A tick ran differently the second time from the same moment, as
 * `Session.syncTest` found. It is a defect in the game. The tick read
 * something a rewind doesn't put back, so a session that runs ahead would
 * resimulate it differently from how its peers ran it.
 *
 * @category Errors
 */
export class RewindDiverged extends Data.TaggedError("SessionRewindDiverged")<{
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
 * A session of one, from `Session.syncTest`, that runs each tick twice, with
 * its app. A test steps it by hand or with a driver.
 *
 * @typeParam E What a tick of its app can fail with.
 * @typeParam HU The actions its handlers accept.
 * @category Models
 */
export interface SyncTest<E = never, HU = never> {
  /** The app it steps, as a session's is. */
  readonly app: App.Steered<E, HU>;
  /**
   * Runs the input stage, then the tick twice from the same moment. It fails
   * with what the game's systems fail with, with `Save.Refused` when the
   * game can't be captured before the tick, and the tick doesn't run then,
   * and with `RewindDiverged` when the two runs differ.
   */
  readonly tick: (
    delta: number
  ) => Effect.Effect<void, E | Save.Refused | RewindDiverged>;
  /** The app's frame stage, as `app.frame` runs it. */
  readonly frame: (alpha?: number, delta?: number) => Effect.Effect<void, E>;
  /** How many ticks it has run twice. */
  readonly checked: number;
  /** Closes its app, as `app.close` closes an app. */
  readonly close: Effect.Effect<void>;
}

/** Steps an app that was taken over, each tick twice. */
const twice = <E, HU>(
  app: App.App<E, HU>,
  reins: Reins<E>
): SyncTest<E, HU> => {
  let checked = 0;
  // The world's hash before the first system, and after each one, by
  // where it was taken. A run that failed has none from there on.
  const run = Effect.fnUntraced(function* (delta: number) {
    const hashes: number[] = [];
    const systems: (string | undefined)[] = [];
    const exit = yield* Effect.exit(
      reins.tick(delta, (system) => {
        hashes.push(partsOf(app).world._fullHash());
        systems.push(system);
      })
    );
    return { exit, hashes, systems };
  });
  const tick = Effect.fnUntraced(function* (delta: number) {
    yield* app.input();
    const moment = yield* Timeline.capture(app, { stages: true });
    const first = yield* run(delta);
    yield* Timeline.rewind(app, moment, { again: true });
    const second = yield* run(delta);
    const once = first.hashes;
    const again = second.hashes;
    const length = Math.min(once.length, again.length);
    let at = 0;
    while (at < length && once[at] === again[at]) {
      at++;
    }
    if (at < length || once.length !== again.length) {
      return yield* new RewindDiverged({
        tick: app.time.tick,
        // Where the two first differ, or where the run that went further
        // went on to and the other did not.
        system: (once.length > again.length ? first : second).systems[at],
      });
    }
    checked++;
    return yield* second.exit;
  });
  return {
    app,
    tick,
    frame: app.frame,
    get checked() {
      return checked;
    },
    close: app.close,
  };
};

/**
 * Makes a session of one that checks that each tick of a game runs the same
 * when a rewind runs it again, as in a session that runs ahead. It runs each
 * tick, rewinds, and runs the tick again from the same moment. It compares
 * the world's hash before the first system and after each one, and `tick`
 * fails with `RewindDiverged`, naming the first system after which the
 * hashes differ.
 *
 *   const test = yield* Session.syncTest(Duel, { seed: 1 })
 *   for (let i = 0; i < 600; i++) yield* test.tick(1 / 60)
 *
 * The rest of the game sees each tick once. The frame and input stages hear
 * each event once and see each change once, and the action log and the
 * recording hold the tick once. An action enqueued on `test.app` is queued
 * for the next tick, as in an app that isn't a session's.
 *
 * **When to use**
 *
 * Use in a test, to find what a tick reads that a rewind doesn't put back:
 * state kept in a service, a plugin or a module, or a value from outside the
 * game. In a real session, such a read shows only once two peers drift apart.
 * Each tick costs a capture of the game, a rewind, a second run of the tick
 * and a world hash per system.
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
  App.External<S, H, P>
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
