import { Effect } from "effect";
import type { Scope } from "effect";

import type {
  AttachError,
  FrameSource,
  GameCrashed,
  GameView,
} from "../../runtime/browser";
import type { InputSource } from "../../runtime/index";
import type { CoopRules, CoopTypes } from "../coop";
import type { Ticker } from "../scoped";
import type { PeerId } from "../transport";
import type { RoomError } from "./errors";
import { browserRoomLayer, hostRoom, joinRoom } from "./signalling";
import type { SignallingRoom } from "./signalling";

// The Co-op client's interface (ADR-0012): what a game supplies, and what its app drives. The
// implementation is in coop-client.ts.

/**
 * The local player's seat, read live: a view reads `slot` in `render`, so it follows the seat
 * without being made again. Slot 0 and no names until a run starts.
 */
export interface LocalPlayer {
  /** The local player's slot in the run's player order, host first. */
  readonly slot: number;
  /** Every player's name, by slot ("Host", "Guest 2"). */
  readonly names: readonly string[];
}

/** How a Co-op game reads the local player's input from the viewport and draws the run into it. */
export interface CoopPresentation<State, PlayerInput> {
  /** Makes the local player's devices. Called once per attach, before `createView`. */
  readonly createInput: (surface: HTMLElement) => InputSource<PlayerInput>;
  /**
   * Makes the view that draws the run from `local`'s point of view. Called once per attach: the
   * client never makes it again, so it reads `local.slot` when it renders.
   */
  readonly createView: (
    container: HTMLElement,
    local: LocalPlayer
  ) => GameView<State>;
}

/**
 * A Co-op game: its lockstep parts (`CoopRules`, from `arcadekit/net`) plus what a browser needs
 * to play them, its content and its presentation. A genre builds it in its `./browser` entry as
 * `{ ...myCoopRules, content, presentation }`.
 */
export interface CoopGame<
  G extends CoopTypes,
  LoadError = never,
> extends CoopRules<G> {
  /**
   * Loads the run's content. Run once per seat (each host or join), in the seat's fiber, so
   * leaving cancels it. It must be JSON data: the client hashes it, and every peer's must match.
   */
  readonly content: Effect.Effect<G["Content"], { readonly message: string }>;
  /**
   * Run once per attach, before anything is made. What an attach loads (a sprite sheet) and
   * what its input and view share (a camera's state) live in its closure. Its failure is
   * `attach`'s.
   */
  readonly presentation: Effect.Effect<
    CoopPresentation<G["State"], G["PlayerInput"]>,
    LoadError
  >;
}

/** How the client opens rooms: `browserCoopRooms` in an app, `fakeCoopRooms` (`arcadekit/net/testing`) in tests. */
export interface CoopRooms {
  readonly host: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>;
  readonly join: (
    code: string
  ) => Effect.Effect<SignallingRoom, RoomError, Scope.Scope>;
}

/**
 * The browser's rooms: the signalling worker at `url` (its base URL, `ws:` or `wss:`), and
 * WebRTC links through `iceServers`. The kit reads no environment: the app passes both.
 */
export const browserCoopRooms = (options: {
  readonly url: string;
  readonly iceServers: readonly RTCIceServer[];
}): CoopRooms => {
  const room = { url: options.url };
  const services = browserRoomLayer({ iceServers: options.iceServers });
  return {
    host: hostRoom(room).pipe(Effect.provide(services)),
    join: (code) => joinRoom(room, code).pipe(Effect.provide(services)),
  };
};

/** One player in the lobby: its peer id, its name as players read it, and its lobby pick ("" until it says). */
export interface LobbyPlayer {
  readonly id: PeerId;
  readonly name: string;
  readonly pick: string;
}

/**
 * Why a seat failed, so an app can say it in its own words:
 *
 * - `content`: the content didn't load.
 * - `room`: the room couldn't be opened, or failed before the start.
 * - `leftOut`: the host started without this player.
 * - `unknownPick`: the host started a run this player's game can't play: a lobby pick it doesn't
 *   have, or more players than it takes. The two are on different builds.
 * - `hostLost`: nothing came from the host, before the run or in it.
 * - `desync`, `contentMismatch`, `removed`, `badInput`: the lockstep session's stops.
 * - `bug`: the client or the game threw.
 */
export type CoopFailure =
  | "content"
  | "room"
  | "leftOut"
  | "unknownPick"
  | "hostLost"
  | "desync"
  | "contentMismatch"
  | "removed"
  | "badInput"
  | "bug";

/**
 * What the Co-op client reports to the app, in one order: a seat's `lobby` events, one
 * `started`, then `run` and `waiting` events, then at most one `failed`, which is its last.
 */
export type CoopEvent<LocalEvent> =
  /**
   * The lobby changed: who's in it and their lobby picks, host first. `canStart` says whether
   * the host can start: at least two players, at most `maxPlayers`, each with a pick.
   */
  | {
      readonly type: "lobby";
      readonly role: "host" | "guest";
      readonly code: string;
      readonly self: PeerId;
      readonly players: readonly LobbyPlayer[];
      readonly maxPlayers: number;
      readonly canStart: boolean;
    }
  /** The run started. `slot` is the local player's; `names` every player's name, by slot. */
  | {
      readonly type: "started";
      readonly slot: number;
      readonly names: readonly string[];
    }
  /**
   * Who stepping waits on (lockstep's "waiting for X"), once it has waited 300 ms, and which
   * other players owe the run an answer. Names, in slot order. Reported when either changes.
   */
  | {
      readonly type: "waiting";
      readonly waitingFor: readonly string[];
      readonly choosing: readonly string[];
    }
  /** The seat failed for good. `message` is the kit's text for a player; `reason` lets an app re-word it. */
  | {
      readonly type: "failed";
      readonly reason: CoopFailure;
      readonly message: string;
    }
  /** What the local player hears of one of the run's events (the game's `localEvent`). */
  | { readonly type: "run"; readonly event: LocalEvent };

/** For tests and debugging: a read of the current seat's run. */
export interface CoopDebug<State> {
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
 * One player's side of a Co-op game in the browser: the lobby over the signalling worker and
 * WebRTC, then a lockstep session stepped on a worker's timer, and a view drawn on animation
 * frames while attached. A hidden tab keeps stepping at full rate, so it holds no one up, and
 * draws nothing, since the browser runs no animation frames for it (ADR-0012). Answers and pause
 * reach the run as this player's step input, never as a `modify`.
 *
 * `attach` and `listen` have `arcadekit/foldkit`'s `AttachableEngine` shapes, so an app mounts
 * the client as it mounts an engine.
 */
export interface CoopClient<G extends CoopTypes, LoadError = never> {
  /**
   * Hosts a room with lobby pick `pick`, after interrupting the seat before it. Returns at once:
   * the lobby, the run and any failure are reported through `listen`.
   */
  readonly host: (pick: string) => Effect.Effect<void>;
  /** Joins the room with join code `code`, with lobby pick `pick`, as `host` opens one. */
  readonly join: (code: string, pick: string) => Effect.Effect<void>;
  /** Changes the local player's lobby pick. Does nothing once the run has started. */
  readonly choose: (pick: string) => Effect.Effect<void>;
  /**
   * Host: starts the run with everyone linked, if the lobby's `canStart` is true. Does nothing
   * otherwise, or for a guest. The worker confirms, then each guest is told the players and
   * their picks. A guest that links in between can't make the run larger than the game's
   * `maxPlayers`: the last to join fail with `leftOut`.
   */
  readonly start: Effect.Effect<void>;
  /**
   * Answers the run: `answer` goes with every step's input until the game says it's settled. A
   * new answer replaces the held one. Does nothing with no run.
   */
  readonly answer: (answer: G["Answer"]) => Effect.Effect<void>;
  /** Holds the pause on this player's step input, or lets it go. Does nothing with no run. */
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  /**
   * Leaves the lobby or the run, and returns once its room, links, session and ticker have
   * closed. No event of that seat follows. The others see this player stop sending (ADR-0012's
   * drop-out).
   */
  readonly leave: Effect.Effect<void>;
  /**
   * Draws the run into `element` on every frame, and reads input from it, for as long as it
   * runs. With no run it draws `render(null, t)`. Fails with the presentation's `LoadError`,
   * with `AttachError` if the input or the view can't be made, and with `GameCrashed` if a frame
   * throws (that frame is the last), each with nothing left attached and after leaving: a seat
   * left running undrawn would hold the others up. Interrupt it to detach, which doesn't leave.
   * One attach at a time: a second dies.
   */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<never, AttachError | GameCrashed | LoadError>;
  /** Calls `onEvent` for every co-op event while the scope is open. */
  readonly listen: (
    onEvent: (event: CoopEvent<G["LocalEvent"]>) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly debug: () => CoopDebug<G["State"]>;
}

export interface CoopClientOptions {
  readonly rooms: CoopRooms;
  /**
   * What ticks the session, every few milliseconds. Defaults to a timer in a dedicated worker,
   * which a hidden tab doesn't throttle (`workerTicker`), made and stopped with each run. Tests
   * pass `manualTicker()` from `arcadekit/net/testing`.
   */
  readonly ticker?: Ticker;
  /** The frame clock while attached. Defaults to `animationFrames`; tests pass `manualFrames()`. */
  readonly frames?: FrameSource;
}
