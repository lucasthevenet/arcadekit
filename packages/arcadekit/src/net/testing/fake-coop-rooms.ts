/**
 * Fake co-op rooms: a signalling worker and WebRTC in one, in memory, for tests of a Co-op game
 * and its app: no socket, no browser.
 *
 * A hub has one room, whose join code is `joinCode`, and its peers link the moment a guest joins.
 * Guests are `guest-1`, `guest-2`, … in join order. Its channels keep what arrives until something
 * listens, as the WebRTC ones do, and deliver a microtask later, as a network would. It is named
 * for its mechanism and the service it provides, `CoopRooms`. Its rooms are a test's data, plain on
 * purpose; each room's lifecycle is the scope of whoever opened it.
 *
 * @since 0.7.0
 */
import {
  Cause,
  Deferred,
  Effect,
  Inspectable,
  Layer,
  Pipeable,
  Predicate,
  Queue,
  Stream,
} from "effect";
import type { Scope, Types } from "effect";
import { dual } from "effect/Function";

import { CoopRooms, PeerLink, SignallingRoom } from "../browser/index";
import type * as Transport from "../transport";

type PeerId = Transport.PeerId;

const TypeId = "~arcadekit/net/testing/FakeCoopRooms";

/**
 * The join code of a fake hub's one room.
 *
 * **When to use**
 *
 * To join a hub's room in a test: a hub's `code` is the same.
 *
 * **Example** (The fake room's code)
 *
 * ```ts
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 *
 * FakeCoopRooms.joinCode; // => "K7MQ2X"
 * FakeCoopRooms.make().code === FakeCoopRooms.joinCode; // => true
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const joinCode = "K7MQ2X";

/**
 * A fake signalling hub with one room, whose peers link the moment a guest joins.
 *
 * **When to use**
 *
 * In a test of a co-op game, or of its app: give `layer(hub)` to each player's `MyCoop.layer`,
 * then one hosts and the others join `code`.
 *
 * **Details**
 *
 * - `rooms` is the hub's `CoopRooms`, for a test that wraps them: one client hosts, the others
 *   join `code`.
 * - `log` lists each room opened and released, in order: `open host`, `open guest-1`,
 *   `release guest-1`.
 *
 * Each room is owned by the scope of whoever opened it. A join with another code fails with
 * `unknown-code`, and one after the start with `started`.
 *
 * **Example** (A host's room, opened and closed)
 *
 * ```ts
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 * import { Effect } from "effect";
 *
 * const hub = FakeCoopRooms.make();
 * const room = Effect.runSync(Effect.scoped(hub.rooms.host));
 * room.role; // => "host"
 * hub.log; // => ["open host", "release host"]
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export interface FakeCoopRooms
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The hub's rooms: one client hosts, the others join `code`. */
  readonly rooms: CoopRooms.CoopRooms;
  /** The join code of the hub's one room. */
  readonly code: string;
  /** Each room opened and released, in order: `open host`, `open guest-1`, `release guest-1`. */
  readonly log: string[];
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<FakeCoopRooms> & {
  readonly drop: (peer: PeerId) => void;
  readonly closeHost: () => void;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: FakeCoopRooms) {
    return { _id: "FakeCoopRooms", code: this.code, log: this.log };
  },
};

/**
 * Checks whether a value is a fake hub.
 *
 * **When to use**
 *
 * Narrow an unknown value before opening its rooms.
 *
 * **Example** (Recognising a hub)
 *
 * ```ts
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 *
 * FakeCoopRooms.isFakeCoopRooms(FakeCoopRooms.make()); // => true
 * FakeCoopRooms.isFakeCoopRooms({ code: "K7MQ2X" }); // => false
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const isFakeCoopRooms = (value: unknown): value is FakeCoopRooms =>
  Predicate.hasProperty(value, TypeId);

/**
 * Provides `CoopRooms` with the hub's rooms.
 *
 * **When to use**
 *
 * Under each player's `MyCoop.layer` in a test, with one hub for all the players of a run.
 *
 * **Example** (The rooms a client gets)
 *
 * ```ts
 * import { CoopRooms } from "arcadekit/net/browser";
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 * import { Effect } from "effect";
 *
 * const hub = FakeCoopRooms.make();
 * const program = Effect.gen(function* () {
 *   return (yield* CoopRooms.CoopRooms) === hub.rooms;
 * });
 * Effect.runSync(program.pipe(Effect.provide(FakeCoopRooms.layer(hub)))); // => true
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const layer = (self: FakeCoopRooms): Layer.Layer<CoopRooms.CoopRooms> =>
  Layer.succeed(CoopRooms.CoopRooms, self.rooms);

/**
 * Cuts `peer`'s link to the host, as a connection that failed: nothing more crosses it, both ends
 * see it closed, and before the start the host's room reports `peer-left`.
 *
 * **When to use**
 *
 * In a test of what a lobby or a run does when one guest's connection fails.
 *
 * **Example** (A guest dropped before any joined)
 *
 * ```ts
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 *
 * const hub = FakeCoopRooms.make();
 * FakeCoopRooms.drop(hub, "guest-1");
 * hub.pipe(FakeCoopRooms.drop("guest-2"));
 * hub.log; // => []
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const drop: {
  (peer: PeerId): (self: FakeCoopRooms) => void;
  (self: FakeCoopRooms, peer: PeerId): void;
} = dual(2, (self: FakeCoopRooms, peer: PeerId): void => {
  (self as Internal).drop(peer);
});

/**
 * Cuts every guest's link to the host, as a host whose tab closed. Before the start, each guest's
 * room fails with `host-left`.
 *
 * **When to use**
 *
 * In a test of what a guest does when its host goes away.
 *
 * **Example** (A host gone before any guest joined)
 *
 * ```ts
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 *
 * const hub = FakeCoopRooms.make();
 * FakeCoopRooms.closeHost(hub);
 * hub.log; // => []
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const closeHost = (self: FakeCoopRooms): void => {
  (self as Internal).closeHost();
};

const nothing = (): void => undefined;

/** One end of a link's two pipes. */
interface End {
  readonly channel: PeerLink.TextChannel;
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
  readonly room: SignallingRoom.SignallingRoom;
  readonly link: (link: PeerLink.PeerLink) => void;
  readonly report: (event: SignallingRoom.Event, last?: boolean) => void;
  readonly fail: (error: SignallingRoom.RoomError) => void;
  started: boolean;
}

/** A guest's link to the host: its two pipes, and the cut that closes them. */
interface FakeLink {
  readonly guest: PeerId;
  readonly cut: () => void;
}

/**
 * Makes a hub with one room, which nobody has opened yet.
 *
 * **When to use**
 *
 * Once per test of a co-op run, for all its players: each player's client gets the hub's rooms
 * from `layer`.
 *
 * **Example** (A hub before anyone hosts)
 *
 * ```ts
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 *
 * const hub = FakeCoopRooms.make();
 * hub.code; // => "K7MQ2X"
 * hub.log; // => []
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const make = (): FakeCoopRooms => {
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
          SignallingRoom.Event,
          SignallingRoom.RoomError | Cause.Done
        >();
        const links: PeerLink.PeerLink[] = [];
        log.push(`open ${self}`);
        const made: FakeRoom = {
          room: SignallingRoom.make({
            role,
            code: joinCode,
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
          }),
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
  const connect = (hosting: FakeRoom, guest: FakeRoom) => {
    let open = true;
    const isOpen = () => open;
    const closed = Deferred.makeUnsafe<undefined>();
    const [hostLockstepEnd, guestLockstepEnd] = pipe(isOpen);
    const [hostMessages, guestMessages] = pipe(isOpen);
    hostLinks.push({
      guest: guest.room.self,
      cut: () => {
        if (!open) {
          return;
        }
        open = false;
        for (const side of [
          hostLockstepEnd,
          guestLockstepEnd,
          hostMessages,
          guestMessages,
        ]) {
          side.close();
        }
        Deferred.doneUnsafe(closed, Effect.succeed(undefined));
      },
    });
    hosting.link(
      PeerLink.make({
        peer: guest.room.self,
        lockstep: hostLockstepEnd.channel,
        messages: hostMessages.channel,
        closed: Deferred.await(closed),
      })
    );
    guest.link(
      PeerLink.make({
        peer: "host",
        lockstep: guestLockstepEnd.channel,
        messages: guestMessages.channel,
        closed: Deferred.await(closed),
      })
    );
  };

  const rooms = CoopRooms.make({
    host: fakeRoom("host", "host").pipe(
      Effect.map((made) => {
        host = made;
        return made.room;
      })
    ),
    join: (code) =>
      Effect.suspend(() => {
        if (code !== joinCode || host === null) {
          return Effect.fail(
            new SignallingRoom.RoomError({
              reason: "unknown-code",
              message:
                "No room has that code. Check it, or ask the host for a new one.",
            })
          );
        }
        if (host.started) {
          return Effect.fail(
            new SignallingRoom.RoomError({
              reason: "started",
              message: "That run has already started.",
            })
          );
        }
        const hosting = host;
        return fakeRoom("guest", `guest-${guests.length + 1}`).pipe(
          Effect.map((guest) => {
            guests.push(guest);
            connect(hosting, guest);
            return guest.room;
          })
        );
      }),
  });

  const self = Object.create(Proto) as Internal;
  return Object.assign(self, {
    rooms,
    code: joinCode,
    log,
    drop: (peer: PeerId) => {
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
            new SignallingRoom.RoomError({
              reason: "host-left",
              message: "The host left.",
            })
          );
        }
      }
    },
  });
};
