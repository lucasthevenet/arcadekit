import { GameLoop } from "@arcadekit/runtime";
import type { GameSimulation, StepInput } from "@arcadekit/runtime";
import { Option, Result, Schema } from "effect";

import type { InputCodec } from "./codec";
import { lockstepError } from "./errors";
import type { LockstepError, RemovedWhy } from "./errors";
import type { PeerId, Transport } from "./transport";

/** One player's input for one step, as every peer steps on it. */
export interface PlayerStepInput<PlayerInput> {
  readonly player: PeerId;
  readonly input: PlayerInput;
}

/**
 * Everything the host decided for one step: each player's input, in player order (host first),
 * and the players removed at this step, whose inputs are absent from it on.
 */
export interface ConfirmedStep<PlayerInput> {
  readonly inputs: readonly PlayerStepInput<PlayerInput>[];
  readonly removed: readonly PeerId[];
}

export interface LockstepOptions<Config, State, Input, Event, PlayerInput> {
  /** What every peer runs. The session makes its own `GameLoop` for it. */
  readonly simulation: GameSimulation<Config, State, Input, Event>;
  /** This peer's config. Every peer must pass the same (the lobby agrees on it); only `contentHash` is checked at the start. */
  readonly config: Config;
  /** A digest of the content the run is played with. A peer whose hash differs from the host's refuses to start. */
  readonly contentHash: string;
  readonly transport: Transport;
  /**
   * This player's device or script. The session reads it once per step it schedules, `inputDelay`
   * steps ahead, calling `endStep` after each read and `endFrame` once per tick that read any.
   */
  readonly local: StepInput<PlayerInput>;
  readonly codec: InputCodec<PlayerInput>;
  /**
   * Makes the simulation's input for one step from every player's. Called once per step, inside
   * the step loop, so it may return the same object each time, refilled.
   */
  readonly combine: (step: ConfirmedStep<PlayerInput>) => Input;
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
  PlayerInput,
> extends LockstepOptions<Config, State, Input, Event, PlayerInput> {
  /**
   * The other players' peer ids, in player order. The host is always the first player. A run
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
  PlayerInput,
> extends LockstepOptions<Config, State, Input, Event, PlayerInput> {
  readonly host: PeerId;
}

/**
 * - `joining`: a peer that hasn't had the host's start message yet.
 * - `running`: stepping.
 * - `waiting`: a step is due but some player's input for it hasn't arrived (`waitingFor`).
 * - `stopped`: for good, with `error` saying why.
 */
export type LockstepStatus = "joining" | "running" | "waiting" | "stopped";

/**
 * One peer's side of a lockstep run. Drive it with `tick(nowMs)` from a timer, often (every few
 * milliseconds is fine): each tick reads what arrived, steps every due step whose inputs are all
 * confirmed, schedules local input and sends. Time comes only from `nowMs`. In an Effect
 * program, `hostLockstepScoped` and `joinLockstepScoped` make one owned by a scope and run it.
 */
export interface LockstepSession<State, Event> {
  readonly status: LockstepStatus;
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
  readonly tick: (nowMs: number) => void;
  /** Hears the run's events and samples, as `GameLoop.subscribe`. */
  readonly subscribe: (listener: (event: Event) => void) => () => void;
  /** Stops listening to the transport. */
  readonly dispose: () => void;
}

/**
 * Starts a run as its host, now: the host is the first player, and `peers` the others. Throws a
 * RangeError for more players than a run holds, and what starting throws (the simulation's
 * `create`, the input source), with nothing left listening.
 */
export const hostLockstep = <Config, State, Input, Event, PlayerInput>(
  options: HostOptions<Config, State, Input, Event, PlayerInput>,
  nowMs: number
): LockstepSession<State, Event> => {
  if (options.peers.length + 1 > MAX_PLAYERS) {
    throw new RangeError(
      `A lockstep run holds at most ${MAX_PLAYERS} players, not ${options.peers.length + 1}`
    );
  }
  const session = new Session(options, options.transport.self, nowMs);
  try {
    session.startAsHost(options.peers, options.seed, nowMs);
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
};

/** Joins the run `host` starts. The session is `joining` until the host's start message arrives. */
export const joinLockstep = <Config, State, Input, Event, PlayerInput>(
  options: JoinOptions<Config, State, Input, Event, PlayerInput>,
  nowMs: number
): LockstepSession<State, Event> => new Session(options, options.host, nowMs);

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

/** One confirmed step: [player, encoded input] pairs, then the removed players. */
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

/** One player's input for a step, as it came on the wire and as it decoded. */
interface PendingInput<PlayerInput> {
  readonly encoded: unknown;
  readonly input: PlayerInput;
}

interface HostSide<PlayerInput> {
  /** The other players still in the run, in player order. */
  readonly peers: PeerId[];
  /** Each player's inputs not yet in a confirmed step, by step. The host's own included. */
  readonly pending: Map<PeerId, Map<number, PendingInput<PlayerInput>>>;
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
  /** This peer's inputs the host may not have yet, by step, encoded. */
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
  PlayerInput,
> implements LockstepSession<State, Event> {
  status: LockstepStatus = "joining";
  error: LockstepError | null = null;
  waitingFor: readonly PeerId[] = [];
  players: readonly PeerId[] = [];

  private readonly options: LockstepOptions<
    Config,
    State,
    Input,
    Event,
    PlayerInput
  >;
  private readonly loop: GameLoop<Config, State, Input, Event>;
  private readonly self: PeerId;
  private readonly stepMs: number;
  private readonly dropAfterMs: number;
  private readonly inbox: [PeerId, string][] = [];
  private readonly unlisten: () => void;
  private host: HostSide<PlayerInput> | null = null;
  private peer: PeerSide | null = null;
  /** Confirmed steps not yet run, decoded. */
  private readonly confirmed = new Map<number, ConfirmedStep<PlayerInput>>();
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

  constructor(
    options: LockstepOptions<Config, State, Input, Event, PlayerInput>,
    host: PeerId,
    nowMs: number
  ) {
    this.options = options;
    this.self = options.transport.self;
    this.loop = new GameLoop(options.simulation);
    this.stepMs = (options.simulation.stepSeconds ?? 1 / 60) * 1000;
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
        return this.options.combine(confirmed);
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
    return this.loop.subscribe(listener);
  }

  dispose(): void {
    this.unlisten();
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
    this.begin(players, seed, nowMs);
  }

  tick(nowMs: number): void {
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
    this.send();
  }

  /** Starts the run on this peer: same seed, same config, everywhere. */
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
    host: HostSide<PlayerInput>,
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
        const encoded = message.inputs[i];
        const decoded = this.options.codec.decode(encoded);
        if (Result.isFailure(decoded)) {
          // Its peer plays other code, or forged it; the others run on without it.
          this.removePeer(host, from, "badInput");
          return;
        }
        pending.set(step, { encoded, input: decoded.success });
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
    host: HostSide<PlayerInput>,
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
    host: HostSide<PlayerInput>,
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
      // Every input decoded when it came, so confirming can't fail.
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
        inputs: inputs.map(({ player, input }) => ({ player, input })),
        removed,
      });
      this.confirmedThrough = step;
    }
  }

  /** Peer: decodes a step from the host, or stops if an input in it doesn't decode. */
  private decodeStep(
    step: number,
    wire: WireStep
  ): ConfirmedStep<PlayerInput> | null {
    const inputs: PlayerStepInput<PlayerInput>[] = [];
    for (const [player, encoded] of wire[0]) {
      const decoded = this.options.codec.decode(encoded);
      if (Result.isFailure(decoded)) {
        this.stop(
          lockstepError({
            kind: "badInput",
            player,
            step,
            issue: decoded.failure,
          })
        );
        return null;
      }
      inputs.push({ player, input: decoded.success });
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

  /** Reads local input for every step through `stepIndex + inputDelay` not read yet. */
  private scheduleLocalInput() {
    const { local, codec, inputDelay } = this.options;
    const through = this.loop.stepIndex + inputDelay;
    if (this.nextLocal > through) {
      return;
    }
    for (; this.nextLocal <= through; this.nextLocal++) {
      const encoded = codec.encode(local.read(this.nextLocal));
      local.endStep?.();
      if (this.host) {
        // The host steps on its own input as the peers decode it: through JSON, then the codec.
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON is the wire: it turns -0 into 0.
        const wire = JSON.parse(JSON.stringify(encoded)) as unknown;
        const decoded = codec.decode(wire);
        if (Result.isFailure(decoded)) {
          this.stop(
            lockstepError({
              kind: "badInput",
              player: this.self,
              step: this.nextLocal,
              issue: decoded.failure,
            })
          );
          return;
        }
        this.host.pending
          .get(this.self)!
          .set(this.nextLocal, { encoded: wire, input: decoded.success });
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

  private send() {
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
  private forgetAcknowledged(host: HostSide<PlayerInput>) {
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
