import { describe, expect, it } from "vitest";

import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  joinCodeFromBytes,
  normalizeJoinCode,
  parseClientMessage,
  parseServerMessage,
} from "./protocol";
import type { ServerMessage } from "./protocol";

describe(joinCodeFromBytes, () => {
  it("maps bytes to letters of the alphabet", () => {
    expect(joinCodeFromBytes([0, 1, 2, 3, 4, 5])).toBe("ABCDEF");
  });

  it("skips bytes the alphabet doesn't divide evenly, so every letter is equally likely", () => {
    const limit =
      Math.floor(256 / JOIN_CODE_ALPHABET.length) * JOIN_CODE_ALPHABET.length;
    expect(joinCodeFromBytes([limit, 255, 0, 1, 2, 3, 4, 5])).toBe("ABCDEF");
  });

  it("gives up when the bytes run out", () => {
    expect(joinCodeFromBytes([0, 1, 255])).toBeUndefined();
  });
});

describe(normalizeJoinCode, () => {
  it("accepts a code typed in lower case with spaces around it", () => {
    expect(normalizeJoinCode("  abc234 ")).toBe("ABC234");
  });

  it.each(["ABC23", "ABC2345", "ABC10O", "ABC-23"])("refuses %s", (typed) => {
    expect(normalizeJoinCode(typed)).toBeUndefined();
  });

  it("accepts every code joinCodeFromBytes makes", () => {
    const code = joinCodeFromBytes([7, 30, 12, 99, 200, 61]);
    expect(code).toHaveLength(JOIN_CODE_LENGTH);
    expect(normalizeJoinCode(code!)).toBe(code);
  });
});

describe(parseClientMessage, () => {
  it("reads a start and each kind of signal", () => {
    expect(parseClientMessage('{"type":"start"}')).toStrictEqual({
      type: "start",
    });
    expect(
      parseClientMessage(
        '{"type":"signal","to":"host","signal":{"kind":"answer","sdp":"v=0"}}'
      )
    ).toStrictEqual({
      type: "signal",
      to: "host",
      signal: { kind: "answer", sdp: "v=0" },
    });
  });

  it.each([
    '{"type":"signal","to":"host","signal":{"kind":"candidate","candidate":"c","sdpMid":0,"sdpMLineIndex":0,"usernameFragment":null}}',
    '{"type":"signal","to":"host","signal":{"kind":"candidate","candidate":"c","sdpMid":"0","sdpMLineIndex":0.5,"usernameFragment":null}}',
    '{"type":"signal","to":3,"signal":{"kind":"offer","sdp":"v=0"}}',
    '{"type":"hello"}',
    "[]",
    "null",
  ])("refuses %s", (text) => {
    expect(parseClientMessage(text)).toBeUndefined();
  });
});

describe(parseServerMessage, () => {
  it.each<ServerMessage>([
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
    expect(parseServerMessage(JSON.stringify(message))).toStrictEqual(message);
  });

  it("refuses an error with an unknown reason", () => {
    expect(
      parseServerMessage('{"type":"error","reason":"bored"}')
    ).toBeUndefined();
  });
});
