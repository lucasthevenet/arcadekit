import { DEFAULT_ROOM_SIZE } from "arcadekit/net/signalling";
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

/** 1 to `DEFAULT_ROOM_SIZE` of something, one per player: the demo's rooms hold no more. */
const PerPlayer = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DEFAULT_ROOM_SIZE)
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

// The host's lobby, as plain values: who is in it and their heroes, host first, in join order.

/** The lobby with `id` added at its end, with no hero yet. A player already in it stays where it is. */
export const withPlayer = (
  players: readonly LobbyPlayer[],
  id: string
): readonly LobbyPlayer[] =>
  players.some((player) => player.id === id)
    ? players
    : [...players, { id, heroId: "" }];

/** The lobby without `id`. */
export const withoutPlayer = (
  players: readonly LobbyPlayer[],
  id: string
): readonly LobbyPlayer[] => players.filter((player) => player.id !== id);

/** The lobby with `id` playing `heroId`. */
export const withHero = (
  players: readonly LobbyPlayer[],
  id: string,
  heroId: string
): readonly LobbyPlayer[] =>
  players.map((player) => (player.id === id ? { id, heroId } : player));

/** Whether the host may start: at least two players, and each has picked a hero. */
export const canStart = (
  players: readonly { readonly heroId: string }[]
): boolean =>
  players.length >= 2 && players.every((player) => player.heroId !== "");

/**
 * Who plays when the host starts, and their heroes: the host (`self`) and every guest still
 * linked, in lobby order. A player who picked no hero plays `fallbackHeroId`. The result is the
 * host's `StartMessage`, and the run's player order.
 */
export const startPlan = (
  players: readonly LobbyPlayer[],
  linked: ReadonlySet<string>,
  self: string,
  fallbackHeroId: string
): { readonly players: string[]; readonly heroIds: string[] } => {
  const playing = players.filter(
    (player) => player.id === self || linked.has(player.id)
  );
  return {
    players: playing.map((player) => player.id),
    heroIds: playing.map((player) => player.heroId || fallbackHeroId),
  };
};
