import { describe, expect, it } from "vitest";

import {
  ClientMessage,
  JoinCode,
  PeerId,
  Room,
  ServerMessage,
  Signal,
} from "./index";

const candidate: Signal.Signal = {
  kind: "candidate",
  candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "abcd",
};

const signalTo = (to: string, signal: unknown) =>
  JSON.stringify({ type: "signal", to, signal });

const offerOfLength = (length: number) =>
  signalTo("host", { kind: "offer", sdp: "s".repeat(length) });

describe(JoinCode.fromBytes, () => {
  it("maps bytes to letters of the alphabet", () => {
    expect(JoinCode.fromBytes([0, 1, 2, 3, 4, 5])).toBe("ABCDEF");
  });

  it("skips bytes the alphabet doesn't divide evenly, so every letter is equally likely", () => {
    const limit =
      Math.floor(256 / JoinCode.alphabet.length) * JoinCode.alphabet.length;
    expect(JoinCode.fromBytes([limit, 255, 0, 1, 2, 3, 4, 5])).toBe("ABCDEF");
  });

  it("gives up when the bytes run out", () => {
    expect(JoinCode.fromBytes([0, 1, 255])).toBeUndefined();
  });
});

describe(JoinCode.fromTyped, () => {
  it("accepts a code typed in lower case with spaces around it", () => {
    expect(JoinCode.fromTyped("  abc234 ")).toBe("ABC234");
  });

  it.each(["ABC23", "ABC2345", "ABC10O", "ABC-23"])("refuses %s", (typed) => {
    expect(JoinCode.fromTyped(typed)).toBeUndefined();
  });

  it("accepts every code JoinCode.fromBytes makes", () => {
    const code = JoinCode.fromBytes([7, 30, 12, 99, 200, 61]);
    expect(code).toHaveLength(JoinCode.length);
    expect(JoinCode.fromTyped(code!)).toBe(code);
  });
});

describe(JoinCode.fromPath, () => {
  it("reads the code of a /join/<code> path, and nothing else", () => {
    expect(
      [
        "/join/k7mq2x",
        "/join/%20K7MQ2X",
        "/join/%E0%A4%A",
        "/join/K7MQ2",
        "/host",
        "/join/K7MQ2X/x",
      ].map(JoinCode.fromPath)
    ).toStrictEqual([
      "K7MQ2X",
      "K7MQ2X",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe(ClientMessage.fromJson, () => {
  it.each<ClientMessage.ClientMessage>([
    { type: "start" },
    { type: "signal", to: "host", signal: { kind: "offer", sdp: "v=0" } },
    { type: "signal", to: "guest-1", signal: { kind: "answer", sdp: "v=0" } },
    { type: "signal", to: "host", signal: candidate },
    {
      type: "signal",
      to: "host",
      signal: {
        kind: "candidate",
        candidate: "",
        sdpMid: null,
        sdpMLineIndex: null,
        usernameFragment: null,
      },
    },
  ])("reads back $type as it was sent", (message) => {
    expect(ClientMessage.fromJson(JSON.stringify(message))).toStrictEqual(
      message
    );
  });

  it("drops fields the protocol doesn't have", () => {
    expect(
      ClientMessage.fromJson('{"type":"start","to":"host"}')
    ).toStrictEqual({
      type: "start",
    });
  });

  it("drops a signal's extra fields too, so the worker relays none of them", () => {
    expect(
      ClientMessage.fromJson(
        signalTo("host", { ...candidate, note: "x", extra: { a: 1 } })
      )
    ).toStrictEqual({ type: "signal", to: "host", signal: candidate });
  });

  it.each([
    signalTo("host", { ...candidate, sdpMid: 0 }),
    signalTo("host", { ...candidate, sdpMLineIndex: 0.5 }),
    signalTo("host", { ...candidate, sdpMLineIndex: -1 }),
    signalTo("host", { ...candidate, sdpMLineIndex: 65_536 }),
    signalTo("host", { ...candidate, sdpMLineIndex: "0" }),
    signalTo("host", { ...candidate, usernameFragment: undefined }),
    signalTo("host", { kind: "pranswer", sdp: "v=0" }),
    signalTo("host", { kind: "offer" }),
    signalTo("host", "v=0"),
    '{"type":"signal","to":3,"signal":{"kind":"offer","sdp":"v=0"}}',
    '{"type":"signal","signal":{"kind":"offer","sdp":"v=0"}}',
    '{"type":"hello"}',
    '{"type":"start"',
    "",
    "[]",
    "null",
  ])("refuses %s", (text) => {
    expect(ClientMessage.fromJson(text)).toBeUndefined();
  });

  it("refuses a field longer than the protocol allows", () => {
    expect(
      [
        signalTo("x".repeat(PeerId.maxLength + 1), {
          kind: "offer",
          sdp: "v=0",
        }),
        signalTo("host", {
          ...candidate,
          sdpMid: "m".repeat(Signal.maxTokenLength + 1),
        }),
        signalTo("host", {
          ...candidate,
          usernameFragment: "u".repeat(Signal.maxTokenLength + 1),
        }),
      ].map(ClientMessage.fromJson)
    ).toStrictEqual([undefined, undefined, undefined]);
    expect(
      [
        signalTo("x".repeat(PeerId.maxLength), { kind: "offer", sdp: "v=0" }),
        signalTo("host", {
          ...candidate,
          sdpMid: "m".repeat(Signal.maxTokenLength),
        }),
      ].map((text) => ClientMessage.fromJson(text)?.type)
    ).toStrictEqual(["signal", "signal"]);
  });

  it("refuses a message longer than ClientMessage.maxLength, and reads one that fits", () => {
    const room = ClientMessage.maxLength - offerOfLength(0).length;
    expect(ClientMessage.fromJson(offerOfLength(room))?.type).toBe("signal");
    expect(ClientMessage.fromJson(offerOfLength(room + 1))).toBeUndefined();
  });
});

describe(ServerMessage.fromJson, () => {
  it.each<ServerMessage.ServerMessage>([
    {
      type: "welcome",
      code: "ABC234",
      self: "guest-1",
      host: "host",
      peers: ["host"],
    },
    { type: "peer-joined", peer: "guest-1" },
    { type: "peer-left", peer: "guest-1" },
    {
      type: "signal",
      from: "host",
      signal: {
        kind: "candidate",
        candidate: "",
        sdpMid: null,
        sdpMLineIndex: null,
        usernameFragment: null,
      },
    },
    { type: "started" },
    { type: "error", reason: "full" },
  ])("reads back $type as it was sent", (message) => {
    expect(ServerMessage.fromJson(JSON.stringify(message))).toStrictEqual(
      message
    );
  });

  it("reads back every error reason", () => {
    for (const reason of ServerMessage.ErrorReason.literals) {
      const message: ServerMessage.ServerMessage = { type: "error", reason };
      expect(ServerMessage.fromJson(JSON.stringify(message))).toStrictEqual(
        message
      );
    }
  });

  it("reads back a relayed signal as long as the longest client message can carry", () => {
    const sdp = "s".repeat(ClientMessage.maxLength - 64);
    const message: ServerMessage.ServerMessage = {
      type: "signal",
      from: "guest-12",
      signal: { kind: "offer", sdp },
    };
    expect(ServerMessage.fromJson(JSON.stringify(message))).toStrictEqual(
      message
    );
  });

  const welcome = {
    type: "welcome",
    code: "ABC234",
    self: "guest-1",
    host: "host",
    peers: ["host"],
  };

  it.each([
    { type: "error", reason: "bored" },
    { type: "error", reason: 3 },
    { type: "error" },
    { ...welcome, code: "abc234" },
    { ...welcome, code: "ABC23" },
    { ...welcome, code: "ABC10O" },
    { ...welcome, peers: "host" },
    { ...welcome, peers: [3] },
    {
      ...welcome,
      peers: Array.from({ length: Room.maxSize }, (_, i) => `guest-${i}`),
    },
    { ...welcome, self: "x".repeat(PeerId.maxLength + 1) },
    { type: "peer-joined" },
    { type: "peer-left", peer: null },
    { type: "signal", from: "host", signal: { kind: "offer", sdp: 0 } },
    { type: "goodbye" },
  ])("refuses %j", (message) => {
    expect(ServerMessage.fromJson(JSON.stringify(message))).toBeUndefined();
  });
});
