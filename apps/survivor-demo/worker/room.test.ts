import { HOST_ID } from "@arcadekit/net/signalling";
import type { ServerMessage, Signal } from "@arcadekit/net/signalling";
import { describe, expect, it } from "vitest";

import { createRoom } from "./room";
import type { RoomOutput } from "./room";

const offer: Signal = { kind: "offer", sdp: "v=0 offer" };
const answer: Signal = { kind: "answer", sdp: "v=0 answer" };

const signal = (to: string, payload: Signal = offer) =>
  JSON.stringify({ type: "signal", to, signal: payload });

const sends = (outputs: readonly RoomOutput[]) =>
  outputs.flatMap((output) =>
    output.kind === "send" ? [[output.to, output.message] as const] : []
  );

const closes = (outputs: readonly RoomOutput[]) =>
  outputs.flatMap((output) => (output.kind === "close" ? [output.peer] : []));

const admitted = (
  room: ReturnType<typeof createRoom>,
  role: "host" | "guest"
) => {
  const admission = room.admit(role, 0);
  if (!admission.ok) {
    throw new Error(`refused: ${admission.reason}`);
  }
  return admission;
};

describe(createRoom, () => {
  it("welcomes the host with the join code and tells it when a guest joins", () => {
    const room = createRoom("ABC234");
    expect(sends(admitted(room, "host").outputs)).toStrictEqual([
      [
        HOST_ID,
        {
          type: "welcome",
          code: "ABC234",
          self: HOST_ID,
          host: HOST_ID,
          peers: [],
        },
      ],
    ]);
    const guest = admitted(room, "guest");
    expect(guest.peer).toBe("guest-1");
    expect(sends(guest.outputs)).toStrictEqual([
      [
        "guest-1",
        {
          type: "welcome",
          code: "ABC234",
          self: "guest-1",
          host: HOST_ID,
          peers: [HOST_ID],
        },
      ],
      [HOST_ID, { type: "peer-joined", peer: "guest-1" }],
    ]);
  });

  it("refuses a guest before the host has opened the code", () => {
    expect(createRoom("ABC234").admit("guest", 0)).toStrictEqual({
      ok: false,
      reason: "unknown-code",
    });
  });

  it("refuses a second host for the same code", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    expect(room.admit("host", 0)).toStrictEqual({
      ok: false,
      reason: "code-taken",
    });
  });

  it("holds the host and 3 guests, and turns a 5th player away", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    for (let i = 0; i < 3; i++) {
      admitted(room, "guest");
    }
    expect(room.admit("guest", 0)).toStrictEqual({ ok: false, reason: "full" });
    expect(room.peers()).toStrictEqual([
      HOST_ID,
      "guest-1",
      "guest-2",
      "guest-3",
    ]);
  });

  it("frees a seat when a guest leaves, without reusing its id", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    admitted(room, "guest");
    admitted(room, "guest");
    expect(sends(room.leave("guest-2"))).toStrictEqual([
      [HOST_ID, { type: "peer-left", peer: "guest-2" }],
    ]);
    expect(admitted(room, "guest").peer).toBe("guest-4");
  });

  it("relays offers from the host to a guest and answers back", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    expect(
      sends(room.receive(HOST_ID, signal("guest-1", offer), 1))
    ).toStrictEqual([
      ["guest-1", { type: "signal", from: HOST_ID, signal: offer }],
    ]);
    expect(
      sends(room.receive("guest-1", signal(HOST_ID, answer), 2))
    ).toStrictEqual([
      [HOST_ID, { type: "signal", from: "guest-1", signal: answer }],
    ]);
  });

  it("relays ICE candidates, including the end-of-candidates one", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    const candidate: Signal = {
      kind: "candidate",
      candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "abcd",
    };
    const end: Signal = {
      kind: "candidate",
      candidate: "",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
    };
    expect(
      sends(room.receive("guest-1", signal(HOST_ID, candidate), 1))
    ).toStrictEqual([
      [HOST_ID, { type: "signal", from: "guest-1", signal: candidate }],
    ]);
    expect(
      sends(room.receive("guest-1", signal(HOST_ID, end), 1))
    ).toStrictEqual([
      [HOST_ID, { type: "signal", from: "guest-1", signal: end }],
    ]);
  });

  it("removes a guest that signals another guest: the star has no guest-to-guest links", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    admitted(room, "guest");
    const outputs = room.receive("guest-1", signal("guest-2"), 1);
    expect(sends(outputs)).toStrictEqual([
      [HOST_ID, { type: "peer-left", peer: "guest-1" }],
      ["guest-1", { type: "error", reason: "not-allowed" }],
    ]);
    expect(closes(outputs)).toStrictEqual(["guest-1"]);
    expect(room.peers()).toStrictEqual([HOST_ID, "guest-2"]);
  });

  it.each([
    ["not JSON", "not json"],
    ["no type", "{}"],
    ["a signal without one", '{"type":"signal","to":"host"}'],
    [
      "too long",
      JSON.stringify({
        type: "signal",
        to: HOST_ID,
        signal: { kind: "offer", sdp: "x".repeat(20_000) },
      }),
    ],
  ])(
    "removes a peer that sends something that isn't the protocol (%s)",
    (_, text) => {
      const room = createRoom("ABC234");
      admitted(room, "host");
      admitted(room, "guest");
      const outputs = room.receive("guest-1", text, 1);
      expect(sends(outputs)).toStrictEqual([
        [HOST_ID, { type: "peer-left", peer: "guest-1" }],
        ["guest-1", { type: "error", reason: "bad-message" }],
      ]);
      expect(room.peers()).toStrictEqual([HOST_ID]);
    }
  );

  it("drops a signal to a peer that has just left", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    room.leave("guest-1");
    expect(room.receive(HOST_ID, signal("guest-1"), 1)).toStrictEqual([]);
  });

  it("closes the room to new guests once the host starts the run", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    expect(
      sends(room.receive(HOST_ID, JSON.stringify({ type: "start" }), 1))
    ).toStrictEqual([
      [HOST_ID, { type: "started" }],
      ["guest-1", { type: "started" }],
    ]);
    expect(room.admit("guest", 2)).toStrictEqual({
      ok: false,
      reason: "started",
    });
  });

  it("lets only the host start the run", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    const outputs = room.receive(
      "guest-1",
      JSON.stringify({ type: "start" }),
      1
    );
    expect(sends(outputs)).toStrictEqual([
      [HOST_ID, { type: "peer-left", peer: "guest-1" }],
      ["guest-1", { type: "error", reason: "not-allowed" }],
    ]);
    expect(room.admit("guest", 2).ok).toBe(true);
  });

  it("ends the room for everyone when the host leaves, and forgets the code", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    const outputs = room.leave(HOST_ID);
    expect(sends(outputs)).toStrictEqual([
      [
        "guest-1",
        { type: "error", reason: "host-left" } satisfies ServerMessage,
      ],
    ]);
    expect(closes(outputs)).toStrictEqual(["guest-1"]);
    expect(room.admit("guest", 1)).toStrictEqual({
      ok: false,
      reason: "unknown-code",
    });
    expect(room.admit("host", 1)).toStrictEqual({
      ok: false,
      reason: "code-taken",
    });
  });

  it("closes the guests without an error when the host leaves after the start", () => {
    const room = createRoom("ABC234");
    admitted(room, "host");
    admitted(room, "guest");
    room.receive(HOST_ID, JSON.stringify({ type: "start" }), 1);
    const outputs = room.leave(HOST_ID);
    expect(sends(outputs)).toStrictEqual([]);
    expect(closes(outputs)).toStrictEqual(["guest-1"]);
    expect(room.peers()).toStrictEqual([]);
  });

  it("sets its expiry when the host opens it", () => {
    const room = createRoom("ABC234", { ttlMs: 1000 });
    expect(room.expiresAtMs()).toBeUndefined();
    room.admit("host", 500);
    expect(room.expiresAtMs()).toBe(1500);
  });

  it("closes everyone when it expires", () => {
    const room = createRoom("ABC234", { ttlMs: 1000 });
    room.admit("host", 500);
    admitted(room, "guest");
    expect(room.expire(1499)).toStrictEqual([]);
    const outputs = room.expire(1500);
    expect(sends(outputs)).toStrictEqual([
      [HOST_ID, { type: "error", reason: "expired" }],
      ["guest-1", { type: "error", reason: "expired" }],
    ]);
    expect(closes(outputs)).toStrictEqual([HOST_ID, "guest-1"]);
    expect(room.admit("guest", 1600)).toStrictEqual({
      ok: false,
      reason: "unknown-code",
    });
  });

  it("treats an expired room as gone even before its alarm runs", () => {
    const room = createRoom("ABC234", { ttlMs: 1000 });
    room.admit("host", 0);
    admitted(room, "guest");
    expect(room.admit("guest", 1000)).toStrictEqual({
      ok: false,
      reason: "unknown-code",
    });
  });

  it("ends the room when a message arrives after it expired", () => {
    const room = createRoom("ABC234", { ttlMs: 1000 });
    room.admit("host", 0);
    admitted(room, "guest");
    expect(
      closes(room.receive(HOST_ID, signal("guest-1"), 1000))
    ).toStrictEqual([HOST_ID, "guest-1"]);
  });
});
