/**
 * Signalling rooms: one peer's side of a room on the signalling worker, and the WebRTC links it
 * makes through it.
 *
 * A host opens a room and gets its join code; each guest joins with the code; the worker relays
 * WebRTC signals between the host and each guest (never guest to guest, as in the star) until the
 * host starts the run (#25). A room is a scoped Effect: its scope owns the socket until
 * the start and every peer link after it, so closing the scope is leaving, and a room that fails
 * has already closed what it opened.
 *
 * Its rules are plain on purpose: a reducer of inputs to outputs, with a refusal as a
 * value (`internal/room-state.ts`). Here is its Effect shell: one fiber owns the socket to the
 * worker, one per peer makes its link, and the room's fiber carries out the rules, one input at a
 * time. Only the room's fiber removes a peer or closes the socket: `FiberMap.remove` waits for the
 * fiber it interrupts, so a fiber that removed itself would never finish.
 *
 * @since 0.7.0
 */
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  FiberMap,
  Inspectable,
  Layer,
  Pipeable,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { Scope, Types } from "effect";
import { Socket } from "effect/socket";

import { JoinCode, PeerId, ServerMessage } from "../signalling/index";
import type { ClientMessage, Signal } from "../signalling/index";
import type * as Transport from "../transport";
import { failureMessage } from "./internal/room-failure";
import type * as Failure from "./internal/room-failure";
import { makeRoomState } from "./internal/room-state";
import type * as RoomState from "./internal/room-state";
import { PeerConnector } from "./peer-connector";
import type * as PeerLink from "./peer-link";
import { layer as rtcLayer } from "./rtc-peer-connector";
import type * as RtcPeerConnector from "./rtc-peer-connector";

const TypeId = "~arcadekit/net/browser/SignallingRoom";

/**
 * Why a room failed: the worker's reasons (`ServerMessage.ErrorReason`, in
 * `arcadekit/net/signalling`), and the client's own:
 *
 * - `unreachable`: the socket didn't open: refused, a malformed URL, or the open timed out.
 * - `lost`: the socket closed after it opened, before the start.
 * - `bad-code`: the typed join code can't be one. No socket is opened.
 * - `peer-failed`: a guest couldn't open its link to the host, or that link closed before the
 *   start.
 * - `no-welcome`: the socket opened, but no welcome came in time.
 * - `bad-server-message`: the worker sent text this client can't read: it speaks another version
 *   of the protocol.
 *
 * **When to use**
 *
 * To say why a room failed in the app's own words, from a `RoomError`'s `reason`.
 *
 * **Example** (A failure in a player's words)
 *
 * ```ts
 * import type { SignallingRoom } from "arcadekit/net/browser";
 *
 * const say = (reason: SignallingRoom.RoomFailure) =>
 *   reason === "bad-code" ? "Check the code." : "Try again.";
 * say("bad-code"); // => "Check the code."
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type RoomFailure = Failure.RoomFailure;

/** The client's own reasons for a room's failure, beside the worker's. */
const ClientFailure: Schema.Literals<
  readonly [
    "unreachable",
    "lost",
    "bad-code",
    "peer-failed",
    "no-welcome",
    "bad-server-message",
  ]
> = Schema.Literals([
  "unreachable",
  "lost",
  "bad-code",
  "peer-failed",
  "no-welcome",
  "bad-server-message",
]);

/** The class `Schema.TaggedError` makes for `RoomError`, written out for isolatedDeclarations. */
type RoomErrorClass = Schema.Class<
  RoomError,
  Schema.TaggedStruct<
    "RoomError",
    {
      readonly reason: Schema.Union<
        readonly [typeof ServerMessage.ErrorReason, typeof ClientFailure]
      >;
      readonly message: Schema.String;
      readonly cause: Schema.optional<Schema.Defect>;
    }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
const RoomErrorBase: RoomErrorClass = Schema.TaggedError<RoomError>()(
  "RoomError",
  {
    reason: Schema.Union([ServerMessage.ErrorReason, ClientFailure]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
);

/**
 * A room that failed before the start. `message` says why, for a player; `reason` lets an app
 * say it in its own words; `cause` is the socket's error when there is one.
 *
 * **When to use**
 *
 * Catch it by its tag where a room is opened, or where its events are read: a room that fails
 * before the start fails its acquire or its `events`.
 *
 * **Example** (A code that can't be one)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const joining = SignallingRoom.join({ url: "wss://game.example.com" }, "hello");
 * const error = Effect.runSync(Effect.flip(joining).pipe(Effect.scoped, Effect.provide(SignallingRoom.layer())));
 * error._tag; // => "RoomError"
 * error.reason; // => "bad-code"
 * error.message; // => "A join code is 6 letters and digits."
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class RoomError extends RoomErrorBase {}

/**
 * What a room reports after its welcome, in order, by `type`. A host hears `peer-joined` when a
 * guest's socket joins, then `peer-connected` once its link is open, or `peer-left` if it leaves
 * or can't connect before the start. A guest hears `peer-connected` once, for the host. Both hear
 * `started` last. A failure is the room's `RoomError`, not an event.
 *
 * **When to use**
 *
 * To read a room's `events`: a lobby lists who is in it, and a host starts once a guest's link is
 * open.
 *
 * **Example** (Starting once a guest is linked)
 *
 * ```ts
 * import type { SignallingRoom } from "arcadekit/net/browser";
 *
 * const ready = (event: SignallingRoom.Event) => event.type === "peer-connected";
 * ready({ type: "peer-joined", peer: "guest-1" }); // => false
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Event = RoomState.Event;

/**
 * Where the signalling worker is, and how long a room may take to open.
 *
 * **When to use**
 *
 * To open a room with `host` or `join`.
 *
 * **Details**
 *
 * `url` is the worker's base URL, normally the page's own origin over WebSocket, such as
 * `wss://game.example.com` or `ws://localhost:1337`. `openTimeout` is how long the socket may take
 * to open, and `welcomeTimeout` how long the worker may take to welcome once it has: 10 seconds
 * each if left out, long enough for a cold worker under `alchemy dev`.
 *
 * **Example** (The page's own worker)
 *
 * ```ts
 * import type { SignallingRoom } from "arcadekit/net/browser";
 *
 * const options: SignallingRoom.Options = { url: "wss://game.example.com", welcomeTimeout: "5 seconds" };
 * options.url; // => "wss://game.example.com"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
  /** The worker's base URL, such as `wss://game.example.com` or `ws://localhost:1337`. */
  readonly url: string;
  /** How long the socket may take to open. 10 seconds if left out. */
  readonly openTimeout?: Duration.Input;
  /** How long the worker may take to welcome, once the socket is open. 10 seconds if left out. */
  readonly welcomeTimeout?: Duration.Input;
}

/**
 * What `host` and `join` need: a way to make peer links, and WebSockets.
 *
 * **When to use**
 *
 * To name what a room's Effect requires. `layer` provides the browser's; a test provides fakes of
 * both.
 *
 * **Example** (The browser's)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import type { Layer } from "effect";
 *
 * const browser: Layer.Layer<SignallingRoom.Services> = SignallingRoom.layer();
 * typeof browser; // => "object"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Services = PeerConnector | Socket.WebSocketConstructor;

/**
 * One peer's side of a signalling room, once the worker has welcomed it: its socket to the worker
 * and the WebRTC links it makes through it.
 *
 * **When to use**
 *
 * To run a lobby over the worker: `events` says who joins, links and leaves, `start` starts the
 * run (host only), and at the start `RtcTransport.fromLinks(room.self, room.links())` carries the
 * run's lockstep session. A Co-op client opens its rooms through `CoopRooms`.
 *
 * **Details**
 *
 * - `role` is `host` or `guest`, `code` the join code, `self` this peer's id (`host`,
 *   `guest-1`, …) and `host` the host's.
 * - `events` is what happens after the welcome, for one consumer. It ends after `started`, and
 *   fails with the room's `RoomError` if the room fails before the start. Events wait until they
 *   are taken, so none is lost before the consumer starts, and closing the room's scope first
 *   interrupts whoever still reads it.
 * - `links()` is the open links, in the order they opened. A host links to every guest; a guest
 *   only to the host.
 * - `start` asks the worker to start, so the room admits no one else; `started` confirms it, and
 *   guests still connecting are dropped (`peer-left`). A guest's does nothing.
 *
 * **Example** (A room a test makes)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import { Effect, Stream } from "effect";
 *
 * const room = SignallingRoom.make({
 *   role: "host",
 *   code: "K7MQ2X",
 *   self: "host",
 *   host: "host",
 *   events: Stream.make({ type: "started" }),
 *   links: () => [],
 *   start: Effect.void,
 * });
 * room.code; // => "K7MQ2X"
 * Effect.runSync(Stream.runCollect(room.events)); // => [{ type: "started" }]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SignallingRoom
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  readonly role: "host" | "guest";
  /** The join code. */
  readonly code: string;
  /** This peer's id in the room (`host`, `guest-1`, …). */
  readonly self: Transport.PeerId;
  /** The host's id. */
  readonly host: Transport.PeerId;
  /** What happens in the room after the welcome, for one consumer. Ends after `started`. */
  readonly events: Stream.Stream<Event, RoomError>;
  /** The open links, in the order they opened. Read it at the start for the run's transport. */
  readonly links: () => readonly PeerLink.PeerLink[];
  /** Host: asks the worker to start, so the room admits no one else. A guest's does nothing. */
  readonly start: Effect.Effect<void>;
}

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: SignallingRoom) {
    return {
      _id: "SignallingRoom",
      role: this.role,
      code: this.code,
      self: this.self,
      links: this.links().map((link) => link.peer),
    };
  },
};

/**
 * Checks whether a value is a signalling room.
 *
 * **When to use**
 *
 * Narrow an unknown value before reading its events.
 *
 * **Example** (Recognising a room)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import { Effect, Stream } from "effect";
 *
 * const room = SignallingRoom.make({
 *   role: "guest",
 *   code: "K7MQ2X",
 *   self: "guest-1",
 *   host: "host",
 *   events: Stream.empty,
 *   links: () => [],
 *   start: Effect.void,
 * });
 * SignallingRoom.isSignallingRoom(room); // => true
 * SignallingRoom.isSignallingRoom({ code: "K7MQ2X" }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isSignallingRoom = (value: unknown): value is SignallingRoom =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a room from its fields.
 *
 * **When to use**
 *
 * In a stand-in for the worker, such as `arcadekit/net/testing`'s `FakeCoopRooms`. A browser
 * opens a room with `host` or `join`.
 *
 * **Details**
 *
 * `make` runs nothing: the room's `events`, `links` and `start` are what it was given.
 *
 * **Example** (A guest's room, printed)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import { Effect, Stream } from "effect";
 *
 * const room = SignallingRoom.make({
 *   role: "guest",
 *   code: "K7MQ2X",
 *   self: "guest-1",
 *   host: "host",
 *   events: Stream.empty,
 *   links: () => [],
 *   start: Effect.void,
 * });
 * room.toJSON(); // => { _id: "SignallingRoom", role: "guest", code: "K7MQ2X", self: "guest-1", links: [] }
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (
  fields: Pick<
    SignallingRoom,
    "role" | "code" | "self" | "host" | "events" | "links" | "start"
  >
): SignallingRoom => {
  const self = Object.create(Proto) as Types.Mutable<SignallingRoom>;
  self.role = fields.role;
  self.code = fields.code;
  self.self = fields.self;
  self.host = fields.host;
  self.events = fields.events;
  self.links = fields.links;
  self.start = fields.start;
  return self;
};

/**
 * Opens a room as its host, and succeeds once the worker welcomes it, with its join code.
 *
 * **When to use**
 *
 * On the peer that hosts a run, to get a join code to read out.
 *
 * **Details**
 *
 * The scope owns the socket (until the start), every peer connection and every link, the run's
 * too: closing it is leaving. If it fails, everything it opened is already closed, and it fails
 * with a `RoomError`: `unreachable` when the socket doesn't open, `no-welcome` when the worker
 * doesn't answer in time, `bad-server-message` when it speaks another version of the protocol. A
 * trace shows it as `SignallingRoom.host`.
 *
 * **Example** (A host's room, in the browser)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const hosting = SignallingRoom.host({ url: "wss://game.example.com" }).pipe(
 *   Effect.tap((room) => Effect.log(`Join code: ${room.code}`))
 * );
 * Effect.isEffect(hosting); // => true
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const host: (
  options: Options
) => Effect.Effect<SignallingRoom, RoomError, Scope.Scope | Services> =
  Effect.fn("SignallingRoom.host")(function* (options: Options) {
    return yield* openRoom(options, "host", "/host");
  });

/**
 * Joins the room with join code `code`, as typed (any case), as `host` opens one.
 *
 * **When to use**
 *
 * On a guest's peer, with the code its player typed.
 *
 * **Details**
 *
 * A code that can't be one fails with `bad-code`, and no socket is opened. The worker turns a
 * guest away with `unknown-code`, `full` or `started`. A guest's room opens its one link, to the
 * host, and fails with `peer-failed` if that link can't be made or closes before the start. A
 * trace shows it as `SignallingRoom.join`.
 *
 * **Example** (A code typed wrong)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const joining = SignallingRoom.join({ url: "wss://game.example.com" }, "K7MQ2");
 * const failed = Effect.runSync(Effect.flip(joining).pipe(Effect.scoped, Effect.provide(SignallingRoom.layer())));
 * failed.reason; // => "bad-code"
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const join: (
  options: Options,
  code: string
) => Effect.Effect<SignallingRoom, RoomError, Scope.Scope | Services> =
  Effect.fn("SignallingRoom.join")(function* (options: Options, code: string) {
    const normalized = JoinCode.fromTyped(code);
    if (normalized === undefined) {
      const url = baseUrl(options.url);
      return yield* new RoomError({
        reason: "bad-code",
        message: failureMessage("bad-code", url),
      });
    }
    return yield* openRoom(options, "guest", `/join/${normalized}`);
  });

/**
 * Provides what `host` and `join` need in a browser: WebRTC links (`RtcPeerConnector`) and the
 * global WebSocket.
 *
 * **When to use**
 *
 * Once, around an app's rooms. A Co-op client's `CoopRooms.layer` provides it to its rooms itself.
 *
 * **Example** (Rooms on local addresses only)
 *
 * ```ts
 * import { SignallingRoom } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const program = SignallingRoom.host({ url: "ws://localhost:1337" }).pipe(
 *   Effect.scoped,
 *   Effect.provide(SignallingRoom.layer({ iceServers: [] }))
 * );
 * Effect.isEffect(program); // => true
 * ```
 *
 * @category layers
 * @since 0.7.0
 */
export const layer = (rtc?: RtcPeerConnector.Options): Layer.Layer<Services> =>
  Layer.merge(rtcLayer(rtc), Socket.layerWebSocketConstructorGlobal);

/** Long enough for a cold worker under `alchemy dev`, which takes seconds. */
const DEFAULT_TIMEOUT = Duration.seconds(10);

const baseUrl = (url: string) => url.replace(/\/+$/u, "");

const openRoom = (
  options: Options,
  role: "host" | "guest",
  path: string
): Effect.Effect<SignallingRoom, RoomError, Scope.Scope | Services> =>
  Effect.gen(function* () {
    const url = baseUrl(options.url);
    const connector = yield* PeerConnector;
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const state = makeRoomState(role, url);
    const inbox = yield* Queue.unbounded<RoomState.RoomInput>();
    // What goes to the worker, as JSON: signals and the start.
    const outbox = yield* Queue.unbounded<string>();
    const events = yield* Queue.unbounded<Event, RoomError | Cause.Done>();
    // Leaving interrupts whoever still reads the events, rather than leaving them waiting.
    yield* Effect.addFinalizer(() => Queue.interrupt(events));
    const welcomed = yield* Deferred.make<
      { readonly code: string; readonly self: Transport.PeerId },
      RoomError
    >();
    const socket = yield* FiberHandle.make<unknown, never>();
    const peers = yield* FiberMap.make<Transport.PeerId, unknown, never>();
    // Each peer being connected's signals, in the order the worker relayed them.
    const signals = new Map<Transport.PeerId, Queue.Queue<Signal.Signal>>();

    const tell = (input: RoomState.RoomInput) => Queue.offer(inbox, input);
    const send = (message: ClientMessage.ClientMessage) => {
      Queue.offerUnsafe(outbox, JSON.stringify(message));
    };

    // Owns the socket: opens it, writes the outbox, and tells the room what the worker says and
    // when the socket closes. The welcome timer starts once the socket is open.
    const dial = Effect.gen(function* () {
      const websocket = yield* Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.try({
            try: () => makeWebSocket(`${url}${path}`),
            // Such as a malformed URL.
            catch: (cause) =>
              new Socket.SocketError({
                reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
              }),
          }),
          (opened) => Effect.sync(() => opened.close(1000))
        ),
        { openTimeout: options.openTimeout ?? DEFAULT_TIMEOUT }
      );
      let opened = false;
      yield* Effect.gen(function* () {
        const reader = yield* websocket.reader;
        opened = true;
        yield* Effect.forkScoped(
          Effect.sleep(options.welcomeTimeout ?? DEFAULT_TIMEOUT).pipe(
            Effect.andThen(tell({ kind: "welcome-timeout" }))
          )
        );
        const writer = yield* websocket.writer;
        // A write that fails is a socket that closed, which the reader hears.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(Queue.take(outbox), (text) =>
              Effect.ignore(writer.write(text))
            )
          )
        );
        for (;;) {
          for (const frame of yield* reader.pull) {
            // A binary frame is no message of this protocol.
            Queue.offerUnsafe(inbox, {
              kind: "server",
              text: typeof frame === "string" ? frame : "",
            });
          }
        }
      }).pipe(
        Effect.scoped,
        Effect.catchTag("SocketError", (error) =>
          tell({ kind: "socket-closed", opened, cause: error })
        ),
        Effect.asVoid
      );
    });

    // Makes one peer's link, and tells the room when it opens, fails or closes. Its scope owns
    // the link, so the room closes it by interrupting this fiber.
    const linkPeer = (
      peer: Transport.PeerId,
      initiator: boolean,
      peerSignals: Queue.Queue<Signal.Signal>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const link = yield* connector.connect({
          peer,
          initiator,
          signals: peerSignals,
          sendSignal: (signal) => send({ type: "signal", to: peer, signal }),
        });
        yield* tell({ kind: "linked", peer, link });
        yield* link.closed;
        yield* tell({ kind: "link-closed", peer });
      }).pipe(
        Effect.scoped,
        Effect.catchTag("PeerLinkError", (error) =>
          tell({ kind: "link-failed", peer, message: error.message })
        ),
        Effect.asVoid
      );

    /** Carries out one output; false once the room has failed. */
    const perform = (output: RoomState.RoomOutput): Effect.Effect<boolean> => {
      switch (output.kind) {
        case "send": {
          return Effect.sync(() => {
            send(output.message);
            return true;
          });
        }
        case "connect": {
          return Effect.gen(function* () {
            const peerSignals = yield* Queue.unbounded<Signal.Signal>();
            signals.set(output.peer, peerSignals);
            yield* FiberMap.run(
              peers,
              output.peer,
              linkPeer(output.peer, output.initiator, peerSignals)
            );
            return true;
          });
        }
        case "signal": {
          return Effect.sync(() => {
            const peerSignals = signals.get(output.peer);
            if (peerSignals !== undefined) {
              Queue.offerUnsafe(peerSignals, output.signal);
            }
            return true;
          });
        }
        case "drop": {
          return FiberMap.remove(peers, output.peer).pipe(
            Effect.andThen(Effect.sync(() => signals.delete(output.peer))),
            Effect.as(true)
          );
        }
        case "welcomed": {
          return Deferred.succeed(welcomed, {
            code: output.code,
            self: output.self,
          }).pipe(Effect.as(true));
        }
        case "event": {
          return Queue.offer(events, output.event).pipe(Effect.as(true));
        }
        case "close-socket": {
          // After `started`: the events end, and the peers keep their links.
          return FiberHandle.clear(socket).pipe(
            Effect.andThen(Queue.end(events)),
            Effect.as(true)
          );
        }
        case "fail": {
          // Close everything first, so whoever hears of the failure finds nothing left open.
          const error =
            output.cause === undefined
              ? new RoomError({
                  reason: output.reason,
                  message: output.message,
                })
              : new RoomError({
                  reason: output.reason,
                  message: output.message,
                  cause: output.cause,
                });
          return Effect.gen(function* () {
            yield* FiberHandle.clear(socket);
            yield* FiberMap.clear(peers);
            signals.clear();
            yield* Deferred.fail(welcomed, error);
            yield* Queue.fail(events, error);
            return false;
          });
        }
      }
    };

    const room = Effect.gen(function* () {
      for (;;) {
        const input = yield* Queue.take(inbox);
        for (const output of state.handle(input)) {
          if (!(yield* perform(output))) {
            return;
          }
        }
      }
    }).pipe(
      // The socket's fiber and the peers' fail only of a bug, such as a PeerConnector's, which
      // ends the room as a bug in it does. Their joins ignore the interrupts that close them.
      Effect.raceFirst(FiberMap.join(peers)),
      Effect.raceFirst(FiberHandle.join(socket)),
      // A bug in the room is a defect for whoever waits on it, not a room that hangs.
      Effect.onError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Deferred.failCause(welcomed, cause).pipe(
              Effect.andThen(Queue.failCause(events, cause))
            )
      )
    );

    yield* Effect.forkScoped(room);
    yield* FiberHandle.run(socket, dial);
    const { code, self } = yield* Deferred.await(welcomed);
    return make({
      role,
      code,
      self,
      host: PeerId.host,
      events: Stream.fromQueue(events),
      links: state.links,
      start: Effect.asVoid(tell({ kind: "start" })),
    });
  });
