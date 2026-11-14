/**
 * Co-op clients: one player's side of a co-op game, running, as an app drives it.
 *
 * Each `Coop` class is the key of one: `yield* MyCoop` gives it. It runs the lobby over the
 * signalling worker and WebRTC, then a lockstep run stepped on a worker's timer, and a view drawn
 * on animation frames while attached. A hidden tab keeps stepping at full rate, so it holds no one
 * up, and draws nothing, since the browser runs no animation frames for it. Its
 * methods are traced under the declared name (`SumCoop.host`, `SumCoop.send` and so on), as an
 * engine's are. `attach` and `listen` have the shapes of `arcadekit/foldkit`'s
 * `EngineEntry.Attachable`, so an app mounts the client as it mounts an engine.
 *
 * @since 0.7.0
 */
import { Inspectable, Pipeable, Predicate } from "effect";
import type { Effect, Scope, Types } from "effect";

import type { AttachError, GameCrashed } from "../../game/browser";
import type { CommandDropped, RefusalFor } from "../../game/index";
import type * as CoopEvent from "./coop-event";

const TypeId = "~arcadekit/net/browser/CoopClient";

/**
 * What a client's `debug` reads of its current seat's run, for tests and debugging.
 *
 * **When to use**
 *
 * In a test of a co-op game, to compare two clients' runs, and in a debugging overlay.
 *
 * **Details**
 *
 * `error` is the lockstep session's stop's message, or null. `hashes` holds the last 32 state
 * hashes, by step. `slot` is the local player's, -1 with no seat. `state` is the run's state, or
 * null with no run: read it, never change it.
 *
 * **Example** (A client with no seat)
 *
 * ```ts
 * import type { CoopClient } from "arcadekit/net/browser";
 *
 * const idle: CoopClient.Debug<null> = { stepIndex: 0, error: null, hashes: {}, slot: -1, state: null };
 * idle.slot; // => -1
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Debug<State> {
  readonly stepIndex: number;
  /** The lockstep session's stop error, or null. */
  readonly error: string | null;
  /** The last 32 state hashes, by step. */
  readonly hashes: Readonly<Record<number, number>>;
  /** The local player's slot; -1 with no seat. */
  readonly slot: number;
  /** The run's state, or null with no run. Read it; never change it. */
  readonly state: State | null;
}

/**
 * One player's side of a co-op game, running: what `yield* MyCoop` gives.
 *
 * **When to use**
 *
 * In an app's Commands and Subscriptions, to host, join, choose, start, send and leave, and to
 * mount it as an engine is mounted. Name it to type a function that takes a client; a test of
 * an app makes a stand-in with `make`.
 *
 * **Details**
 *
 * - `host(pick)` hosts a room with lobby pick `pick`, after interrupting the seat before it, and
 *   `join(code, pick)` joins the room with join code `code`. Each returns at once: the lobby, the
 *   run and any failure are reported through `listen`, and none of them before every earlier
 *   seat has closed.
 * - `choose(pick)` changes the local player's lobby pick; it does nothing once the run has
 *   started. `start` starts the run if the lobby's `canStart` is true, and does nothing
 *   otherwise, or for a guest. A guest that links between the host's start and the worker's
 *   confirmation can't make the run larger than the game's `maxPlayers`: the last to join fail
 *   with `leftOut`.
 * - `send(command)` sends a command to the run as the local player and waits for the rules'
 *   answer, as `Game.Engine`'s `send` does. The command rides the player's next step, and every
 *   peer's rules take or refuse it alike at that step. It succeeds when this player's own took
 *   it, fails with the rejection they refused it with, and fails with `CommandDropped` when they
 *   gave no answer: there is no run (`noRun`: no seat, or still its lobby), or the run stopped,
 *   or this player left, first (`runEnded`). When it succeeds or is refused, `listen` has heard
 *   what the command's step reported. Interrupt it to take the command back while it has no step
 *   yet.
 * - `leave` leaves the lobby or the run, and returns once its room, links, session and ticker
 *   have closed, with those of any earlier seat. No event of that seat follows.
 * - `attach(element)` draws the run into `element` on every frame, and reads input from it, for
 *   as long as it runs; with no run it draws `render(null, t)`. It fails with what the engine's
 *   `uses` fail with, with `AttachError` if the view or the input source can't be made, and with
 *   `GameCrashed` if a frame throws, each after leaving: a seat left running undrawn would hold
 *   the others up. Interrupt it to detach, which doesn't leave. One attach at a time: a second
 *   dies.
 * - `listen(onEvent)` hears everything the current seat reports while the scope is open, in one
 *   order: the client's own events and the run's. A seat hears its run from the start.
 * - `debug()` reads the current seat's run.
 *
 * **Example** (A stand-in client that records what it is asked)
 *
 * ```ts
 * import { CoopClient } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const asked: string[] = [];
 * const client = CoopClient.make({
 *   host: (pick) =>
 *     Effect.sync(() => {
 *       asked.push(`host ${pick}`);
 *     }),
 *   join: (code, pick) =>
 *     Effect.sync(() => {
 *       asked.push(`join ${code} ${pick}`);
 *     }),
 *   choose: () => Effect.void,
 *   start: Effect.void,
 *   send: () => Effect.void,
 *   leave: Effect.void,
 *   attach: () => Effect.never,
 *   listen: () => Effect.void,
 *   debug: () => ({ stepIndex: 0, error: null, hashes: {}, slot: -1, state: null }),
 * });
 * Effect.runSync(client.host("red"));
 * asked; // => ["host red"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface CoopClient<State, Event, Command, E, Refusals>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** Hosts a room with lobby pick `pick`, after interrupting the seat before it. Returns at once. */
  readonly host: (pick: string) => Effect.Effect<void>;
  /** Joins the room with join code `code`, with lobby pick `pick`, as `host` opens one. */
  readonly join: (code: string, pick: string) => Effect.Effect<void>;
  /** Changes the local player's lobby pick. Does nothing once the run has started. */
  readonly choose: (pick: string) => Effect.Effect<void>;
  /** Host: starts the run with everyone linked, if the lobby's `canStart` is true. */
  readonly start: Effect.Effect<void>;
  /** Sends a command to the run as the local player, and waits for the rules' answer. */
  readonly send: <C extends Command>(
    command: C
  ) => Effect.Effect<void, RefusalFor<Refusals, C> | CommandDropped>;
  /** Leaves the lobby or the run, and returns once its seat has closed. */
  readonly leave: Effect.Effect<void>;
  /** Draws the run into `element` on every frame, and reads input from it, until interrupted. */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<never, AttachError | GameCrashed | E>;
  /** Hears everything the current seat reports while the scope is open. */
  readonly listen: (
    onEvent: (event: CoopEvent.CoopEvent<Event>) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Reads the current seat's run, for tests and debugging. */
  readonly debug: () => Debug<State>;
}

/** What a client is made from: its methods. */
type Methods<State, Event, Command, E, Refusals> = Omit<
  CoopClient<State, Event, Command, E, Refusals>,
  typeof TypeId | keyof Pipeable.Pipeable | keyof Inspectable.Inspectable
>;

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: CoopClient<unknown, unknown, unknown, unknown, unknown>) {
    const { stepIndex, slot } = this.debug();
    return { _id: "CoopClient", slot, stepIndex };
  },
};

/**
 * Checks whether a value is a Co-op client.
 *
 * **When to use**
 *
 * Narrow an unknown value before driving it.
 *
 * **Example** (Recognising a client)
 *
 * ```ts
 * import { CoopClient } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const client = CoopClient.make({
 *   host: () => Effect.void,
 *   join: () => Effect.void,
 *   choose: () => Effect.void,
 *   start: Effect.void,
 *   send: () => Effect.void,
 *   leave: Effect.void,
 *   attach: () => Effect.never,
 *   listen: () => Effect.void,
 *   debug: () => ({ stepIndex: 0, error: null, hashes: {}, slot: -1, state: null }),
 * });
 * CoopClient.isCoopClient(client); // => true
 * CoopClient.isCoopClient({ host: () => Effect.void }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isCoopClient = (
  value: unknown
): value is CoopClient<unknown, unknown, unknown, unknown, unknown> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a client from its methods.
 *
 * **When to use**
 *
 * In a test of an app's Commands, to stand in for a `Coop`'s client and record what the app
 * asks of it. An app's own client comes from its `Coop`'s `layer`, which makes it so.
 *
 * **Details**
 *
 * `make` calls none of them: each method of the client is what it was given. A client prints its
 * slot and its step.
 *
 * **Example** (A client in a lobby)
 *
 * ```ts
 * import { CoopClient } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const client = CoopClient.make({
 *   host: () => Effect.void,
 *   join: () => Effect.void,
 *   choose: () => Effect.void,
 *   start: Effect.void,
 *   send: () => Effect.void,
 *   leave: Effect.void,
 *   attach: () => Effect.never,
 *   listen: () => Effect.void,
 *   debug: () => ({ stepIndex: 0, error: null, hashes: {}, slot: 0, state: null }),
 * });
 * client.toJSON(); // => { _id: "CoopClient", slot: 0, stepIndex: 0 }
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <State, Event, Command, E, Refusals>(
  methods: Methods<State, Event, Command, E, Refusals>
): CoopClient<State, Event, Command, E, Refusals> =>
  Object.assign(
    Object.create(Proto) as Types.Mutable<
      CoopClient<State, Event, Command, E, Refusals>
    >,
    methods
  );
