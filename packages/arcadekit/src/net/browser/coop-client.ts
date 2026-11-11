import { Cause, Data, Effect, Fiber, FiberHandle, Queue, Stream } from "effect";
import type { Clock, Scope } from "effect";

import type { LocalPlayer, ViewContext } from "../../game/browser";
import { CommandDropped } from "../../game/index";
import type { PlayerInputOf, PlayersSimulation } from "../../game/index";
import { attachError, frameLoop } from "../../runtime/browser";
import type { FrameSource, GameView } from "../../runtime/browser";
import type { InputSource, StepInput } from "../../runtime/index";
import { contentHash } from "../content-hash";
import type { LockstepError } from "../errors";
import {
  canStart,
  encodeLobbyMessage,
  knownPicks,
  parseLobbyMessage,
  playerName,
  startPlan,
  withPick,
  withPlayer,
  withoutPlayer,
} from "../lobby";
import type { LobbyMessage, LobbyPick } from "../lobby";
import type { LockstepOptions } from "../lockstep";
import { hostLockstepScoped, joinLockstepScoped } from "../scoped";
import type { ScopedLockstepSession, Ticker } from "../scoped";
import { DEFAULT_ROOM_SIZE } from "../signalling/protocol";
import type { PeerId } from "../transport";
import { linksTransport } from "./channel";
import type { PeerLink } from "./channel";
import type { CoopClient } from "./coop";
import {
  LobbyChanged,
  RunStarted,
  SeatFailed,
  WaitingChanged,
} from "./coop-events";
import type { CoopEvent, CoopFailure } from "./coop-events";
import type { Rooms } from "./coop-rooms";
import type { RoomError } from "./errors";
import type { RoomEvent, SignallingRoom } from "./signalling";

// The Co-op client's implementation. Its lifecycles are Effect: a seat is a fiber whose scope
// owns the room, the lobby, the session and the ticker, and an attach is a scope that owns the
// view and the input. What runs per tick and per frame is plain code (ADR-0017).

/** The view and input source factories of one attach, with what they use already given. */
export interface CoopPresented<State, PlayerInput> {
  readonly view: (
    container: HTMLElement,
    context: ViewContext
  ) => GameView<State>;
  readonly input: (surface: HTMLElement) => InputSource<PlayerInput>;
}

/**
 * What the Co-op client is made from: a `Coop` declaration with nothing left to resolve. What
 * it uses has its services, and the app's rooms, the ticker and the frame clock are beside it.
 * Only the kit builds one: the `Coop` builder's `layer`, and the test game's client in
 * `arcadekit/net/testing`.
 */
export interface CoopParts<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
  Content,
  E,
> {
  readonly simulation: PlayersSimulation<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >;
  /** Run once per seat, in the seat's fiber, so leaving cancels it. */
  readonly content: Effect.Effect<Content, { readonly message: string }>;
  /** Run once per attach, in the attach's scope, before the view and the input are made. */
  readonly presentation: Effect.Effect<
    CoopPresented<State, PlayerInputOf<Input>>,
    E,
    Scope.Scope
  >;
  readonly hash: (state: State) => number;
  readonly picks: (content: Content) => readonly string[];
  readonly config: (content: Content, picks: readonly string[]) => Config;
  /** A signalling room's default size (4) if left out. */
  readonly maxPlayers?: number;
  /** Defaults 4 steps ahead (67 ms at 60 Hz, ADR-0012) and a hash every 60 steps. */
  readonly lockstep?: {
    readonly inputDelay?: number;
    readonly hashEvery?: number;
  };
  /** The tags of the events that end a run: after one, a lost host or peer is no failure. */
  readonly ends: ReadonlySet<string>;
  readonly rooms: Rooms;
  /** Makes what ticks a run, in the run's scope: the `CoopTicker` reference's value. */
  readonly ticker: Effect.Effect<Ticker, never, Scope.Scope>;
  readonly frames: FrameSource;
}

/** A seat's own failure: what isn't the room's error or the session's stop. */
class SeatError extends Data.TaggedError("SeatError")<{
  readonly reason: CoopFailure;
  readonly message: string;
}> {}

/** What a seat can fail with: each is reported as `failed`. */
type SeatFailure = RoomError | SeatError | LockstepError;

/** What a seat's lobby handles, one at a time. */
type LobbyInput =
  | { readonly type: "room"; readonly event: RoomEvent }
  /** A lobby message from `from`, on its link's reliable channel. */
  | {
      readonly type: "said";
      readonly from: PeerId;
      readonly message: LobbyMessage;
    }
  /** The local player's lobby pick changed. */
  | { readonly type: "pick"; readonly pick: string }
  /** The local player asked to start. */
  | { readonly type: "start" };

/** Who plays the run, by slot, and their lobby picks. The host draws the seed. */
interface RunPlan {
  readonly players: readonly PeerId[];
  readonly picks: readonly string[];
  readonly seed?: number;
}

/**
 * This player's place in one room, from its host or join to the next host, join or leave.
 * Its fiber owns the room, the lobby, the session and the ticker; the client reads the rest.
 */
interface Seat<State, Event, Command, Refusals> {
  pick: string;
  /** The lobby's inputs, while the lobby runs. */
  lobby: Queue.Enqueue<LobbyInput, RoomError | SeatError> | null;
  slot: number;
  /** Every player's peer id, by slot. */
  players: readonly PeerId[];
  /** Every player's name, by slot. */
  names: readonly string[];
  run: ScopedLockstepSession<State, Event, Command, Refusals> | null;
  /** Ticks the run, while it runs: a frame ticks it before drawing. */
  frameTick: (() => void) | null;
  /** The run ended: what the session reports after that (the others leaving) is no failure. */
  ended: boolean;
  /** The seat failed: it has said its last. */
  failed: boolean;
  /** The players shown as waited on: a bit per slot. */
  waitingMask: number;
  /** Since when stepping has waited without a break, or null. */
  waitingSinceMs: number | null;
  readonly hashes: Map<number, number>;
}

/**
 * How long stepping must wait before the players it waits on are shown. Lockstep waits a frame
 * now and then as input arrives; that isn't worth a banner.
 */
const WAITING_SHOWN_MS = 300;
/** How many recent state hashes `debug` keeps. */
const KEPT_HASHES = 32;
/** Steps ahead local input is scheduled, without the game's own number (ADR-0012). */
const INPUT_DELAY = 4;
/** Steps between state hash comparisons, without the game's own number. */
const HASH_EVERY = 60;
const NO_NAMES: readonly string[] = [];

const stopMessage = (error: LockstepError): string => {
  const { reason } = error;
  switch (reason.kind) {
    case "desync": {
      return `The run stopped: the players' games no longer match. ${error.message}.`;
    }
    case "contentMismatch": {
      return `Your game content differs from the host's, so you can't play this run together (host ${reason.hostContentHash}, yours ${reason.localContentHash}).`;
    }
    case "removed": {
      return reason.why === "stalled"
        ? `The host removed you from the run at step ${reason.step}: it waited on you too long.`
        : `The host removed you from the run at step ${reason.step}: your game sent input it couldn't read. Are you both on the same version?`;
    }
    case "badInput": {
      return `The run stopped: input from ${reason.player} for step ${reason.step} couldn't be read. Are you both on the same version?`;
    }
    case "hostLost": {
      return `Lost the host: nothing heard for ${Math.round(reason.silentMs / 1000)} s. The run is over.`;
    }
  }
};

const failureOf = (
  error: SeatFailure
): { readonly reason: CoopFailure; readonly message: string } => {
  switch (error._tag) {
    case "LockstepError": {
      return { reason: error.reason.kind, message: stopMessage(error) };
    }
    case "RoomError": {
      return { reason: "room", message: error.message };
    }
    case "SeatError": {
      return { reason: error.reason, message: error.message };
    }
  }
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The Clock's monotonic time in milliseconds, as the session reads it. */
const millis = (clock: Clock.Clock): number =>
  Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;

/** The names of the slots set in `mask`, in slot order. */
const namesOf = (names: readonly string[], mask: number): string[] => {
  const result: string[] = [];
  for (let slot = 0; slot < names.length; slot++) {
    if ((mask & (1 << slot)) !== 0) {
      result.push(names[slot]!);
    }
  }
  return result;
};

const makeSeat = <State, Event, Command, Refusals>(
  pick: string
): Seat<State, Event, Command, Refusals> => ({
  pick,
  lobby: null,
  slot: 0,
  players: [],
  names: NO_NAMES,
  run: null,
  frameTick: null,
  ended: false,
  failed: false,
  waitingMask: 0,
  waitingSinceMs: null,
  hashes: new Map(),
});

/**
 * The Co-op client of `parts`. Its scope (the app) owns the current seat: closing it leaves.
 *
 * Each host or join is one fiber, a seat, in a `FiberHandle`: it loads the content, opens the
 * room, runs the lobby, then the run, and its scope owns all of them. A new host or join
 * interrupts the seat before it, and leave interrupts it and waits for it to close. A seat's
 * fiber ends no sooner than the one before it, so waiting for the last seat waits for them all.
 * Only host, join and leave choose the current seat, and a seat reports only while it is
 * current, so a seat being closed can't speak over the next.
 */
export const coopClient = <
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
  Content,
  E,
>(
  parts: CoopParts<Config, State, Input, Event, Command, Refusals, Content, E>
): Effect.Effect<
  CoopClient<State, Event, Command, E, Refusals>,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    type PlayerInput = PlayerInputOf<Input>;
    type Seated = Seat<State, Event, Command, Refusals>;

    const seats = yield* FiberHandle.make();
    // Seats fork from plain code (host and join), on the Scheduler and Clock the client was made with.
    const runSeat = yield* FiberHandle.runtime(seats)<never>();
    const { frames } = parts;
    const maxPlayers = parts.maxPlayers ?? DEFAULT_ROOM_SIZE;
    const listeners = new Set<(event: CoopEvent<Event>) => void>();
    let current: Seated | null = null;
    /** The fiber of the last seat taken: the next waits for it to close before it speaks. */
    let lastSeat: Fiber.Fiber<unknown, unknown> | null = null;
    /** The attached devices, while attached. */
    let device: InputSource<PlayerInput> | null = null;
    let attached = false;
    // Closing the client's scope leaves: no seat is this player's while the handle closes it.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        current = null;
      })
    );

    /**
     * The local player's seat, read live: by the attached view when it draws, and by whoever
     * hears one of the run's events, when it hears it.
     */
    const local: LocalPlayer = {
      get slot() {
        return current?.slot ?? 0;
      },
      get names() {
        return current?.names ?? NO_NAMES;
      },
    };
    const seated: ViewContext = { local };

    /** Reports `event` if `seat` is still this player's: a seat being replaced says nothing. */
    const emit = (seat: Seated, event: CoopEvent<Event>) => {
      if (current !== seat || seat.failed) {
        return;
      }
      for (const listener of listeners) {
        listener(event);
      }
    };

    /** Reports the seat's failure: its last event. */
    const fail = (seat: Seated, reason: CoopFailure, message: string) => {
      emit(seat, new SeatFailed({ reason, message }));
      seat.failed = true;
    };

    // The lobby: one input at a time, from the room, the links and the local player.
    const lobby = (
      seat: Seated,
      room: SignallingRoom,
      content: Content
    ): Effect.Effect<RunPlan, RoomError | SeatError, Scope.Scope> =>
      Effect.gen(function* () {
        const inputs = yield* Queue.unbounded<
          LobbyInput,
          RoomError | SeatError
        >();
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            seat.lobby = inputs;
          }),
          () =>
            Effect.sync(() => {
              seat.lobby = null;
            })
        );
        // The room's events, until its start, then the room's failure if it fails first, a bug
        // in it included.
        yield* Effect.forkScoped(
          room.events.pipe(
            Stream.runForEach((event) =>
              Queue.offer(inputs, { type: "room", event })
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Queue.failCause(inputs, cause)
            )
          )
        );
        const { role, code, self } = room;
        /** This game's lobby picks: what the host starts with, and what a guest accepts. */
        const valid = parts.picks(content);
        /** The host keeps the lobby; a guest has the host's last word on it. */
        let roster: readonly LobbyPick[] =
          role === "host" ? [{ id: self, pick: seat.pick }] : [];
        const emitLobby = () =>
          emit(
            seat,
            new LobbyChanged({
              role,
              code,
              self,
              players: roster.map(({ id, pick }) => ({
                id,
                name: playerName(id),
                pick,
              })),
              maxPlayers,
              canStart: canStart(roster, maxPlayers),
            })
          );
        /** Host: tells every guest the lobby, and the app. */
        const shareLobby = () => {
          if (role === "host") {
            const text = encodeLobbyMessage({ type: "lobby", players: roster });
            for (const link of room.links()) {
              link.messages.send(text);
            }
          }
          emitLobby();
        };
        const sendToHost = (message: LobbyMessage) => {
          const link = room.links().find(({ peer }) => peer === room.host);
          link?.messages.send(encodeLobbyMessage(message));
        };
        /** Hears what `link`'s peer says until the lobby ends. */
        const listenTo = (link: PeerLink) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              link.messages.listen((text) => {
                const message = parseLobbyMessage(text);
                if (message !== undefined) {
                  Queue.offerUnsafe(inputs, {
                    type: "said",
                    from: link.peer,
                    message,
                  });
                }
              })
            ),
            (stop) => Effect.sync(stop)
          );

        /**
         * Host: the worker confirmed the start. Everyone linked plays, in lobby order, and a
         * pick the game doesn't have becomes its first. A guest that linked since the host asked
         * can make one too many for the game: the last to join get a start without them.
         */
        const startAsHost = (): RunPlan => {
          const linked = new Set(room.links().map(({ peer }) => peer));
          const plan = startPlan(roster, linked, self, valid, maxPlayers);
          const text = encodeLobbyMessage({ type: "start", ...plan });
          for (const link of room.links()) {
            link.messages.send(text);
          }
          return {
            ...plan,
            seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
          };
        };

        /**
         * A guest: what the host says. The start ends the lobby, unless it leaves this player
         * out, or this player's game can't play it: more players than it takes, or a pick it
         * doesn't have, which would stop the run on every peer at its start. Only a host on
         * another build starts either.
         */
        const hearHost = (
          message: LobbyMessage
        ): Effect.Effect<RunPlan | undefined, SeatError> => {
          switch (message.type) {
            case "lobby": {
              roster = message.players;
              emitLobby();
              return Effect.succeed(undefined);
            }
            case "start": {
              if (!message.players.includes(self)) {
                return Effect.fail(
                  new SeatError({
                    reason: "leftOut",
                    message: "The run started without you.",
                  })
                );
              }
              if (message.players.length > maxPlayers) {
                return Effect.fail(
                  new SeatError({
                    reason: "tooManyPlayers",
                    message:
                      "The host started with more players than your game takes. Are you both on the same version?",
                  })
                );
              }
              if (!knownPicks(message.picks, valid)) {
                return Effect.fail(
                  new SeatError({
                    reason: "unknownPick",
                    message:
                      "The host started with a pick your game doesn't have. Are you both on the same version?",
                  })
                );
              }
              return Effect.succeed({
                players: message.players,
                picks: message.picks,
              });
            }
            case "pick": {
              return Effect.succeed(undefined);
            }
          }
        };

        /** Handles one input; the run's plan once the lobby is over. */
        const handle = (input: LobbyInput) =>
          Effect.gen(function* () {
            switch (input.type) {
              case "room": {
                const { event } = input;
                if (event.type === "peer-connected") {
                  // Listen in the input that reports the link: its early messages wait for it.
                  yield* listenTo(event.link);
                  if (role === "host") {
                    roster = withPlayer(roster, event.peer);
                    shareLobby();
                  } else {
                    sendToHost({ type: "pick", pick: seat.pick });
                  }
                } else if (event.type === "peer-left") {
                  roster = withoutPlayer(roster, event.peer);
                  shareLobby();
                } else if (event.type === "started") {
                  if (role === "host") {
                    return startAsHost();
                  }
                  // A guest waits for the host's start message. The host drops a guest it
                  // hadn't linked yet at the start, and sends it none: its link closes instead.
                  const hostLink = room
                    .links()
                    .find(({ peer }) => peer === room.host);
                  if (hostLink !== undefined) {
                    yield* Effect.forkScoped(
                      Effect.andThen(
                        hostLink.closed,
                        Queue.fail(
                          inputs,
                          new SeatError({
                            reason: "hostLost",
                            message: "Lost the host before the run started.",
                          })
                        )
                      )
                    );
                  }
                }
                break;
              }
              case "said": {
                if (role === "guest") {
                  return yield* hearHost(input.message);
                }
                if (input.message.type === "pick") {
                  roster = withPick(roster, input.from, input.message.pick);
                  shareLobby();
                }
                break;
              }
              case "pick": {
                if (role === "host") {
                  roster = withPick(roster, self, input.pick);
                  shareLobby();
                } else {
                  sendToHost({ type: "pick", pick: input.pick });
                }
                break;
              }
              case "start": {
                if (role === "host" && canStart(roster, maxPlayers)) {
                  yield* room.start;
                }
                break;
              }
            }
          });

        emitLobby();
        for (;;) {
          const plan = yield* handle(yield* Queue.take(inputs));
          if (plan !== undefined) {
            return plan;
          }
        }
      });

    /**
     * The local player's input for each scheduled step: what the attached devices hold, or null
     * while nothing is attached, which the rules see as a player with no input. One source for
     * every run: it reads whatever is attached when a step is scheduled.
     */
    const localInput: StepInput<PlayerInput | null> = {
      read: (step) => (device === null ? null : device.read(step)),
      endStep: () => device?.endStep?.(),
      endFrame: () => device?.endFrame?.(),
    };

    const recordHash = (seat: Seated, state: State): number => {
      const hash = parts.hash(state);
      seat.hashes.set(seat.run?.stepIndex ?? 0, hash);
      if (seat.hashes.size > KEPT_HASHES) {
        seat.hashes.delete(seat.hashes.keys().next().value!);
      }
      return hash;
    };

    // The run's events reach the app as the rules reported them, each with the local player.
    const onGameEvent = (seat: Seated, event: Event) => {
      if (parts.ends.has((event as { readonly _tag: string })._tag)) {
        seat.ended = true;
      }
      emit(seat, { _tag: "RunEvent", event, local });
    };

    /**
     * After each tick: who stepping waits on, when that changes. Kept as a bit per slot; the
     * names are built only on a change. It reads the session alone: nothing of the game's runs
     * between steps but the local player's input source.
     */
    const afterTick = (seat: Seated, clock: Clock.Clock) => {
      const { run } = seat;
      // Stopped, or ended: nothing is left to wait on.
      if (run === null || run.error !== null || seat.ended) {
        return;
      }
      const nowMs = millis(clock);
      const { waitingFor } = run;
      if (waitingFor.length === 0) {
        seat.waitingSinceMs = null;
      } else {
        seat.waitingSinceMs ??= nowMs;
      }
      let waiting = 0;
      if (
        seat.waitingSinceMs !== null &&
        nowMs - seat.waitingSinceMs >= WAITING_SHOWN_MS
      ) {
        for (const peer of waitingFor) {
          const slot = seat.players.indexOf(peer);
          if (slot !== -1) {
            waiting |= 1 << slot;
          }
        }
      }
      if (waiting !== seat.waitingMask) {
        seat.waitingMask = waiting;
        emit(
          seat,
          new WaitingChanged({ waitingFor: namesOf(seat.names, waiting) })
        );
      }
    };

    // The run, in the seat's scope: the session, its listener and its ticker close with it.
    const play = (
      seat: Seated,
      room: SignallingRoom,
      content: Content,
      plan: RunPlan
    ): Effect.Effect<void, LockstepError, Scope.Scope> =>
      Effect.gen(function* () {
        seat.players = plan.players;
        seat.names = plan.players.map(playerName);
        seat.slot = plan.players.indexOf(room.self);
        const shared: LockstepOptions<
          Config,
          State,
          Input,
          Event,
          Command,
          Refusals
        > = {
          simulation: parts.simulation,
          config: parts.config(content, plan.picks),
          contentHash: contentHash(content),
          transport: linksTransport(room.self, room.links()),
          local: localInput,
          hash: (state) => recordHash(seat, state),
          inputDelay: parts.lockstep?.inputDelay ?? INPUT_DELAY,
          hashEvery: parts.lockstep?.hashEvery ?? HASH_EVERY,
        };
        const session =
          room.role === "host"
            ? yield* hostLockstepScoped({
                ...shared,
                peers: plan.players.slice(1),
                seed: plan.seed ?? 0,
              })
            : yield* joinLockstepScoped({
                ...shared,
                host: room.host,
                players: plan.players,
              });
        seat.run = session;
        emit(seat, new RunStarted({ slot: seat.slot, names: seat.names }));
        yield* session.listen((event) => onGameEvent(seat, event));
        const timer = yield* parts.ticker;
        const clock = yield* Effect.clockWith(Effect.succeed);
        // The timer's ticks and the frames' ticks, as one ticker. A frame ticks too: when drawing
        // keeps the main thread busy, the worker's messages wait, and a tick per frame keeps input
        // flowing. Ticks go by the clock, so an extra one only runs sooner. A hidden tab gets no
        // frames: the timer's ticks alone step it.
        const ticks: Ticker = (onTick) => {
          const tick = () => {
            // `onTick` ticks the session before it returns.
            onTick();
            afterTick(seat, clock);
          };
          const stopTimer = timer(tick);
          seat.frameTick = tick;
          return () => {
            seat.frameTick = null;
            stopTimer();
          };
        };
        yield* session.run(ticks).pipe(
          // The others leaving a run that has ended is no failure: stop quietly, keeping what
          // the app shows of its end on screen.
          Effect.catchTag("LockstepError", (error) =>
            seat.ended ? Effect.void : Effect.fail(error)
          )
        );
      });

    /**
     * One host or join, from the content load to the run's end. It opens its room at once, then
     * waits for `previous`, the seat before it, to close before it speaks: its lobby, or its
     * failure. Its fiber ends no sooner than `previous`, so the wait covers every earlier seat.
     */
    const playSeat = (
      seat: Seated,
      open: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>,
      previous: Fiber.Fiber<unknown, unknown> | null
    ): Effect.Effect<void> => {
      /** The seat before this one has closed: its room, links, session and ticker are gone. */
      const closed: Effect.Effect<void> =
        previous === null ? Effect.void : Effect.asVoid(Fiber.await(previous));
      return Effect.gen(function* () {
        const content = yield* Effect.mapError(
          parts.content,
          ({ message }) => new SeatError({ reason: "content", message })
        );
        const room = yield* open;
        yield* closed;
        // The lobby's listeners end at the start; the room stays open for the run's links.
        const plan = yield* Effect.scoped(lobby(seat, room, content));
        yield* play(seat, room, content, plan);
      }).pipe(
        // Closed before the failure is reported: the room, links, session and ticker are gone.
        Effect.scoped,
        Effect.catch((error) =>
          Effect.andThen(
            closed,
            Effect.sync(() => {
              const { reason, message } = failureOf(error);
              fail(seat, reason, message);
            })
          )
        ),
        // A bug: it ends the seat like a failure, and is logged. An interrupt (leave, or a new
        // seat) reports nothing.
        Effect.catchDefect((defect) =>
          Effect.logError("The co-op client failed", defect).pipe(
            Effect.andThen(closed),
            Effect.andThen(
              Effect.sync(() =>
                fail(
                  seat,
                  "bug",
                  `Co-op stopped on a bug: ${messageOf(defect)}`
                )
              )
            )
          )
        ),
        // Also when interrupted while the seat before it still closes: the next seat, and
        // leave, wait for this fiber alone.
        Effect.ensuring(closed)
      );
    };

    /** Makes a new seat this player's, then runs it, interrupting the seat before it. */
    const take = (
      pick: string,
      open: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>
    ) =>
      Effect.sync(() => {
        const seat: Seated = makeSeat(pick);
        current = seat;
        lastSeat = runSeat(playSeat(seat, open, lastSeat));
      });

    const leave = Effect.suspend(() => {
      current = null;
      return FiberHandle.clear(seats);
    });

    // Attaching twice at once is a programming error, so it dies rather than fail.
    const claim = Effect.acquireRelease(
      Effect.suspend(() => {
        if (attached) {
          return Effect.die(
            new Error("This co-op client is already attached to an element")
          );
        }
        attached = true;
        return Effect.void;
      }),
      () =>
        Effect.sync(() => {
          attached = false;
        })
    );

    return {
      host: (pick) => take(pick, parts.rooms.host),
      join: (code, pick) => take(pick, parts.rooms.join(code)),
      choose: (pick) =>
        Effect.sync(() => {
          const seat = current;
          // Before the lobby opens, the pick is what it opens with.
          if (seat !== null && seat.run === null) {
            seat.pick = pick;
            if (seat.lobby !== null) {
              Queue.offerUnsafe(seat.lobby, { type: "pick", pick });
            }
          }
        }),
      start: Effect.sync(() => {
        if (current !== null && current.lobby !== null) {
          Queue.offerUnsafe(current.lobby, { type: "start" });
        }
      }),
      // The current seat's session answers it. Before a run there are no rules to ask.
      send: (command) =>
        Effect.suspend(() => {
          const run = current?.run ?? null;
          return run === null
            ? Effect.fail(
                new CommandDropped({
                  command: (command as { readonly _tag: string })._tag,
                  reason: "noRun",
                })
              )
            : run.send(command);
        }),
      leave,
      // Its own scope: a crash releases the view and input as detaching does. The scope runs
      // every release even if one throws, so the client can always attach again.
      attach: (element) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* claim;
            const made = yield* parts.presentation;
            // The view first, then the input source, as an engine makes them.
            const view = yield* Effect.acquireRelease(
              Effect.try({
                try: () => made.view(element, seated),
                catch: attachError,
              }),
              (drawn) => Effect.sync(() => drawn.dispose())
            );
            const input = yield* Effect.acquireRelease(
              Effect.try({
                try: () => made.input(element),
                catch: attachError,
              }),
              (read) => Effect.sync(() => read.dispose())
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                device = input;
              }),
              () =>
                Effect.sync(() => {
                  if (device === input) {
                    device = null;
                  }
                })
            );
            return yield* frameLoop(frames, (nowMs) => {
              const seat = current;
              // The frame's tick, before drawing (ADR-0012).
              seat?.frameTick?.();
              view.render(seat?.run?.state ?? null, nowMs / 1000);
            });
          })
        ).pipe(
          // The app then shows co-op as stopped, so this player leaves: a seat left running
          // would freeze the others' run when it next waits on this player, or while it holds
          // a pause. An interrupt (an unmount) is no failure, and doesn't leave.
          Effect.tapError(() => leave)
        ),
      listen: (onEvent) => {
        // Its own function, so one handler listening twice is two listeners.
        const listener = (event: CoopEvent<Event>) => onEvent(event);
        return Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(listener);
          }),
          () =>
            Effect.sync(() => {
              listeners.delete(listener);
            })
        );
      },
      debug: () => {
        const run = current?.run ?? null;
        return {
          stepIndex: run?.stepIndex ?? 0,
          error: run?.error?.message ?? null,
          hashes: Object.fromEntries(current?.hashes ?? []),
          slot: current?.slot ?? -1,
          state: run?.state ?? null,
        };
      },
    };
  });
