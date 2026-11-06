import {
  Cause,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  FiberMap,
  Layer,
  Queue,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import { HOST_ID, normalizeJoinCode } from "../signalling/protocol";
import type { ClientMessage, Signal } from "../signalling/protocol";
import type { PeerId } from "../transport";
import type { PeerLink } from "./channel";
import { roomError } from "./errors";
import type { RoomError } from "./errors";
import { createRoomState } from "./room-state";
import type { RoomEvent, RoomInput, RoomOutput } from "./room-state";
import { PeerConnector, rtcPeerConnector } from "./rtc";
import type { RtcOptions } from "./rtc";

export type { RoomEvent } from "./room-state";

// The signalling client's Effect shell (#25, ADR-0012). Its rules are room-state.ts; here, one
// fiber owns the socket to the worker, one per peer makes its link, and the room fiber carries
// out the rules, one input at a time. Only the room fiber removes a peer or closes the socket:
// FiberMap.remove waits for the fiber it interrupts, so a fiber that removed itself would never
// finish.

export interface RoomOptions {
  /** The worker's base URL, normally the page's own origin, such as `wss://game.example.com` or `ws://localhost:1337`. */
  readonly url: string;
  /** How long the socket may take to open. Defaults to 10 seconds. */
  readonly openTimeout?: Duration.Input;
  /** How long the worker may take to welcome, once the socket is open. Defaults to 10 seconds. */
  readonly welcomeTimeout?: Duration.Input;
}

/**
 * One peer's side of a signalling room, once the worker has welcomed it: its socket to the
 * worker and the WebRTC links it makes through it. A host links to every guest; a guest only to
 * the host. Once the host starts, the links are the run's: `linksTransport(room.self,
 * room.links())` carries a lockstep session's messages.
 */
export interface SignallingRoom {
  readonly role: "host" | "guest";
  /** The join code. */
  readonly code: string;
  /** This peer's id in the room (`host`, `guest-1`, …). */
  readonly self: PeerId;
  /** The host's id. */
  readonly host: PeerId;
  /**
   * What happens in the room after the welcome, for one consumer. Ends after `started`, and
   * fails with the room's RoomError if it fails before the start. Closing the room's scope first
   * interrupts whoever still reads it. Events wait in the room until taken, so none is lost
   * before the consumer starts.
   */
  readonly events: Stream.Stream<RoomEvent, RoomError>;
  /** The open links, in the order they opened. Read it at the start for `linksTransport`. */
  readonly links: () => readonly PeerLink[];
  /**
   * Host: asks the worker to start, so the room admits no one else; `started` confirms it, and
   * guests still connecting are dropped (`peer-left`). A guest's does nothing.
   */
  readonly start: Effect.Effect<void>;
}

/** What `hostRoom` and `joinRoom` need: a way to make peer links, and WebSockets. */
export type RoomServices = PeerConnector | Socket.WebSocketConstructor;

/**
 * Opens a room as its host. Succeeds once the worker welcomes it, with its join code. The scope
 * owns the socket (until the start), every peer connection and every link, the run's too:
 * closing it is leaving. If it fails, everything it opened is already closed.
 */
export const hostRoom = (
  options: RoomOptions
): Effect.Effect<SignallingRoom, RoomError, Scope.Scope | RoomServices> =>
  openRoom(options, "host", "/host");

/**
 * Joins the room with join code `code`, as typed (any case), as `hostRoom` opens one. A code
 * that can't be one fails with `bad-code`, and no socket is opened.
 */
export const joinRoom = (
  options: RoomOptions,
  code: string
): Effect.Effect<SignallingRoom, RoomError, Scope.Scope | RoomServices> =>
  Effect.suspend(() => {
    const normalized = normalizeJoinCode(code);
    return normalized === undefined
      ? Effect.fail(roomError("bad-code", baseUrl(options.url)))
      : openRoom(options, "guest", `/join/${normalized}`);
  });

/** What `hostRoom` and `joinRoom` need in a browser: WebRTC links, and the global WebSocket. */
export const browserRoomLayer = (rtc?: RtcOptions): Layer.Layer<RoomServices> =>
  Layer.merge(
    Layer.succeed(PeerConnector, rtcPeerConnector(rtc)),
    Socket.layerWebSocketConstructorGlobal
  );

/** Long enough for a cold worker under `alchemy dev`, which takes seconds. */
const DEFAULT_TIMEOUT = Duration.seconds(10);

const baseUrl = (url: string) => url.replace(/\/+$/u, "");

const openRoom = (
  options: RoomOptions,
  role: "host" | "guest",
  path: string
): Effect.Effect<SignallingRoom, RoomError, Scope.Scope | RoomServices> =>
  Effect.gen(function* () {
    const url = baseUrl(options.url);
    const connector = yield* PeerConnector;
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const state = createRoomState(role, url);
    const inbox = yield* Queue.unbounded<RoomInput>();
    // What goes to the worker, as JSON: signals and the start.
    const outbox = yield* Queue.unbounded<string>();
    const events = yield* Queue.unbounded<RoomEvent, RoomError | Cause.Done>();
    // Leaving interrupts whoever still reads the events, rather than leaving them waiting.
    yield* Effect.addFinalizer(() => Queue.interrupt(events));
    const welcomed = yield* Deferred.make<
      { readonly code: string; readonly self: PeerId },
      RoomError
    >();
    const socket = yield* FiberHandle.make();
    const peers = yield* FiberMap.make<PeerId>();
    // Each peer being connected's signals, in the order the worker relayed them.
    const signals = new Map<PeerId, Queue.Queue<Signal>>();

    const tell = (input: RoomInput) => Queue.offer(inbox, input);
    const send = (message: ClientMessage) => {
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
      peer: PeerId,
      initiator: boolean,
      peerSignals: Queue.Queue<Signal>
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
    const perform = (output: RoomOutput): Effect.Effect<boolean> => {
      switch (output.kind) {
        case "send": {
          return Effect.sync(() => {
            send(output.message);
            return true;
          });
        }
        case "connect": {
          return Effect.gen(function* () {
            const peerSignals = yield* Queue.unbounded<Signal>();
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
          return Effect.gen(function* () {
            yield* FiberHandle.clear(socket);
            yield* FiberMap.clear(peers);
            signals.clear();
            yield* Deferred.fail(welcomed, output.error);
            yield* Queue.fail(events, output.error);
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
    return {
      role,
      code,
      self,
      host: HOST_ID,
      events: Stream.fromQueue(events),
      links: state.links,
      start: Effect.asVoid(tell({ kind: "start" })),
    };
  });
