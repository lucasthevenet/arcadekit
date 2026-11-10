import { Cause, Data, Effect, Fiber, FiberHandle, Queue, Stream } from "effect";
import type { Clock, Scope } from "effect";

import { animationFrames, attachError } from "../../runtime/browser";
import type { InputSource, PlayerInputs, StepInput } from "../../runtime/index";
import { contentHash } from "../content-hash";
import type { CoopTypes } from "../coop";
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
import { combinePlayerInputs } from "../player-inputs";
import { hostLockstepScoped, joinLockstepScoped } from "../scoped";
import type { ScopedLockstepSession, Ticker } from "../scoped";
import { DEFAULT_ROOM_SIZE } from "../signalling/protocol";
import type { PeerId } from "../transport";
import { linksTransport } from "./channel";
import type { PeerLink } from "./channel";
import type {
  CoopClient,
  CoopClientOptions,
  CoopEvent,
  CoopFailure,
  CoopGame,
  LocalPlayer,
} from "./coop";
import type { RoomError } from "./errors";
import { coopFrameLoop } from "./frame-loop";
import type { RoomEvent, SignallingRoom } from "./signalling";
import { workerTicker } from "./ticker";

// The Co-op client's implementation. Its lifecycles are Effect: a seat is a fiber whose scope
// owns the room, the lobby, the session and the ticker, and an attach is a scope that owns the
// input and the view. What runs per tick and per frame is plain code (ADR-0017).

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
interface Seat<G extends CoopTypes> {
  pick: string;
  /** The lobby's inputs, while the lobby runs. */
  lobby: Queue.Enqueue<LobbyInput, RoomError | SeatError> | null;
  slot: number;
  /** Every player's peer id, by slot. */
  players: readonly PeerId[];
  /** Every player's name, by slot. */
  names: readonly string[];
  run: ScopedLockstepSession<G["State"], G["Event"]> | null;
  /** Ticks the run, while it runs: a frame ticks it before drawing. */
  frameTick: (() => void) | null;
  /** The run ended: what the session reports after that (the others leaving) is no failure. */
  ended: boolean;
  /** The seat failed: it has said its last. */
  failed: boolean;
  /** The players shown as waited on, and as choosing: a bit per slot. */
  waitingMask: number;
  choosingMask: number;
  /** Since when stepping has waited without a break, or null. */
  waitingSinceMs: number | null;
  /** The local player's answer, sent with every step's input until the game says it's settled. */
  answer: G["Answer"] | null;
  paused: boolean;
  readonly hashes: Map<number, number>;
}

/** How often the session ticks. Browsers clamp shorter timers to about 4 ms anyway. */
const TICK_MS = 4;
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

const makeSeat = <G extends CoopTypes>(pick: string): Seat<G> => ({
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
  choosingMask: 0,
  waitingSinceMs: null,
  answer: null,
  paused: false,
  hashes: new Map(),
});

/**
 * The Co-op client for `game`. Its scope (the app) owns the current seat: closing it leaves.
 *
 * Each host or join is one fiber, a seat, in a `FiberHandle`: it loads the content, opens the
 * room, runs the lobby, then the run, and its scope owns all of them. A new host or join
 * interrupts the seat before it, and leave interrupts it and waits for it to close. Only host,
 * join and leave choose the current seat, and a seat reports only while it is current, so a
 * seat being closed can't speak over the next.
 */
export const makeCoopClient = <G extends CoopTypes, LoadError = never>(
  game: CoopGame<G, LoadError>,
  options: CoopClientOptions
): Effect.Effect<CoopClient<G, LoadError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    type State = G["State"];
    type PlayerInput = G["PlayerInput"];
    type Content = G["Content"];

    const seats = yield* FiberHandle.make();
    // Seats fork from plain code (host and join), on the Scheduler and Clock the client was made with.
    const runSeat = yield* FiberHandle.runtime(seats)<never>();
    const frames = options.frames ?? animationFrames;
    const maxPlayers = game.maxPlayers ?? DEFAULT_ROOM_SIZE;
    const listeners = new Set<(event: CoopEvent<G["LocalEvent"]>) => void>();
    let current: Seat<G> | null = null;
    /** The fiber of the last seat taken: the next waits for it to close before it speaks. */
    let lastSeat: Fiber.Fiber<unknown, unknown> | null = null;
    /** The attached devices, while attached. */
    let device: InputSource<PlayerInput> | null = null;
    let attached = false;

    /** Reports `event` if `seat` is still this player's: a seat being replaced says nothing. */
    const emit = (seat: Seat<G>, event: CoopEvent<G["LocalEvent"]>) => {
      if (current !== seat || seat.failed) {
        return;
      }
      for (const listener of listeners) {
        listener(event);
      }
    };

    /** Reports the seat's failure: its last event. */
    const fail = (seat: Seat<G>, reason: CoopFailure, message: string) => {
      emit(seat, { type: "failed", reason, message });
      seat.failed = true;
    };

    // The lobby: one input at a time, from the room, the links and the local player.
    const lobby = (
      seat: Seat<G>,
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
        const valid = game.picks(content);
        /** The host keeps the lobby; a guest has the host's last word on it. */
        let roster: readonly LobbyPick[] =
          role === "host" ? [{ id: self, pick: seat.pick }] : [];
        const emitLobby = () =>
          emit(seat, {
            type: "lobby",
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
          });
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
         * pick the game doesn't have becomes its first.
         */
        const startAsHost = (): RunPlan => {
          const linked = new Set(room.links().map(({ peer }) => peer));
          const plan = startPlan(roster, linked, self, valid);
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
         * out or names a pick this player's game doesn't have, which would stop the run on
         * every peer at its start.
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
     * The local player's input for one scheduled step: the attached devices (null while
     * detached), the held answer unless the game says it's settled, and the held pause.
     */
    const localInput = (seat: Seat<G>): StepInput<PlayerInput> => {
      const fill = game.localInput();
      return {
        read: (step) => {
          const read = device === null ? null : device.read(step);
          const state = seat.run?.state ?? null;
          if (
            seat.answer !== null &&
            state !== null &&
            game.settled(seat.answer, state, seat.slot)
          ) {
            // It was applied, or what it answered ended without it.
            seat.answer = null;
          }
          return fill(read, seat.answer, seat.paused);
        },
        endStep: () => device?.endStep?.(),
        endFrame: () => device?.endFrame?.(),
      };
    };

    const recordHash = (seat: Seat<G>, state: State): number => {
      const hash = game.hash(state);
      seat.hashes.set(seat.run?.stepIndex ?? 0, hash);
      if (seat.hashes.size > KEPT_HASHES) {
        seat.hashes.delete(seat.hashes.keys().next().value!);
      }
      return hash;
    };

    const onGameEvent = (seat: Seat<G>, event: G["Event"]) => {
      if (game.runEnded(event)) {
        seat.ended = true;
      }
      const heard = game.localEvent(event, seat.slot, seat.names);
      if (heard !== null) {
        emit(seat, { type: "run", event: heard });
      }
    };

    /**
     * After each tick: who stepping waits on, and who else owes the run an answer, when either
     * changes. Both are kept as a bit per slot; the names are built only on a change.
     */
    const afterTick = (seat: Seat<G>, clock: Clock.Clock) => {
      const { run } = seat;
      // Stopped, or ended: nothing is left to wait on or choose.
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
      let choosing = 0;
      const { state } = run;
      if (state !== null) {
        for (let slot = 0; slot < seat.players.length; slot++) {
          if (slot !== seat.slot && game.choosing(state, slot)) {
            choosing |= 1 << slot;
          }
        }
      }
      if (waiting !== seat.waitingMask || choosing !== seat.choosingMask) {
        seat.waitingMask = waiting;
        seat.choosingMask = choosing;
        emit(seat, {
          type: "waiting",
          waitingFor: namesOf(seat.names, waiting),
          choosing: namesOf(seat.names, choosing),
        });
      }
    };

    // The run, in the seat's scope: the session, its listener and its ticker close with it.
    const play = (
      seat: Seat<G>,
      room: SignallingRoom,
      content: Content,
      plan: RunPlan
    ): Effect.Effect<void, LockstepError, Scope.Scope> =>
      Effect.gen(function* () {
        seat.players = plan.players;
        seat.names = plan.players.map(playerName);
        seat.slot = plan.players.indexOf(room.self);
        const shared: LockstepOptions<
          G["Config"],
          State,
          PlayerInputs<PlayerInput>,
          G["Event"],
          PlayerInput
        > = {
          simulation: game.simulation,
          config: game.config(content, plan.picks),
          contentHash: contentHash(content),
          transport: linksTransport(room.self, room.links()),
          local: localInput(seat),
          codec: game.codec,
          combine: combinePlayerInputs<PlayerInput>(plan.players),
          hash: (state) => recordHash(seat, state),
          inputDelay: game.lockstep?.inputDelay ?? INPUT_DELAY,
          hashEvery: game.lockstep?.hashEvery ?? HASH_EVERY,
        };
        const session =
          room.role === "host"
            ? yield* hostLockstepScoped({
                ...shared,
                peers: plan.players.slice(1),
                seed: plan.seed ?? 0,
              })
            : yield* joinLockstepScoped({ ...shared, host: room.host });
        seat.run = session;
        emit(seat, { type: "started", slot: seat.slot, names: seat.names });
        yield* session.listen((event) => onGameEvent(seat, event));
        const timer: Ticker =
          options.ticker ?? (yield* workerTicker({ everyMs: TICK_MS }));
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
     * waits for `previous`, the seat before it, to close before its lobby speaks.
     */
    const playSeat = (
      seat: Seat<G>,
      open: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>,
      previous: Fiber.Fiber<unknown, unknown> | null
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const content = yield* Effect.mapError(
          game.content,
          ({ message }) => new SeatError({ reason: "content", message })
        );
        const room = yield* open;
        if (previous !== null) {
          yield* Fiber.await(previous);
        }
        // The lobby's listeners end at the start; the room stays open for the run's links.
        const plan = yield* Effect.scoped(lobby(seat, room, content));
        yield* play(seat, room, content, plan);
      }).pipe(
        // Closed before the failure is reported: the room, links, session and ticker are gone.
        Effect.scoped,
        Effect.catch((error) =>
          Effect.sync(() => {
            const { reason, message } = failureOf(error);
            fail(seat, reason, message);
          })
        ),
        // A bug: it ends the seat like a failure, and is logged. An interrupt (leave, or a new
        // seat) reports nothing.
        Effect.catchDefect((defect) =>
          Effect.logError("The co-op client failed", defect).pipe(
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
        )
      );

    /** Makes a new seat this player's, then runs it, interrupting the seat before it. */
    const take = (
      pick: string,
      open: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>
    ) =>
      Effect.sync(() => {
        const seat = makeSeat<G>(pick);
        current = seat;
        lastSeat = runSeat(playSeat(seat, open, lastSeat));
      });

    const leave = Effect.suspend(() => {
      current = null;
      return FiberHandle.clear(seats);
    });

    /** The local player's seat, read live by the attached view. */
    const local: LocalPlayer = {
      get slot() {
        return current?.slot ?? 0;
      },
      get names() {
        return current?.names ?? NO_NAMES;
      },
    };

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
      host: (pick) => take(pick, options.rooms.host),
      join: (code, pick) => take(pick, options.rooms.join(code)),
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
      answer: (answer) =>
        Effect.sync(() => {
          if (current !== null && current.run !== null) {
            current.answer = answer;
          }
        }),
      setPaused: (paused) =>
        Effect.sync(() => {
          if (current !== null && current.run !== null) {
            current.paused = paused;
          }
        }),
      leave,
      // Its own scope: a crash releases the view and input as detaching does. The scope runs
      // every release even if one throws, so the client can always attach again.
      attach: (element) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* claim;
            const presentation = yield* game.presentation;
            const input = yield* Effect.acquireRelease(
              Effect.try({
                try: () => presentation.createInput(element),
                catch: attachError,
              }),
              (made) => Effect.sync(() => made.dispose())
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
            // Released first: the view is disposed before the input.
            const view = yield* Effect.acquireRelease(
              Effect.try({
                try: () => presentation.createView(element, local),
                catch: attachError,
              }),
              (made) => Effect.sync(() => made.dispose())
            );
            return yield* coopFrameLoop(frames, (nowMs) => {
              const seat = current;
              // The frame's tick, before drawing (ADR-0012).
              seat?.frameTick?.();
              view.render(seat?.run?.state ?? null, nowMs / 1000);
            });
          })
        ).pipe(
          // The app then shows co-op as stopped, so this player leaves: a seat left running
          // would freeze the others' run when it next owes an answer, or while it holds the
          // pause. An interrupt (an unmount) is no failure, and doesn't leave.
          Effect.tapError(() => leave)
        ),
      listen: (onEvent) => {
        // Its own function, so one handler listening twice is two listeners.
        const listener = (event: CoopEvent<G["LocalEvent"]>) => onEvent(event);
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
