import { describe, expect, it } from "vitest";

import { linksTransport } from "./channel";
import type { PeerLink, TextChannel } from "./channel";

// The WebRTC Transport adapter over fake channels: each lockstep message is one channel message,
// to and from the right peer, and nothing reaches a peer with no link.

const channel = () => {
  const sent: string[] = [];
  const handlers = new Set<(text: string) => void>();
  const text: TextChannel = {
    send: (message) => sent.push(message),
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose: () => () => {},
    isOpen: () => true,
  };
  const arrive = (message: string) => {
    for (const handler of handlers) {
      handler(message);
    }
  };
  return { text, sent, arrive };
};

const link = (peer: string) => {
  const lockstep = channel();
  const messages = channel();
  const value: PeerLink = {
    peer,
    lockstep: lockstep.text,
    messages: messages.text,
    close: () => {},
  };
  return { value, lockstep, messages };
};

describe(linksTransport, () => {
  it("sends each message whole on the peer's lockstep channel, and hears every peer's", () => {
    const one = link("guest-1");
    const two = link("guest-2");
    const transport = linksTransport("host", [one.value, two.value]);
    const heard: [string, string][] = [];
    const stop = transport.listen((from, message) =>
      heard.push([from, message])
    );

    const message = JSON.stringify({ kind: "steps", from: 0, steps: [] });
    transport.send("guest-2", message);
    transport.send("guest-9", "lost");
    one.lockstep.arrive('{"kind":"inputs"}');
    two.lockstep.arrive("{}");
    two.messages.arrive("not the run's");
    stop();
    one.lockstep.arrive("after stop");

    expect(transport.self).toBe("host");
    expect([
      one.lockstep.sent,
      two.lockstep.sent,
      two.messages.sent,
    ]).toStrictEqual([[], [message], []]);
    expect(heard).toStrictEqual([
      ["guest-1", '{"kind":"inputs"}'],
      ["guest-2", "{}"],
    ]);
  });
});
