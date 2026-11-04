import { readFileSync } from "node:fs";

import { ContentError, loadContent } from "@gamekit/content";
import type { ContentSource } from "@gamekit/content";
import type {
  PeerLink,
  RoomEvent,
  SignallingRoom,
  TextChannel,
} from "@gamekit/net/browser";
import { survivorsContentDefinition } from "@gamekit/survivors";
import type { GameContent } from "@gamekit/survivors";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoopClient } from "./client";
import type { CoopEvent } from "./client";
import { encodeLobbyMessage, parseLobbyMessage, playerName } from "./lobby";

// The co-op client in Node, with no browser: a fake signalling hub links the host to each guest
// with in-memory channels that keep what arrives until something listens, as the WebRTC ones
// do, and fake timers drive the clients' tickers. Nothing is attached, so nothing is drawn and
// the local input stands still.

const contentDir = new URL("../../public/content/", import.meta.url);
const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content: GameContent = await Effect.runPromise(
  loadContent({ ...survivorsContentDefinition, source: fileSource })
);

interface End {
  readonly channel: TextChannel;
  readonly deliver: (text: string) => void;
}

/** One end of an in-memory pipe, sending to `other()`, a microtask later as a network would. */
const end = (other: () => End): End => {
  const handlers = new Set<(text: string) => void>();
  let early: string[] | null = [];
  return {
    channel: {
      send: (text) => queueMicrotask(() => other().deliver(text)),
      listen: (handler) => {
        handlers.add(handler);
        for (const text of early ?? []) {
          handler(text);
        }
        early = null;
        return () => handlers.delete(handler);
      },
      onClose: () => () => {},
      isOpen: () => true,
    },
    deliver: (text) => {
      if (early === null) {
        for (const handler of handlers) {
          handler(text);
        }
      } else {
        early.push(text);
      }
    },
  };
};

/** Both ends of one in-memory pipe. */
const pipe = (): [TextChannel, TextChannel] => {
  const a: End = end(() => b);
  const b: End = end(() => a);
  return [a.channel, b.channel];
};

/** A signalling worker and WebRTC in one: rooms whose peers link the moment a guest joins. */
const fakeHub = () => {
  const CODE = "K7MQ2X";
  let host: ReturnType<typeof fakeRoom> | null = null;
  const guests: ReturnType<typeof fakeRoom>[] = [];

  const fakeRoom = (role: "host" | "guest", self: string) => {
    const listeners = new Set<(event: RoomEvent) => void>();
    const links: PeerLink[] = [];
    let status: SignallingRoom["status"] = "open";
    const emit = (event: RoomEvent) => {
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener(event);
        }
      });
    };
    const room: SignallingRoom = {
      role,
      get status() {
        return status;
      },
      code: CODE,
      self,
      host: "host",
      links: () => [...links],
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: () => {
        for (const peer of [host!, ...guests]) {
          peer.started();
        }
      },
      close: () => {
        status = "closed";
      },
    };
    return {
      room,
      emit,
      link: (link: PeerLink) => {
        links.push(link);
        emit({ type: "peer-connected", peer: link.peer, link });
      },
      started: () => {
        status = "started";
        emit({ type: "started" });
      },
    };
  };

  return {
    host: () => {
      host = fakeRoom("host", "host");
      host.emit({ type: "welcome", code: CODE, self: "host" });
      return host.room;
    },
    join: (code: string) => {
      expect(code).toBe(CODE);
      const self = `guest-${guests.length + 1}`;
      const guest = fakeRoom("guest", self);
      guests.push(guest);
      guest.emit({ type: "welcome", code: CODE, self });
      const [hostLockstep, guestLockstep] = pipe();
      const [hostMessages, guestMessages] = pipe();
      host!.link({
        peer: self,
        lockstep: hostLockstep,
        messages: hostMessages,
        close: closeNothing,
      });
      guest.link({
        peer: "host",
        lockstep: guestLockstep,
        messages: guestMessages,
        close: closeNothing,
      });
      return guest.room;
    },
  };
};

// oxlint-disable-next-line eslint/no-empty-function -- the fake links have nothing to close.
const closeNothing = () => {};

const started = (events: readonly CoopEvent[]) =>
  events.find((event) => event.type === "started");

const client = (hub: ReturnType<typeof fakeHub>) => {
  const events: CoopEvent[] = [];
  const coop = new CoopClient({
    signalling: { url: "ws://unused" },
    rooms: hub,
  });
  coop.subscribe((event) => events.push(event));
  return { coop, events };
};

const ended = (events: readonly CoopEvent[]) =>
  events.some((event) => event.type === "runEnded");

const lastLobby = (events: readonly CoopEvent[]) =>
  events.findLast((event) => event.type === "lobby");

/** Lets queued microtasks run, at the current fake time. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("a co-op run", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gathers a lobby, starts everyone with their heroes and steps the same run", async () => {
    const hub = fakeHub();
    const host = client(hub);
    const guest = client(hub);
    host.coop.host(content, "spark");
    await settle();
    guest.coop.join(content, "K7MQ2X", "ember");
    await settle();
    guest.coop.chooseHero("tide");
    await settle();
    const lobby = {
      type: "lobby",
      code: "K7MQ2X",
      players: [
        { id: "host", heroId: "spark" },
        { id: "guest-1", heroId: "tide" },
      ],
    };
    expect([
      host.coop.canStart(),
      lastLobby(host.events),
      lastLobby(guest.events),
    ]).toMatchObject([
      true,
      { ...lobby, role: "host", self: "host" },
      { ...lobby, role: "guest", self: "guest-1" },
    ]);

    host.coop.start();
    await vi.advanceTimersByTimeAsync(5000);
    const [hostRun, guestRun] = [host.coop.debug(), guest.coop.debug()];
    expect([started(host.events), started(guest.events)]).toStrictEqual([
      { type: "started", slot: 0, players: ["Host", "Guest 1"] },
      { type: "started", slot: 1, players: ["Host", "Guest 1"] },
    ]);
    // Both stepped most of the 5 s, and agree on the state at every step both hashed.
    const common = Object.keys(hostRun.hashes).filter(
      (step) => step in guestRun.hashes
    );
    expect([
      hostRun.error,
      guestRun.error,
      hostRun.stepIndex > 200,
      common.length > 2,
      common.map((step) => hostRun.hashes[Number(step)]),
    ]).toStrictEqual([
      null,
      null,
      true,
      true,
      common.map((step) => guestRun.hashes[Number(step)]),
    ]);
  });

  it("shows who it waits on, then stops with a clear error when the host goes quiet", async () => {
    const hub = fakeHub();
    const host = client(hub);
    const guest = client(hub);
    host.coop.host(content, "spark");
    await settle();
    guest.coop.join(content, "K7MQ2X", "ember");
    await settle();
    host.coop.start();
    await vi.advanceTimersByTimeAsync(1000);
    host.coop.leave();
    await vi.advanceTimersByTimeAsync(12_000);
    const waited = guest.events.some(
      (event) => event.type === "waiting" && event.waitingFor.includes("Host")
    );
    expect([waited, guest.events.at(-1)]).toStrictEqual([
      true,
      {
        type: "failed",
        message: "Lost the host: nothing heard for 10 s. The run is over.",
      },
    ]);
  });

  it("keeps the summary when the others leave a run that has ended", async () => {
    const short: GameContent = {
      ...content,
      rules: { ...content.rules, runLength: 1 },
    };
    const hub = fakeHub();
    const host = client(hub);
    const guest = client(hub);
    host.coop.host(short, "spark");
    await settle();
    guest.coop.join(short, "K7MQ2X", "ember");
    await settle();
    host.coop.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect([ended(host.events), ended(guest.events)]).toStrictEqual([
      true,
      true,
    ]);
    host.coop.leave();
    await vi.advanceTimersByTimeAsync(12_000);
    // The guest's session lost the host, but the run had ended: no failure, no waiting banner.
    const afterEnd = guest.events.slice(
      guest.events.findIndex((event) => event.type === "runEnded")
    );
    expect([
      guest.coop.debug().error,
      afterEnd
        .filter((event) => event.type !== "hud")
        .map((event) => event.type),
    ]).toStrictEqual([
      "Lost the host host: nothing heard for 10000 ms",
      ["runEnded"],
    ]);
  });
});

describe("the lobby's messages", () => {
  it("read back what was sent and refuse anything else", () => {
    const messages = [
      { type: "hero", heroId: "ember" },
      { type: "lobby", players: [{ id: "host", heroId: "spark" }] },
      { type: "start", players: ["host", "guest-1"], heroIds: ["a", "b"] },
    ] as const;
    expect([
      messages.map((message) => parseLobbyMessage(encodeLobbyMessage(message))),
      [
        "{",
        "[]",
        '{"type":"hero"}',
        '{"type":"start","players":["host"],"heroIds":[]}',
        '{"type":"lobby","players":[{"id":1}]}',
      ].map(parseLobbyMessage),
      ["host", "guest-3", "someone"].map(playerName),
    ]).toStrictEqual([
      messages,
      [undefined, undefined, undefined, undefined, undefined],
      ["Host", "Guest 3", "someone"],
    ]);
  });
});
