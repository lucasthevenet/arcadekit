/**
 * Co-op events: what a seat of a Co-op client reports to its app.
 *
 * A seat reports, in one order, its `LobbyChanged` events, one `RunStarted`, then the run's own
 * events and `WaitingChanged`, then at most one `SeatFailed`, which is its last. The four are the
 * client's own, Schema classes an app puts in its Messages and its Model as they are; a run's
 * events come as every peer's rules reported them, each in a `RunEvent` with the local player of
 * the seat that heard it. A `Coop` class's `match` handles them all. Plain on purpose (ADR-0024):
 * Schemas and their values, data an app keeps.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

import type { LocalPlayer } from "../../game/browser";
import { seatEvent } from "./internal/seat-event";
import type { SeatEvent } from "./internal/seat-event";

/**
 * One player in the lobby: its peer id, its name as players read it (`Host`, `Guest 2`), and its
 * lobby pick, `""` until it says.
 *
 * **When to use**
 *
 * To draw a lobby from a `LobbyChanged`'s `players`.
 *
 * **Example** (A lobby line)
 *
 * ```ts
 * import type { CoopEvent } from "arcadekit/net/browser";
 *
 * const line = ({ name, pick }: CoopEvent.LobbyPlayer) => `${name}: ${pick || "choosing"}`;
 * line({ id: "guest-1", name: "Guest 1", pick: "" }); // => "Guest 1: choosing"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface LobbyPlayer {
  readonly id: string;
  readonly name: string;
  readonly pick: string;
}

const FAILURES = [
  "content",
  "room",
  "leftOut",
  "unknownPick",
  "tooManyPlayers",
  "hostLost",
  "desync",
  "contentMismatch",
  "removed",
  "badInput",
  "bug",
] as const;

/**
 * Why a seat failed, so an app can say it in its own words:
 *
 * - `content`: the content didn't load.
 * - `room`: the room couldn't be opened, or failed before the start.
 * - `leftOut`: the host started without this player.
 * - `unknownPick`: the host started with a lobby pick this player's game doesn't have. The two
 *   are on different builds.
 * - `tooManyPlayers`: the host started with more players than this player's game takes. Only a
 *   host on another build sends such a start.
 * - `hostLost`: nothing came from the host, before the run or in it.
 * - `desync`, `contentMismatch`, `removed`, `badInput`: the lockstep session's stops.
 * - `bug`: the client or the game threw.
 *
 * **When to use**
 *
 * To re-word a `SeatFailed` by its `reason`.
 *
 * **Example** (A failure in the app's words)
 *
 * ```ts
 * import type { CoopEvent } from "arcadekit/net/browser";
 *
 * const say = (reason: CoopEvent.Failure) =>
 *   reason === "leftOut" ? "The run started without you." : "Co-op stopped.";
 * say("leftOut"); // => "The run started without you."
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Failure = (typeof FAILURES)[number];

const LobbyChangedBase: SeatEvent<
  "LobbyChanged",
  {
    readonly role: Schema.Literals<readonly ["host", "guest"]>;
    readonly code: Schema.String;
    readonly self: Schema.String;
    readonly players: Schema.$Array<
      Schema.Struct<{
        readonly id: Schema.String;
        readonly name: Schema.String;
        readonly pick: Schema.String;
      }>
    >;
    readonly maxPlayers: Schema.Int;
    readonly canStart: Schema.Boolean;
  }
> = seatEvent("LobbyChanged", {
  role: Schema.Literals(["host", "guest"]),
  code: Schema.String,
  self: Schema.String,
  players: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      pick: Schema.String,
    })
  ),
  maxPlayers: Schema.Int,
  canStart: Schema.Boolean,
});

/**
 * The lobby changed: the local player's `role` in it, its join `code`, the local player's peer id
 * (`self`), and who is in it with their lobby picks, host first. `canStart` says whether the host
 * can start: at least two players, at most `maxPlayers`, each with a pick.
 *
 * **When to use**
 *
 * To draw the lobby, and to offer the host the start once `canStart` is true. It is a Schema
 * class, so an app keeps one in its Model as it is.
 *
 * **Example** (A lobby the host can start)
 *
 * ```ts
 * import { CoopEvent } from "arcadekit/net/browser";
 *
 * const lobby = new CoopEvent.LobbyChanged({
 *   role: "host",
 *   code: "K7MQ2X",
 *   self: "host",
 *   players: [
 *     { id: "host", name: "Host", pick: "red" },
 *     { id: "guest-1", name: "Guest 1", pick: "green" },
 *   ],
 *   maxPlayers: 4,
 *   canStart: true,
 * });
 * lobby._tag; // => "LobbyChanged"
 * lobby.players.map(({ name }) => name); // => ["Host", "Guest 1"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export class LobbyChanged extends LobbyChangedBase {}

const RunStartedBase: SeatEvent<
  "RunStarted",
  {
    readonly slot: Schema.Int;
    readonly names: Schema.$Array<Schema.String>;
  }
> = seatEvent("RunStarted", {
  slot: Schema.Int,
  names: Schema.Array(Schema.String),
});

/**
 * The run started. `slot` is the local player's; `names` every player's name, by slot.
 *
 * **When to use**
 *
 * To leave the lobby's screen for the run's, and to name the players by slot.
 *
 * **Details**
 *
 * Every event of the run comes after it, what the run's start reports first: what the
 * simulation's `create` reports, then the first sample, on the host's seat as on a guest's.
 *
 * **Example** (Who the local player is)
 *
 * ```ts
 * import { CoopEvent } from "arcadekit/net/browser";
 *
 * const started = new CoopEvent.RunStarted({ slot: 1, names: ["Host", "Guest 1"] });
 * started.names[started.slot]; // => "Guest 1"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export class RunStarted extends RunStartedBase {}

const WaitingChangedBase: SeatEvent<
  "WaitingChanged",
  { readonly waitingFor: Schema.$Array<Schema.String> }
> = seatEvent("WaitingChanged", {
  waitingFor: Schema.Array(Schema.String),
});

/**
 * Who the run waits for changed: the players stepping waits on (lockstep's "waiting for X"), by
 * name, in slot order, and none once it steps again.
 *
 * **When to use**
 *
 * To show a banner while the run waits on a player whose input hasn't arrived.
 *
 * **Details**
 *
 * It is told once the run has stood at one step for 300 ms: a run that steps waits on nobody,
 * however far behind another peer's it is. Who a run waits on to decide something, such as an
 * upgrade to pick, is the game's to say: its sample does, as survivors' HUD has a `choosing` flag
 * for each hero.
 *
 * **Example** (A banner)
 *
 * ```ts
 * import { CoopEvent } from "arcadekit/net/browser";
 *
 * const waiting = new CoopEvent.WaitingChanged({ waitingFor: ["Guest 1"] });
 * `Waiting for ${waiting.waitingFor.join(", ")}`; // => "Waiting for Guest 1"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export class WaitingChanged extends WaitingChangedBase {}

const SeatFailedBase: SeatEvent<
  "SeatFailed",
  {
    readonly reason: Schema.Literals<typeof FAILURES>;
    readonly message: Schema.String;
  }
> = seatEvent("SeatFailed", {
  reason: Schema.Literals(FAILURES),
  message: Schema.String,
});

/**
 * The seat failed for good: its last event. `message` is the kit's text for a player; `reason`
 * lets an app re-word it.
 *
 * **When to use**
 *
 * To leave the run's screen and say why.
 *
 * **Example** (A host that left)
 *
 * ```ts
 * import { CoopEvent } from "arcadekit/net/browser";
 *
 * const failed = new CoopEvent.SeatFailed({ reason: "hostLost", message: "Lost the host." });
 * failed.reason; // => "hostLost"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export class SeatFailed extends SeatFailedBase {}

/**
 * What a run case of `match` is given besides the event: `local`, the local player whose seat
 * heard it.
 *
 * **When to use**
 *
 * To tell the local player's events from the others', in a `Coop`'s `match` under `run`:
 * `hero === local.slot`.
 *
 * **Details**
 *
 * `local` is that seat's own, one object for all its run's events, so an event that is kept says
 * whose it was after the player has left or taken another seat.
 *
 * **Example** (Whose event it is)
 *
 * ```ts
 * import type { CoopEvent } from "arcadekit/net/browser";
 *
 * const mine = (by: number, { local }: CoopEvent.SeatContext) => by === local.slot;
 * mine(1, { local: { slot: 1, names: ["Host", "Guest 1"] } }); // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SeatContext {
  /** The local player, whose seat heard the event. */
  readonly local: LocalPlayer;
}

/**
 * One of the run's events or samples, as every peer's rules reported it, with the local player
 * whose seat heard it.
 *
 * **When to use**
 *
 * Rarely by hand: a `Coop`'s `match` hands each run case its event and the seat.
 *
 * **Details**
 *
 * The event keeps its own tag inside, so a game may name an event as it likes: no tag of the
 * run's is taken by the client's own.
 *
 * **Example** (A run's event, as a seat hears it)
 *
 * ```ts
 * import type { CoopEvent } from "arcadekit/net/browser";
 *
 * const heard: CoopEvent.RunEvent<{ readonly _tag: "Filled"; readonly total: number }> = {
 *   _tag: "RunEvent",
 *   event: { _tag: "Filled", total: 100 },
 *   local: { slot: 0, names: ["Host"] },
 * };
 * heard.event.total; // => 100
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface RunEvent<Event> extends SeatContext {
  readonly _tag: "RunEvent";
  readonly event: Event;
}

/**
 * Everything the Co-op client reports to the app: its own four events and the run's, in one
 * order.
 *
 * **When to use**
 *
 * To type what a client's `listen` hears. A `Coop`'s `match` turns each into the app's Message.
 *
 * **Details**
 *
 * A seat's `LobbyChanged` events come first, then one `RunStarted`, then the run's own events and
 * `WaitingChanged`, then at most one `SeatFailed`, which is its last. The run's own begin with
 * what its start reports, on the host's seat as on a guest's.
 *
 * **Example** (Telling the client's own from the run's)
 *
 * ```ts
 * import { CoopEvent } from "arcadekit/net/browser";
 *
 * const fromRun = (event: CoopEvent.CoopEvent<{ readonly _tag: "Filled" }>) =>
 *   event._tag === "RunEvent";
 * fromRun(new CoopEvent.RunStarted({ slot: 0, names: ["Host"] })); // => false
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type CoopEvent<Event> =
  | LobbyChanged
  | RunStarted
  | WaitingChanged
  | SeatFailed
  | RunEvent<Event>;
