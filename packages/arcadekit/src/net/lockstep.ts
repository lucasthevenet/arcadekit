import { Option, Result, Schema } from "effect";

import { CommandDropped, Loop } from "../game/index";
import type {
  PlayerInputOf,
  PlayersSimulation,
  RefusalFor,
  Settled,
  StepInput,
} from "../game/index";
import { MAX_STEP_COMMANDS, payloadCodec } from "./codec";
import type { PayloadCodec, StepPayload } from "./codec";
import { lockstepError } from "./errors";
import type { LockstepError, RemovedWhy } from "./errors";
import { combinePlayerInputs } from "./player-inputs";
import type { PeerId, Transport } from "./transport";

/** One player's part of one step, as every peer steps on it. */
export interface PlayerStepInput<PlayerInput, Command> extends Readonly<
  StepPayload<PlayerInput, Command>
> {
  readonly player: PeerId;
}

/**
 * Everything the host decided for one step: each player's input and commands, in player order
 * (host first), and the players removed at this step, who are absent from it on.
 */
export interface ConfirmedStep<PlayerInput, Command> {
  readonly inputs: readonly PlayerStepInput<PlayerInput, Command>[];
  readonly removed: readonly PeerId[];
}

export interface LockstepOptions<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> {
  /**
   * What every peer runs: a simulation several players can play, whose step input was declared
   * with `Game.PlayerInputs`. The session steps it through a `Game.Loop` of its own. From that
   * declared input it takes the Schema of one player's input, which is what crosses the network
   * for each player, and it makes each step's input itself: every player's input at its slot
   * (its place in the run's player order, host first) and the players removed at that step in
   * `leaving`.
   */
  readonly simulation: PlayersSimulation<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >;
  /** This peer's config. Every peer must pass the same (the lobby agrees on it); only `contentHash` is checked at the start. */
  readonly config: Config;
  /** A digest of the content the run is played with. A peer whose hash differs from the host's refuses to start. */
  readonly contentHash: string;
  readonly transport: Transport;
  /**
   * This player's device or script: one player's input for each step, or null for a step with
   * none (nothing is attached), which every peer's rules then see at this player's slot. The
   * session reads it once per step it schedules, `inputDelay` steps ahead, calling `endStep`
   * after each read and `endFrame` once per tick that read any. What it reads must be what the
   * one-player Schema encodes: a tick throws on a value it refuses.
   */
  readonly local: StepInput<PlayerInputOf<Input> | null>;
  /** A digest of the whole state, the same on every peer for the same run. Compared every `hashEvery` steps. */
  readonly hash: (state: State) => number;
  /** How many steps ahead local input is scheduled (ADR-0012). 2 to 6 at 60 Hz. */
  readonly inputDelay: number;
  /** Peers compare state hashes after every this many steps. */
  readonly hashEvery: number;
  /**
   * How long the host lets stepping stall on a player before removing them, and a peer waits on
   * a silent host before giving up. Defaults to 10 000 ms. A stall is a wait on a player's input
   * of `STALL_MS` or more; it goes on until a second passes without one. So a peer that still
   * sends but can't keep up, such as a hidden tab whose timers are throttled to 1 Hz, is
   * removed as a silent one is.
   */
  readonly dropAfterMs?: number;
}

export interface HostOptions<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> extends LockstepOptions<Config, State, Input, Event, Command, Refusals> {
  /**
   * The other players' peer ids, in player order. The host is always the first player, so the
   * run's player order is the host, then these: what every guest passes as `players`. A run
   * holds at most 16 players, the host included.
   */
  readonly peers: readonly PeerId[];
  readonly seed: number;
}

export interface JoinOptions<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> extends LockstepOptions<Config, State, Input, Event, Command, Refusals> {
  readonly host: PeerId;
  /**
   * The run's player order, as the lobby agreed it: the host, then the `peers` the host passes,
   * this peer among them. A player's slot is its index here for the whole run. The host's start
   * message doesn't say it: it lists who is still in the run when it is sent, and a guest that
   * first hears it after a player was removed must still put every input at the slot the others
   * do.
   */
  readonly players: readonly PeerId[];
}

/**
 * - `joining`: a peer that hasn't had the host's start message yet. A command sent now waits
 *   for the run's first steps.
 * - `running`: stepping.
 * - `waiting`: a step is due but some player's input for it hasn't arrived (`waitingFor`).
 * - `stopped`: for good, with `error` saying why.
 */
export type LockstepStatus = "joining" | "running" | "waiting" | "stopped";

/**
 * One peer's side of a lockstep run. Drive it with `tick(nowMs)` from a timer, often (every few
 * milliseconds is fine): each tick reads what arrived, steps every due step whose inputs are all
 * confirmed, schedules local input and sends. Time comes only from `nowMs`, and what the run
 * reports reaches its listeners inside a tick, never outside one. In an Effect program,
 * `hostLockstepScoped` and `joinLockstepScoped` make one owned by a scope and run it.
 */
export interface LockstepSession<State, Event, Command, Refusals> {
  readonly status: LockstepStatus;
  /** Why the session stopped, or null. */
  readonly error: LockstepError | null;
  /** The players whose input the next step waits on, while `status` is `waiting`. Show them ("waiting for X"). */
  readonly waitingFor: readonly PeerId[];
  /**
   * The run's players still in it, in player order. Empty until the run starts. Not where a
   * slot comes from: a player keeps its slot when another leaves.
   */
  readonly players: readonly PeerId[];
  /** The run's state, to draw. Read it; never change it. Null before the run starts. */
  readonly state: State | null;
  /** Steps run since the start. */
  readonly stepIndex: number;
  readonly tick: (nowMs: number) => void;
  /**
   * Hears the run's events and samples, as `Game.Loop`'s `subscribe`. Returns a function that
   * stops it.
   *
   * A session reports from its ticks and from nowhere else, so a listener in place before the
   * first tick hears the run from its start: what `create` reports, then the first sample, then
   * what each tick's steps report. A guest's run starts in a tick, the one that has the host's
   * start message. A host's starts as the session is made, before anything can listen to it:
   * the session keeps what that start reported and tells it at its first tick, before the tick
   * does anything else. No step has run by then, so `state` is still the one `create` made. A
   * listener that comes later hears what comes after it: nothing is told twice.
   *
   * A listener is called inside the tick, before the senders (`send`) whose commands that
   * tick's steps answered are told.
   */
  readonly subscribe: (listener: (event: Event) => void) => () => void;
  /**
   * Sends a command to the run as this peer's player: `Game.Loop`'s `send`, without the slot.
   * The command rides this player's payload for the next step the session schedules (`inputDelay`
   * steps ahead, as its input does), so every peer's rules get it at the start of that same step,
   * after the commands of the players before this one in player order, and take or refuse it
   * alike. At most four commands ride one step: a fifth rides the next, in the order sent. A
   * command sent while the session is `joining` waits for the first steps the run schedules.
   *
   * ```ts
   * session.send(new ChooseUpgrade({ offer, index }), (outcome) => {
   *   if (outcome?._tag === "OfferClosed") {
   *     // This peer's rules refused it, and so did every other peer's.
   *   }
   * });
   * ```
   *
   * `settled` is called once, on this peer only, with how the command ended here: `undefined`
   * when this peer's rules took it, the rejection they refused it with, or a `CommandDropped`
   * (`runEnded`) when they gave no answer: the session stopped, was disposed or threw out of a
   * tick first, or the step came back from the host without the command. After a stop or a
   * dispose it is called at once. Otherwise it is called once the session is out of the tick that
   * ended the command, so it may send again.
   *
   * A listener (`subscribe`) is called inside the tick, so whenever `settled` hears the rules'
   * answer, the listeners have heard everything that tick's steps reported, the command's step
   * among them. A tick that throws before it has told that step tells the sender
   * `CommandDropped`: no sender hears the rules' answer to a command whose step its listeners
   * did not hear.
   *
   * It speaks for this peer's rules alone. A player the host removes after it confirmed the
   * step of that player's command is told `runEnded`, though the peers still in the run applied
   * the command: no peer can tell from where it stands.
   *
   * Returns a function that takes the command back while it waits for a step: until the session
   * next schedules one, which is about a step in a run that steps, and longer in a stall. Once it
   * rides a step it is every peer's, and taking it back only keeps `settled` from being called.
   *
   * Throws for a command the simulation doesn't declare, and for one that can't cross the
   * network: a value JSON doesn't carry (a NaN), which no peer could decode.
   */
  readonly send: <C extends Command>(
    command: C,
    settled?: (outcome: Settled<RefusalFor<Refusals, C>>) => void
  ) => () => void;
  /**
   * Stops listening to the transport, and drops the commands the rules haven't answered: their
   * senders hear `CommandDropped` before it returns.
   */
  readonly dispose: () => void;
}

/**
 * Starts a run as its host, now: the host is the first player, and `peers` the others. The run's
 * state is there when it returns. What the start reports (what the simulation's `create`
 * reports, then the first sample) is told at the session's first tick, as everything a session
 * reports is told from a tick: `subscribe` before that tick to hear the run from its start, as
 * a guest's listener does.
 *
 * ```ts
 * const session = hostLockstep(
 *   {
 *     simulation: Survivors,
 *     config: { content, heroIds: ["bolter", "burner"] },
 *     contentHash: "content-v1",
 *     transport,
 *     local: { read: () => ({ moveX: 1, moveZ: 0 }) },
 *     hash: hashWorld,
 *     inputDelay: 4,
 *     hashEvery: 60,
 *     peers: ["guest"],
 *     seed: 1234,
 *   },
 *   0
 * );
 * // Before the first tick: it hears the run from its start.
 * session.subscribe(Survivors.match({ ... }));
 * session.tick(16);
 * ```
 *
 * Throws a RangeError for more players than a run holds, an Error for a simulation whose step
 * input was not declared with `Game.PlayerInputs` (a type error first), and what starting throws
 * (the simulation's `create`, the input source), each with nothing left listening.
 */
export const hostLockstep = <Config, State, Input, Event, Command, Refusals>(
  options: HostOptions<Config, State, Input, Event, Command, Refusals>,
  nowMs: number
): LockstepSession<State, Event, Command, Refusals> => {
  if (options.peers.length + 1 > MAX_PLAYERS) {
    throw new RangeError(
      `A lockstep run holds at most ${MAX_PLAYERS} players, not ${options.peers.length + 1}`
    );
  }
  const { self } = options.transport;
  const session = new Session(options, self, [self, ...options.peers], nowMs);
  try {
    session.startAsHost(options.peers, options.seed, nowMs);
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
};

/**
 * Joins the run `host` starts, with the options the host passed but `peers` and `seed`, and
 * with the run's player order as `players`. The session is `joining` until the host's start
 * message arrives: the tick that has it starts the run, and tells what the start reports.
 * Throws for a simulation whose step input was not declared with `Game.PlayerInputs`, as
 * `hostLockstep` does.
 */
export const joinLockstep = <Config, State, Input, Event, Command, Refusals>(
  options: JoinOptions<Config, State, Input, Event, Command, Refusals>,
  nowMs: number
): LockstepSession<State, Event, Command, Refusals> =>
  new Session(options, options.host, options.players, nowMs);

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

class Session<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> implements LockstepSession<State, Event, Command, Refusals> {
  status: LockstepStatus = "joining";
  error: LockstepError | null = null;
  waitingFor: readonly PeerId[] = [];
  players: readonly PeerId[] = [];

  private readonly options: LockstepOptions<
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
    options: LockstepOptions<Config, State, Input, Event, Command, Refusals>,
    host: PeerId,
    order: readonly PeerId[],
    nowMs: number
  ) {
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
    this.loop = new Loop<Config, State, Input, Event, Command, Refusals>(
      options.simulation
    );
    this.loop.subscribe((event) => this.emit(event));
    this.stepMs = options.simulation.definition.stepSeconds * 1000;
    this.dropAfterMs = options.dropAfterMs ?? 10_000;
    this.lastTickMs = nowMs;
    if (host !== this.self) {
      this.peer = {
        host,
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
    // that tick, since the caller has no session to listen to until this returns (ADR-0022).
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
    host: HostSide<PlayerInputOf<Input>, Command>,
    from: PeerId,
    message: Message
  ) {
    if (!host.peers.includes(from)) {
      const removed = host.removed.get(from);
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
      this.receivePeerHash(host, from, message.step, hash);
      return;
    }
    if (message.kind !== "inputs") {
      return;
    }
    host.started.add(from);
    const pending = host.pending.get(from)!;
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
          this.removePeer(host, from, "badInput");
          return;
        }
        pending.set(step, payload);
      }
    }
    advanceKnown(host.inputsKnown, from, pending);
    host.stepsAck.set(
      from,
      Math.max(host.stepsAck.get(from)!, message.stepsAck)
    );
    host.hostHashAck.set(
      from,
      Math.max(host.hostHashAck.get(from)!, message.hashAck)
    );
    for (const [step, hash] of message.hashes) {
      this.receivePeerHash(host, from, step, hash);
    }
  }

  /** Keeps a peer's hash for `step` and compares it, if the peer can have hashed that step. */
  private receivePeerHash(
    host: HostSide<PlayerInputOf<Input>, Command>,
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
    host.peerHashAck.set(from, Math.max(host.peerHashAck.get(from)!, step));
    let hashes = host.peerHashes.get(step);
    if (!hashes) {
      hashes = new Map();
      host.peerHashes.set(step, hashes);
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
    const host = this.host!;
    for (const peer of host.peers) {
      const stall = host.stalls.get(peer)!;
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
    const stalled = host.peers.filter((peer) => {
      const since = host.stalls.get(peer)!.stalledSinceMs;
      return since !== undefined && nowMs - since >= this.dropAfterMs;
    });
    for (const peer of stalled) {
      this.removePeer(host, peer, "stalled");
    }
  }

  /** Host: removes `peer`'s player at the next step it confirms. */
  private removePeer(
    host: HostSide<PlayerInputOf<Input>, Command>,
    peer: PeerId,
    why: RemovedWhy
  ) {
    const step = this.confirmedThrough + 1;
    host.peers.splice(host.peers.indexOf(peer), 1);
    host.removing.push(peer);
    host.removed.set(peer, { step, why });
    host.pending.delete(peer);
    host.stalls.delete(peer);
    host.peerHashAck.delete(peer);
    host.hostHashAck.delete(peer);
    host.stepsAck.delete(peer);
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
    const host = this.host!;
    const players = [this.self, ...host.peers];
    for (;;) {
      const step = this.confirmedThrough + 1;
      if (players.some((p) => !host.pending.get(p)!.has(step))) {
        return;
      }
      // Every payload decoded when it came, so confirming can't fail.
      const inputs = players.map((player) => {
        const pending = host.pending.get(player)!;
        const input = pending.get(step)!;
        pending.delete(step);
        return { player, ...input };
      });
      const removed = host.removing;
      host.removing = [];
      host.wire.set(step, [
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
      const { host } = this;
      return [this.self, ...host.peers].filter(
        (p) => !host.pending.get(p)!.has(step)
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
    const host = this.host!;
    for (const peer of host.peers) {
      if (!host.started.has(peer)) {
        transport.send(
          peer,
          JSON.stringify({
            kind: "start",
            seed: host.seed,
            contentHash: this.options.contentHash,
            players: [this.self, ...host.peers],
          } satisfies Message)
        );
        continue;
      }
      const from = host.stepsAck.get(peer)! + 1;
      const steps: WireStep[] = [];
      for (
        let step = from;
        step <= this.confirmedThrough && steps.length < MAX_BATCH;
        step++
      ) {
        steps.push(host.wire.get(step)!);
      }
      const hashAck = host.hostHashAck.get(peer)!;
      transport.send(
        peer,
        JSON.stringify({
          kind: "steps",
          from,
          steps,
          inputsAck: host.inputsKnown.get(peer)!,
          hashAck: host.peerHashAck.get(peer)!,
          hashes: oldestHashes(this.ownHashes, hashAck),
          waiting: this.waitingFor,
        } satisfies Message)
      );
    }
    this.forgetAcknowledged(host);
  }

  /** Host: forgets confirmed steps and hashes every peer still in the run has. */
  private forgetAcknowledged(host: HostSide<PlayerInputOf<Input>, Command>) {
    const { peers } = host;
    const stepsAck = Math.min(
      this.confirmedThrough,
      ...peers.map((p) => host.stepsAck.get(p)!)
    );
    for (const step of host.wire.keys()) {
      if (step <= stepsAck) {
        host.wire.delete(step);
      }
    }
    const hashesAck = Math.min(
      this.loop.stepIndex,
      ...peers.map((p) =>
        Math.min(host.hostHashAck.get(p)!, host.peerHashAck.get(p)!)
      )
    );
    for (const step of this.ownHashes.keys()) {
      if (step <= hashesAck) {
        this.ownHashes.delete(step);
      }
    }
    // Not only with `ownHashes`: a peer's resent hash can arrive after the host forgot its step.
    for (const step of host.peerHashes.keys()) {
      if (step <= hashesAck) {
        host.peerHashes.delete(step);
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
