import { Schema } from "effect";

import type { LocalPlayer } from "../../game/browser";
import type { EventInstance, NoFields } from "../../game/index";

// What a seat reports to its app: the Co-op client's own events, as Schema classes an app puts in
// its Messages and its Model as they are, and the run's events, each with the local player. A
// `Coop` class's `match` handles them all (coop.ts).

/** One player in the lobby: its peer id, its name as players read it, and its lobby pick ("" until it says). */
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
 */
export type CoopFailure = (typeof FAILURES)[number];

/**
 * The class of one of the Co-op client's own events: a Schema, and the constructor of its
 * values. They are what a seat reports of itself, not what a run reports, so they are no
 * `Game.Event`s, and their tags are told from the run's by where each stands in `match`.
 */
type SeatEvent<
  Tag extends string,
  F extends Schema.Struct.Fields,
> = Schema.Class<EventInstance<Tag, F>, Schema.TaggedStruct<Tag, F>, NoFields>;

/** A seat event's class, from its tag and fields. Each is given its written type where it is declared. */
const seatEvent = (tag: string, fields: Schema.Struct.Fields): unknown =>
  Schema.TaggedClass<{ readonly _tag: string }>(`arcadekit/net/${tag}`)(
    tag,
    fields
  );

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
}) as typeof LobbyChangedBase;

/**
 * The lobby changed: the local player's `role` in it, its join `code`, the local player's peer
 * id (`self`), and who is in it with their lobby picks, host first. `canStart` says whether the
 * host can start: at least two players, at most `maxPlayers`, each with a pick.
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
}) as typeof RunStartedBase;

/** The run started. `slot` is the local player's; `names` every player's name, by slot. */
export class RunStarted extends RunStartedBase {}

const WaitingChangedBase: SeatEvent<
  "WaitingChanged",
  { readonly waitingFor: Schema.$Array<Schema.String> }
> = seatEvent("WaitingChanged", {
  waitingFor: Schema.Array(Schema.String),
}) as typeof WaitingChangedBase;

/**
 * Who the run waits for changed: the players stepping waits on (lockstep's "waiting for X"),
 * once it has waited 300 ms. Names, in slot order; none once it steps again. Who a run waits on
 * to decide something, such as an upgrade to pick, is the game's to say: its sample does, as
 * survivors' HUD has a `choosing` flag for each hero.
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
}) as typeof SeatFailedBase;

/**
 * The seat failed for good: its last event. `message` is the kit's text for a player; `reason`
 * lets an app re-word it.
 */
export class SeatFailed extends SeatFailedBase {}

/** What a run case of `match` is given besides the event. */
export interface SeatContext {
  /** The local player, whose seat heard the event: `local.slot` is this player's hero, tile, score. */
  readonly local: LocalPlayer;
}

/**
 * One of the run's events or samples, as every peer's rules reported it, with the local player
 * whose seat heard it. The event keeps its own tag inside, so a game may name an event as it
 * likes.
 */
export interface RunEvent<Event> extends SeatContext {
  readonly _tag: "RunEvent";
  readonly event: Event;
}

/**
 * What the Co-op client reports to the app, in one order: a seat's `LobbyChanged` events, one
 * `RunStarted`, then the run's own events and `WaitingChanged`, then at most one `SeatFailed`,
 * which is its last. The class's `match` handles each.
 */
export type CoopEvent<Event> =
  | LobbyChanged
  | RunStarted
  | WaitingChanged
  | SeatFailed
  | RunEvent<Event>;
