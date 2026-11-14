// oxlint-disable eslint/max-classes-per-file -- the fakes of Cloudflare's classes are classes too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerMessage } from "../../../src/net/signalling/index";
import { SignallingWorker } from "../../../src/net/worker/index";
import { roomRequest } from "../../../src/net/worker/internal/routes";

/**
 * The entry's own interface, over fakes of the Cloudflare objects it makes or extends: the
 * `DurableObject` base class, `WebSocketPair`, and a `Response` that may be a 101. The rooms'
 * rules are tested in `room.test.ts` and `connections.test.ts`; this checks that the app's
 * setup reaches them.
 */

vi.mock(import("cloudflare:workers"), () => ({
  DurableObject: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  } as never,
}));

/** The worker's end of a socket: it records what the room sends it and how it closes it. */
const fakeServerSocket = () => {
  const received: ServerMessage.ServerMessage[] = [];
  let closedWith: string | undefined;
  return {
    received,
    closed: () => closedWith,
    accept: () => {},
    send: (text: string) => {
      const message = ServerMessage.fromJson(text);
      if (message === undefined) {
        throw new Error(`not a server message: ${text}`);
      }
      received.push(message);
    },
    close: (_code: number, reason: string) => {
      closedWith = reason;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
};

/** The worker's ends of the sockets made so far, in order. */
let servers: ReturnType<typeof fakeServerSocket>[] = [];

const CODE = "ABC234";

/** One room's Durable Object of `Room`, and a way to connect a peer to it as the Worker does. */
const openRoom = (Room: SignallingWorker.RoomClass) => {
  const ctx = { storage: { setAlarm: async () => {} } };
  const room = new Room(ctx as unknown as DurableObjectState, {});
  const connect = async (role: "host" | "guest") => {
    const response = await room.fetch?.(
      roomRequest(new Request("https://worker.example/"), CODE, role)
    );
    const server = servers.at(-1);
    if (response === undefined || server === undefined) {
      throw new Error("the room didn't answer");
    }
    return { status: response.status, server };
  };
  return { connect };
};

describe("a signalling room's Durable Object class", () => {
  beforeEach(() => {
    servers = [];
    vi.stubGlobal(
      "WebSocketPair",
      class {
        readonly 0 = {};
        readonly 1 = fakeServerSocket();
        constructor() {
          servers.push(this[1]);
        }
      }
    );
    // Outside Cloudflare, a Response can't have status 101 or carry a socket.
    vi.stubGlobal(
      "Response",
      class {
        readonly status: number;
        constructor(_body: unknown, init: { readonly status: number }) {
          this.status = init.status;
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a room size no room can have, when the class is made", () => {
    expect(() => SignallingWorker.room({ roomSize: 17 })).toThrow(RangeError);
    expect(() => SignallingWorker.room({ roomSize: 1 })).toThrow(RangeError);
    expect(() => SignallingWorker.room({ roomSize: 2.5 })).toThrow(RangeError);
  });

  it("holds as many players as the app set, and no more", async () => {
    const { connect } = openRoom(SignallingWorker.room({ roomSize: 2 }));
    const host = await connect("host");
    const guest = await connect("guest");
    const third = await connect("guest");

    expect(host.status).toBe(101);
    expect(host.server.received[0]?.type).toBe("welcome");
    expect(guest.server.closed()).toBeUndefined();
    expect(third.server.received).toStrictEqual([
      { type: "error", reason: "full" },
    ]);
    expect(third.server.closed()).toBe("full");
  });

  it("holds 4 players when the app sets no size", async () => {
    const { connect } = openRoom(SignallingWorker.room());
    await connect("host");
    for (let i = 0; i < 3; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the guests join one after another.
      await connect("guest");
    }
    expect(servers.map((server) => server.closed())).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const fifth = await connect("guest");
    expect(fifth.server.closed()).toBe("full");
  });

  it("answers 400 to a request that isn't a peer's", async () => {
    const Room = SignallingWorker.room();
    const room = new Room(
      {
        storage: { setAlarm: async () => {} },
      } as unknown as DurableObjectState,
      {}
    );
    const response = await room.fetch?.(new Request("https://worker.example/"));
    expect(response?.status).toBe(400);
  });
});
