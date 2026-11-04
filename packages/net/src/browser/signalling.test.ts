import type { Signal } from "@gamekit/signalling/protocol";
import { describe, expect, it } from "vitest";

import type { PeerLink, TextChannel } from "./channel";
import type { ConnectPeerOptions } from "./rtc";
import { hostRoom, joinRoom } from "./signalling";
import type {
  RoomEvent,
  SignallingRoom,
  SignallingSocketHandlers,
} from "./signalling";

// The signalling client's state machine, in Node: a fake socket stands in for the worker and a
// fake ConnectPeer for WebRTC, so each test says what the worker and the peers do, and checks
// what the room sends and reports.

const fakeChannel = () => {
  const handlers = new Set<(text: string) => void>();
  const closers = new Set<() => void>();
  let open = true;
  const channel: TextChannel = {
    send: () => {},
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose: (handler) => {
      closers.add(handler);
      return () => closers.delete(handler);
    },
    isOpen: () => open,
  };
  const close = () => {
    if (open) {
      open = false;
      for (const closer of closers) {
        closer();
      }
    }
  };
  return { channel, close };
};

interface FakePeer {
  readonly options: ConnectPeerOptions;
  readonly received: Signal[];
  closed: boolean;
  /** The data channels open. */
  readonly open: () => PeerLink;
}

const offer: Signal = { kind: "offer", sdp: "v=0 offer" };
const answer: Signal = { kind: "answer", sdp: "v=0 answer" };

const setup = (
  role: "host" | "guest",
  code = "k7mq2x",
  connectThrows = false
) => {
  const sent: unknown[] = [];
  const peers: FakePeer[] = [];
  const events: RoomEvent[] = [];
  const urls: string[] = [];
  let handlers: SignallingSocketHandlers | undefined;
  let socketClosed = false;
  const options = {
    url: "ws://signal.test/",
    openSocket: (url: string, socketHandlers: SignallingSocketHandlers) => {
      urls.push(url);
      handlers = socketHandlers;
      return {
        send: (text: string) => sent.push(JSON.parse(text)),
        close: () => {
          socketClosed = true;
        },
      };
    },
    connectPeer: (peerOptions: ConnectPeerOptions) => {
      if (connectThrows) {
        throw new SyntaxError("stun.example is not a valid stun or turn URL");
      }
      const lockstep = fakeChannel();
      const messages = fakeChannel();
      const peer: FakePeer = {
        options: peerOptions,
        received: [],
        closed: false,
        open: () => {
          const link: PeerLink = {
            peer: peerOptions.peer,
            lockstep: lockstep.channel,
            messages: messages.channel,
            close: () => {
              lockstep.close();
              messages.close();
            },
          };
          peerOptions.onOpen(link);
          return link;
        },
      };
      peers.push(peer);
      return {
        receive: (signal: Signal) => peer.received.push(signal),
        close: () => {
          peer.closed = true;
        },
      };
    },
  };
  const room: SignallingRoom =
    role === "host" ? hostRoom(options) : joinRoom(options, code);
  room.subscribe((event) => events.push(event));
  const server = (message: unknown) => {
    handlers!.message(JSON.stringify(message));
  };
  return {
    room,
    sent,
    peers,
    events,
    urls,
    server,
    open: () => handlers!.open(),
    dropSocket: () => handlers!.close(),
    socketClosed: () => socketClosed,
  };
};

const welcomeHost = {
  type: "welcome",
  code: "K7MQ2X",
  self: "host",
  host: "host",
  peers: [],
};

/** Event types, with the peer where there is one: what a test compares. */
const summary = (events: readonly RoomEvent[]) =>
  events.map((event) =>
    "peer" in event ? `${event.type} ${event.peer}` : event.type
  );

describe("hosting a room", () => {
  it("opens /host, links to each guest that joins, and starts", () => {
    const t = setup("host");
    t.open();
    t.server(welcomeHost);
    expect([t.urls, t.room.status, t.room.code, t.room.self]).toStrictEqual([
      ["ws://signal.test/host"],
      "open",
      "K7MQ2X",
      "host",
    ]);

    t.server({ type: "peer-joined", peer: "guest-1" });
    const [guest] = t.peers;
    // The host's signals go to that guest through the worker, and the guest's come back to it.
    guest!.options.sendSignal(offer);
    t.server({ type: "signal", from: "guest-1", signal: answer });
    expect([
      guest!.options.peer,
      guest!.options.initiator,
      guest!.received,
    ]).toStrictEqual(["guest-1", true, [answer]]);

    const link = guest!.open();
    const linksBefore = t.room.links();
    t.room.start();
    t.server({ type: "started" });
    expect(t.sent).toStrictEqual([
      { type: "signal", to: "guest-1", signal: offer },
      { type: "start" },
    ]);
    // The run keeps its links once the socket is gone.
    expect([
      linksBefore,
      t.room.status,
      t.socketClosed(),
      t.room.links(),
    ]).toStrictEqual([[link], "started", true, [link]]);
    expect(summary(t.events)).toStrictEqual([
      "welcome",
      "peer-joined guest-1",
      "peer-connected guest-1",
      "started",
    ]);
  });

  it("drops a guest that leaves, fails to connect, or isn't connected at the start", () => {
    const t = setup("host");
    t.open();
    t.server(welcomeHost);
    for (const peer of ["guest-1", "guest-2", "guest-3"]) {
      t.server({ type: "peer-joined", peer });
    }
    const [one, two, three] = t.peers;
    one!.open();
    t.server({ type: "peer-left", peer: "guest-1" });
    two!.options.onFail("ICE failed");
    t.server({ type: "started" });
    expect(t.room.links()).toStrictEqual([]);
    expect(three!.closed).toBe(true);
    expect(t.events.slice(5)).toStrictEqual([
      { type: "peer-left", peer: "guest-1" },
      { type: "peer-left", peer: "guest-2", reason: "ICE failed" },
      {
        type: "peer-left",
        peer: "guest-3",
        reason: "not connected at the start",
      },
      { type: "started" },
    ]);
  });

  it("treats a link that closes before the start as a guest that left", () => {
    const t = setup("host");
    t.open();
    t.server(welcomeHost);
    t.server({ type: "peer-joined", peer: "guest-1" });
    t.peers[0]!.open().close();
    expect(t.room.links()).toStrictEqual([]);
    expect(t.events.at(-1)).toStrictEqual({
      type: "peer-left",
      peer: "guest-1",
    });
  });
});

describe("a peer connection that can't be made at all", () => {
  it("drops the guest on the host, and fails the room on a guest", () => {
    const reason =
      "WebRTC setup with guest-1 failed: stun.example is not a valid stun or turn URL";
    const host = setup("host", undefined, true);
    host.open();
    host.server(welcomeHost);
    host.server({ type: "peer-joined", peer: "guest-1" });
    expect(host.events.slice(1)).toStrictEqual([
      { type: "peer-joined", peer: "guest-1" },
      { type: "peer-left", peer: "guest-1", reason },
    ]);
    expect(host.room.status).toBe("open");

    const guest = setup("guest", "k7mq2x", true);
    guest.open();
    guest.server({
      type: "welcome",
      code: "K7MQ2X",
      self: "guest-1",
      host: "host",
      peers: ["host"],
    });
    expect([guest.room.status, guest.events.at(-1)]).toStrictEqual([
      "failed",
      {
        type: "failed",
        reason: "peer-failed",
        message:
          "WebRTC setup with host failed: stun.example is not a valid stun or turn URL",
      },
    ]);
    expect(guest.socketClosed()).toBe(true);
  });
});

describe("joining a room", () => {
  it("opens /join/<code>, answers the host and starts with it", () => {
    const t = setup("guest", " k7mq2x ");
    t.open();
    t.server({
      type: "welcome",
      code: "K7MQ2X",
      self: "guest-1",
      host: "host",
      peers: ["host"],
    });
    const [host] = t.peers;
    expect([t.urls, host!.options.peer, host!.options.initiator]).toStrictEqual(
      [["ws://signal.test/join/K7MQ2X"], "host", false]
    );
    t.server({ type: "signal", from: "host", signal: offer });
    host!.options.sendSignal(answer);
    expect(host!.received).toStrictEqual([offer]);
    host!.open();
    // A guest can't start the run.
    t.room.start();
    expect(t.sent).toStrictEqual([
      { type: "signal", to: "host", signal: answer },
    ]);
    t.server({ type: "started" });
    expect(summary(t.events)).toStrictEqual([
      "welcome",
      "peer-connected host",
      "started",
    ]);
    expect([t.room.status, t.room.self, t.room.links().length]).toStrictEqual([
      "started",
      "guest-1",
      1,
    ]);
  });

  it("fails clearly when the worker refuses, can't be reached, drops or the host can't be reached", async () => {
    const refused = setup("guest");
    refused.open();
    refused.server({ type: "error", reason: "unknown-code" });

    const unreachable = setup("guest");
    unreachable.dropSocket();

    const lost = setup("guest");
    lost.open();
    lost.server({
      type: "welcome",
      code: "K7MQ2X",
      self: "guest-1",
      host: "host",
      peers: ["host"],
    });
    lost.dropSocket();

    const noHost = setup("guest");
    noHost.open();
    noHost.server({
      type: "welcome",
      code: "K7MQ2X",
      self: "guest-1",
      host: "host",
      peers: ["host"],
    });
    noHost.peers[0]!.options.onFail("ICE failed");

    const badCode = setup("guest", "K7MQ");
    await Promise.resolve();

    const failures = [refused, unreachable, lost, noHost, badCode].map((t) => [
      t.room.status,
      t.events.at(-1),
    ]);
    expect(failures).toStrictEqual([
      [
        "failed",
        {
          type: "failed",
          reason: "unknown-code",
          message:
            "No room has that code. Check it, or ask the host for a new one.",
        },
      ],
      [
        "failed",
        {
          type: "failed",
          reason: "unreachable",
          message: "Couldn't reach the signalling server at ws://signal.test.",
        },
      ],
      [
        "failed",
        {
          type: "failed",
          reason: "lost",
          message: "Lost the connection to the signalling server.",
        },
      ],
      [
        "failed",
        { type: "failed", reason: "peer-failed", message: "ICE failed" },
      ],
      [
        "failed",
        {
          type: "failed",
          reason: "bad-code",
          message: "A join code is 6 letters and digits.",
        },
      ],
    ]);
    expect(badCode.urls).toStrictEqual([]);
    expect(noHost.peers[0]!.closed).toBe(true);
  });

  it("refuses to play a run that started before its link to the host opened", () => {
    const t = setup("guest");
    t.open();
    t.server({
      type: "welcome",
      code: "K7MQ2X",
      self: "guest-1",
      host: "host",
      peers: ["host"],
    });
    t.server({ type: "started" });
    expect(t.events.at(-1)).toMatchObject({
      type: "failed",
      reason: "started",
    });
  });
});
