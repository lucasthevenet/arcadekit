import { Effect, Fiber, Layer, Logger, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { parseServerMessage, ROOM_TTL_MS } from "../signalling/protocol";
import type { ServerMessage } from "../signalling/protocol";
import { acceptSocket, expireRoom, roomLayer } from "./connections";
import type { PeerSocket, RoomConnections } from "./connections";
import type { RoomOptions } from "./room";
import { CLOSE_PROTOCOL_ERROR, CLOSE_SERVER_ERROR } from "./sockets";

const CODE = "ABC234";

type Listener = (event: { readonly data: unknown }) => void;

/**
 * A peer's socket as the Durable Object's WebSocket would be: it records what the room sends it,
 * and the test plays the peer with `say` and `hangUp`. `onSend` runs after each message the room
 * sends it.
 */
const fakeSocket = (onSend: () => void = () => {}) => {
  const received: ServerMessage[] = [];
  const listeners = {
    message: new Set<Listener>(),
    close: new Set<Listener>(),
    error: new Set<Listener>(),
  };
  let closedWith: { code: number; reason: string } | undefined;
  const socket: PeerSocket = {
    send: (text) => {
      if (closedWith !== undefined) {
        throw new Error("send after close");
      }
      const message = parseServerMessage(text);
      if (message === undefined) {
        throw new Error(`not a server message: ${text}`);
      }
      received.push(message);
      onSend();
    },
    close: (code, reason) => {
      closedWith = { code, reason };
    },
    addEventListener: (type: keyof typeof listeners, listener: Listener) => {
      listeners[type].add(listener);
    },
    removeEventListener: (type: keyof typeof listeners, listener: Listener) => {
      listeners[type].delete(listener);
    },
  };
  return {
    socket,
    received,
    closed: () => closedWith,
    listening: () =>
      listeners.message.size + listeners.close.size + listeners.error.size,
    /** The peer sends `data`. */
    say: (data: unknown) => {
      for (const listener of listeners.message) {
        listener({ data });
      }
    },
    /** The peer's end closes. */
    hangUp: () => {
      for (const listener of listeners.close) {
        listener({ data: undefined });
      }
    },
  };
};

/**
 * One `SignallingRoom` Durable Object's runtime, as `index.ts` makes it, over a fake storage
 * whose `setAlarm` the test controls, with the room `options` it was set up with. Its clock is a test clock from 0, which runs on the
 * room's own scheduler.
 */
const setup = (
  setAlarm: (atMs: number) => Promise<void> = async () => {},
  options: RoomOptions = {}
) => {
  const alarms: number[] = [];
  const logs: unknown[] = [];
  const room = roomLayer(
    {
      setAlarm: (atMs) => {
        alarms.push(atMs);
        return setAlarm(atMs);
      },
    },
    options
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      TestClock.layer().pipe(Layer.provideMerge(room)),
      Logger.layer([Logger.make((log) => logs.push(log.message))])
    )
  );
  const run = <A>(effect: Effect.Effect<A, never, RoomConnections>) =>
    runtime.runPromise(effect);
  const accepted = new Response("accepted");
  /** Opens a socket to the room as a Durable Object's fetch would, and answers its request. */
  const connect = async (role: "host" | "guest") => {
    const peer = fakeSocket();
    const response = await run(acceptSocket(peer.socket, CODE, role, accepted));
    return { ...peer, response };
  };
  return { runtime, run, connect, accepted, alarms, logs };
};

/** A `setAlarm` that never finishes, so the test can act while the room waits on it. */
const neverSet = () => Effect.runPromise(Effect.never);

/**
 * Lets the room's connections take what their sockets just received. Microtasks only, no
 * timer: Cloudflare can drop the timers an event leaves behind, so a message must be handled
 * without one.
 */
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each await lets the next microtask run.
    await Promise.resolve();
  }
};

const offer = JSON.stringify({
  type: "signal",
  to: "guest-1",
  signal: { kind: "offer", sdp: "v=0" },
});

describe(acceptSocket, () => {
  it("welcomes a host and its guests, then relays their signals", async () => {
    const { connect, accepted } = setup();
    const host = await connect("host");
    const guest = await connect("guest");
    expect(host.response).toBe(accepted);
    expect(guest.response).toBe(accepted);
    host.say(offer);
    await settle();
    expect(guest.received).toStrictEqual([
      {
        type: "welcome",
        code: CODE,
        self: "guest-1",
        host: "host",
        peers: ["host"],
      },
      {
        type: "signal",
        from: "host",
        signal: { kind: "offer", sdp: "v=0" },
      },
    ]);
    expect(host.received.map((message) => message.type)).toStrictEqual([
      "welcome",
      "peer-joined",
    ]);
  });

  it("holds 4 players unless the object was set up with another room size", async () => {
    const byDefault = setup();
    await byDefault.connect("host");
    for (let i = 0; i < 3; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the guests join one after another.
      await byDefault.connect("guest");
    }
    const fifth = await byDefault.connect("guest");
    expect(fifth.received).toStrictEqual([{ type: "error", reason: "full" }]);

    const pair = setup(undefined, { roomSize: 2 });
    await pair.connect("host");
    await pair.connect("guest");
    const third = await pair.connect("guest");
    expect(third.received).toStrictEqual([{ type: "error", reason: "full" }]);
    expect(third.closed()).toStrictEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: "full",
    });
  });

  it("sets the room's expiry alarm when its host connects, and only then", async () => {
    const { connect, alarms } = setup();
    await connect("host");
    await connect("guest");
    await connect("host");
    expect(alarms).toStrictEqual([ROOM_TTL_MS]);
  });

  it("answers a refused socket's request too, so it hears why", async () => {
    const { connect, accepted } = setup();
    const guest = await connect("guest");
    expect(guest.response).toBe(accepted);
    expect(guest.received).toStrictEqual([
      { type: "error", reason: "unknown-code" },
    ]);
    expect(guest.closed()?.code).toBe(CLOSE_PROTOCOL_ERROR);
    expect(guest.listening()).toBe(0);
  });

  it("answers 503 and leaves no room behind when the host's alarm can't be set", async () => {
    const { connect, logs } = setup(() =>
      Promise.reject(new Error("storage is down"))
    );
    const host = await connect("host");
    expect(host.response.status).toBe(503);
    expect(host.closed()).toStrictEqual({
      code: CLOSE_SERVER_ERROR,
      reason: "server error",
    });
    expect(host.listening()).toBe(0);
    expect(logs).toHaveLength(1);
    // The room never opened: a guest with its code finds nothing, so no host without an expiry
    // is left in it.
    const guest = await connect("guest");
    expect(guest.received).toStrictEqual([
      { type: "error", reason: "unknown-code" },
    ]);
  });

  it("reads a binary message as a bad one", async () => {
    const { connect } = setup();
    const host = await connect("host");
    host.say(new ArrayBuffer(8));
    await settle();
    expect(host.received.at(-1)).toStrictEqual({
      type: "error",
      reason: "bad-message",
    });
    expect(host.closed()).toStrictEqual({
      code: CLOSE_PROTOCOL_ERROR,
      reason: "bad-message",
    });
  });

  it("tells the host when a guest's socket closes, and stops listening to it", async () => {
    const { connect } = setup();
    const host = await connect("host");
    const guest = await connect("guest");
    guest.hangUp();
    await settle();
    expect(host.received.at(-1)).toStrictEqual({
      type: "peer-left",
      peer: "guest-1",
    });
    expect(guest.listening()).toBe(0);
  });

  it("closes the sockets still open when the Durable Object's runtime goes", async () => {
    const { connect, runtime } = setup();
    const host = await connect("host");
    await runtime.dispose();
    expect(host.closed()?.code).toBe(CLOSE_SERVER_ERROR);
    expect(host.listening()).toBe(0);
  });

  it("closes a host's socket if the runtime goes while its alarm is being set", async () => {
    const { run, runtime, alarms } = setup(neverSet);
    const host = fakeSocket();
    const request = run(
      acceptSocket(host.socket, CODE, "host", new Response())
    );
    await settle();
    expect(alarms).toStrictEqual([ROOM_TTL_MS]);
    await runtime.dispose();
    await expect(request).rejects.toBeDefined();
    expect(host.closed()?.code).toBe(CLOSE_SERVER_ERROR);
    expect(host.listening()).toBe(0);
  });

  it("closes a socket interrupted as the room admits it, so no host is left behind", async () => {
    const { run } = setup(neverSet);
    let interrupted = false;
    // The connection is interrupted inside the room's welcome, as if the runtime went right then.
    const host = fakeSocket(() => {
      if (!interrupted) {
        interrupted = true;
        Fiber.getCurrent()?.interruptUnsafe();
      }
    });
    await expect(
      run(acceptSocket(host.socket, CODE, "host", new Response()))
    ).rejects.toBeDefined();
    expect(host.closed()?.code).toBe(CLOSE_SERVER_ERROR);
    expect(host.listening()).toBe(0);
    const guest = fakeSocket();
    await run(acceptSocket(guest.socket, CODE, "guest", new Response()));
    expect(guest.received).toStrictEqual([
      { type: "error", reason: "unknown-code" },
    ]);
  });
});

describe("the expiry alarm", () => {
  it("closes everyone once the room's time is up", async () => {
    const { connect, run } = setup();
    const host = await connect("host");
    const guest = await connect("guest");
    await run(Effect.andThen(TestClock.adjust(ROOM_TTL_MS - 1), expireRoom));
    expect(host.closed()).toBeUndefined();
    await run(Effect.andThen(TestClock.adjust(1), expireRoom));
    for (const peer of [host, guest]) {
      expect(peer.received.at(-1)).toStrictEqual({
        type: "error",
        reason: "expired",
      });
      expect(peer.closed()).toStrictEqual({
        code: CLOSE_PROTOCOL_ERROR,
        reason: "expired",
      });
    }
  });

  it("does nothing in an object whose room was never opened", async () => {
    const { run } = setup();
    await expect(run(expireRoom)).resolves.toBeUndefined();
  });
});
