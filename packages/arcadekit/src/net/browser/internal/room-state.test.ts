import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { Signal } from "../../signalling/index";
import { PeerLink } from "../index";
import { makeRoomState } from "./room-state";
import type { RoomInput, RoomOutput, RoomState } from "./room-state";

// The signalling client's rules, as tables: what the worker, the socket and the peer links do,
// and what the room asks its shell to do about it.

const channel: PeerLink.TextChannel = {
  send: () => {},
  listen: () => () => {},
  onClose: () => () => {},
  isOpen: () => true,
};

const link = (peer: string): PeerLink.PeerLink =>
  PeerLink.make({
    peer,
    lockstep: channel,
    messages: channel,
    closed: Effect.never,
  });

const server = (message: unknown): RoomInput => ({
  kind: "server",
  text: JSON.stringify(message),
});

const offer: Signal.Signal = { kind: "offer", sdp: "v=0 offer" };
const answer: Signal.Signal = { kind: "answer", sdp: "v=0 answer" };

const welcomeHost = server({
  type: "welcome",
  code: "K7MQ2X",
  self: "host",
  host: "host",
  peers: [],
});

const welcomeGuest = server({
  type: "welcome",
  code: "K7MQ2X",
  self: "guest-1",
  host: "host",
  peers: ["host"],
});

/** An output as a test compares it: a failure as its reason and message, a link as its peer. */
const shown = (output: RoomOutput): unknown => {
  switch (output.kind) {
    case "fail": {
      const { reason, message } = output;
      return { kind: "fail", reason, message };
    }
    case "event": {
      return output.event.type === "peer-connected"
        ? { kind: "event", type: "peer-connected", peer: output.event.peer }
        : { kind: "event", ...output.event };
    }
    default: {
      return output;
    }
  }
};

/** Each input with the outputs it made. */
const play = (room: RoomState, inputs: readonly RoomInput[]) =>
  inputs.map((input) => room.handle(input).map(shown));

const peerLeft = (peer: string, reason?: string) => [
  { kind: "drop", peer },
  {
    kind: "event",
    type: "peer-left",
    peer,
    ...(reason === undefined ? {} : { reason }),
  },
];

const failed = (reason: string, message: string) => [
  { kind: "fail", reason, message },
];

describe("hosting a room", () => {
  it("links to each guest that joins, and starts", () => {
    const room = makeRoomState("host", "ws://signal.test");
    const guest = link("guest-1");
    const before = play(room, [
      welcomeHost,
      server({ type: "peer-joined", peer: "guest-1" }),
      server({ type: "signal", from: "guest-1", signal: answer }),
      { kind: "linked", peer: "guest-1", link: guest },
      // A late signal from a linked peer goes nowhere.
      server({ type: "signal", from: "guest-1", signal: offer }),
      { kind: "start" },
    ]);
    const linksBefore = room.links();
    const after = play(room, [
      server({ type: "started" }),
      // Once started, the socket and the links are the run's business.
      { kind: "socket-closed", opened: true },
      { kind: "link-closed", peer: "guest-1" },
      { kind: "welcome-timeout" },
      { kind: "start" },
    ]);
    expect(before).toStrictEqual([
      [{ kind: "welcomed", code: "K7MQ2X", self: "host" }],
      [
        { kind: "event", type: "peer-joined", peer: "guest-1" },
        { kind: "connect", peer: "guest-1", initiator: true },
      ],
      [{ kind: "signal", peer: "guest-1", signal: answer }],
      [{ kind: "event", type: "peer-connected", peer: "guest-1" }],
      [],
      [{ kind: "send", message: { type: "start" } }],
    ]);
    expect(after).toStrictEqual([
      [{ kind: "event", type: "started" }, { kind: "close-socket" }],
      [],
      [],
      [],
      [],
    ]);
    // The run keeps its links once the socket is gone.
    expect([linksBefore, room.links()]).toStrictEqual([[guest], [guest]]);
  });

  it("drops a guest that leaves, fails to connect, or isn't connected at the start", () => {
    const room = makeRoomState("host", "ws://signal.test");
    play(room, [
      welcomeHost,
      ...["guest-1", "guest-2", "guest-3"].map((peer) =>
        server({ type: "peer-joined", peer })
      ),
      { kind: "linked", peer: "guest-1", link: link("guest-1") },
    ]);
    expect(
      play(room, [
        server({ type: "peer-left", peer: "guest-1" }),
        { kind: "link-failed", peer: "guest-2", message: "ICE failed" },
        server({ type: "started" }),
        // guest-3's link opening just after the start is too late.
        { kind: "linked", peer: "guest-3", link: link("guest-3") },
      ])
    ).toStrictEqual([
      peerLeft("guest-1"),
      peerLeft("guest-2", "ICE failed"),
      [
        ...peerLeft("guest-3", "not connected at the start"),
        { kind: "event", type: "started" },
        { kind: "close-socket" },
      ],
      [],
    ]);
    expect(room.links()).toStrictEqual([]);
  });

  it("treats a link that closes before the start as a guest that left", () => {
    const room = makeRoomState("host", "ws://signal.test");
    play(room, [
      welcomeHost,
      server({ type: "peer-joined", peer: "guest-1" }),
      { kind: "linked", peer: "guest-1", link: link("guest-1") },
    ]);
    expect([
      play(room, [{ kind: "link-closed", peer: "guest-1" }]),
      room.links(),
    ]).toStrictEqual([[peerLeft("guest-1")], []]);
  });
});

describe("a peer connection that can't be made at all", () => {
  it("drops the guest on the host, and fails the room on a guest", () => {
    const reason =
      "WebRTC setup with guest-1 failed: stun.example is not a valid stun or turn URL";
    const host = makeRoomState("host", "ws://signal.test");
    expect(
      play(host, [
        welcomeHost,
        server({ type: "peer-joined", peer: "guest-1" }),
        { kind: "link-failed", peer: "guest-1", message: reason },
        // The room is still open.
        { kind: "start" },
      ]).slice(2)
    ).toStrictEqual([
      peerLeft("guest-1", reason),
      [{ kind: "send", message: { type: "start" } }],
    ]);

    const guest = makeRoomState("guest", "ws://signal.test");
    const message =
      "WebRTC setup with host failed: stun.example is not a valid stun or turn URL";
    expect(
      play(guest, [
        welcomeGuest,
        { kind: "link-failed", peer: "host", message },
      ])
    ).toStrictEqual([
      [
        { kind: "welcomed", code: "K7MQ2X", self: "guest-1" },
        { kind: "connect", peer: "host", initiator: false },
      ],
      failed("peer-failed", message),
    ]);
  });
});

describe("joining a room", () => {
  it("answers the host and starts with it", () => {
    const room = makeRoomState("guest", "ws://signal.test");
    const host = link("host");
    expect(
      play(room, [
        welcomeGuest,
        server({ type: "signal", from: "host", signal: offer }),
        // Only the host signals a guest, and only the host joins.
        server({ type: "signal", from: "guest-2", signal: offer }),
        server({ type: "peer-joined", peer: "guest-2" }),
        { kind: "linked", peer: "host", link: host },
        // A guest can't start the run.
        { kind: "start" },
        server({ type: "started" }),
      ])
    ).toStrictEqual([
      [
        { kind: "welcomed", code: "K7MQ2X", self: "guest-1" },
        { kind: "connect", peer: "host", initiator: false },
      ],
      [{ kind: "signal", peer: "host", signal: offer }],
      [],
      [],
      [{ kind: "event", type: "peer-connected", peer: "host" }],
      [],
      [{ kind: "event", type: "started" }, { kind: "close-socket" }],
    ]);
    expect(room.links()).toStrictEqual([host]);
  });

  it("fails clearly when the worker refuses, can't be reached, drops or the host can't be reached", () => {
    const outcomes = [
      [server({ type: "error", reason: "unknown-code" })],
      [{ kind: "socket-closed", opened: false }],
      [{ kind: "socket-closed", opened: true }],
      [welcomeGuest, { kind: "socket-closed", opened: true }],
      [
        welcomeGuest,
        { kind: "link-failed", peer: "host", message: "ICE failed" },
      ],
      [
        welcomeGuest,
        { kind: "linked", peer: "host", link: link("host") },
        { kind: "link-closed", peer: "host" },
      ],
      [welcomeGuest, server({ type: "error", reason: "host-left" })],
    ] satisfies RoomInput[][];
    expect(
      outcomes.map((inputs) =>
        play(makeRoomState("guest", "ws://signal.test"), inputs).at(-1)!
      )
    ).toStrictEqual([
      failed(
        "unknown-code",
        "No room has that code. Check it, or ask the host for a new one."
      ),
      failed(
        "unreachable",
        "Couldn't reach the signalling server at ws://signal.test."
      ),
      failed("lost", "Lost the connection to the signalling server."),
      failed("lost", "Lost the connection to the signalling server."),
      failed("peer-failed", "ICE failed"),
      failed("peer-failed", "The host left."),
      failed("host-left", "The host left."),
    ]);
  });

  it("keeps the socket's error as the failure's cause", () => {
    const cause = new Error("connection refused");
    const [output] = makeRoomState("guest", "ws://signal.test").handle({
      kind: "socket-closed",
      opened: false,
      cause,
    });
    expect(output?.kind === "fail" && output.cause).toBe(cause);
  });

  it("refuses to play a run that started before its link to the host opened", () => {
    const room = makeRoomState("guest", "ws://signal.test");
    expect(
      play(room, [welcomeGuest, server({ type: "started" })]).at(-1)
    ).toStrictEqual(failed("started", "That run has already started."));
  });
});

describe("a worker that doesn't welcome, or speaks another protocol", () => {
  const otherVersion = failed(
    "bad-server-message",
    "The signalling server speaks another version of the game's protocol. Reload the page."
  );

  it("fails when no welcome comes in time, and not once it has", () => {
    expect([
      play(makeRoomState("host", "ws://signal.test"), [
        { kind: "welcome-timeout" },
      ]),
      play(makeRoomState("host", "ws://signal.test"), [
        welcomeHost,
        { kind: "welcome-timeout" },
      ]),
    ]).toStrictEqual([
      [
        failed(
          "no-welcome",
          "The signalling server didn't answer. Try again in a moment."
        ),
      ],
      [[{ kind: "welcomed", code: "K7MQ2X", self: "host" }], []],
    ]);
  });

  it("fails on a message it can't read, before the welcome or after it", () => {
    const cases = [
      [{ kind: "server", text: "{v2" }],
      [server({ type: "welcome", code: 7 })],
      // Anything but a welcome or an error comes too early.
      [server({ type: "peer-joined", peer: "guest-1" })],
      [welcomeHost, server({ type: "peer-joined", peer: 3 })],
      [welcomeHost, { kind: "server", text: "" }],
    ] satisfies RoomInput[][];
    expect(
      cases.map((inputs) =>
        play(makeRoomState("host", "ws://signal.test"), inputs).at(-1)!
      )
    ).toStrictEqual(cases.map(() => otherVersion));
  });

  it("does nothing once it has failed", () => {
    const room = makeRoomState("host", "ws://signal.test");
    expect(
      play(room, [
        { kind: "welcome-timeout" },
        welcomeHost,
        { kind: "socket-closed", opened: true },
        { kind: "start" },
      ]).slice(1)
    ).toStrictEqual([[], [], []]);
  });
});
