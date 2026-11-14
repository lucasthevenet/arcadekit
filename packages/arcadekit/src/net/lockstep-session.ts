/**
 * Lockstep sessions: one peer's side of a lockstep run, as plain code a caller ticks.
 *
 * Every peer steps the same `Game.Simulation` on the inputs the host confirms for each step.
 * A session is a host of the declared simulation, as `Game.Loop` is: it steps it
 * through a loop of its own, reads from its declared `Game.PlayerInputs` what one player sends,
 * and carries a player's commands to every peer's rules at one step. It knows no network: it talks
 * through a `Transport`. In an Effect program, `ScopedLockstepSession` makes one its scope owns.
 *
 * Plain on purpose: a tick decides each step's input and runs the steps, so it gives
 * the same bits on every peer and finishes in the call that ticks it, and its time comes in as an
 * argument, so it reads no clock of its own. Its resends and its stall timers are the tick's own
 * work, and its listeners are called inside the tick, before the senders it answered.
 *
 * @since 0.7.0
 */
import { Inspectable, Option, Predicate, Result, Schema } from "effect";
import type { Cause } from "effect";
import { pipeArguments } from "effect/Pipeable";
import type { Pipeable } from "effect/Pipeable";

import { CommandDropped, makeLoop } from "../game/index";
import type {
  Loop,
  PlayerInputOf,
  PlayersSimulation,
  RefusalFor,
  Settled,
  StepInput,
} from "../game/index";
import { MAX_STEP_COMMANDS, payloadCodec } from "./internal/codec";
import type {
  ConfirmedStep,
  PayloadCodec,
  PlayerStepInput,
  StepPayload,
} from "./internal/codec";
import { combinePlayerInputs } from "./internal/player-inputs";
import type { PeerId, Transport } from "./transport";

const TypeId = "~arcadekit/net/LockstepSession";

const RemovedWhySchema: Schema.Literals<readonly ["stalled", "badInput"]> =
  Schema.Literals(["stalled", "badInput"]);

/**
 * Why the host removed a player: stepping stalled on it (`stalled`), or its input didn't decode
 * (`badInput`).
 *
 * **When to use**
 *
 * To tell a removed player why, from a `removed` stop's `why`.
 *
 * **Example** (Why a player was removed)
 *
 * ```ts
 * import type { LockstepSession } from "arcadekit/net";
 *
 * const why: LockstepSession.RemovedWhy = "stalled";
 * why === "stalled" ? "too slow" : "bad input"; // => "too slow"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type RemovedWhy = typeof RemovedWhySchema.Type;

type StopReasonSchema = Schema.Union<
  readonly [
    Schema.Struct<{
      readonly kind: Schema.Literal<"desync">;
      readonly step: Schema.Number;
      readonly hashes: Schema.$Record<Schema.String, Schema.Number>;
    }>,
    Schema.Struct<{
      readonly kind: Schema.Literal<"contentMismatch">;
      readonly hostContentHash: Schema.String;
      readonly localContentHash: Schema.String;
    }>,
    Schema.Struct<{
      readonly kind: Schema.Literal<"removed">;
      readonly peer: Schema.String;
      readonly step: Schema.Number;
      readonly why: typeof RemovedWhySchema;
    }>,
    Schema.Struct<{
      readonly kind: Schema.Literal<"badInput">;
      readonly player: Schema.String;
      readonly step: Schema.Number;
      readonly issue: Schema.String;
    }>,
    Schema.Struct<{
      readonly kind: Schema.Literal<"hostLost">;
      readonly host: Schema.String;
      readonly silentMs: Schema.Number;
    }>,
  ]
>;

const StopReasonSchema: StopReasonSchema = Schema.Union([
  // Two peers' states differ: their hashes of the state after `step` steps don't match. `hashes`
  // has each peer's hash of that state, for the peers that reported one.
  Schema.Struct({
    kind: Schema.Literal("desync"),
    step: Schema.Number,
    hashes: Schema.Record(Schema.String, Schema.Number),
  }),
  // The host plays different content, so this peer refused to start.
  Schema.Struct({
    kind: Schema.Literal("contentMismatch"),
    hostContentHash: Schema.String,
    localContentHash: Schema.String,
  }),
  // The host removed this peer's player at `step`: after stepping stalled on its input for
  // `dropAfterMs` (`stalled`), or because an input it sent didn't decode (`badInput`).
  Schema.Struct({
    kind: Schema.Literal("removed"),
    peer: Schema.String,
    step: Schema.Number,
    why: RemovedWhySchema,
  }),
  // `player`'s input for `step` didn't decode on this peer: in a step from the host, or, on the
  // host, its own. `issue` is what the one-player Schema said is wrong with it.
  Schema.Struct({
    kind: Schema.Literal("badInput"),
    player: Schema.String,
    step: Schema.Number,
    issue: Schema.String,
  }),
  // Nothing came from the host for `silentMs`. With no host, no step can be decided.
  Schema.Struct({
    kind: Schema.Literal("hostLost"),
    host: Schema.String,
    silentMs: Schema.Number,
  }),
]);

/**
 * Why a lockstep session stopped, by `kind`:
 *
 * - `desync`: two peers' states differ. Their hashes of the state after `step` steps don't match,
 *   and `hashes` has each peer's, for the peers that reported one.
 * - `contentMismatch`: the host plays different content, so this peer refused to start.
 * - `removed`: the host removed this peer's player at `step`, after stepping stalled on its
 *   input for `dropAfterMs` (`why: "stalled"`), or because an input it sent didn't decode
 *   (`why: "badInput"`).
 * - `badInput`: `player`'s input for `step` didn't decode on this peer, in a step from the host
 *   or, on the host, its own. The peers' one-player Schemas differ (they play other code), or the
 *   host's own input doesn't survive the wire (a NaN, which JSON carries as null). `issue` is
 *   what the one-player Schema said.
 * - `hostLost`: nothing came from the host for `silentMs`. With no host, no step can be decided.
 *
 * **When to use**
 *
 * To say why a run stopped in the app's own words, from a `LockstepError`'s `reason`.
 *
 * **Example** (A stop in a player's words)
 *
 * ```ts
 * import type { LockstepSession } from "arcadekit/net";
 *
 * const say = (reason: LockstepSession.StopReason): string =>
 *   reason.kind === "hostLost" ? "The host left." : "The run stopped.";
 * say({ kind: "hostLost", host: "host", silentMs: 10_000 }); // => "The host left."
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type StopReason = typeof StopReasonSchema.Type;

/** The class `Schema.TaggedError` makes for `LockstepError`, written out for isolatedDeclarations. */
type LockstepErrorClass = Schema.Class<
  LockstepError,
  Schema.TaggedStruct<
    "LockstepError",
    { readonly message: Schema.String; readonly reason: StopReasonSchema }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
const LockstepErrorBase: LockstepErrorClass =
  // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
  Schema.TaggedError<LockstepError>()("LockstepError", {
    message: Schema.String,
    reason: StopReasonSchema,
  });

/**
 * Why a lockstep session stopped for good: its `reason` holds the details, and its `message`
 * says them.
 *
 * **When to use**
 *
 * Read it from a plain session's `error`, or catch it by its tag where a scoped session's `run`
 * fails, to show why the run is over.
 *
 * **Details**
 *
 * A session stops once and for good: its `status` is `stopped` and its `error` holds this from
 * then on. A desync's `message` names the step and every peer's hash in hex, so the peers'
 * logs name the same desync.
 *
 * **Example** (A guest that hears nothing from its host)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { LockstepSession, MemoryNetwork } from "arcadekit/net";
 * import { Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const guest = LockstepSession.join(
 *   {
 *     simulation: Sum,
 *     config: null,
 *     contentHash: "content-v1",
 *     transport: MemoryNetwork.connect(network, "guest"),
 *     local: { read: () => 2 },
 *     hash: (state) => state.total,
 *     inputDelay: 3,
 *     hashEvery: 30,
 *     host: "host",
 *     players: ["host", "guest"],
 *   },
 *   0
 * );
 * guest.tick(10_000);
 * guest.error?._tag; // => "LockstepError"
 * guest.error?.reason.kind; // => "hostLost"
 * guest.error?.message; // => "Lost the host host: nothing heard for 10000 ms"
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class LockstepError extends LockstepErrorBase {}

/**
 * What every peer of a run passes to its session, host and guest alike.
 *
 * **When to use**
 *
 * To share the options of a run's sessions, as a host's and its guests' are built: the host's
 * add `peers` and `seed` (`HostOptions`), a guest's `host` and `players` (`JoinOptions`).
 *
 * **Details**
 *
 * - `simulation` is a simulation several players can play, whose step input was declared with
 *   `Game.PlayerInputs`. The session steps it through a `Game.Loop` of its own. From that declared
 *   input it takes the Schema of one player's input, which is what crosses the network for each
 *   player, and it makes each step's input itself: every player's input at its slot (its place in
 *   the run's player order, host first) and the players removed at that step in `leaving`.
 * - `config` must be the same on every peer (the lobby agrees on it); only `contentHash` is
 *   checked, at the start: a peer whose hash differs from the host's refuses to start.
 * - `local` is this player's device or script: one player's input for each step, or null for a
 *   step with none (nothing is attached), which every peer's rules then see at this player's
 *   slot. The session reads it once per step it schedules, `inputDelay` steps ahead, calling
 *   `endStep` after each read and `endFrame` once per tick that read any. What it reads must be
 *   what the one-player Schema encodes: a tick throws on a value it refuses.
 * - `hash` digests the whole state, the same on every peer for the same run, compared every
 *   `hashEvery` steps.
 * - `inputDelay` is how many steps ahead local input is scheduled: 2 to 6 at 60 Hz.
 * - `dropAfterMs` is how long the host lets stepping stall on a player before removing it, and a
 *   guest waits on a silent host before giving up: 10 000 ms if left out. A stall is a wait on a
 *   player's input of 250 ms or more, and it goes on until a second passes without one, so a peer
 *   that still sends but can't keep up, such as a hidden tab whose timers are throttled to 1 Hz,
 *   is removed as a silent one is.
 *
 * **Example** (How long a run's input delay is)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { LockstepSession, MemoryNetwork } from "arcadekit/net";
 * import { Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const delayMs = <C, S, I, E, M, R>(options: LockstepSession.Options<C, S, I, E, M, R>) =>
 *   options.inputDelay * options.simulation.definition.stepSeconds * 1000;
 * const network = MemoryNetwork.make({ seed: 1 });
 * const options = {
 *   simulation: Sum,
 *   config: null,
 *   contentHash: "content-v1",
 *   transport: MemoryNetwork.connect(network, "host"),
 *   local: { read: () => 1 },
 *   hash: (state: Game.StateOf<typeof Sum>) => state.total,
 *   inputDelay: 3,
 *   hashEvery: 30,
 * };
 * Math.round(delayMs(options)); // => 50
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options<Config, State, Input, Event, Command, Refusals> {
  /** What every peer runs: a simulation whose step input is a `Game.PlayerInputs`. */
  readonly simulation: PlayersSimulation<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >;
  /** This peer's config. Every peer must pass the same; only `contentHash` is checked at the start. */
  readonly config: Config;
  /** A digest of the content the run is played with. A peer whose hash differs from the host's refuses to start. */
  readonly contentHash: string;
  readonly transport: Transport;
  /** This player's device or script: one player's input for each step, or null for a step with none. */
  readonly local: StepInput<PlayerInputOf<Input> | null>;
  /** A digest of the whole state, the same on every peer for the same run. Compared every `hashEvery` steps. */
  readonly hash: (state: State) => number;
  /** How many steps ahead local input is scheduled. 2 to 6 at 60 Hz. */
  readonly inputDelay: number;
  /** Peers compare state hashes after every this many steps. */
  readonly hashEvery: number;
  /** How long stepping may stall on a player, or a guest wait on its host, before it gives up. 10 000 ms if left out. */
  readonly dropAfterMs?: number;
}

/**
 * A host's options: what every peer passes, the other players and the run's seed.
 *
 * **When to use**
 *
 * To start a run with `host`.
 *
 * **Details**
 *
 * The host is always the first player, so the run's player order is the host, then `peers`:
 * what every guest passes as `players`. A run holds at most 16 players, the host included.
 *
 * **Example** (The run's player order, from the host's options)
 *
 * ```ts
 * import type { LockstepSession } from "arcadekit/net";
 *
 * const order = (
 *   self: string,
 *   options: Pick<LockstepSession.HostOptions<null, null, null, never, never, never>, "peers">
 * ) => [self, ...options.peers];
 * order("host", { peers: ["guest-1", "guest-2"] }); // => ["host", "guest-1", "guest-2"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface HostOptions<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> extends Options<Config, State, Input, Event, Command, Refusals> {
  /** The other players' peer ids, in player order, after the host. */
  readonly peers: readonly PeerId[];
  /** The run's seed, which every peer's simulation gets. */
  readonly seed: number;
}

/**
 * A guest's options: what every peer passes, the host to join and the run's player order.
 *
 * **When to use**
 *
 * To join a run with `join`.
 *
 * **Details**
 *
 * `players` is the run's player order as the lobby agreed it: the host, then the `peers` the
 * host passes, this peer among them. A player's slot is its index here for the whole run. The
 * host's start message doesn't say it: it lists who is still in the run when it is sent, and a
 * guest that first hears it after a player was removed must still put every input at the slot
 * the others do.
 *
 * **Example** (A guest's slot)
 *
 * ```ts
 * import type { LockstepSession } from "arcadekit/net";
 *
 * const slotOf = (
 *   self: string,
 *   options: Pick<LockstepSession.JoinOptions<null, null, null, never, never, never>, "players">
 * ) => options.players.indexOf(self);
 * slotOf("guest-2", { players: ["host", "guest-1", "guest-2"] }); // => 2
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface JoinOptions<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> extends Options<Config, State, Input, Event, Command, Refusals> {
  /** The host's peer id. */
  readonly host: PeerId;
  /** The run's player order, host first, this peer among them. */
  readonly players: readonly PeerId[];
}

/**
 * Where a session is:
 *
 * - `joining`: a guest that hasn't had the host's start message yet. A command sent now waits
 *   for the run's first steps.
 * - `running`: stepping.
 * - `waiting`: a step is due, but some player's input for it hasn't arrived (`waitingFor`).
 * - `stopped`: for good, with `error` saying why.
 *
 * **When to use**
 *
 * To show a run's state: a lobby until it runs, a banner while it waits, the stop's reason once
 * it has stopped.
 *
 * **Example** (A banner while the run waits)
 *
 * ```ts
 * import type { LockstepSession } from "arcadekit/net";
 *
 * const banner = (status: LockstepSession.Status) =>
 *   status === "waiting" ? "Waiting for a player" : "";
 * banner("waiting"); // => "Waiting for a player"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Status = "joining" | "running" | "waiting" | "stopped";

/**
 * One peer's side of a lockstep run, ticked by its caller.
 *
 * **When to use**
 *
 * To run a lockstep run with its time in the caller's hands: a test of the protocol, a bench, a
 * server. An Effect program uses `ScopedLockstepSession`, which makes one its scope owns and
 * ticks it on the Clock or a ticker.
 *
 * **Details**
 *
 * It is a host of the simulation, as `Game.Loop` is, and its capabilities are its methods:
 *
 * - `tick(nowMs)`, from a timer, often (every few milliseconds is fine): each tick reads what
 *   arrived, steps every due step whose inputs are all confirmed, schedules local input and
 *   sends. Time comes only from `nowMs`.
 * - `subscribe(listener)` hears the run's events and samples, as `Game.Loop`'s does, and returns
 *   a function that stops it. A session reports from its ticks and from nowhere else, so a
 *   listener in place before the first tick hears the run from its start: what `create`
 *   reports, then the first sample. A host's run starts as the session is made, and
 *   the session tells what that start reported at its first tick, before the tick does anything
 *   else. A listener that comes later hears what comes after it: nothing is told twice. A
 *   listener is called inside the tick, before the senders whose commands that tick's steps
 *   answered.
 * - `send(command, settled?)` is `Game.Loop`'s `send` without the slot. The command rides this
 *   player's payload for the next step the session schedules, `inputDelay` steps ahead, so every
 *   peer's rules get it at the start of that step, after the commands of the players before this
 *   one in player order, and take or refuse it alike. At most four commands ride one step: a
 *   fifth rides the next. `settled` is called once, on this peer, with `undefined` when its rules
 *   took the command, the rejection they refused it with, or a `CommandDropped` (`runEnded`)
 *   when they gave no answer. That is once the session is out of the tick that ended the
 *   command, so it may send again. `send` returns a function that takes the command back while
 *   it waits for a step. It throws for a command the simulation doesn't declare, and for one no
 *   peer could decode, such as one holding a NaN.
 * - `dispose()` stops listening to the transport and drops the commands the rules haven't
 *   answered: their senders hear `CommandDropped` before it returns.
 *
 * `state` is the run's state, to draw: read it, never change it. It is null before the run
 * starts. `players` is who is still in the run, in player order: it is not where a slot comes
 * from, since a player keeps its slot when another leaves. A session prints its status, its step
 * and its players.
 *
 * **Example** (A host and a guest on a test network)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { LockstepSession, MemoryNetwork } from "arcadekit/net";
 * import { Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1, latencyMs: 10 });
 * const shared = {
 *   simulation: Sum,
 *   config: null,
 *   contentHash: "content-v1",
 *   hash: (state: Game.StateOf<typeof Sum>) => state.total,
 *   inputDelay: 3,
 *   hashEvery: 30,
 * };
 * const host = LockstepSession.host(
 *   { ...shared, transport: MemoryNetwork.connect(network, "host"), local: { read: () => 1 }, peers: ["guest"], seed: 7 },
 *   0
 * );
 * const guest = LockstepSession.join(
 *   { ...shared, transport: MemoryNetwork.connect(network, "guest"), local: { read: () => 2 }, host: "host", players: ["host", "guest"] },
 *   0
 * );
 * for (let now = 0; now <= 1000; now += 4) {
 *   MemoryNetwork.advance(network, now);
 *   host.tick(now);
 *   guest.tick(now);
 * }
 * host.status; // => "running"
 * host.state?.total === 3 * host.stepIndex; // => true
 * guest.players; // => ["host", "guest"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface LockstepSession<State, Event, Command, Refusals>
  extends Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  readonly status: Status;
  /** Why the session stopped, or null. */
  readonly error: LockstepError | null;
  /** The players whose input the next step waits on, while `status` is `waiting`. Show them ("waiting for X"). */
  readonly waitingFor: readonly PeerId[];
  /** The run's players still in it, in player order. Empty until the run starts. */
  readonly players: readonly PeerId[];
  /** The run's state, to draw. Read it; never change it. Null before the run starts. */
  readonly state: State | null;
  /** Steps run since the start. */
  readonly stepIndex: number;
  /** Reads what arrived, runs the steps that are due and confirmed, schedules local input and sends. */
  readonly tick: (nowMs: number) => void;
  /** Hears the run's events and samples, inside the ticks that report them. Returns a function that stops it. */
  readonly subscribe: (listener: (event: Event) => void) => () => void;
  /**
   * Sends a command to the run as this peer's player, and tells `settled` how this peer's rules
   * answered. Returns a function that takes it back while it has no step.
   */
  readonly send: <C extends Command>(
    command: C,
    settled?: (outcome: Settled<RefusalFor<Refusals, C>>) => void
  ) => () => void;
  /** Stops listening to the transport, and tells the senders still waiting `CommandDropped`. */
  readonly dispose: () => void;
}

/**
 * Checks whether a value is a lockstep session.
 *
 * **When to use**
 *
 * Narrow an unknown value before ticking it.
 *
 * **Example** (Recognising a session)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { LockstepSession, MemoryNetwork } from "arcadekit/net";
 * import { Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const guest = LockstepSession.join(
 *   {
 *     simulation: Sum,
 *     config: null,
 *     contentHash: "content-v1",
 *     transport: MemoryNetwork.connect(network, "guest"),
 *     local: { read: () => 1 },
 *     hash: (state) => state.total,
 *     inputDelay: 3,
 *     hashEvery: 30,
 *     host: "host",
 *     players: ["host", "guest"],
 *   },
 *   0
 * );
 * LockstepSession.isLockstepSession(guest); // => true
 * LockstepSession.isLockstepSession({ tick: () => {} }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isLockstepSession = (
  value: unknown
): value is LockstepSession<unknown, unknown, unknown, unknown> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Starts a run as its host, now: the host is the first player, and `peers` the others.
 *
 * **When to use**
 *
 * On the host's peer, once the lobby has agreed on who plays, in what order, and the config.
 * Its guests `join` with the same options but `peers` and `seed`.
 *
 * **Details**
 *
 * The run's state is there when it returns. What the start reports (what the simulation's
 * `create` reports, then the first sample) is told at the session's first tick, as everything a
 * session reports is told from a tick: `subscribe` before that tick to hear the run from its
 * start, as a guest's listener does.
 *
 * It throws a `RangeError` for more players than a run holds (16), an `Error` for a simulation
 * whose step input was not declared with `Game.PlayerInputs` (a type error on `simulation`
 * first, when the call infers its types from it), and what starting throws (the simulation's
 * `create`, the input source), each with nothing left listening.
 *
 * **Example** (Hearing a host's run from its start)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { LockstepSession, MemoryNetwork } from "arcadekit/net";
 * import { Schema } from "effect";
 *
 * class RaceBegan extends Game.Event("RaceBegan", { laps: Schema.Int }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   events: [RaceBegan],
 *   create: (config: { readonly laps: number }, { report }) => {
 *     report(new RaceBegan({ laps: config.laps }));
 *     return { metres: 0 };
 *   },
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const host = LockstepSession.host(
 *   {
 *     simulation: Race,
 *     config: { laps: 3 },
 *     contentHash: "content-v1",
 *     transport: MemoryNetwork.connect(network, "host"),
 *     local: { read: () => 1 },
 *     hash: (state) => state.metres,
 *     inputDelay: 3,
 *     hashEvery: 30,
 *     peers: ["guest"],
 *     seed: 7,
 *   },
 *   0
 * );
 * const heard: string[] = [];
 * host.subscribe(Race.match({ RaceBegan: ({ laps }) => heard.push(`${laps} laps`) }));
 * heard.length; // => 0
 * host.tick(4);
 * heard; // => ["3 laps"]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const host = <Config, State, Input, Event, Command, Refusals>(
  options: HostOptions<Config, State, Input, Event, Command, Refusals>,
  nowMs: number
): LockstepSession<State, Event, Command, Refusals> => {
  if (options.peers.length + 1 > MAX_PLAYERS) {
    throw new RangeError(
      `A lockstep run holds at most ${MAX_PLAYERS} players, not ${options.peers.length + 1}`
    );
  }
  const { self } = options.transport;
  const session = new SessionImpl(
    options,
    self,
    [self, ...options.peers],
    nowMs
  );
  try {
    session.startAsHost(options.peers, options.seed, nowMs);
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
};

/**
 * Joins the run `host` starts, with the options the host passed but `peers` and `seed`, and with
 * the run's player order as `players`.
 *
 * **When to use**
 *
 * On each guest's peer, with the options the lobby agreed on.
 *
 * **Details**
 *
 * The session is `joining` until the host's start message arrives: the tick that has it starts
 * the run, and tells what the start reports. A guest whose content hash differs from the host's
 * stops at that tick with `contentMismatch`. It throws for a simulation whose step input was not
 * declared with `Game.PlayerInputs`, as `host` does.
 *
 * **Example** (A guest before the host's start)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { LockstepSession, MemoryNetwork } from "arcadekit/net";
 * import { Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Number),
 *   create: () => ({ total: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const network = MemoryNetwork.make({ seed: 1 });
 * const guest = LockstepSession.join(
 *   {
 *     simulation: Sum,
 *     config: null,
 *     contentHash: "content-v1",
 *     transport: MemoryNetwork.connect(network, "guest"),
 *     local: { read: () => 2 },
 *     hash: (state) => state.total,
 *     inputDelay: 3,
 *     hashEvery: 30,
 *     host: "host",
 *     players: ["host", "guest"],
 *   },
 *   0
 * );
 * guest.status; // => "joining"
 * guest.state; // => null
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const join = <Config, State, Input, Event, Command, Refusals>(
  options: JoinOptions<Config, State, Input, Event, Command, Refusals>,
  nowMs: number
): LockstepSession<State, Event, Command, Refusals> =>
  new SessionImpl(options, options.host, options.players, nowMs);

const hex = (hash: number) => (hash >>> 0).toString(16).padStart(8, "0");

const describe = (reason: StopReason): string => {
  switch (reason.kind) {
    case "desync": {
      const hashes = Object.entries(reason.hashes)
        .map(([peer, hash]) => `${peer} ${hex(hash)}`)
        .join(", ");
      return `Desync after step ${reason.step}: state hashes differ (${hashes})`;
    }
    case "contentMismatch": {
      return `Content differs from the host's: host ${reason.hostContentHash}, this peer ${reason.localContentHash}`;
    }
    case "removed": {
      const why =
        reason.why === "stalled"
          ? "stepping stalled on its input"
          : "its input didn't decode";
      return `The host removed ${reason.peer} from the run at step ${reason.step}: ${why}`;
    }
    case "badInput": {
      return `The input of ${reason.player} for step ${reason.step} didn't decode: ${reason.issue}`;
    }
    case "hostLost": {
      return `Lost the host ${reason.host}: nothing heard for ${Math.round(reason.silentMs)} ms`;
    }
  }
};

const lockstepError = (reason: StopReason): LockstepError =>
  new LockstepError({ message: describe(reason), reason });

// The wire format. Every message is JSON. Each side resends what the other hasn't acknowledged
// on every tick, so a lost, duplicated or reordered message does no harm. A message that doesn't
// decode to one below is dropped, so a peer on other code, or a forged one, can't stop a tick.

/** Most inputs, steps or hashes one message carries. */
const MAX_BATCH = 64;
/** Most players in a run, the host included. */
const MAX_PLAYERS = 16;
/** The host keeps a peer's inputs for at most this many steps past the last confirmed one. */
const MAX_INPUTS_AHEAD = MAX_BATCH;

/** A step number. */
const Step = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** The last step acknowledged, or -1 for none yet. */
const Ack = Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1));
const Players = Schema.Array(Schema.String).check(
  Schema.isMaxLength(MAX_PLAYERS)
);

/** One confirmed step: [player, encoded payload] pairs, then the removed players. */
const WireStep = Schema.Tuple([
  Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown])).check(
    Schema.isMaxLength(MAX_PLAYERS)
  ),
  Players,
]);
type WireStep = typeof WireStep.Type;

/** [step, hash] pairs, oldest first. */
const WireHashes = Schema.Array(Schema.Tuple([Step, Schema.Finite])).check(
  Schema.isMaxLength(MAX_BATCH)
);

const Message = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start"),
    seed: Schema.Finite,
    contentHash: Schema.String,
    players: Players,
  }),
  // Peer to host.
  Schema.Struct({
    kind: Schema.Literal("inputs"),
    /** The step of `inputs[0]`. */
    from: Step,
    inputs: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(MAX_BATCH)),
    /** Every step through this one is confirmed on the peer. */
    stepsAck: Ack,
    hashes: WireHashes,
    /** The highest step of the host's hashes the peer has. */
    hashAck: Ack,
  }),
  // Host to peer.
  Schema.Struct({
    kind: Schema.Literal("steps"),
    /** The step of `steps[0]`. */
    from: Step,
    steps: Schema.Array(WireStep).check(Schema.isMaxLength(MAX_BATCH)),
    /** The host has every input of this peer's through this step. */
    inputsAck: Ack,
    /** The highest step of this peer's hashes the host has. */
    hashAck: Ack,
    hashes: WireHashes,
    waiting: Players,
  }),
  Schema.Struct({
    kind: Schema.Literal("desync"),
    step: Step,
    hashes: Schema.Record(Schema.String, Schema.Finite).check(
      Schema.isMaxProperties(MAX_PLAYERS)
    ),
  }),
  // Host to a removed peer.
  Schema.Struct({
    kind: Schema.Literal("removed"),
    step: Step,
    why: Schema.Literals(["stalled", "badInput"]),
  }),
]);
type Message = typeof Message.Type;

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Message)
);

/** Most steps one tick runs to catch up after a wait: 0.25 s at 60 Hz. */
const MAX_CATCH_UP_SECONDS = 0.25;
/** A wait on one player this long is a stall: longer than the network's hiccups. */
const STALL_MS = 250;
/** A stall ends once stepping has gone this long without stalling on that player. */
const STALL_RECOVERY_MS = 1000;

interface Stall {
  /** The step whose input from this player stepping waits on now, if any. */
  waitingStep: number | undefined;
  /** Since when stepping has waited on `waitingStep`. */
  waitingSinceMs: number;
  /** The start of the first wait in the stall now going on, if any. */
  stalledSinceMs: number | undefined;
  /** The last time a wait on this player was long enough to count. */
  lastStalledMs: number;
}

const NO_STALL: Stall = {
  waitingStep: undefined,
  waitingSinceMs: 0,
  stalledSinceMs: undefined,
  lastStalledMs: 0,
};

/** One player's payload for a step: as it came on the wire, and as the codec decoded it. */
interface PendingInput<PlayerInput, Command> extends StepPayload<
  PlayerInput,
  Command
> {
  readonly encoded: unknown;
}

/** A command this peer's player sent, until its sender has been told how it ended. */
interface LocalSend {
  readonly tag: string;
  /** The command as it crosses the network: what rides a step's payload. */
  readonly wire: unknown;
  readonly settled: ((outcome: Settled<unknown>) => void) | undefined;
  /** Set when the sender takes the command back: `settled` is then not called. */
  withdrawn: boolean;
  /** Set once this peer's loop has the command: its answer is then the rules'. */
  handed: boolean;
}

/** How a local command ended, kept until the session is out of its tick. */
interface Answer {
  readonly sent: LocalSend;
  readonly outcome: Settled<unknown>;
}

const NO_COMMANDS: readonly never[] = [];

const noop = (): void => undefined;

const tagOf = (command: unknown): string =>
  (command as { readonly _tag: string })._tag;

interface HostSide<PlayerInput, Command> {
  /** The other players still in the run, in player order. */
  readonly peers: PeerId[];
  /** Each player's payloads not yet in a confirmed step, by step. The host's own included. */
  readonly pending: Map<
    PeerId,
    Map<number, PendingInput<PlayerInput, Command>>
  >;
  /** Each player's inputs are all known through this step. */
  readonly inputsKnown: Map<PeerId, number>;
  /** Peers the host has heard from since the start; the others get the start message again. */
  readonly started: Set<PeerId>;
  /** How long stepping has waited, and stalled, on each peer (see `dropAfterMs`). */
  readonly stalls: Map<PeerId, Stall>;
  /** Removed players, with the step they were removed at and why, to tell them again if they speak. */
  readonly removed: Map<
    PeerId,
    { readonly step: number; readonly why: RemovedWhy }
  >;
  /** Confirmed steps some peer may not have yet. */
  readonly wire: Map<number, WireStep>;
  readonly stepsAck: Map<PeerId, number>;
  /** Each peer's hashes, by step. */
  readonly peerHashes: Map<number, Map<PeerId, number>>;
  readonly peerHashAck: Map<PeerId, number>;
  /** The highest step of the host's hashes each peer has. */
  readonly hostHashAck: Map<PeerId, number>;
  /** Players removed, to announce in the next confirmed step. */
  removing: PeerId[];
  seed: number;
}

interface PeerSide {
  readonly host: PeerId;
  /** This peer's payloads the host may not have yet, by step, encoded. */
  readonly unsent: Map<number, unknown>;
  /** Hashes from the host, by step. */
  readonly hostHashes: Map<number, number>;
  hostWaiting: readonly PeerId[];
  lastHeardMs: number;
  hashAck: number;
}

/**
 * The session `host` and `join` make. A class, as Effect's own runtime objects are and as
 * `Game.Loop`'s is: no game names it or calls `new` on it, and its value is a
 * `LockstepSession`, with a `TypeId`, `pipe` and a printed form.
 */
class SessionImpl<Config, State, Input, Event, Command, Refusals>
  extends Inspectable.Class
  implements LockstepSession<State, Event, Command, Refusals>
{
  readonly [TypeId]: typeof TypeId = TypeId;
  status: Status = "joining";
  error: LockstepError | null = null;
  waitingFor: readonly PeerId[] = [];
  players: readonly PeerId[] = [];

  private readonly options: Options<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >;
  private readonly loop: Loop<Config, State, Input, Event, Command, Refusals>;
  /** Who hears the run's events and samples: the session's own set, told only from a tick. */
  private readonly listeners = new Set<(event: Event) => void>();
  /**
   * What a host's start reported, in order, until its first tick tells it: `create`'s events,
   * then the first sample. Null once told, and on a guest, whose run starts in a tick.
   */
  private startReport: Event[] | null = null;
  /** One player's part of a step to its wire form and back, from the simulation's declaration. */
  private readonly codec: PayloadCodec<PlayerInputOf<Input>, Command>;
  /** The tags of the simulation's commands. */
  private readonly commandTags: ReadonlySet<string>;
  /** The run's player order, host first: a player's slot is its index here for the whole run. */
  private readonly order: readonly PeerId[];
  /** Makes a step's input from every player's, by slot in the run's player order. */
  private readonly combine: (
    step: ConfirmedStep<PlayerInputOf<Input>, unknown>
  ) => Input;
  /** The local player's commands that have no step yet, in the order sent. */
  private outbox: LocalSend[] = [];
  /** The local player's commands riding a scheduled step this peer hasn't run, by step. */
  private readonly riding = new Map<number, LocalSend[]>();
  /** Every local command whose sender hasn't been answered, wherever it waits. */
  private readonly unanswered = new Set<LocalSend>();
  /** How local commands ended, until the tick is over and their senders can be told. */
  private answers: Answer[] = [];
  /**
   * Disposed, or a tick threw: this peer's rules will answer nothing more, so a send is answered
   * at once.
   */
  private ended = false;
  private readonly self: PeerId;
  private readonly stepMs: number;
  private readonly dropAfterMs: number;
  private readonly inbox: [PeerId, string][] = [];
  private readonly unlisten: () => void;
  private host: HostSide<PlayerInputOf<Input>, Command> | null = null;
  private peer: PeerSide | null = null;
  /** Confirmed steps not yet run, decoded. */
  private readonly confirmed = new Map<
    number,
    ConfirmedStep<PlayerInputOf<Input>, Command>
  >();
  /** Every step through this one is confirmed. */
  private confirmedThrough = -1;
  /** The next step to read local input for. */
  private nextLocal = 0;
  /** This peer's own hashes, by step, until the other side has them. */
  private readonly ownHashes = new Map<number, number>();
  /** Steps owed by time, not yet run. */
  private owed = 0;
  private lastTickMs: number;
  private stopMessage: Message | null = null;
  private readonly buffer: StepInput<Input>;

  /**
   * `order` is the run's player order, host first, as its lobby agreed it. The slots come from
   * it and from nothing the host says later: a start message lists who is still in the run.
   */
  constructor(
    options: Options<Config, State, Input, Event, Command, Refusals>,
    hostId: PeerId,
    order: readonly PeerId[],
    nowMs: number
  ) {
    super();
    this.options = options;
    this.self = options.transport.self;
    // Before anything listens: a simulation with no players' input is refused here.
    this.codec = payloadCodec(options.simulation);
    this.commandTags = new Set(
      options.simulation.definition.commands.map(({ tag }) => tag)
    );
    this.order = order;
    // The simulation's step input is the players' input of its own one-player input, which the
    // types can't see through `PlayerInputOf`.
    this.combine = combinePlayerInputs<PlayerInputOf<Input>>(order) as (
      step: ConfirmedStep<PlayerInputOf<Input>, unknown>
    ) => Input;
    this.loop = makeLoop<Config, State, Input, Event, Command, Refusals>(
      options.simulation
    );
    this.loop.subscribe((event) => this.emit(event));
    this.stepMs = options.simulation.definition.stepSeconds * 1000;
    this.dropAfterMs = options.dropAfterMs ?? 10_000;
    this.lastTickMs = nowMs;
    if (hostId !== this.self) {
      this.peer = {
        host: hostId,
        unsent: new Map(),
        hostHashes: new Map(),
        hostWaiting: [],
        lastHeardMs: nowMs,
        hashAck: -1,
      };
    }
    this.unlisten = options.transport.listen((from, message) => {
      this.inbox.push([from, message]);
    });
    this.buffer = {
      read: (step) => {
        const confirmed = this.confirmed.get(step)!;
        this.confirmed.delete(step);
        if (confirmed.removed.length > 0) {
          this.players = this.players.filter(
            (player) => !confirmed.removed.includes(player)
          );
        }
        this.handCommands(step, confirmed);
        return this.combine(confirmed);
      },
    };
  }

  get state(): State | null {
    return this.loop.state;
  }

  pipe() {
    // oxlint-disable-next-line prefer-rest-params -- Effect's own `pipe` reads its arguments so, with no array made per call.
    return pipeArguments(this, arguments);
  }

  toJSON(): unknown {
    return {
      _id: "LockstepSession",
      self: this.self,
      status: this.status,
      stepIndex: this.loop.stepIndex,
      players: this.players,
    };
  }

  get stepIndex(): number {
    return this.loop.stepIndex;
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * What the loop reports, on its way to the listeners. A host's loop starts while the session
   * is being made, when nothing can listen yet: what it reports then is kept for the first tick.
   */
  private emit(event: Event): void {
    if (this.startReport !== null) {
      this.startReport.push(event);
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Host, at its first tick: tells what the start reported, in the order the loop reported it,
   * before the tick does anything else. No step has run since the start, so a listener that
   * reads the state on hearing it reads the one `create` made.
   */
  private tellStart(reported: readonly Event[]): void {
    // Forgotten first: a listener that throws ends this tick, and no later one tells it again.
    this.startReport = null;
    for (const event of reported) {
      this.emit(event);
    }
  }

  send<C extends Command>(
    command: C,
    settled?: (outcome: Settled<RefusalFor<Refusals, C>>) => void
  ): () => void {
    const tag = tagOf(command);
    const name = this.options.simulation.simulationName;
    if (!this.commandTags.has(tag)) {
      throw new Error(
        `Simulation "${name}" has no command "${tag}": list it in \`commands\` and handle it in \`apply\``
      );
    }
    // Checked here, where the mistake is: on the wire it would show as this player's bad input,
    // and remove it from the run or, on the host, stop the run for everyone.
    const wire = this.codec.encodeCommand(command);
    if (Result.isFailure(wire)) {
      throw new Error(
        `Simulation "${name}": the command "${tag}" can't cross the network, so no peer could apply it: ${wire.failure}. A lockstep run sends a command as JSON, and every peer applies what it decodes: keep to values JSON carries (no NaN, no Infinity).`
      );
    }
    if (this.status === "stopped" || this.ended) {
      settled?.(new CommandDropped({ command: tag, reason: "runEnded" }));
      // Nothing is waiting, so there is nothing to take back.
      return noop;
    }
    const sent: LocalSend = {
      tag,
      wire: wire.success,
      settled: settled as LocalSend["settled"],
      withdrawn: false,
      handed: false,
    };
    this.outbox.push(sent);
    this.unanswered.add(sent);
    return () => {
      sent.withdrawn = true;
      const at = this.outbox.indexOf(sent);
      if (at !== -1) {
        // It has no step yet, so it never gets one.
        this.outbox.splice(at, 1);
        this.unanswered.delete(sent);
      }
    };
  }

  dispose(): void {
    this.unlisten();
    this.ended = true;
    this.dropSends();
    const thrown = this.tell();
    if (thrown !== undefined) {
      throw thrown.error;
    }
  }

  /**
   * Hands a confirmed step's commands to the loop, which applies them before the step: in player
   * order, and each player's in the order sent. Every peer does the same, so every peer's rules
   * take or refuse each alike. Only this peer's own have a sender to answer: they are matched
   * with what it sent for the step by place and by tag, and what the step doesn't carry of
   * them (only a host on other code leaves one out) is answered as dropped, since this peer's
   * rules never get it.
   */
  private handCommands(
    step: number,
    confirmed: ConfirmedStep<PlayerInputOf<Input>, Command>
  ): void {
    const mine = this.riding.get(step);
    for (const { player, commands } of confirmed.inputs) {
      if (commands.length === 0) {
        continue;
      }
      const slot = this.order.indexOf(player);
      if (slot === -1) {
        continue;
      }
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i]!;
        const sent = player === this.self ? mine?.[i] : undefined;
        if (sent === undefined || sent.tag !== tagOf(command)) {
          this.loop.send(command, slot);
        } else {
          sent.handed = true;
          this.loop.send(command, slot, (outcome) =>
            this.answer(sent, outcome)
          );
        }
      }
    }
    if (mine !== undefined) {
      this.riding.delete(step);
      for (const sent of mine) {
        if (!sent.handed) {
          this.answer(sent, runEnded(sent));
        }
      }
    }
  }

  /** Keeps how a local command ended, once, until its sender can be told. */
  private answer(sent: LocalSend, outcome: Settled<unknown>): void {
    if (!this.unanswered.delete(sent)) {
      return;
    }
    if (sent.settled !== undefined && !sent.withdrawn) {
      this.answers.push({ sent, outcome });
    }
  }

  /**
   * Drops every local command this peer's rules haven't answered, to be told `runEnded`: those
   * with no step yet, those riding a step that won't run here, and those the loop had when a
   * step threw.
   */
  private dropSends(): void {
    for (const sent of this.unanswered) {
      this.answer(sent, runEnded(sent));
    }
    this.outbox = [];
    this.riding.clear();
  }

  /**
   * Tells each local sender how its command ended, in the order they ended. The session is out
   * of its own work by now, so a sender may send again from here. One that throws doesn't keep
   * the others from hearing: the first throw is returned once all were told.
   */
  private tell(): { readonly error: unknown } | undefined {
    const { answers } = this;
    if (answers.length === 0) {
      return undefined;
    }
    this.answers = [];
    let thrown: { readonly error: unknown } | undefined;
    for (const { sent, outcome } of answers) {
      if (!sent.withdrawn) {
        try {
          sent.settled?.(outcome);
        } catch (error) {
          thrown ??= { error };
        }
      }
    }
    return thrown;
  }

  startAsHost(peers: readonly PeerId[], seed: number, nowMs: number): void {
    const players = [this.self, ...peers];
    this.host = {
      peers: [...peers],
      pending: new Map(players.map((p) => [p, new Map()])),
      inputsKnown: new Map(players.map((p) => [p, -1])),
      started: new Set(),
      stalls: new Map(peers.map((p) => [p, { ...NO_STALL }])),
      removed: new Map(),
      wire: new Map(),
      stepsAck: new Map(peers.map((p) => [p, -1])),
      peerHashes: new Map(),
      peerHashAck: new Map(peers.map((p) => [p, -1])),
      hostHashAck: new Map(peers.map((p) => [p, -1])),
      removing: [],
      seed,
    };
    // The run starts here, not at the first tick. Its state is there at once, what starting
    // throws is thrown with nothing left listening, and the run's first steps are scheduled
    // before anyone can send: started at the first tick, a command sent before it would ride
    // step 0 on every peer, where it rides the step after those. Only the telling waits for
    // that tick, since the caller has no session to listen to until this returns.
    this.startReport = [];
    this.begin(players, seed, nowMs);
  }

  tick(nowMs: number): void {
    try {
      this.work(nowMs);
    } catch (error) {
      // A step, the hash or the input source threw: a bug, and this peer's run is over where
      // the throw left it. No sender is left waiting on rules that won't answer.
      this.ended = true;
      this.dropSends();
      this.tell();
      throw error;
    }
    if (this.answers.length > 0) {
      const thrown = this.tell();
      if (thrown !== undefined) {
        throw thrown.error;
      }
    }
  }

  /** One tick's work. Senders hear how their commands ended after it, never inside it. */
  private work(nowMs: number): void {
    if (this.startReport !== null) {
      this.tellStart(this.startReport);
    }
    const inbox = this.inbox.splice(0);
    for (const [from, text] of inbox) {
      const message = decodeMessage(text);
      if (Option.isSome(message) && this.status !== "stopped") {
        this.receive(from, message.value, nowMs);
      }
    }
    if (this.status === "stopped") {
      this.resendStop();
      return;
    }
    if (this.host) {
      this.dropStalledPeers(nowMs);
      this.confirm();
    } else if (nowMs - this.peer!.lastHeardMs >= this.dropAfterMs) {
      this.stop(
        lockstepError({
          kind: "hostLost",
          host: this.peer!.host,
          silentMs: nowMs - this.peer!.lastHeardMs,
        })
      );
      return;
    }
    if (this.status === "joining") {
      this.lastTickMs = nowMs;
      return;
    }
    this.runDueSteps(nowMs);
    if (this.error !== null) {
      return;
    }
    this.scheduleLocalInput();
    if (this.error !== null) {
      return;
    }
    if (this.host) {
      this.confirm();
    }
    this.transmit();
  }

  /**
   * Starts the run on this peer: same seed, same config, everywhere. `players` are those in the
   * run now: on a guest, who the host's start message lists.
   */
  private begin(players: readonly PeerId[], seed: number, nowMs: number) {
    this.players = players;
    this.loop.start(this.options.config, seed, nowMs);
    this.status = "running";
    this.lastTickMs = nowMs;
    this.scheduleLocalInput();
  }

  private receive(from: PeerId, message: Message, nowMs: number) {
    if (this.host) {
      this.receiveAsHost(this.host, from, message);
    } else {
      this.receiveAsPeer(this.peer!, from, message, nowMs);
    }
  }

  private receiveAsHost(
    side: HostSide<PlayerInputOf<Input>, Command>,
    from: PeerId,
    message: Message
  ) {
    if (!side.peers.includes(from)) {
      const removed = side.removed.get(from);
      if (removed !== undefined) {
        this.sendRemoved(from, removed.step, removed.why);
      }
      return;
    }
    if (message.kind === "desync") {
      // Not trusted: a peer vouches only for its own hash, so the claim counts as that and no
      // more. The host's own hash decides, so a forged claim can't end the run.
      const hash = message.hashes[from];
      const own = this.ownHashes.get(message.step);
      if (hash === undefined) {
        return;
      }
      if (own !== undefined && hash !== own) {
        // The same hashes the peer stopped with, so every peer names the same desync.
        this.stop(
          lockstepError({
            kind: "desync",
            step: message.step,
            hashes: { [this.self]: own, [from]: hash },
          })
        );
        return;
      }
      this.receivePeerHash(side, from, message.step, hash);
      return;
    }
    if (message.kind !== "inputs") {
      return;
    }
    side.started.add(from);
    const pending = side.pending.get(from)!;
    const last = this.confirmedThrough + MAX_INPUTS_AHEAD;
    for (let i = 0; i < message.inputs.length; i++) {
      const step = message.from + i;
      if (step > this.confirmedThrough && step <= last && !pending.has(step)) {
        const payload: PendingInput<PlayerInputOf<Input>, Command> = {
          encoded: message.inputs[i],
          input: null,
          commands: NO_COMMANDS,
        };
        if (this.codec.decode(payload.encoded, payload) !== null) {
          // Its peer plays other code, or forged it; the others run on without it.
          this.removePeer(side, from, "badInput");
          return;
        }
        pending.set(step, payload);
      }
    }
    advanceKnown(side.inputsKnown, from, pending);
    side.stepsAck.set(
      from,
      Math.max(side.stepsAck.get(from)!, message.stepsAck)
    );
    side.hostHashAck.set(
      from,
      Math.max(side.hostHashAck.get(from)!, message.hashAck)
    );
    for (const [step, hash] of message.hashes) {
      this.receivePeerHash(side, from, step, hash);
    }
  }

  /** Keeps a peer's hash for `step` and compares it, if the peer can have hashed that step. */
  private receivePeerHash(
    side: HostSide<PlayerInputOf<Input>, Command>,
    from: PeerId,
    step: number,
    hash: number
  ) {
    // A peer steps only on confirmed steps, so it can't have hashed one past them.
    if (
      step % this.options.hashEvery !== 0 ||
      step > this.confirmedThrough + 1
    ) {
      return;
    }
    side.peerHashAck.set(from, Math.max(side.peerHashAck.get(from)!, step));
    let hashes = side.peerHashes.get(step);
    if (!hashes) {
      hashes = new Map();
      side.peerHashes.set(step, hashes);
    }
    hashes.set(from, hash);
    this.compareHashes(step);
  }

  private receiveAsPeer(
    peer: PeerSide,
    from: PeerId,
    message: Message,
    nowMs: number
  ) {
    if (from !== peer.host) {
      return;
    }
    peer.lastHeardMs = nowMs;
    switch (message.kind) {
      case "start": {
        if (this.status !== "joining") {
          return;
        }
        if (message.contentHash !== this.options.contentHash) {
          this.stop(
            lockstepError({
              kind: "contentMismatch",
              hostContentHash: message.contentHash,
              localContentHash: this.options.contentHash,
            })
          );
          return;
        }
        this.begin(message.players, message.seed, nowMs);
        return;
      }
      case "steps": {
        if (this.status === "joining") {
          return;
        }
        for (let i = 0; i < message.steps.length; i++) {
          const step = message.from + i;
          if (step > this.confirmedThrough && !this.confirmed.has(step)) {
            const confirmed = this.decodeStep(step, message.steps[i]!);
            if (confirmed === null) {
              return;
            }
            this.confirmed.set(step, confirmed);
          }
        }
        while (this.confirmed.has(this.confirmedThrough + 1)) {
          this.confirmedThrough += 1;
        }
        for (const step of peer.unsent.keys()) {
          if (step <= message.inputsAck) {
            peer.unsent.delete(step);
          }
        }
        for (const step of this.ownHashes.keys()) {
          if (step <= message.hashAck) {
            this.ownHashes.delete(step);
          }
        }
        for (const [step, hash] of message.hashes) {
          peer.hashAck = Math.max(peer.hashAck, step);
          peer.hostHashes.set(step, hash);
          this.compareHashes(step);
        }
        peer.hostWaiting = message.waiting;
        break;
      }
      case "desync": {
        this.stop(
          lockstepError({
            kind: "desync",
            step: message.step,
            hashes: message.hashes,
          })
        );
        break;
      }
      case "removed": {
        this.stop(
          lockstepError({
            kind: "removed",
            peer: this.self,
            step: message.step,
            why: message.why,
          })
        );
        break;
      }
      case "inputs": {
        break;
      }
    }
  }

  /**
   * Host: removes the players stepping has stalled on for `dropAfterMs`, at the next step it
   * confirms. A silent peer and one too slow to keep up both stall it. Since the last tick,
   * stepping has waited on `waitingFor`.
   */
  private dropStalledPeers(nowMs: number) {
    const side = this.host!;
    for (const peer of side.peers) {
      const stall = side.stalls.get(peer)!;
      if (this.waitingFor.includes(peer)) {
        // Stepping on at the pace input arrives isn't a stall; waiting on one step for long is.
        const step = this.confirmedThrough + 1;
        if (stall.waitingStep !== step) {
          stall.waitingStep = step;
          stall.waitingSinceMs = this.lastTickMs;
        }
        if (nowMs - stall.waitingSinceMs >= STALL_MS) {
          stall.stalledSinceMs ??= stall.waitingSinceMs;
          stall.lastStalledMs = nowMs;
        }
      } else {
        stall.waitingStep = undefined;
        if (nowMs - stall.lastStalledMs >= STALL_RECOVERY_MS) {
          stall.stalledSinceMs = undefined;
        }
      }
    }
    const stalled = side.peers.filter((peer) => {
      const since = side.stalls.get(peer)!.stalledSinceMs;
      return since !== undefined && nowMs - since >= this.dropAfterMs;
    });
    for (const peer of stalled) {
      this.removePeer(side, peer, "stalled");
    }
  }

  /** Host: removes `peer`'s player at the next step it confirms. */
  private removePeer(
    side: HostSide<PlayerInputOf<Input>, Command>,
    peer: PeerId,
    why: RemovedWhy
  ) {
    const step = this.confirmedThrough + 1;
    side.peers.splice(side.peers.indexOf(peer), 1);
    side.removing.push(peer);
    side.removed.set(peer, { step, why });
    side.pending.delete(peer);
    side.stalls.delete(peer);
    side.peerHashAck.delete(peer);
    side.hostHashAck.delete(peer);
    side.stepsAck.delete(peer);
    // A silent peer rarely hears it, and stops on its own timeout; one that speaks again is told again.
    this.sendRemoved(peer, step, why);
  }

  private sendRemoved(peer: PeerId, step: number, why: RemovedWhy) {
    this.options.transport.send(
      peer,
      JSON.stringify({ kind: "removed", step, why } satisfies Message)
    );
  }

  /** Host: confirms every next step for which every player still in the run has sent input. */
  private confirm() {
    const side = this.host!;
    const players = [this.self, ...side.peers];
    for (;;) {
      const step = this.confirmedThrough + 1;
      if (players.some((p) => !side.pending.get(p)!.has(step))) {
        return;
      }
      // Every payload decoded when it came, so confirming can't fail.
      const inputs = players.map((player) => {
        const pending = side.pending.get(player)!;
        const input = pending.get(step)!;
        pending.delete(step);
        return { player, ...input };
      });
      const removed = side.removing;
      side.removing = [];
      side.wire.set(step, [
        inputs.map(({ player, encoded }) => [player, encoded] as const),
        removed,
      ]);
      this.confirmed.set(step, {
        inputs: inputs.map(({ player, input, commands }) => ({
          player,
          input,
          commands,
        })),
        removed,
      });
      this.confirmedThrough = step;
    }
  }

  /** Peer: decodes a step from the host, or stops if a payload in it doesn't decode. */
  private decodeStep(
    step: number,
    wire: WireStep
  ): ConfirmedStep<PlayerInputOf<Input>, Command> | null {
    const inputs: PlayerStepInput<PlayerInputOf<Input>, Command>[] = [];
    for (const [player, encoded] of wire[0]) {
      const input: StepPayload<PlayerInputOf<Input>, Command> & {
        readonly player: PeerId;
      } = { player, input: null, commands: NO_COMMANDS };
      const issue = this.codec.decode(encoded, input);
      if (issue !== null) {
        this.stop(lockstepError({ kind: "badInput", player, step, issue }));
        return null;
      }
      inputs.push(input);
    }
    return { inputs, removed: wire[1] };
  }

  /**
   * Runs the steps time says are due and whose inputs are confirmed, splitting frames at hash
   * steps so each hash is of the state after exactly that many steps.
   */
  private runDueSteps(nowMs: number) {
    const maxOwed = Math.ceil((MAX_CATCH_UP_SECONDS * 1000) / this.stepMs);
    this.owed = Math.min(
      this.owed + (nowMs - this.lastTickMs) / this.stepMs,
      maxOwed
    );
    this.lastTickMs = nowMs;
    const due = Math.floor(this.owed);
    const ready = this.confirmedThrough + 1 - this.loop.stepIndex;
    let remaining = Math.min(due, ready);
    this.owed -= remaining;
    const { hashEvery } = this.options;
    while (remaining > 0) {
      const steps = Math.min(
        remaining,
        hashEvery - (this.loop.stepIndex % hashEvery)
      );
      this.loop.frame(this.buffer, { steps }, nowMs);
      remaining -= steps;
      const step = this.loop.stepIndex;
      if (step % hashEvery === 0) {
        this.ownHashes.set(step, this.options.hash(this.loop.state!));
        this.compareHashes(step);
        if (this.status === "stopped") {
          return;
        }
      }
    }
    this.waitingFor = due > ready ? this.missingPlayers() : [];
    this.status = this.waitingFor.length > 0 ? "waiting" : "running";
  }

  /** Who the next unconfirmed step waits on. */
  private missingPlayers(): readonly PeerId[] {
    if (this.host) {
      const step = this.confirmedThrough + 1;
      const side = this.host;
      return [this.self, ...side.peers].filter(
        (p) => !side.pending.get(p)!.has(step)
      );
    }
    const peer = this.peer!;
    return peer.hostWaiting.length > 0 ? peer.hostWaiting : [peer.host];
  }

  /**
   * Reads local input for every step through `stepIndex + inputDelay` not read yet. The local
   * player's commands that wait for a step ride the first of them, `MAX_STEP_COMMANDS` to a
   * step, in the order sent.
   */
  private scheduleLocalInput() {
    const { codec } = this;
    const { local, inputDelay } = this.options;
    const through = this.loop.stepIndex + inputDelay;
    if (this.nextLocal > through) {
      return;
    }
    for (; this.nextLocal <= through; this.nextLocal++) {
      let commands: readonly unknown[] = NO_COMMANDS;
      if (this.outbox.length > 0) {
        const riding = this.outbox.splice(0, MAX_STEP_COMMANDS);
        this.riding.set(this.nextLocal, riding);
        commands = riding.map((sent) => sent.wire);
      }
      const encoded = codec.encode(local.read(this.nextLocal), commands);
      local.endStep?.();
      if (this.host) {
        // The host steps on its own payload as the peers decode it: `encode` took it through
        // JSON, which is the wire (it turns -0 into 0), and the codec decodes it.
        const payload: PendingInput<PlayerInputOf<Input>, Command> = {
          encoded,
          input: null,
          commands: NO_COMMANDS,
        };
        const issue = codec.decode(encoded, payload);
        if (issue !== null) {
          this.stop(
            lockstepError({
              kind: "badInput",
              player: this.self,
              step: this.nextLocal,
              issue,
            })
          );
          return;
        }
        this.host.pending.get(this.self)!.set(this.nextLocal, payload);
      } else {
        this.peer!.unsent.set(this.nextLocal, encoded);
      }
    }
    local.endFrame?.();
  }

  /**
   * Compares the hashes known for `step`. The host compares every peer's with its own; a peer
   * compares its own with the host's. A mismatch stops the run.
   */
  private compareHashes(step: number) {
    const own = this.ownHashes.get(step);
    if (own === undefined) {
      return;
    }
    if (this.host) {
      const peers = this.host.peerHashes.get(step);
      if (peers && [...peers.values()].some((hash) => hash !== own)) {
        this.stop(
          lockstepError({
            kind: "desync",
            step,
            hashes: { [this.self]: own, ...Object.fromEntries(peers) },
          })
        );
      }
      return;
    }
    const hostHash = this.peer!.hostHashes.get(step);
    if (hostHash !== undefined && hostHash !== own) {
      this.stop(
        lockstepError({
          kind: "desync",
          step,
          hashes: { [this.peer!.host]: hostHash, [this.self]: own },
        })
      );
    }
  }

  private stop(error: LockstepError) {
    this.status = "stopped";
    this.error = error;
    this.waitingFor = [];
    // This peer's rules will answer nothing more: the senders still waiting hear after this tick.
    this.dropSends();
    if (error.reason.kind === "desync") {
      this.stopMessage = {
        kind: "desync",
        step: error.reason.step,
        hashes: error.reason.hashes,
      };
    }
    this.resendStop();
  }

  /** Keeps telling the other side about a desync, since the message may be lost. */
  private resendStop() {
    if (this.stopMessage === null) {
      return;
    }
    const text = JSON.stringify(this.stopMessage);
    const to = this.host ? this.host.peers : [this.peer!.host];
    for (const peer of to) {
      this.options.transport.send(peer, text);
    }
  }

  /** Sends what the other side hasn't acknowledged. */
  private transmit() {
    const { transport } = this.options;
    if (this.peer) {
      const { peer } = this;
      // Unsent inputs are contiguous, oldest first.
      const from: number = peer.unsent.keys().next().value ?? this.nextLocal;
      const inputs: unknown[] = [];
      for (
        let step = from;
        peer.unsent.has(step) && inputs.length < MAX_BATCH;
        step++
      ) {
        inputs.push(peer.unsent.get(step));
      }
      transport.send(
        peer.host,
        JSON.stringify({
          kind: "inputs",
          from,
          inputs,
          stepsAck: this.confirmedThrough,
          hashes: oldestHashes(this.ownHashes, -1),
          hashAck: peer.hashAck,
        } satisfies Message)
      );
      return;
    }
    const side = this.host!;
    for (const peer of side.peers) {
      if (!side.started.has(peer)) {
        transport.send(
          peer,
          JSON.stringify({
            kind: "start",
            seed: side.seed,
            contentHash: this.options.contentHash,
            players: [this.self, ...side.peers],
          } satisfies Message)
        );
        continue;
      }
      const from = side.stepsAck.get(peer)! + 1;
      const steps: WireStep[] = [];
      for (
        let step = from;
        step <= this.confirmedThrough && steps.length < MAX_BATCH;
        step++
      ) {
        steps.push(side.wire.get(step)!);
      }
      const hashAck = side.hostHashAck.get(peer)!;
      transport.send(
        peer,
        JSON.stringify({
          kind: "steps",
          from,
          steps,
          inputsAck: side.inputsKnown.get(peer)!,
          hashAck: side.peerHashAck.get(peer)!,
          hashes: oldestHashes(this.ownHashes, hashAck),
          waiting: this.waitingFor,
        } satisfies Message)
      );
    }
    this.forgetAcknowledged(side);
  }

  /** Host: forgets confirmed steps and hashes every peer still in the run has. */
  private forgetAcknowledged(side: HostSide<PlayerInputOf<Input>, Command>) {
    const { peers } = side;
    const stepsAck = Math.min(
      this.confirmedThrough,
      ...peers.map((p) => side.stepsAck.get(p)!)
    );
    for (const step of side.wire.keys()) {
      if (step <= stepsAck) {
        side.wire.delete(step);
      }
    }
    const hashesAck = Math.min(
      this.loop.stepIndex,
      ...peers.map((p) =>
        Math.min(side.hostHashAck.get(p)!, side.peerHashAck.get(p)!)
      )
    );
    for (const step of this.ownHashes.keys()) {
      if (step <= hashesAck) {
        this.ownHashes.delete(step);
      }
    }
    // Not only with `ownHashes`: a peer's resent hash can arrive after the host forgot its step.
    for (const step of side.peerHashes.keys()) {
      if (step <= hashesAck) {
        side.peerHashes.delete(step);
      }
    }
  }
}

const runEnded = (sent: LocalSend): CommandDropped =>
  new CommandDropped({ command: sent.tag, reason: "runEnded" });

/** Advances `known` for `player` past every step `pending` holds or already confirmed. */
const advanceKnown = (
  known: Map<PeerId, number>,
  player: PeerId,
  pending: Map<number, unknown>
) => {
  let through = known.get(player)!;
  while (pending.has(through + 1)) {
    through += 1;
  }
  known.set(player, through);
};

/** The oldest hashes after step `after`, as many as one message carries; the rest follow as they're acknowledged. */
const oldestHashes = (
  hashes: Map<number, number>,
  after: number
): [step: number, hash: number][] => {
  const oldest: [number, number][] = [];
  for (const [step, hash] of hashes) {
    if (oldest.length === MAX_BATCH) {
      break;
    }
    if (step > after) {
      oldest.push([step, hash]);
    }
  }
  return oldest;
};
