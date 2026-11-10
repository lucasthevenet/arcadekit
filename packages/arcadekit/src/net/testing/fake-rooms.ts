import { Cause, Deferred, Effect, Queue, Stream } from "effect";
import type { Scope } from "effect";

import type {
  CoopRooms,
  PeerLink,
  RoomEvent,
  SignallingRoom,
  TextChannel,
} from "../browser/index";
import { RoomError } from "../browser/index";
import type { PeerId } from "../transport";

// A signalling worker and WebRTC in one, in memory, for tests of a Co-op game and its app: no
// socket, no browser. Its channels keep what arrives until something listens, as the WebRTC
// ones do, and deliver a microtask later, as a network would.

/** The join code of a fake hub's one room. */
export const FAKE_JOIN_CODE = "K7MQ2X";

export interface FakeCoopRooms {
  /** Pass to `makeCoopClient(game, { rooms })`: one client hosts, the others join `code`. */
  readonly rooms: CoopRooms;
  readonly code: string;
  /** Each room opened and released, in order: `open host`, `open guest-1`, `release guest-1`. */
  readonly log: string[];
  /**
   * Cuts `peer`'s link to the host, as a connection that failed: nothing more crosses it, both
   * ends see it closed, and before the start the host's room reports `peer-left`.
   */
  readonly drop: (peer: PeerId) => void;
  /**
   * Cuts every guest's link to the host, as a host whose tab closed. Before the start, each
   * guest's room fails with `host-left`.
   */
  readonly closeHost: () => void;
}

const nothing = (): void => undefined;

/** One end of a link's two pipes. */
interface End {
  readonly channel: TextChannel;
  readonly deliver: (text: string) => void;
  readonly close: () => void;
}

/** One end of an in-memory pipe, sending to `other()`, a microtask later. */
const end = (other: () => End, isOpen: () => boolean): End => {
  const handlers = new Set<(text: string) => void>();
  const closers = new Set<() => void>();
  let early: string[] | null = [];
  return {
    channel: {
      send: (text) =>
        queueMicrotask(() => {
          if (isOpen()) {
            other().deliver(text);
          }
        }),
      listen: (handler) => {
        handlers.add(handler);
        for (const text of early ?? []) {
          handler(text);
        }
        early = null;
        return () => handlers.delete(handler);
      },
      onClose: (handler) => {
        if (!isOpen()) {
          handler();
          return nothing;
        }
        closers.add(handler);
        return () => closers.delete(handler);
      },
      isOpen,
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
    close: () => {
      for (const handler of closers) {
        handler();
      }
      closers.clear();
    },
  };
};

/** Both ends of one in-memory pipe, open while `isOpen`. */
const pipe = (isOpen: () => boolean): [End, End] => {
  const a: End = end(() => b, isOpen);
  const b: End = end(() => a, isOpen);
  return [a, b];
};

interface FakeRoom {
  readonly room: SignallingRoom;
  readonly link: (link: PeerLink) => void;
  readonly report: (event: RoomEvent, last?: boolean) => void;
  readonly fail: (error: RoomError) => void;
  started: boolean;
}

/** A guest's link to the host: its two pipes, and the cut that closes them. */
interface FakeLink {
  readonly guest: PeerId;
  readonly cut: () => void;
}

/**
 * A fake signalling hub with one room, whose peers link the moment a guest joins. Guests are
 * `guest-1`, `guest-2`, … in join order. Each room is owned by the scope of whoever opened it.
 */
export const fakeCoopRooms = (): FakeCoopRooms => {
  const log: string[] = [];
  let host: FakeRoom | null = null;
  const guests: FakeRoom[] = [];
  const hostLinks: FakeLink[] = [];

  const fakeRoom = (
    role: "host" | "guest",
    self: PeerId
  ): Effect.Effect<FakeRoom, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<
          RoomEvent,
          RoomError | Cause.Done
        >();
        const links: PeerLink[] = [];
        log.push(`open ${self}`);
        const made: FakeRoom = {
          room: {
            role,
            code: FAKE_JOIN_CODE,
            self,
            host: "host",
            events: Stream.fromQueue(events),
            links: () => links.filter((link) => link.lockstep.isOpen()),
            start: Effect.sync(() => {
              for (const peer of [host, ...guests]) {
                if (peer !== null && !peer.started) {
                  peer.started = true;
                  peer.report({ type: "started" }, true);
                }
              }
            }),
          },
          link: (link) => {
            links.push(link);
            made.report({ type: "peer-connected", peer: link.peer, link });
          },
          // A microtask later, as the room's own fiber would.
          report: (event, last = false) =>
            queueMicrotask(() => {
              Queue.offerUnsafe(events, event);
              if (last) {
                Queue.endUnsafe(events);
              }
            }),
          fail: (error) =>
            queueMicrotask(() => {
              Queue.failCauseUnsafe(events, Cause.fail(error));
            }),
          started: false,
        };
        return made;
      }),
      () => Effect.sync(() => log.push(`release ${self}`))
    );

  /** Links `guest` to the host: a lockstep pipe and a messages pipe, cut together. */
  const connect = (hostRoom: FakeRoom, guest: FakeRoom) => {
    let open = true;
    const isOpen = () => open;
    const closed = Deferred.makeUnsafe<undefined>();
    const [hostLockstep, guestLockstep] = pipe(isOpen);
    const [hostMessages, guestMessages] = pipe(isOpen);
    hostLinks.push({
      guest: guest.room.self,
      cut: () => {
        if (!open) {
          return;
        }
        open = false;
        for (const side of [
          hostLockstep,
          guestLockstep,
          hostMessages,
          guestMessages,
        ]) {
          side.close();
        }
        Deferred.doneUnsafe(closed, Effect.succeed(undefined));
      },
    });
    hostRoom.link({
      peer: guest.room.self,
      lockstep: hostLockstep.channel,
      messages: hostMessages.channel,
      closed: Deferred.await(closed),
    });
    guest.link({
      peer: "host",
      lockstep: guestLockstep.channel,
      messages: guestMessages.channel,
      closed: Deferred.await(closed),
    });
  };

  const rooms: CoopRooms = {
    host: fakeRoom("host", "host").pipe(
      Effect.map((made) => {
        host = made;
        return made.room;
      })
    ),
    join: (code) =>
      Effect.suspend(() => {
        if (code !== FAKE_JOIN_CODE || host === null) {
          return Effect.fail(
            new RoomError({
              reason: "unknown-code",
              message:
                "No room has that code. Check it, or ask the host for a new one.",
            })
          );
        }
        if (host.started) {
          return Effect.fail(
            new RoomError({
              reason: "started",
              message: "That run has already started.",
            })
          );
        }
        const hostRoom = host;
        return fakeRoom("guest", `guest-${guests.length + 1}`).pipe(
          Effect.map((guest) => {
            guests.push(guest);
            connect(hostRoom, guest);
            return guest.room;
          })
        );
      }),
  };

  return {
    rooms,
    code: FAKE_JOIN_CODE,
    log,
    drop: (peer) => {
      for (const link of hostLinks) {
        if (link.guest === peer) {
          link.cut();
        }
      }
      if (host !== null && !host.started) {
        host.report({ type: "peer-left", peer });
      }
    },
    closeHost: () => {
      for (const link of hostLinks) {
        link.cut();
      }
      for (const guest of guests) {
        if (!guest.started) {
          guest.fail(
            new RoomError({ reason: "host-left", message: "The host left." })
          );
        }
      }
    },
  };
};
