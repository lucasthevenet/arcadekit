import { Effect, Exit, Fiber, Queue, Result, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  PeerConnector,
  RtcPeerConnector,
} from "../../../src/net/browser/index";
import type { PeerLink } from "../../../src/net/browser/index";
import type { Signal } from "../../../src/net/signalling/index";

// The WebRTC connector over a fake RTCPeerConnection and fake data channels, in Node, on a
// TestClock: what it signals, in what order it applies the peer's signals, when its link opens,
// fails and closes, and that its scope always closes what it made.

type Listener = (event: {
  readonly data?: unknown;
  readonly candidate?: RtcPeerConnector.IceCandidateLike | null;
}) => void;

const events = () => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    add: (type: string, listener: Listener) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    remove: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type: string, event: Parameters<Listener>[0] = {}) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    count: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
};

const fakeChannel = (label: string, init: RTCDataChannelInit) => {
  const on = events();
  const channel: RtcPeerConnector.DataChannelLike & {
    readyState: RTCDataChannelState;
  } = {
    readyState: "connecting",
    send: () => {},
    close: () => {
      fake.closes += 1;
    },
    addEventListener: (type, listener) => on.add(type, listener),
    removeEventListener: (type, listener) => on.remove(type, listener),
  };
  const fake = {
    label,
    init,
    channel,
    closes: 0,
    listening: on.count,
    open: () => {
      channel.readyState = "open";
      on.fire("open");
    },
    /** The other side closed it. */
    closedByPeer: () => {
      channel.readyState = "closed";
      on.fire("close");
    },
  };
  return fake;
};

const fakeConnection = (
  options: {
    /** The nth data channel (from 0) that throws when made. */
    readonly throwOnChannel?: number;
    readonly rejectRemote?: boolean;
  } = {}
) => {
  const on = events();
  const log: string[] = [];
  const channels: ReturnType<typeof fakeChannel>[] = [];
  const configs: RTCConfiguration[] = [];
  let closes = 0;
  const connection: RtcPeerConnector.PeerConnectionLike & {
    connectionState: RTCPeerConnectionState;
  } = {
    connectionState: "new",
    createDataChannel: (label, init) => {
      if (channels.length === options.throwOnChannel) {
        throw new TypeError("too many channels");
      }
      const made = fakeChannel(label, init);
      channels.push(made);
      return made.channel;
    },
    createOffer: () => {
      log.push("createOffer");
      return Promise.resolve({ type: "offer", sdp: "v=0 offer" });
    },
    createAnswer: () => {
      log.push("createAnswer");
      return Promise.resolve({ type: "answer", sdp: "v=0 answer" });
    },
    setLocalDescription: (description) => {
      log.push(`local ${description.type}`);
      return Promise.resolve();
    },
    setRemoteDescription: (description) => {
      log.push(`remote ${description.type}`);
      return options.rejectRemote === true
        ? Promise.reject(new Error("bad SDP"))
        : Promise.resolve();
    },
    addIceCandidate: (candidate) => {
      log.push(`candidate ${candidate.candidate}`);
      return Promise.resolve();
    },
    addEventListener: (type, listener) => on.add(type, listener),
    removeEventListener: (type, listener) => on.remove(type, listener),
    close: () => {
      closes += 1;
    },
  };
  return {
    make: (config: RTCConfiguration) => {
      configs.push(config);
      return connection;
    },
    log,
    channels,
    configs,
    closes: () => closes,
    listening: on.count,
    candidate: (candidate: RtcPeerConnector.IceCandidateLike | null) =>
      on.fire("icecandidate", { candidate }),
    state: (state: RTCPeerConnectionState) => {
      connection.connectionState = state;
      on.fire("connectionstatechange");
    },
    openChannels: () => {
      for (const channel of channels) {
        channel.open();
      }
    },
  };
};

const play = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(TestClock.layer())));

/** Lets the connection's fibers and the fake's promises run. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) {
    yield* Effect.yieldNow;
  }
});

/** Starts connecting to `peer` in a scope the test closes. */
const connecting = (
  fake: ReturnType<typeof fakeConnection>,
  initiator: boolean,
  options: RtcPeerConnector.Options = {}
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const signals = yield* Queue.unbounded<Signal.Signal>();
    const sent: Signal.Signal[] = [];
    const fiber = yield* Effect.forkChild(
      RtcPeerConnector.make({
        iceServers: [],
        makeConnection: fake.make,
        ...options,
      })
        .connect({
          peer: "guest-1",
          initiator,
          signals,
          sendSignal: (signal) => sent.push(signal),
        })
        .pipe(Scope.provide(scope))
    );
    yield* settle;
    return { scope, signals, sent, fiber };
  });

const linkError = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = Exit.findError(exit);
  if (
    Result.isFailure(error) ||
    !(error.success instanceof PeerConnector.PeerLinkError)
  ) {
    throw new Error(
      `Expected a PeerConnector.PeerLinkError, got ${String(exit)}`
    );
  }
  const { peer, reason, message } = error.success;
  return { peer, reason, message };
};

const answer: Signal.Signal = { kind: "answer", sdp: "v=0 answer" };
const offer: Signal.Signal = { kind: "offer", sdp: "v=0 offer" };
const candidate = (text: string): Signal.Signal => ({
  kind: "candidate",
  candidate: text,
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "u",
});

describe(RtcPeerConnector.make, () => {
  it("offers, applies the peer's signals in order, and links once both channels open", async () => {
    const fake = fakeConnection();
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* connecting(fake, true);
        yield* Queue.offerAll(t.signals, [
          answer,
          candidate("c1"),
          candidate(""),
        ]);
        fake.candidate({
          candidate: "mine",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: "m",
        });
        fake.candidate(null);
        yield* settle;
        fake.channels[0]!.open();
        yield* settle;
        const beforeBoth = t.fiber.pollUnsafe();
        fake.channels[1]!.open();
        const link = yield* Fiber.join(t.fiber);
        const open = {
          beforeBoth,
          peer: link.peer,
          lockstepOpen: link.lockstep.isOpen(),
          sent: t.sent,
          closes: fake.closes(),
        };
        yield* Scope.close(t.scope, Exit.void);
        return open;
      })
    );
    expect(exit).toStrictEqual(
      Exit.succeed({
        beforeBoth: undefined,
        peer: "guest-1",
        lockstepOpen: true,
        sent: [
          offer,
          {
            kind: "candidate",
            candidate: "mine",
            sdpMid: "0",
            sdpMLineIndex: 0,
            usernameFragment: "m",
          },
          {
            kind: "candidate",
            candidate: "",
            sdpMid: null,
            sdpMLineIndex: null,
            usernameFragment: null,
          },
        ],
        closes: 0,
      })
    );
    // The end of candidates is applied as nothing.
    expect(fake.log).toStrictEqual([
      "createOffer",
      "local offer",
      "remote answer",
      "candidate c1",
    ]);
    expect(fake.configs).toStrictEqual([{ iceServers: [] }]);
    expect(fake.channels.map(({ label, init }) => [label, init])).toStrictEqual(
      [
        [
          "lockstep",
          { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 },
        ],
        ["messages", { negotiated: true, id: 1 }],
      ]
    );
    // Its scope closed both channels and the connection, and removed every listener.
    expect([
      fake.closes(),
      fake.channels.map((channel) => channel.closes),
      fake.listening(),
      fake.channels.map((channel) => channel.listening()),
    ]).toStrictEqual([1, [1, 1], 0, [1, 1]]);
  });

  it("answers the peer's offer when it doesn't make one", async () => {
    const fake = fakeConnection();
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* connecting(fake, false);
        const before = [...fake.log];
        yield* Queue.offer(t.signals, offer);
        yield* settle;
        yield* Scope.close(t.scope, Exit.void);
        return { before, sent: t.sent };
      })
    );
    expect(exit).toStrictEqual(Exit.succeed({ before: [], sent: [answer] }));
    expect(fake.log).toStrictEqual([
      "remote offer",
      "createAnswer",
      "local answer",
    ]);
  });

  it("closes what it made when a part of it can't be made", async () => {
    const results = await Promise.all(
      (
        [
          [0, "no channel"],
          [1, "one channel"],
        ] as const
      ).map(async ([throwOnChannel, made]) => {
        const fake = fakeConnection({ throwOnChannel });
        const exit = await play(
          Effect.scoped(
            RtcPeerConnector.make({ makeConnection: fake.make }).connect({
              peer: "guest-1",
              initiator: true,
              signals: Effect.runSync(Queue.unbounded<Signal.Signal>()),
              sendSignal: () => {},
            })
          )
        );
        return [
          made,
          linkError(exit),
          fake.closes(),
          fake.channels.map((channel) => channel.closes),
        ];
      })
    );
    const setup = {
      peer: "guest-1",
      reason: "setup",
      message: "WebRTC setup with guest-1 failed: too many channels",
    };
    expect(results).toStrictEqual([
      ["no channel", setup, 1, []],
      ["one channel", setup, 1, [1]],
    ]);
  });

  it("fails setting up when the connection can't be made", async () => {
    const exit = await play(
      Effect.scoped(
        RtcPeerConnector.make({
          makeConnection: () => {
            throw new SyntaxError("stun.example is not a valid stun URL");
          },
        }).connect({
          peer: "host",
          initiator: false,
          signals: Effect.runSync(Queue.unbounded<Signal.Signal>()),
          sendSignal: () => {},
        })
      )
    );
    expect(linkError(exit)).toStrictEqual({
      peer: "host",
      reason: "setup",
      message:
        "WebRTC setup with host failed: stun.example is not a valid stun URL",
    });
  });

  it("fails when the peer's description can't be applied", async () => {
    const fake = fakeConnection({ rejectRemote: true });
    const exit = await play(
      Effect.gen(function* () {
        const t = yield* connecting(fake, true);
        yield* Queue.offer(t.signals, answer);
        const result = yield* Fiber.await(t.fiber);
        yield* Scope.close(t.scope, Exit.void);
        return result;
      })
    );
    expect(Exit.isSuccess(exit) && linkError(exit.value)).toStrictEqual({
      peer: "guest-1",
      reason: "setup",
      message: "WebRTC setup with guest-1 failed: bad SDP",
    });
    expect(fake.closes()).toBe(1);
  });

  it("fails when ICE fails before the channels open, or they don't open in time", async () => {
    const failed = fakeConnection();
    const late = fakeConnection();
    const exit = await play(
      Effect.gen(function* () {
        const one = yield* connecting(failed, true);
        failed.state("failed");
        const two = yield* connecting(late, true, { openTimeout: "5 seconds" });
        yield* TestClock.adjust("4999 millis");
        const beforeTimeout = two.fiber.pollUnsafe();
        yield* TestClock.adjust("1 millis");
        return [
          yield* Fiber.await(one.fiber),
          beforeTimeout,
          yield* Fiber.await(two.fiber),
        ] as const;
      })
    );
    const [iceFailed, beforeTimeout, timedOut] = Exit.isSuccess(exit)
      ? exit.value
      : [];
    expect([
      linkError(iceFailed!),
      beforeTimeout,
      linkError(timedOut!),
    ]).toStrictEqual([
      {
        peer: "guest-1",
        reason: "failed",
        message:
          "Couldn't connect to guest-1 directly. Without a TURN server, some networks can't connect.",
      },
      undefined,
      {
        peer: "guest-1",
        reason: "timeout",
        message:
          "Couldn't connect to guest-1 directly in time. Without a TURN server, some networks can't connect.",
      },
    ]);
  });

  it("ends the link when the connection fails after it opened, a channel closes or its scope closes", async () => {
    const results = await Promise.all(
      (["connection failed", "channel closed", "scope closed"] as const).map(
        async (how) => {
          const fake = fakeConnection();
          const exit = await play(
            Effect.gen(function* () {
              const t = yield* connecting(fake, true);
              fake.openChannels();
              const link: PeerLink.PeerLink = yield* Fiber.join(t.fiber);
              const closed = yield* Effect.forkChild(link.closed);
              yield* settle;
              const before = closed.pollUnsafe() !== undefined;
              switch (how) {
                case "connection failed": {
                  fake.state("failed");
                  break;
                }
                case "channel closed": {
                  fake.channels[1]!.closedByPeer();
                  break;
                }
                case "scope closed": {
                  // Closing a connection fires no close event on its channels.
                  yield* Scope.close(t.scope, Exit.void);
                  break;
                }
              }
              yield* settle;
              const after = closed.pollUnsafe() !== undefined;
              yield* Scope.close(t.scope, Exit.void);
              return [before, after];
            })
          );
          return [how, exit];
        }
      )
    );
    expect(results).toStrictEqual([
      ["connection failed", Exit.succeed([false, true])],
      ["channel closed", Exit.succeed([false, true])],
      ["scope closed", Exit.succeed([false, true])],
    ]);
  });
});
