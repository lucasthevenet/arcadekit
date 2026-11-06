import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Stream,
} from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import type { Signal } from "../signalling/protocol";
import { PeerLinkError } from "./channel";
import type { PeerLink, TextChannel } from "./channel";
import { RoomError } from "./errors";
import { PeerConnector } from "./rtc";
import type { PeerConnectorApi, PeerLinkOptions } from "./rtc";
import { hostRoom, joinRoom } from "./signalling";
import type { RoomEvent, SignallingRoom } from "./signalling";

// The room's Effect shell, in Node, on a TestClock: a fake WebSocket stands in for the worker and
// a fake PeerConnector for WebRTC. The room's rules are tested in room-state.test.ts; these check
// that the shell carries them out: what it opens, sends and reports, and what it closes when.

type SocketListener = (event: Socket.WebSocketEvent) => void;

const fakeSocket = () => {
  const listeners = new Map<string, Set<SocketListener>>();
  const sent: unknown[] = [];
  let closedWith: number | undefined;
  const fire = (type: string, event: Socket.WebSocketEvent) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  const ws: Socket.WebSocketLike & { readyState: number } = {
    readyState: 0,
    addEventListener: (type, listener, options) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      const once: SocketListener = (event) => {
        listeners.get(type)!.delete(once);
        listener(event);
      };
      listeners.get(type)!.add(options?.once === true ? once : listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    close: (code) => {
      ws.readyState = 3;
      closedWith ??= code;
    },
    send: (data) => {
      sent.push(JSON.parse(String(data)));
    },
  };
  return {
    ws,
    sent,
    closedWith: () => closedWith,
    open: () => {
      ws.readyState = 1;
      fire("open", {});
    },
    server: (message: unknown) =>
      fire("message", {
        data: typeof message === "string" ? message : JSON.stringify(message),
      }),
    /** The worker or the network closed it. */
    drop: (code = 1006) => {
      ws.readyState = 3;
      fire("close", { code, reason: "" });
    },
  };
};

const fakeChannel = (): TextChannel => ({
  send: () => {},
  listen: () => () => {},
  onClose: () => () => {},
  isOpen: () => true,
});

interface FakePeer {
  readonly options: PeerLinkOptions;
  readonly received: Signal[];
  /** Whether the scope `connect` ran in has closed. */
  released: boolean;
  /** Its channels open. */
  readonly open: () => PeerLink;
  /** Its link closes, or its connection fails, after it opened. */
  readonly close: () => void;
  /** It can't connect. */
  readonly fail: (message: string) => void;
  /** It dies: a bug in the connector. */
  readonly crash: (defect: Error) => void;
}

const fakeConnector = () => {
  const peers: FakePeer[] = [];
  const api: PeerConnectorApi = {
    connect: (options) =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<PeerLink, PeerLinkError>();
        const closed = yield* Deferred.make<undefined>();
        const peer: FakePeer = {
          options,
          received: [],
          released: false,
          open: () => {
            const link: PeerLink = {
              peer: options.peer,
              lockstep: fakeChannel(),
              messages: fakeChannel(),
              closed: Deferred.await(closed),
            };
            Deferred.doneUnsafe(opened, Effect.succeed(link));
            return link;
          },
          close: () => Deferred.doneUnsafe(closed, Effect.undefined),
          fail: (message) =>
            Deferred.doneUnsafe(
              opened,
              Effect.fail(
                new PeerLinkError({
                  peer: options.peer,
                  reason: "failed",
                  message,
                })
              )
            ),
          crash: (defect) => Deferred.doneUnsafe(opened, Effect.die(defect)),
        };
        peers.push(peer);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            peer.released = true;
          })
        );
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(options.signals).pipe(
              Effect.map((signal) => peer.received.push(signal))
            )
          )
        );
        return yield* Deferred.await(opened);
      }),
  };
  return { api, peers };
};

const play = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(TestClock.layer())));

/** Lets the room's fibers run. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) {
    yield* Effect.yieldNow;
  }
});

/**
 * A room being opened, in a scope the test closes, with a fake worker and fake peers. `socket()`
 * is the latest socket the room made.
 */
const opening = (
  role: "host" | "guest",
  code = "k7mq2x",
  /**
   * The WebSocket constructor throws, as it does on a malformed URL, or the socket it makes has a
   * bug: listening to it throws `socketBug`.
   */
  broken?: "throws" | "buggy"
) =>
  Effect.gen(function* () {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const urls: string[] = [];
    const connector = fakeConnector();
    const layer = Layer.mergeAll(
      Layer.succeed(Socket.WebSocketConstructor, (url: string) => {
        urls.push(url);
        if (broken === "throws") {
          throw new SyntaxError(`${url} is not a valid URL`);
        }
        const made = fakeSocket();
        sockets.push(made);
        return broken === "buggy"
          ? {
              ...made.ws,
              addEventListener: () => {
                throw socketBug;
              },
            }
          : made.ws;
      }),
      Layer.succeed(PeerConnector, connector.api)
    );
    const options = { url: "ws://signal.test/" };
    const scope = yield* Scope.make();
    const fiber = yield* Effect.forkChild(
      (role === "host" ? hostRoom(options) : joinRoom(options, code)).pipe(
        Effect.provide(layer),
        Scope.provide(scope)
      )
    );
    yield* settle;
    return {
      scope,
      fiber,
      urls,
      sockets,
      socket: () => sockets.at(-1)!,
      peers: connector.peers,
    };
  });

/** Reads the room's events as they come, until the stream ends or fails. */
const watching = (room: SignallingRoom) =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const reading = yield* Effect.forkChild(
      Stream.runForEach(room.events, (event) =>
        Effect.sync(() => seen.push(summary(event)))
      )
    );
    return { seen, reading };
  });

/** An event as a test compares it: its type, with the peer and the reason where there are ones. */
const summary = (event: RoomEvent) =>
  [
    event.type,
    "peer" in event ? event.peer : undefined,
    "reason" in event ? event.reason : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

const socketBug = new Error("socket bug");

/** What a fiber that has ended died of; how else it ended, or that it hasn't. */
const defect = (exit: Exit.Exit<unknown, unknown> | undefined) => {
  if (exit === undefined) {
    return "still running";
  }
  return Exit.isFailure(exit) && Cause.hasDies(exit.cause)
    ? Cause.squash(exit.cause)
    : String(exit);
};

const roomFailure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return "succeeded";
  }
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  return error?._tag === "Fail" && error.error instanceof RoomError
    ? { reason: error.error.reason, message: error.error.message }
    : String(exit);
};

const welcomeHost = {
  type: "welcome",
  code: "K7MQ2X",
  self: "host",
  host: "host",
  peers: [],
};

const welcomeGuest = {
  type: "welcome",
  code: "K7MQ2X",
  self: "guest-1",
  host: "host",
  peers: ["host"],
};

const answer: Signal = { kind: "answer", sdp: "v=0 answer" };
const offer: Signal = { kind: "offer", sdp: "v=0 offer" };

describe("hosting a room", () => {
  it("opens /host, succeeds on the welcome, links each guest and starts, keeping the links", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("host");
        t.socket().open();
        yield* settle;
        const beforeWelcome = t.fiber.pollUnsafe();
        t.socket().server(welcomeHost);
        const room = yield* Fiber.join(t.fiber);
        const { seen, reading } = yield* watching(room);

        t.socket().server({ type: "peer-joined", peer: "guest-1" });
        yield* settle;
        const [guest] = t.peers;
        // The host's signals go to that guest through the worker, and the guest's come back to it.
        guest!.options.sendSignal(offer);
        t.socket().server({ type: "signal", from: "guest-1", signal: answer });
        yield* settle;
        const link = guest!.open();
        yield* settle;
        yield* room.start;
        yield* settle;
        t.socket().server({ type: "started" });
        const ended = yield* Fiber.await(reading);
        const result = {
          beforeWelcome,
          room: [room.role, room.code, room.self, room.host],
          urls: t.urls,
          guest: [
            guest!.options.peer,
            guest!.options.initiator,
            guest!.received,
          ],
          sent: t.socket().sent,
          seen,
          ended: Exit.isSuccess(ended),
          // The run keeps its links once the socket is gone.
          closedWith: t.socket().closedWith(),
          links: room.links(),
          kept: !guest!.released,
          link,
        };
        yield* Scope.close(t.scope, Exit.void);
        return { ...result, releasedAfter: guest!.released };
      })
    );
    expect(Exit.isSuccess(exit) && exit.value).toStrictEqual({
      beforeWelcome: undefined,
      room: ["host", "K7MQ2X", "host", "host"],
      urls: ["ws://signal.test/host"],
      guest: ["guest-1", true, [answer]],
      sent: [
        { type: "signal", to: "guest-1", signal: offer },
        { type: "start" },
      ],
      seen: ["peer-joined guest-1", "peer-connected guest-1", "started"],
      ended: true,
      closedWith: 1000,
      links: [Exit.isSuccess(exit) && exit.value.link],
      kept: true,
      link: Exit.isSuccess(exit) && exit.value.link,
      releasedAfter: true,
    });
  });

  it("drops a guest that leaves, whose link closes, or that isn't connected at the start", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("host");
        t.socket().open();
        t.socket().server(welcomeHost);
        const room = yield* Fiber.join(t.fiber);
        const { seen, reading } = yield* watching(room);
        for (const peer of ["guest-1", "guest-2", "guest-3"]) {
          t.socket().server({ type: "peer-joined", peer });
        }
        yield* settle;
        const [one, two, three] = t.peers;
        one!.open();
        two!.open();
        yield* settle;
        t.socket().server({ type: "peer-left", peer: "guest-1" });
        // guest-2's connection fails after it opened, before the start.
        two!.close();
        yield* settle;
        t.socket().server({ type: "started" });
        yield* Fiber.await(reading);
        return {
          seen,
          released: t.peers.map((peer) => peer.released),
          links: room.links(),
          three: three!.options.peer,
        };
      })
    );
    expect(Exit.isSuccess(exit) && exit.value).toStrictEqual({
      seen: [
        "peer-joined guest-1",
        "peer-joined guest-2",
        "peer-joined guest-3",
        "peer-connected guest-1",
        "peer-connected guest-2",
        "peer-left guest-1",
        "peer-left guest-2",
        "peer-left guest-3 not connected at the start",
        "started",
      ],
      released: [true, true, true],
      links: [],
      three: "guest-3",
    });
  });

  it("keeps the events until they are read", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("host");
        t.socket().open();
        t.socket().server(welcomeHost);
        t.socket().server({ type: "peer-joined", peer: "guest-1" });
        t.socket().server({ type: "started" });
        const room = yield* Fiber.join(t.fiber);
        yield* settle;
        return (yield* Stream.runCollect(room.events)).map(summary);
      })
    );
    expect(exit).toStrictEqual(
      Exit.succeed([
        "peer-joined guest-1",
        "peer-left guest-1 not connected at the start",
        "started",
      ])
    );
  });

  it("closes the socket and every peer when its scope closes", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("host");
        t.socket().open();
        t.socket().server(welcomeHost);
        yield* Fiber.join(t.fiber);
        t.socket().server({ type: "peer-joined", peer: "guest-1" });
        t.socket().server({ type: "peer-joined", peer: "guest-2" });
        yield* settle;
        t.peers[0]!.open();
        yield* settle;
        yield* Scope.close(t.scope, Exit.void);
        return [t.socket().closedWith(), t.peers.map((peer) => peer.released)];
      })
    );
    expect(exit).toStrictEqual(Exit.succeed([1000, [true, true]]));
  });

  it("interrupts a reader of its events outside the scope when the scope closes", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("host");
        t.socket().open();
        t.socket().server(welcomeHost);
        const room = yield* Fiber.join(t.fiber);
        const reading = yield* Effect.forkDetach(Stream.runDrain(room.events));
        yield* settle;
        yield* Scope.close(t.scope, Exit.void);
        yield* settle;
        const read = reading.pollUnsafe();
        return read !== undefined && Exit.hasInterrupts(read);
      })
    );
    expect(exit).toStrictEqual(Exit.succeed(true));
  });
});

describe("joining a room", () => {
  it("opens /join/<code>, answers the host and starts with it", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("guest", " k7mq2x ");
        t.socket().open();
        t.socket().server(welcomeGuest);
        const room = yield* Fiber.join(t.fiber);
        const { seen, reading } = yield* watching(room);
        yield* settle;
        const [host] = t.peers;
        t.socket().server({ type: "signal", from: "host", signal: offer });
        host!.options.sendSignal(answer);
        yield* settle;
        host!.open();
        yield* settle;
        // A guest can't start the run.
        yield* room.start;
        yield* settle;
        t.socket().server({ type: "started" });
        yield* Fiber.await(reading);
        return {
          urls: t.urls,
          room: [room.role, room.self, room.host],
          host: [host!.options.peer, host!.options.initiator, host!.received],
          sent: t.socket().sent,
          seen,
          links: room.links().length,
        };
      })
    );
    expect(Exit.isSuccess(exit) && exit.value).toStrictEqual({
      urls: ["ws://signal.test/join/K7MQ2X"],
      room: ["guest", "guest-1", "host"],
      host: ["host", false, [offer]],
      sent: [{ type: "signal", to: "host", signal: answer }],
      seen: ["peer-connected host", "started"],
      links: 1,
    });
  });

  it("fails without a socket when the code can't be one", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("guest", "K7MQ");
        return [yield* Fiber.await(t.fiber), t.urls] as const;
      })
    );
    const [opened, urls] = Exit.isSuccess(exit) ? exit.value : [];
    expect([roomFailure(opened!), urls]).toStrictEqual([
      { reason: "bad-code", message: "A join code is 6 letters and digits." },
      [],
    ]);
  });

  it("fails clearly when the worker can't be reached, refuses or drops", async () => {
    const outcomes = await Promise.all(
      (["throws", "never opens", "refused", "closed"] as const).map((how) =>
        play(
          Effect.gen(function* () {
            const t = yield* opening(
              "guest",
              "k7mq2x",
              how === "throws" ? "throws" : undefined
            );
            switch (how) {
              case "never opens": {
                yield* TestClock.adjust("10 seconds");
                break;
              }
              case "refused": {
                t.socket().open();
                t.socket().server({ type: "error", reason: "unknown-code" });
                t.socket().drop(1000);
                break;
              }
              case "closed": {
                t.socket().open();
                yield* settle;
                t.socket().drop();
                break;
              }
            }
            const opened = yield* Fiber.await(t.fiber);
            return [how, roomFailure(opened), t.sockets[0]?.closedWith()];
          })
        )
      )
    );
    const unreachable = {
      reason: "unreachable",
      message: "Couldn't reach the signalling server at ws://signal.test.",
    };
    expect(
      outcomes.map((exit) => (Exit.isSuccess(exit) ? exit.value : exit))
    ).toStrictEqual([
      ["throws", unreachable, undefined],
      ["never opens", unreachable, 1000],
      [
        "refused",
        {
          reason: "unknown-code",
          message:
            "No room has that code. Check it, or ask the host for a new one.",
        },
        1000,
      ],
      [
        "closed",
        {
          reason: "lost",
          message: "Lost the connection to the signalling server.",
        },
        1000,
      ],
    ]);
  });

  it("fails the room, closing the socket, when the link to the host can't be made or closes before the start", async () => {
    const outcomes = await Promise.all(
      (["can't connect", "closes"] as const).map((how) =>
        play(
          Effect.gen(function* () {
            const t = yield* opening("guest");
            t.socket().open();
            t.socket().server(welcomeGuest);
            const room = yield* Fiber.join(t.fiber);
            const { seen, reading } = yield* watching(room);
            yield* settle;
            const [host] = t.peers;
            if (how === "can't connect") {
              host!.fail("ICE failed");
            } else {
              host!.open();
              yield* settle;
              host!.close();
            }
            const ended = yield* Fiber.await(reading);
            return {
              seen,
              failure: roomFailure(ended),
              closedWith: t.socket().closedWith(),
              released: host!.released,
              links: room.links(),
            };
          })
        )
      )
    );
    expect(
      outcomes.map((exit) => (Exit.isSuccess(exit) ? exit.value : exit))
    ).toStrictEqual([
      {
        seen: [],
        failure: { reason: "peer-failed", message: "ICE failed" },
        closedWith: 1000,
        released: true,
        links: [],
      },
      {
        seen: ["peer-connected host"],
        failure: { reason: "peer-failed", message: "The host left." },
        closedWith: 1000,
        released: true,
        links: [],
      },
    ]);
  });

  it("fails the events when the socket drops after the welcome, closing every peer", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("guest");
        t.socket().open();
        t.socket().server(welcomeGuest);
        const room = yield* Fiber.join(t.fiber);
        yield* settle;
        t.peers[0]!.open();
        yield* settle;
        t.socket().drop();
        const events = yield* Effect.exit(Stream.runCollect(room.events));
        return [
          roomFailure(events),
          Exit.isFailure(events) ? [] : events.value.map(summary),
          t.peers[0]!.released,
        ];
      })
    );
    expect(exit).toStrictEqual(
      Exit.succeed([
        {
          reason: "lost",
          message: "Lost the connection to the signalling server.",
        },
        [],
        true,
      ])
    );
  });
});

describe("a worker that doesn't welcome, or speaks another protocol", () => {
  it("fails with no-welcome when the welcome doesn't come in time after the socket opens", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const slow = yield* opening("host");
        const silent = yield* opening("host");
        // The welcome timer starts once the socket is open, not when it is made.
        yield* TestClock.adjust("6 seconds");
        slow.socket().open();
        silent.socket().open();
        yield* settle;
        yield* TestClock.adjust("9999 millis");
        slow.socket().server(welcomeHost);
        yield* settle;
        yield* TestClock.adjust("1 millis");
        return [
          roomFailure(yield* Fiber.await(slow.fiber)),
          roomFailure(yield* Fiber.await(silent.fiber)),
          silent.socket().closedWith(),
        ];
      })
    );
    expect(exit).toStrictEqual(
      Exit.succeed([
        "succeeded",
        {
          reason: "no-welcome",
          message:
            "The signalling server didn't answer. Try again in a moment.",
        },
        1000,
      ])
    );
  });

  it("fails at once with bad-server-message on a welcome it can't read, closing the socket", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("guest");
        t.socket().open();
        t.socket().server({ type: "welcome", code: 7, v: 2 });
        yield* settle;
        return [
          roomFailure(yield* Fiber.await(t.fiber)),
          t.socket().closedWith(),
          t.peers.length,
        ];
      })
    );
    expect(exit).toStrictEqual(
      Exit.succeed([
        {
          reason: "bad-server-message",
          message:
            "The signalling server speaks another version of the game's protocol. Reload the page.",
        },
        1000,
        0,
      ])
    );
  });
});

describe("a bug in the room's socket or a peer's connector", () => {
  it("dies of a socket's bug before the welcome, rather than wait for the welcome", async () => {
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("host", "k7mq2x", "buggy");
        yield* settle;
        return defect(t.fiber.pollUnsafe());
      })
    );
    expect(exit).toStrictEqual(Exit.succeed(socketBug));
  });

  it("fails the events with a connector's bug, rather than wait for the link", async () => {
    const bug = new Error("connector bug");
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* opening("guest");
        t.socket().open();
        t.socket().server(welcomeGuest);
        const room = yield* Fiber.join(t.fiber);
        const { reading } = yield* watching(room);
        yield* settle;
        t.peers[0]!.crash(bug);
        yield* settle;
        return defect(reading.pollUnsafe());
      })
    );
    expect(exit).toStrictEqual(Exit.succeed(bug));
  });
});
