import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PeerLink, RtcTransport } from "./index";
import type { RtcPeerConnector } from "./index";
import { dataChannelText } from "./internal/data-channel-text";

// The WebRTC Transport adapter over fake channels: each lockstep message is one channel message,
// to and from the right peer, and nothing reaches a peer with no link. Then `dataChannelText`
// over a fake RTCDataChannel.

const channel = () => {
  const sent: string[] = [];
  const handlers = new Set<(text: string) => void>();
  const text: PeerLink.TextChannel = {
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
  const value: PeerLink.PeerLink = PeerLink.make({
    peer,
    lockstep: lockstep.text,
    messages: messages.text,
    closed: Effect.never,
  });
  return { value, lockstep, messages };
};

describe(RtcTransport.fromLinks, () => {
  it("sends each message whole on the peer's lockstep channel, and hears every peer's", () => {
    const one = link("guest-1");
    const two = link("guest-2");
    const transport = RtcTransport.fromLinks("host", [one.value, two.value]);
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

/** A fake RTCDataChannel: `fire` dispatches an event, as the browser would. */
const dataChannel = (readyState: RTCDataChannelState) => {
  const listeners = new Map<
    string,
    Set<(event: { readonly data?: unknown }) => void>
  >();
  const wrapped = new Map<
    (event: { readonly data?: unknown }) => void,
    (event: { readonly data?: unknown }) => void
  >();
  const sent: string[] = [];
  const fake: RtcPeerConnector.DataChannelLike & {
    readyState: RTCDataChannelState;
  } = {
    readyState,
    send: (text) => sent.push(text),
    close: () => {},
    addEventListener: (type, listener, options) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      const once = (event: { readonly data?: unknown }) => {
        listeners.get(type)!.delete(once);
        listener(event);
      };
      listeners.get(type)!.add(options?.once === true ? once : listener);
      wrapped.set(listener, once);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
      listeners.get(type)?.delete(wrapped.get(listener)!);
    },
  };
  const fire = (type: string, event: { readonly data?: unknown } = {}) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  const listening = (type: string) => listeners.get(type)?.size ?? 0;
  return { channel: fake, sent, fire, listening };
};

describe(dataChannelText, () => {
  it("keeps what arrives until the first listener, and ignores binary messages", () => {
    const fake = dataChannel("open");
    const text = dataChannelText(fake.channel);
    fake.fire("message", { data: "early" });
    fake.fire("message", { data: new ArrayBuffer(2) });
    const first: string[] = [];
    const second: string[] = [];
    text.listen((message) => first.push(message));
    text.listen((message) => second.push(message));
    fake.fire("message", { data: "later" });
    expect([first, second]).toStrictEqual([["early", "later"], ["later"]]);
  });

  it("loses a message sent while the channel isn't open", () => {
    const fake = dataChannel("connecting");
    const text = dataChannelText(fake.channel);
    text.send("lost");
    fake.channel.readyState = "open";
    text.send("sent");
    expect([fake.sent, text.isOpen()]).toStrictEqual([["sent"], true]);
  });

  it("calls onClose at once on a channel that has already closed, and only once", () => {
    const fake = dataChannel("closed");
    const text = dataChannelText(fake.channel);
    let calls = 0;
    text.onClose(() => {
      calls += 1;
    });
    const atOnce = calls;
    // A close event still queued when the handler was added.
    fake.fire("close");
    expect([atOnce, calls]).toStrictEqual([1, 1]);
  });

  it("calls onClose when the channel closes, until it stops listening", () => {
    const fake = dataChannel("open");
    const text = dataChannelText(fake.channel);
    const closes: string[] = [];
    text.onClose(() => closes.push("kept"));
    const stop = text.onClose(() => closes.push("stopped"));
    stop();
    fake.channel.readyState = "closed";
    fake.fire("close");
    fake.fire("close");
    expect([closes, fake.listening("close")]).toStrictEqual([["kept"], 0]);
  });
});
