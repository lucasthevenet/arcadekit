import {
  HeroInput,
  combineHeroInputs,
  hashWorld,
  isChoosing,
  survivorsSimulation,
} from "@arcadekit/survivors";
import type {
  GameContent,
  HudSample,
  RunSummary,
  SurvivorsConfig,
  SurvivorsEvent,
  SurvivorsInput,
  UpgradeChoice,
  UpgradePick,
  World,
} from "@arcadekit/survivors";
import {
  SurvivorsSoundView,
  SurvivorsView,
} from "@arcadekit/survivors/browser";
import type {
  SurvivorsArt,
  SurvivorsGameSound,
} from "@arcadekit/survivors/browser";
import type { ContentError } from "arcadekit/content";
import { InputController, MOVE_AXES } from "arcadekit/input";
import {
  hostLockstepScoped,
  joinLockstepScoped,
  schemaCodec,
} from "arcadekit/net";
import type {
  LockstepError,
  LockstepOptions,
  PeerId,
  ScopedLockstepSession,
  Ticker,
} from "arcadekit/net";
import { linksTransport } from "arcadekit/net/browser";
import type {
  PeerLink,
  RoomError,
  RoomEvent,
  SignallingRoom,
} from "arcadekit/net/browser";
import type { StepInput } from "arcadekit/runtime";
import {
  animationFrames,
  attachError,
  combineViews,
} from "arcadekit/runtime/browser";
import type {
  AttachError,
  FrameSource,
  GameCrashed,
  GameView,
} from "arcadekit/runtime/browser";
import { Cause, Data, Effect, FiberHandle, Queue, Stream } from "effect";
import type { Clock, Scope } from "effect";

import { contentHash } from "./content-hash";
import { coopFrameLoop } from "./frame-loop";
import {
  canStart,
  encodeLobbyMessage,
  parseLobbyMessage,
  playerName,
  startPlan,
  withHero,
  withPlayer,
  withoutPlayer,
} from "./lobby";
import type { LobbyMessage, LobbyPlayer } from "./lobby";
import { workerTicker } from "./ticker";

/**
 * What the co-op client reports to the app. Player names are for display ("Guest 2"); the
 * game's events are the local player's only.
 */
export type CoopEvent =
  /** The lobby changed: who's in it and their heroes, host first. */
  | {
      readonly type: "lobby";
      readonly role: "host" | "guest";
      readonly code: string;
      readonly self: string;
      readonly players: readonly LobbyPlayer[];
    }
  /** The run started. `slot` is the local player's hero; `players` every player's name, by slot. */
  | {
      readonly type: "started";
      readonly slot: number;
      readonly players: readonly string[];
    }
  /**
   * Who stepping waits on (lockstep's "waiting for X"), once it has waited `WAITING_SHOWN_MS`,
   * and which other players have an upgrade offer open while the run is frozen for a level-up.
   * Reported when either changes.
   */
  | {
      readonly type: "waiting";
      readonly waitingFor: readonly string[];
      readonly choosing: readonly string[];
    }
  /** The lobby or the run failed for good: unreachable signalling, a desync, removal, a lost host… */
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "hud"; readonly hud: HudSample }
  /** The local player's hero has offer `offer` open. Answer with `pickUpgrade`. */
  | {
      readonly type: "levelUp";
      readonly offer: number;
      readonly choices: readonly UpgradeChoice[];
    }
  | { readonly type: "runEnded"; readonly summary: RunSummary };

/** How the client opens rooms: `browserRooms()` in the app (config.ts); a fake hub in tests. */
export interface CoopRooms {
  readonly host: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>;
  readonly join: (
    code: string
  ) => Effect.Effect<SignallingRoom, RoomError, Scope.Scope>;
}

export interface CoopClientOptions {
  readonly rooms: CoopRooms;
  /** The run's content: the app's content load. It runs in the seat's fiber, so leaving cancels it. */
  readonly content: Effect.Effect<GameContent, ContentError>;
  /**
   * What ticks the session, made in the run's scope, which stops it. Defaults to a timer in a
   * dedicated worker, which a hidden tab doesn't throttle (`workerTicker`).
   */
  readonly ticker?: Effect.Effect<Ticker, never, Scope.Scope>;
  /** The frame clock while attached. Defaults to `animationFrames`; tests pass `manualFrames()`. */
  readonly frames?: FrameSource;
  /** Steps ahead local input is scheduled. 4 steps is 67 ms at 60 Hz (ADR-0012). */
  readonly inputDelay?: number;
  /** Steps between state hash comparisons. */
  readonly hashEvery?: number;
  /**
   * What the run's sounds play through: every peer hears the whole fight, its own hero's hurt
   * and down loudest. Without it the run is silent.
   */
  readonly sound?: SurvivorsGameSound;
  /** Makes the drawing view for hero `localHero`. Defaults to a `SurvivorsView`; tests pass fakes. */
  readonly createView?: (
    element: HTMLElement,
    art: SurvivorsArt,
    localHero: number
  ) => GameView<World>;
}

/**
 * One player's side of co-op survivors in the browser (#25): the lobby over the signalling
 * worker and WebRTC, then a lockstep session stepped on a worker's timer, and a view drawn on
 * animation frames while attached. A hidden tab keeps stepping at full rate, so it holds no one
 * up, and draws nothing, since the browser runs no animation frames for it (ADR-0012). Picks
 * and pause reach the run as this player's step input, never as a `modify` (ADR-0012).
 */
export interface CoopClient {
  /**
   * Hosts a room playing `heroId`, after interrupting the room or run before it. Returns at
   * once: the lobby, the run and any failure are reported through `listen`.
   */
  readonly host: (heroId: string) => Effect.Effect<void>;
  /** Joins the room with join code `code`, playing `heroId`, as `host` opens one. */
  readonly join: (code: string, heroId: string) => Effect.Effect<void>;
  /** Changes the local player's hero in the lobby. */
  readonly chooseHero: (heroId: string) => Effect.Effect<void>;
  /**
   * Host: starts the run with everyone linked, once there are at least two players and each
   * has a hero. The worker confirms, then each guest is told the players and their heroes.
   */
  readonly start: Effect.Effect<void>;
  /** Picks choice `index` of the local hero's offer `offer`, as the next steps' input. */
  readonly pickUpgrade: (offer: number, index: number) => Effect.Effect<void>;
  /** Holds the run paused for everyone while this player's hero is playing, as step input. */
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  /**
   * Leaves the lobby or the run, and returns once its room, links, session and worker have
   * closed. The others see this player stop sending (ADR-0012's drop-out).
   */
  readonly leave: Effect.Effect<void>;
  /**
   * Draws the run into `element` with `art` (the app's sprite sheet) on every frame, and reads
   * input from it, for as long as it runs: as `AttachableEngine.attach` does. Fails with
   * `AttachError` at once if the view or input can't be made, and with `GameCrashed` if a frame
   * throws (that frame is the last), with nothing left attached. One attach at a time: a
   * second dies.
   */
  readonly attach: (
    element: HTMLElement,
    art: SurvivorsArt
  ) => Effect.Effect<never, AttachError | GameCrashed>;
  /** Calls `onEvent` for every co-op event while the scope is open. */
  readonly listen: (
    onEvent: (event: CoopEvent) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** For tests and debugging: the run's step, its stop error and its recent state hashes by step. */
  readonly debug: () => {
    readonly stepIndex: number;
    readonly error: string | null;
    readonly hashes: Readonly<Record<number, number>>;
  };
}

/** The lobby's own failure, such as a start that leaves this player out. */
export class CoopError extends Data.TaggedError("CoopError")<{
  readonly message: string;
}> {}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type SessionOptions = LockstepOptions<
  SurvivorsConfig,
  World,
  SurvivorsInput,
  SurvivorsEvent,
  HeroInput
>;

/** What a seat's lobby handles, one at a time. */
type LobbyInput =
  | { readonly type: "room"; readonly event: RoomEvent }
  /** A lobby message from `from`, on its link's reliable channel. */
  | {
      readonly type: "said";
      readonly from: PeerId;
      readonly message: LobbyMessage;
    }
  /** The local player picked `heroId`. */
  | { readonly type: "hero"; readonly heroId: string }
  /** The local player asked to start. */
  | { readonly type: "start" };

/** Who plays the run, by slot, and their heroes. The host draws the seed. */
interface RunPlan {
  readonly players: readonly PeerId[];
  readonly heroIds: readonly string[];
  readonly seed?: number;
}

/**
 * This player's place in one room, from its host or join to the next host, join or leave.
 * Its fiber owns the room, the lobby, the session and the worker; the client reads the rest.
 */
interface Seat {
  heroId: string;
  /** The lobby's inputs, while the lobby runs. */
  lobby: Queue.Enqueue<LobbyInput, RoomError> | null;
  slot: number;
  players: readonly string[];
  run: ScopedLockstepSession<World, SurvivorsEvent> | null;
  /** Ticks the run, while it runs: a frame ticks it before drawing. */
  frameTick: (() => void) | null;
  /** The run ended: what the session reports after that (the others leaving) is no failure. */
  ended: boolean;
  waitingKey: string;
  /** Since when stepping has waited without a break, or null. */
  waitingSinceMs: number | null;
  /** The local player's pick, sent with every step's input until its offer closes. */
  pick: UpgradePick | null;
  paused: boolean;
  /** The local player's step input: one object, refilled. */
  readonly input: Mutable<HeroInput>;
  readonly hashes: Map<number, number>;
}

/** What a seat can fail with: each is reported as `failed`. */
type SeatError = ContentError | RoomError | CoopError | LockstepError;

/** How often the session ticks. Browsers clamp shorter timers to about 4 ms anyway. */
const TICK_MS = 4;
/**
 * How long stepping must wait before the players it waits on are shown. Lockstep waits a frame
 * now and then as input arrives; that isn't worth a banner.
 */
const WAITING_SHOWN_MS = 300;
/** How many recent state hashes `debug` keeps. */
const KEPT_HASHES = 32;

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

const failureMessage = (error: SeatError): string =>
  error._tag === "LockstepError" ? stopMessage(error) : error.message;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The Clock's monotonic time in milliseconds, as the session reads it. */
const millis = (clock: Clock.Clock): number =>
  Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;

const makeSeat = (heroId: string): Seat => ({
  heroId,
  lobby: null,
  slot: 0,
  players: [],
  run: null,
  frameTick: null,
  ended: false,
  waitingKey: "",
  waitingSinceMs: null,
  pick: null,
  paused: false,
  input: { moveX: 0, moveZ: 0 },
  hashes: new Map(),
});

/**
 * The co-op client. Its scope (the app) owns the current seat: closing it leaves.
 *
 * Each host or join is one fiber, a seat, in a `FiberHandle`: it loads the content, opens the
 * room, runs the lobby, then the run, and its scope owns all of them. A new host or join
 * interrupts the seat before it, and leave interrupts it and waits for it to close. Only host,
 * join and leave choose the current seat, and a seat reports only while it is current, so a
 * seat being closed can't speak over the next.
 */
export const makeCoopClient = (
  options: CoopClientOptions
): Effect.Effect<CoopClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const seats = yield* FiberHandle.make();
    // Seats fork from plain code (host and join), on the Scheduler and Clock the client was made with.
    const runSeat = yield* FiberHandle.runtime(seats)<never>();
    const frames = options.frames ?? animationFrames;
    const listeners = new Set<(event: CoopEvent) => void>();
    let current: Seat | null = null;
    let controller: InputController<keyof typeof MOVE_AXES> | null = null;
    let attached = false;

    /** Reports `event` if `seat` is still this player's: a seat being replaced says nothing. */
    const emit = (seat: Seat, event: CoopEvent) => {
      if (current !== seat) {
        return;
      }
      for (const listener of listeners) {
        listener(event);
      }
    };

    // The lobby: one input at a time, from the room, the links and the local player.
    const lobby = (
      seat: Seat,
      room: SignallingRoom,
      content: GameContent
    ): Effect.Effect<RunPlan, RoomError | CoopError, Scope.Scope> =>
      Effect.gen(function* () {
        const inputs = yield* Queue.unbounded<
          LobbyInput,
          RoomError | CoopError
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
        /** The host keeps the lobby; a guest has the host's last word on it. */
        let roster: readonly LobbyPlayer[] =
          role === "host" ? [{ id: self, heroId: seat.heroId }] : [];
        const emitLobby = () =>
          emit(seat, { type: "lobby", role, code, self, players: roster });
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

        /** Host: the worker confirmed the start. Everyone linked plays, in lobby order. */
        const startAsHost = (): RunPlan => {
          const linked = new Set(room.links().map(({ peer }) => peer));
          const plan = startPlan(
            roster,
            linked,
            self,
            content.heroes[0]?.id ?? ""
          );
          const text = encodeLobbyMessage({ type: "start", ...plan });
          for (const link of room.links()) {
            link.messages.send(text);
          }
          return {
            ...plan,
            seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
          };
        };

        /** A guest: what the host says. The start ends the lobby, unless it leaves this player out. */
        const hearHost = (message: LobbyMessage) => {
          switch (message.type) {
            case "lobby": {
              roster = [...message.players];
              emitLobby();
              return Effect.succeed(undefined);
            }
            case "start": {
              return message.players.includes(self)
                ? Effect.succeed<RunPlan>({
                    players: message.players,
                    heroIds: message.heroIds,
                  })
                : Effect.fail(
                    new CoopError({ message: "The run started without you." })
                  );
            }
            case "hero": {
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
                    sendToHost({ type: "hero", heroId: seat.heroId });
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
                          new CoopError({
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
                if (input.message.type === "hero") {
                  roster = withHero(roster, input.from, input.message.heroId);
                  shareLobby();
                }
                break;
              }
              case "hero": {
                if (role === "host") {
                  roster = withHero(roster, self, input.heroId);
                  shareLobby();
                } else {
                  sendToHost({ type: "hero", heroId: input.heroId });
                }
                break;
              }
              case "start": {
                if (role === "host" && canStart(roster)) {
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

    /** The local player's input: the attached device, the pending pick and the pause. */
    const localInput = (seat: Seat): StepInput<HeroInput> => ({
      read: () => {
        const { input } = seat;
        input.moveX = controller ? controller.axis("moveX") : 0;
        input.moveZ = controller ? controller.axis("moveY") : 0;
        const world = seat.run?.state ?? null;
        const { pick } = seat;
        if (
          pick !== null &&
          world !== null &&
          (world.offerSeq !== pick.offer ||
            world.heroes[seat.slot]?.offer === null)
        ) {
          // Its offer closed: the pick was applied, or the offer ended without it.
          seat.pick = null;
        }
        if (seat.pick === null) {
          delete input.pick;
        } else {
          input.pick = seat.pick;
        }
        if (seat.paused) {
          input.paused = true;
        } else {
          delete input.paused;
        }
        return input;
      },
      endFrame: () => controller?.endFrame(),
    });

    const recordHash = (seat: Seat, world: World): number => {
      const hash = hashWorld(world);
      seat.hashes.set(seat.run?.stepIndex ?? 0, hash);
      if (seat.hashes.size > KEPT_HASHES) {
        seat.hashes.delete(seat.hashes.keys().next().value!);
      }
      return hash;
    };

    const onGameEvent = (seat: Seat, event: SurvivorsEvent) => {
      switch (event.type) {
        case "hud": {
          emit(seat, event);
          return;
        }
        case "levelUp": {
          if (event.hero === seat.slot) {
            emit(seat, {
              type: "levelUp",
              offer: event.offer,
              choices: event.choices,
            });
          }
          return;
        }
        case "runEnded": {
          seat.ended = true;
          const summary = event.summaries[seat.slot];
          if (summary !== undefined) {
            emit(seat, { type: "runEnded", summary });
          }
        }
      }
    };

    /** After each tick: who stepping waits on, and who is choosing an upgrade, when either changes. */
    const afterTick = (seat: Seat, clock: Clock.Clock) => {
      const { run } = seat;
      // Stopped, or ended: nothing is left to wait on or choose.
      if (run === null || run.error !== null || seat.ended) {
        return;
      }
      const nowMs = millis(clock);
      if (run.waitingFor.length === 0) {
        seat.waitingSinceMs = null;
      } else {
        seat.waitingSinceMs ??= nowMs;
      }
      const waitingFor =
        seat.waitingSinceMs !== null &&
        nowMs - seat.waitingSinceMs >= WAITING_SHOWN_MS
          ? run.waitingFor.map(playerName)
          : [];
      const world = run.state;
      const choosing =
        world !== null && isChoosing(world)
          ? world.heroes
              .filter((hero) => hero.offer !== null && hero.slot !== seat.slot)
              .map((hero) => playerName(seat.players[hero.slot] ?? ""))
          : [];
      const key = `${waitingFor.join(",")}|${choosing.join(",")}`;
      if (key !== seat.waitingKey) {
        seat.waitingKey = key;
        emit(seat, { type: "waiting", waitingFor, choosing });
      }
    };

    // The run, in the seat's scope: the session, its listener and its worker close with it.
    const play = (
      seat: Seat,
      room: SignallingRoom,
      content: GameContent,
      plan: RunPlan
    ): Effect.Effect<void, LockstepError, Scope.Scope> =>
      Effect.gen(function* () {
        seat.players = plan.players;
        seat.slot = plan.players.indexOf(room.self);
        const shared: SessionOptions = {
          simulation: survivorsSimulation,
          config: { content, heroIds: plan.heroIds },
          contentHash: contentHash(content),
          transport: linksTransport(room.self, room.links()),
          local: localInput(seat),
          codec: schemaCodec(HeroInput),
          combine: combineHeroInputs(plan.players),
          hash: (world) => recordHash(seat, world),
          inputDelay: options.inputDelay ?? 4,
          hashEvery: options.hashEvery ?? 60,
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
        emit(seat, {
          type: "started",
          slot: seat.slot,
          players: plan.players.map(playerName),
        });
        yield* session.listen((event) => onGameEvent(seat, event));
        const worker = yield* (
          options.ticker ?? workerTicker({ everyMs: TICK_MS })
        );
        const clock = yield* Effect.clockWith(Effect.succeed);
        // The worker's ticks and the frames' ticks, as one ticker. A frame ticks too: when drawing
        // keeps the main thread busy, the worker's messages wait, and a tick per frame keeps input
        // flowing. Ticks go by the clock, so an extra one only runs sooner. A hidden tab gets no
        // frames: the worker's ticks alone step it.
        const ticks: Ticker = (onTick) => {
          const tick = () => {
            // `onTick` ticks the session before it returns.
            onTick();
            afterTick(seat, clock);
          };
          const stopWorker = worker(tick);
          seat.frameTick = tick;
          return () => {
            seat.frameTick = null;
            stopWorker();
          };
        };
        yield* session.run(ticks).pipe(
          // The others leaving a run that has ended is no failure: stop quietly, keeping its
          // summary on screen.
          Effect.catchTag("LockstepError", (error) =>
            seat.ended ? Effect.void : Effect.fail(error)
          )
        );
      });

    /** One host or join, from the content load to the run's end. */
    const playSeat = (
      seat: Seat,
      open: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const content = yield* options.content;
        const room = yield* open;
        // The lobby's listeners end at the start; the room stays open for the run's links.
        const plan = yield* Effect.scoped(lobby(seat, room, content));
        yield* play(seat, room, content, plan);
      }).pipe(
        // Closed before the failure is reported: the room, links, session and worker are gone.
        Effect.scoped,
        Effect.catch((error) =>
          Effect.sync(() =>
            emit(seat, { type: "failed", message: failureMessage(error) })
          )
        ),
        // A bug: it ends the seat like a failure, and is logged. An interrupt (leave, or a new
        // seat) reports nothing.
        Effect.catchDefect((defect) =>
          Effect.logError("The co-op client failed", defect).pipe(
            Effect.andThen(
              Effect.sync(() =>
                emit(seat, {
                  type: "failed",
                  message: `Co-op stopped on a bug: ${messageOf(defect)}`,
                })
              )
            )
          )
        )
      );

    /** Makes `seat` this player's, then runs it, interrupting the seat before it. */
    const take = (
      heroId: string,
      open: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>
    ) =>
      Effect.sync(() => {
        const seat = makeSeat(heroId);
        current = seat;
        runSeat(playSeat(seat, open));
      });

    /** The drawing view, and the sound view beside it, both for the local hero. */
    const makeView = (
      element: HTMLElement,
      art: SurvivorsArt,
      localHero: number
    ): GameView<World> => {
      const view =
        options.createView?.(element, art, localHero) ??
        new SurvivorsView(element, art, { localHero });
      const { sound } = options;
      return sound === undefined
        ? view
        : combineViews<World>(
            view,
            new SurvivorsSoundView({ ...sound, localHero })
          );
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
      host: (heroId) => take(heroId, options.rooms.host),
      join: (code, heroId) => take(heroId, options.rooms.join(code)),
      chooseHero: (heroId) =>
        Effect.sync(() => {
          const seat = current;
          if (seat !== null) {
            seat.heroId = heroId;
            if (seat.lobby !== null) {
              Queue.offerUnsafe(seat.lobby, { type: "hero", heroId });
            }
          }
        }),
      start: Effect.sync(() => {
        if (current !== null && current.lobby !== null) {
          Queue.offerUnsafe(current.lobby, { type: "start" });
        }
      }),
      pickUpgrade: (offer, index) =>
        Effect.sync(() => {
          if (current !== null) {
            current.pick = { offer, index };
          }
        }),
      setPaused: (paused) =>
        Effect.sync(() => {
          if (current !== null) {
            current.paused = paused;
          }
        }),
      leave: Effect.suspend(() => {
        current = null;
        return FiberHandle.clear(seats);
      }),
      // Its own scope: a crash releases the view and input as detaching does. The scope runs
      // every release even if one throws, so the client can always attach again.
      attach: (element, art) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* claim;
            const input = yield* Effect.acquireRelease(
              Effect.try({
                try: () => new InputController(element, { axes: MOVE_AXES }),
                catch: attachError,
              }),
              (made) => Effect.sync(() => made.dispose())
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                controller = input;
              }),
              () =>
                Effect.sync(() => {
                  if (controller === input) {
                    controller = null;
                  }
                })
            );
            let view: GameView<World> | null = null;
            let viewSlot = current?.slot ?? 0;
            // Released first: the view is disposed before the input.
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                const old = view;
                view = null;
                old?.dispose();
              })
            );
            view = yield* Effect.try({
              try: () => makeView(element, art, viewSlot),
              catch: attachError,
            });
            return yield* coopFrameLoop(frames, (nowMs) => {
              const seat = current;
              // The frame's tick, before drawing (ADR-0012).
              seat?.frameTick?.();
              // Drawn from the local hero's point of view: a new view when the slot changes.
              const slot = seat?.slot ?? 0;
              if (slot !== viewSlot) {
                const old = view;
                view = null;
                old?.dispose();
                view = makeView(element, art, slot);
                viewSlot = slot;
              }
              view!.render(seat?.run?.state ?? null, nowMs / 1000);
            });
          })
        ),
      listen: (onEvent) => {
        // Its own function, so one handler listening twice is two listeners.
        const listener = (event: CoopEvent) => onEvent(event);
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
        };
      },
    };
  });
