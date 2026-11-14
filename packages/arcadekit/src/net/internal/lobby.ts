import { Option, Schema } from "effect";

import { Room } from "../signalling/index";
import type { PeerId } from "../transport";

// What a co-op lobby's peers say over each peer link's reliable `messages` channel, before the
// run, and the host's lobby as plain values. The lockstep session's own messages travel on the
// `lockstep` channel. In the host star, a guest talks only to the host, and the host tells each
// guest the whole lobby. The Co-op client (`arcadekit/net/browser`) is the shell that sends and
// hears these. Plain on purpose (ADR-0024): untrusted messages decoded with Schema where they
// arrive, and the lobby's values, which are data work.

/** One player in the lobby: its peer id and its lobby pick ("" until it says). */
export interface LobbyPick {
  readonly id: PeerId;
  readonly pick: string;
}

/** What a lobby's peers say to each other. */
export type LobbyMessage =
  /** Guest to host: this guest's lobby pick. Sent when its link opens and on each change. */
  | { readonly type: "pick"; readonly pick: string }
  /** Host to guests: everyone in the lobby, host first, in join order. */
  | { readonly type: "lobby"; readonly players: readonly LobbyPick[] }
  /**
   * Host to guests: the run starts. `players` is the player order, host first, and `picks` each
   * one's lobby pick, in that order: what the game's `config` is made from. The seed and the
   * content hash come in the lockstep session's own start message, which checks the hash.
   */
  | {
      readonly type: "start";
      readonly players: readonly PeerId[];
      readonly picks: readonly string[];
    };

// The messages as Schemas: what arrives is untrusted, so it is decoded where it arrives.

const LobbyPickSchema = Schema.Struct({
  id: Schema.String,
  pick: Schema.String,
});

const PickMessage = Schema.Struct({
  type: Schema.Literal("pick"),
  pick: Schema.String,
});

const LobbyListMessage = Schema.Struct({
  type: Schema.Literal("lobby"),
  players: Schema.Array(LobbyPickSchema),
});

/** 1 to `Room.maxSize` of something, one per player: no room holds more. */
const PerPlayer = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(Room.maxSize)
);

const StartMessage = Schema.Struct({
  type: Schema.Literal("start"),
  players: PerPlayer,
  picks: PerPlayer,
}).check(
  Schema.makeFilter(({ players, picks }) => players.length === picks.length, {
    expected: "one pick per player",
  })
);

const LobbyMessageSchema = Schema.Union([
  PickMessage,
  LobbyListMessage,
  StartMessage,
]);

export const encodeLobbyMessage = (message: LobbyMessage): string =>
  JSON.stringify(message);

const decodeLobbyMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(LobbyMessageSchema)
);

/** Reads one lobby message; `undefined` when it isn't one. */
export const parseLobbyMessage = (text: string): LobbyMessage | undefined =>
  Option.getOrUndefined(decodeLobbyMessage(text));

/** A peer id as players read it: `host` is "Host", `guest-2` is "Guest 2". */
export const playerName = (id: PeerId): string => {
  if (id === "host") {
    return "Host";
  }
  const guest = /^guest-(?<n>\d+)$/u.exec(id);
  return guest ? `Guest ${guest.groups!.n}` : id;
};

// The host's lobby, as plain values: who is in it and their lobby picks, host first, in join
// order.

/** The lobby with `id` added at its end, with no pick yet. A player already in it stays where it is. */
export const withPlayer = (
  players: readonly LobbyPick[],
  id: PeerId
): readonly LobbyPick[] =>
  players.some((player) => player.id === id)
    ? players
    : [...players, { id, pick: "" }];

/** The lobby without `id`. */
export const withoutPlayer = (
  players: readonly LobbyPick[],
  id: PeerId
): readonly LobbyPick[] => players.filter((player) => player.id !== id);

/** The lobby with `id` having picked `pick`. */
export const withPick = (
  players: readonly LobbyPick[],
  id: PeerId,
  pick: string
): readonly LobbyPick[] =>
  players.map((player) => (player.id === id ? { id, pick } : player));

/**
 * Whether the host may start: at least two players, at most `maxPlayers`, and each has a lobby
 * pick. `maxPlayers` is the game's number, or a room's default size without one.
 */
export const canStart = (
  players: readonly { readonly pick: string }[],
  maxPlayers: number = Room.defaultSize
): boolean =>
  players.length >= 2 &&
  players.length <= maxPlayers &&
  players.every((player) => player.pick !== "");

/**
 * Who plays when the host starts, and their lobby picks: the host (`self`) and every guest still
 * linked, in lobby order, up to `maxPlayers`. A guest that linked after the host asked to start
 * can make the lobby one too many: the last to join are left out. `valid` is the game's list of
 * picks: a player whose pick is empty or not in it plays the first. The result is the host's
 * `StartMessage`, and the run's player order.
 */
export const startPlan = (
  players: readonly LobbyPick[],
  linked: ReadonlySet<PeerId>,
  self: PeerId,
  valid: readonly string[],
  maxPlayers: number
): { readonly players: PeerId[]; readonly picks: string[] } => {
  const playing = players
    .filter((player) => player.id === self || linked.has(player.id))
    .slice(0, maxPlayers);
  const fallback = valid[0] ?? "";
  return {
    players: playing.map((player) => player.id),
    picks: playing.map((player) =>
      valid.includes(player.pick) ? player.pick : fallback
    ),
  };
};

/** Whether every pick of a start is one this peer's game has: a guest refuses a start with another. */
export const knownPicks = (
  picks: readonly string[],
  valid: readonly string[]
): boolean => picks.every((pick) => valid.includes(pick));
