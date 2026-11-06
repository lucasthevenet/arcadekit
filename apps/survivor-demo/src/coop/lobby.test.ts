import { describe, expect, it } from "vitest";

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
import type { LobbyMessage } from "./lobby";

// The lobby messages as they cross a peer link: what a peer sends reads back the same, and
// anything else reads as `undefined`, which the client drops.

const parse = (value: unknown) => parseLobbyMessage(JSON.stringify(value));

describe("lobby messages", () => {
  it("reads back each message it encodes", () => {
    const messages: LobbyMessage[] = [
      { type: "hero", heroId: "knight" },
      {
        type: "lobby",
        players: [
          { id: "host", heroId: "knight" },
          { id: "guest-1", heroId: "" },
        ],
      },
      {
        type: "start",
        players: ["host", "guest-1"],
        heroIds: ["knight", "mage"],
      },
    ];
    for (const message of messages) {
      expect(parseLobbyMessage(encodeLobbyMessage(message))).toStrictEqual(
        message
      );
    }
  });

  it("drops fields a message doesn't have", () => {
    expect(parse({ type: "hero", heroId: "knight", extra: 1 })).toStrictEqual({
      type: "hero",
      heroId: "knight",
    });
    expect(
      parse({ type: "lobby", players: [{ id: "host", heroId: "", x: 1 }] })
    ).toStrictEqual({ type: "lobby", players: [{ id: "host", heroId: "" }] });
  });

  it("takes a start with as many heroes as a room holds", () => {
    const players = ["host", "guest-1", "guest-2", "guest-3"];
    expect(parse({ type: "start", players, heroIds: players })).toStrictEqual({
      type: "start",
      players,
      heroIds: players,
    });
  });

  it("refuses a start with more heroes than a room holds", () => {
    const players = ["host", "guest-1", "guest-2", "guest-3", "guest-4"];
    expect(parse({ type: "start", players, heroIds: players })).toBeUndefined();
  });

  it("refuses a start with no players", () => {
    expect(parse({ type: "start", players: [], heroIds: [] })).toBeUndefined();
  });

  it("refuses a start whose players and heroes differ in number", () => {
    expect(
      parse({
        type: "start",
        players: ["host", "guest-1"],
        heroIds: ["knight"],
      })
    ).toBeUndefined();
    expect(
      parse({ type: "start", players: ["host"], heroIds: ["knight", "mage"] })
    ).toBeUndefined();
  });

  it("refuses messages of the wrong shape", () => {
    for (const value of [
      null,
      [],
      "hero",
      42,
      {},
      { type: "wave" },
      { type: "hero" },
      { type: "hero", heroId: 3 },
      { type: "lobby", players: "host" },
      { type: "lobby", players: [{ id: "host" }] },
      { type: "lobby", players: [null] },
      { type: "start", players: ["host"], heroIds: [7] },
      { type: "start", players: ["host"] },
    ]) {
      expect(parse(value)).toBeUndefined();
    }
  });

  it("refuses text that isn't JSON", () => {
    for (const text of ["", "{", "not json", '{"type":"hero",', "\u0000"]) {
      expect(parseLobbyMessage(text)).toBeUndefined();
    }
  });
});

describe(playerName, () => {
  it("names the host and the guests", () => {
    expect(playerName("host")).toBe("Host");
    expect(playerName("guest-2")).toBe("Guest 2");
    expect(playerName("someone")).toBe("someone");
  });
});

describe("the host's lobby", () => {
  const host = { id: "host", heroId: "spark" };

  it("adds each guest once, at the end, with no hero, and removes it", () => {
    const joined = withPlayer(withPlayer([host], "guest-1"), "guest-2");
    expect([
      joined,
      withPlayer(joined, "guest-1"),
      withoutPlayer(joined, "guest-1"),
    ]).toStrictEqual([
      [host, { id: "guest-1", heroId: "" }, { id: "guest-2", heroId: "" }],
      joined,
      [host, { id: "guest-2", heroId: "" }],
    ]);
  });

  it("can start once two players have each picked a hero", () => {
    const joined = withPlayer([host], "guest-1");
    expect([
      canStart([host]),
      canStart(joined),
      canStart(withHero(joined, "guest-1", "ember")),
    ]).toStrictEqual([false, false, true]);
  });

  it("starts with the host and the guests still linked, in lobby order", () => {
    const players = [
      host,
      { id: "guest-1", heroId: "ember" },
      { id: "guest-2", heroId: "" },
      { id: "guest-3", heroId: "tide" },
    ];
    expect(
      startPlan(players, new Set(["guest-3", "guest-2"]), "host", "spark")
    ).toStrictEqual({
      players: ["host", "guest-2", "guest-3"],
      heroIds: ["spark", "spark", "tide"],
    });
  });
});
