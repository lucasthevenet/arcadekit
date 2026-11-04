import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startLocalSignalling } from "./local";
import type { LocalSignalling } from "./local";

// The local server over real sockets: Node's WebSocket client against the room rules the worker
// uses, on a free port.

interface Client {
  readonly messages: unknown[];
  readonly send: (message: unknown) => void;
  /** Waits until `count` messages have arrived. */
  readonly received: (count: number) => Promise<unknown[]>;
  /** Waits for the socket to close; resolves with its close code. */
  readonly closed: Promise<number>;
}

const connect = (url: string): Client => {
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  const closed = once(socket, "close").then(
    ([event]) => (event as CloseEvent).code
  );
  const opened = once(socket, "open");
  return {
    messages,
    send: (message) => {
      void opened.then(() => socket.send(JSON.stringify(message)));
    },
    received: async (count) => {
      await vi.waitFor(
        () => {
          if (messages.length < count) {
            throw new Error(`${messages.length} of ${count} messages so far`);
          }
        },
        { timeout: 5000, interval: 5 }
      );
      return messages.slice(0, count);
    },
    closed,
  };
};

const offer = { kind: "offer", sdp: "v=0" };

let server: LocalSignalling | undefined;

describe("the local signalling server", () => {
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("opens a room, lets a guest join with its code, relays signals and starts", async () => {
    server = await startLocalSignalling({ port: 0 });
    const host = connect(`${server.url}/host`);
    const [welcome] = (await host.received(1)) as [{ code: string }];
    const guest = connect(`${server.url}/join/${welcome.code.toLowerCase()}`);
    await guest.received(1);
    await host.received(2);
    host.send({ type: "signal", to: "guest-1", signal: offer });
    await guest.received(2);
    host.send({ type: "start" });
    expect([await host.received(3), await guest.received(3)]).toStrictEqual([
      [
        {
          type: "welcome",
          code: welcome.code,
          self: "host",
          host: "host",
          peers: [],
        },
        { type: "peer-joined", peer: "guest-1" },
        { type: "started" },
      ],
      [
        {
          type: "welcome",
          code: welcome.code,
          self: "guest-1",
          host: "host",
          peers: ["host"],
        },
        { type: "signal", from: "host", signal: offer },
        { type: "started" },
      ],
    ]);
  });

  it("turns away an unknown code, a late joiner and, at expiry, the room", async () => {
    server = await startLocalSignalling({ port: 0, ttlMs: 1000 });
    const stranger = connect(`${server.url}/join/K7MQ2X`);
    const host = connect(`${server.url}/host`);
    const [welcome] = (await host.received(1)) as [{ code: string }];
    const guest = connect(`${server.url}/join/${welcome.code}`);
    await guest.received(1);
    expect([
      await stranger.received(1),
      await stranger.closed,
      await host.received(3),
      await host.closed,
    ]).toStrictEqual([
      [{ type: "error", reason: "unknown-code" }],
      4000,
      [
        welcome,
        { type: "peer-joined", peer: "guest-1" },
        { type: "error", reason: "expired" },
      ],
      4000,
    ]);
  });
});
