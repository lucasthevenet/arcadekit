import { parseServerMessage } from "@arcadekit/net/signalling";
import type { ServerMessage } from "@arcadekit/net/signalling";
import { describe, expect, it } from "vitest";

import { createRoom } from "./room";
import { CLOSE_PROTOCOL_ERROR, createSocketRoom } from "./sockets";
import type { RoomSocket } from "./sockets";

/** A socket that records what the room sends it, as the Durable Object's WebSocket would. */
const fakeSocket = () => {
  const received: ServerMessage[] = [];
  let closedWith: { code: number; reason: string } | undefined;
  const socket: RoomSocket = {
    send: (text) => {
      if (closedWith !== undefined) {
        throw new Error("send after close");
      }
      const message = parseServerMessage(text);
      if (message === undefined) {
        throw new Error(`not a server message: ${text}`);
      }
      received.push(message);
    },
    close: (code, reason) => {
      closedWith = { code, reason };
    },
  };
  return { socket, received, closed: () => closedWith };
};

const offer = JSON.stringify({
  type: "signal",
  to: "guest-1",
  signal: { kind: "offer", sdp: "v=0" },
});

describe(createSocketRoom, () => {
  it("relays between sockets by peer id", () => {
    const rooms = createSocketRoom(createRoom("ABC234"));
    const host = fakeSocket();
    const guest = fakeSocket();
    rooms.open(host.socket, "host", 0);
    rooms.open(guest.socket, "guest", 0);
    rooms.message(host.socket, offer, 1);
    expect(guest.received.at(-1)).toStrictEqual({
      type: "signal",
      from: "host",
      signal: { kind: "offer", sdp: "v=0" },
    });
    expect(host.received.map((message) => message.type)).toStrictEqual([
      "welcome",
      "peer-joined",
    ]);
  });

  it("sends a 5th player an error and closes its socket with the reason", () => {
    const rooms = createSocketRoom(createRoom("ABC234"));
    rooms.open(fakeSocket().socket, "host", 0);
    for (let i = 0; i < 3; i++) {
      rooms.open(fakeSocket().socket, "guest", 0);
    }
    const fifth = fakeSocket();
    rooms.open(fifth.socket, "guest", 0);
    expect(fifth.received).toStrictEqual([{ type: "error", reason: "full" }]);
    expect(fifth.closed()).toStrictEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: "full",
    });
  });

  it("tells the host when a guest's socket closes, and ignores that socket afterwards", () => {
    const rooms = createSocketRoom(createRoom("ABC234"));
    const host = fakeSocket();
    const guest = fakeSocket();
    rooms.open(host.socket, "host", 0);
    rooms.open(guest.socket, "guest", 0);
    rooms.closed(guest.socket);
    rooms.closed(guest.socket);
    rooms.message(guest.socket, offer, 1);
    expect(host.received.at(-1)).toStrictEqual({
      type: "peer-left",
      peer: "guest-1",
    });
    expect(host.received).toHaveLength(3);
  });

  it("closes every guest when the host's socket closes", () => {
    const rooms = createSocketRoom(createRoom("ABC234"));
    const host = fakeSocket();
    const guest = fakeSocket();
    rooms.open(host.socket, "host", 0);
    rooms.open(guest.socket, "guest", 0);
    rooms.closed(host.socket);
    expect(guest.received.at(-1)).toStrictEqual({
      type: "error",
      reason: "host-left",
    });
    expect(guest.closed()).toStrictEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: "host-left",
    });
  });

  it("closes everyone when the alarm finds the room expired", () => {
    const rooms = createSocketRoom(createRoom("ABC234", { ttlMs: 1000 }));
    const host = fakeSocket();
    rooms.open(host.socket, "host", 0);
    rooms.alarm(999);
    expect(host.closed()).toBeUndefined();
    rooms.alarm(1000);
    expect(host.received.at(-1)).toStrictEqual({
      type: "error",
      reason: "expired",
    });
    expect(host.closed()).toStrictEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: "expired",
    });
  });

  it("closes an expired room's sockets when someone tries to join before the alarm runs", () => {
    const rooms = createSocketRoom(createRoom("ABC234", { ttlMs: 1000 }));
    const host = fakeSocket();
    const late = fakeSocket();
    rooms.open(host.socket, "host", 0);
    rooms.open(late.socket, "guest", 1000);
    expect(host.closed()).toStrictEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: "expired",
    });
    expect(late.received).toStrictEqual([
      { type: "error", reason: "unknown-code" },
    ]);
  });
});
