import { MAX_PLAYERS } from "@arcadekit/net/signalling";
import { Option, Schema } from "effect";

// What a co-op lobby's peers say over each peer link's reliable `messages` channel, before the
// run. The lockstep session's own messages travel on the `lockstep` channel; these are the
// demo's. In the host star, a guest talks only to the host, and the host tells each guest the
// whole lobby.

/** One player in the lobby: its peer id and the hero it picked ("" until it says). */
export const LobbyPlayer = Schema.Struct({
  id: Schema.String,
  heroId: Schema.String,
});
export type LobbyPlayer = typeof LobbyPlayer.Type;

/** Guest to host: the hero this guest plays. Sent when its link opens and on each change. */
export const HeroMessage = Schema.Struct({
  type: Schema.Literal("hero"),
  heroId: Schema.String,
});

/** Host to guests: everyone in the lobby, host first, in join order. */
export const LobbyListMessage = Schema.Struct({
  type: Schema.Literal("lobby"),
  players: Schema.Array(LobbyPlayer),
});

/** 1 to `MAX_PLAYERS` of something, one per player: a run's world takes no more. */
const PerPlayer = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PLAYERS)
);

/**
 * Host to guests: the run starts. `players` is the player order, host first, and `heroIds`
 * each one's hero, in that order: the run's `SurvivorsConfig.heroIds`. The seed and the
 * content hash come in the lockstep session's own start message, which checks the hash.
 */
export const StartMessage = Schema.Struct({
  type: Schema.Literal("start"),
  players: PerPlayer,
  heroIds: PerPlayer,
}).check(
  Schema.makeFilter(
    ({ players, heroIds }) => players.length === heroIds.length,
    { expected: "one hero per player" }
  )
);

export const LobbyMessage = Schema.Union([
  HeroMessage,
  LobbyListMessage,
  StartMessage,
]);
export type LobbyMessage = typeof LobbyMessage.Type;

export const encodeLobbyMessage = (message: LobbyMessage): string =>
  JSON.stringify(message);

const decodeLobbyMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(LobbyMessage)
);

/** Reads one lobby message; `undefined` when it isn't one. */
export const parseLobbyMessage = (text: string): LobbyMessage | undefined =>
  Option.getOrUndefined(decodeLobbyMessage(text));

/** A peer id as players read it: `host` is "Host", `guest-2` is "Guest 2". */
export const playerName = (id: string): string => {
  if (id === "host") {
    return "Host";
  }
  const guest = /^guest-(?<n>\d+)$/u.exec(id);
  return guest ? `Guest ${guest.groups!.n}` : id;
};
