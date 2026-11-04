// What a co-op lobby's peers say over each peer link's reliable `messages` channel, before the
// run. The lockstep session's own messages travel on the `lockstep` channel; these are the
// demo's. In the host star, a guest talks only to the host, and the host tells each guest the
// whole lobby.

/** One player in the lobby: its peer id and the hero it picked ("" until it says). */
export interface LobbyPlayer {
  readonly id: string;
  readonly heroId: string;
}

export type LobbyMessage =
  /** Guest to host: the hero this guest plays. Sent when its link opens and on each change. */
  | { readonly type: "hero"; readonly heroId: string }
  /** Host to guests: everyone in the lobby, host first, in join order. */
  | { readonly type: "lobby"; readonly players: readonly LobbyPlayer[] }
  /**
   * Host to guests: the run starts. `players` is the player order, host first, and `heroIds`
   * each one's hero, in that order: the run's `SurvivorsConfig.heroIds`. The seed and the
   * content hash come in the lockstep session's own start message, which checks the hash.
   */
  | {
      readonly type: "start";
      readonly players: readonly string[];
      readonly heroIds: readonly string[];
    };

export const encodeLobbyMessage = (message: LobbyMessage): string =>
  JSON.stringify(message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isPlayer = (value: unknown): value is LobbyPlayer =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.heroId === "string";

/** Reads one lobby message; `undefined` when it isn't one. */
export const parseLobbyMessage = (text: string): LobbyMessage | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value.type) {
    case "hero": {
      return typeof value.heroId === "string"
        ? { type: "hero", heroId: value.heroId }
        : undefined;
    }
    case "lobby": {
      const { players } = value;
      return Array.isArray(players) && players.every(isPlayer)
        ? {
            type: "lobby",
            players: players.map(({ id, heroId }) => ({ id, heroId })),
          }
        : undefined;
    }
    case "start": {
      const { players, heroIds } = value;
      return isStrings(players) &&
        isStrings(heroIds) &&
        players.length === heroIds.length &&
        players.length > 0
        ? { type: "start", players, heroIds }
        : undefined;
    }
    default: {
      return undefined;
    }
  }
};

/** A peer id as players read it: `host` is "Host", `guest-2` is "Guest 2". */
export const playerName = (id: string): string => {
  if (id === "host") {
    return "Host";
  }
  const guest = /^guest-(?<n>\d+)$/u.exec(id);
  return guest ? `Guest ${guest.groups!.n}` : id;
};
