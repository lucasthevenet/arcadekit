import { describe, expect, it } from "vitest";

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
} from "./lobby";
import type { LobbyMessage } from "./lobby";

// The lobby messages as they cross a peer link: what a peer sends reads back the same, and
// anything else reads as `undefined`, which the client drops.

const parse = (value: unknown) => parseLobbyMessage(JSON.stringify(value));

describe("lobby messages", () => {
  it("reads back each message it encodes", () => {
    const messages: LobbyMessage[] = [
      { type: "pick", pick: "knight" },
      {
        type: "lobby",
        players: [
          { id: "host", pick: "knight" },
          { id: "guest-1", pick: "" },
        ],
      },
      {
        type: "start",
        players: ["host", "guest-1"],
        picks: ["knight", "mage"],
      },
    ];
    for (const message of messages) {
      expect(parseLobbyMessage(encodeLobbyMessage(message))).toStrictEqual(
        message
      );
    }
  });

  it("drops fields a message doesn't have", () => {
    expect(parse({ type: "pick", pick: "knight", extra: 1 })).toStrictEqual({
      type: "pick",
      pick: "knight",
    });
    expect(
      parse({ type: "lobby", players: [{ id: "host", pick: "", x: 1 }] })
    ).toStrictEqual({ type: "lobby", players: [{ id: "host", pick: "" }] });
  });

  it("takes a start with as many picks as the largest room holds", () => {
    const players = Array.from({ length: 16 }, (_, i) => `p-${i}`);
    expect(parse({ type: "start", players, picks: players })).toStrictEqual({
      type: "start",
      players,
      picks: players,
    });
  });

  it("refuses a start with more picks than the largest room holds", () => {
    const players = Array.from({ length: 17 }, (_, i) => `p-${i}`);
    expect(parse({ type: "start", players, picks: players })).toBeUndefined();
  });

  it("refuses a start with no players", () => {
    expect(parse({ type: "start", players: [], picks: [] })).toBeUndefined();
  });

  it("refuses a start whose players and picks differ in number", () => {
    expect(
      parse({
        type: "start",
        players: ["host", "guest-1"],
        picks: ["knight"],
      })
    ).toBeUndefined();
    expect(
      parse({ type: "start", players: ["host"], picks: ["knight", "mage"] })
    ).toBeUndefined();
  });

  it("refuses messages of the wrong shape", () => {
    for (const value of [
      null,
      [],
      "pick",
      42,
      {},
      { type: "wave" },
      { type: "pick" },
      { type: "pick", pick: 3 },
      { type: "lobby", players: "host" },
      { type: "lobby", players: [{ id: "host" }] },
      { type: "lobby", players: [null] },
      { type: "start", players: ["host"], picks: [7] },
      { type: "start", players: ["host"] },
    ]) {
      expect(parse(value)).toBeUndefined();
    }
  });

  it("refuses text that isn't JSON", () => {
    for (const text of ["", "{", "not json", '{"type":"pick",', "\u0000"]) {
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
  const host = { id: "host", pick: "spark" };

  it("adds each guest once, at the end, with no pick, and removes it", () => {
    const joined = withPlayer(withPlayer([host], "guest-1"), "guest-2");
    expect([
      joined,
      withPlayer(joined, "guest-1"),
      withoutPlayer(joined, "guest-1"),
    ]).toStrictEqual([
      [host, { id: "guest-1", pick: "" }, { id: "guest-2", pick: "" }],
      joined,
      [host, { id: "guest-2", pick: "" }],
    ]);
  });

  it("can start once two players have each a pick", () => {
    const joined = withPlayer([host], "guest-1");
    expect([
      canStart([host]),
      canStart(joined),
      canStart(withPick(joined, "guest-1", "ember")),
    ]).toStrictEqual([false, false, true]);
  });

  it("can't start with more players than the game takes, or than a room's default size", () => {
    const five = ["host", "guest-1", "guest-2", "guest-3", "guest-4"].map(
      (id) => ({ id, pick: "spark" })
    );
    expect([
      canStart(five.slice(0, 2), 2),
      canStart(five.slice(0, 3), 2),
      canStart(five.slice(0, 4)),
      canStart(five),
      canStart(five, 5),
    ]).toStrictEqual([true, false, true, false, true]);
  });

  it("starts with the host and the guests still linked, in lobby order", () => {
    const players = [
      host,
      { id: "guest-1", pick: "ember" },
      { id: "guest-2", pick: "" },
      { id: "guest-3", pick: "tide" },
    ];
    expect(
      startPlan(players, new Set(["guest-3", "guest-2"]), "host", [
        "spark",
        "ember",
        "tide",
      ])
    ).toStrictEqual({
      players: ["host", "guest-2", "guest-3"],
      picks: ["spark", "spark", "tide"],
    });
  });

  it("starts a player whose pick is empty or unknown with the game's first pick", () => {
    const players = [
      { id: "host", pick: "frost" },
      { id: "guest-1", pick: "" },
      { id: "guest-2", pick: "ember" },
    ];
    expect([
      startPlan(players, new Set(["guest-1", "guest-2"]), "host", [
        "spark",
        "ember",
      ]),
      startPlan(players, new Set(["guest-1"]), "host", []),
    ]).toStrictEqual([
      {
        players: ["host", "guest-1", "guest-2"],
        picks: ["spark", "spark", "ember"],
      },
      { players: ["host", "guest-1"], picks: ["", ""] },
    ]);
  });

  it("knows a start whose picks are all the game's", () => {
    expect([
      knownPicks(["spark", "ember"], ["spark", "ember", "tide"]),
      knownPicks(["spark", "frost"], ["spark", "ember"]),
      knownPicks(["spark"], []),
    ]).toStrictEqual([true, false, false]);
  });
});
