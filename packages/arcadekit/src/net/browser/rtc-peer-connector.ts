/**
 * WebRTC peer connectors: the browser's `PeerConnector`, which links two peers over an
 * `RTCPeerConnection` with two data channels.
 *
 * Each link has two channels, negotiated with fixed ids so each side makes its own and neither
 * waits for a `datachannel` event:
 *
 * - `lockstep`, unordered with no retransmits. A lockstep session sends, on every tick, every
 *   input and step the other side hasn't acknowledged, so a lost message is covered by the next
 *   one a few milliseconds later. A reliable, ordered channel would instead hold every later
 *   message back until the lost one is retransmitted (head-of-line blocking), stalling steps by a
 *   round trip or more for nothing.
 * - `messages`, reliable and ordered, for the app's few messages around a run (the lobby).
 *
 * Connecting is Effect: the scope owns the connection and each channel from the moment it is
 * made, a failure is a typed `PeerLinkError`, and the wait for both channels to open is an
 * `Effect.callback` that removes its listeners when interrupted. The connection's ICE and state
 * listeners are plain, as host callbacks: they send a signal, or settle a `Deferred`, while the
 * browser dispatches the event.
 *
 * @since 0.7.0
 */
import { Deferred, Duration, Effect, Layer, Queue } from "effect";
import type { Scope } from "effect";

import type { Signal } from "../signalling/index";
import { dataChannelText } from "./internal/data-channel-text";
import {
  PeerConnector,
  PeerLinkError,
  make as makeConnector,
} from "./peer-connector";
import type * as PeerLink from "./peer-link";
import { make as makePeerLink } from "./peer-link";

/**
 * The part of an `RTCDataChannel` a WebRTC link uses.
 *
 * **When to use**
 *
 * To stand in for a data channel in a test, through `Options`' `makeConnection`.
 *
 * **Example** (A channel that is open, and sends nowhere)
 *
 * ```ts
 * import type { RtcPeerConnector } from "arcadekit/net/browser";
 *
 * const channel: RtcPeerConnector.DataChannelLike = {
 *   readyState: "open",
 *   send: () => {},
 *   close: () => {},
 *   addEventListener: () => {},
 *   removeEventListener: () => {},
 * };
 * channel.readyState; // => "open"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly send: (text: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    type: "open" | "close" | "message",
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean }
  ) => void;
  readonly removeEventListener: (
    type: "open" | "close" | "message",
    listener: (event: { readonly data?: unknown }) => void
  ) => void;
}

/**
 * An ICE candidate's fields, as an `icecandidate` event carries them.
 *
 * **When to use**
 *
 * To fire a candidate from a test's stand-in connection.
 *
 * **Example** (A host candidate)
 *
 * ```ts
 * import type { RtcPeerConnector } from "arcadekit/net/browser";
 *
 * const candidate: RtcPeerConnector.IceCandidateLike = {
 *   candidate: "candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host",
 *   sdpMid: "0",
 *   sdpMLineIndex: 0,
 *   usernameFragment: null,
 * };
 * candidate.sdpMLineIndex; // => 0
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface IceCandidateLike {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
}

/**
 * The parts of `RTCPeerConnection` a WebRTC link uses: what a test stands in for.
 *
 * **When to use**
 *
 * To give `make` a connection of a test's own, through `Options`' `makeConnection`.
 *
 * **Example** (The state a stand-in starts in)
 *
 * ```ts
 * import type { RtcPeerConnector } from "arcadekit/net/browser";
 *
 * const state: RtcPeerConnector.PeerConnectionLike["connectionState"] = "new";
 * state; // => "new"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface PeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState;
  readonly createDataChannel: (
    label: string,
    init: RTCDataChannelInit
  ) => DataChannelLike;
  readonly createOffer: () => Promise<RTCSessionDescriptionInit>;
  readonly createAnswer: () => Promise<RTCSessionDescriptionInit>;
  readonly setLocalDescription: (
    description: RTCSessionDescriptionInit
  ) => Promise<void>;
  readonly setRemoteDescription: (
    description: RTCSessionDescriptionInit
  ) => Promise<void>;
  readonly addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
  readonly addEventListener: (
    type: "icecandidate" | "connectionstatechange",
    listener: (event: { readonly candidate?: IceCandidateLike | null }) => void
  ) => void;
  readonly removeEventListener: (
    type: "icecandidate" | "connectionstatechange",
    listener: (event: { readonly candidate?: IceCandidateLike | null }) => void
  ) => void;
  readonly close: () => void;
}

/**
 * Free public STUN, enough for most home networks. No TURN: two symmetric NATs can't connect
 * (ADR-0012).
 *
 * **When to use**
 *
 * As the `iceServers` of an app that runs no STUN server of its own.
 *
 * **Example** (The default servers)
 *
 * ```ts
 * import { RtcPeerConnector } from "arcadekit/net/browser";
 *
 * RtcPeerConnector.defaultIceServers[0]?.urls; // => "stun:stun.l.google.com:19302"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const defaultIceServers: readonly RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * How WebRTC links are made: the ICE servers, how long the channels may take to open, and what
 * makes a connection.
 *
 * **When to use**
 *
 * To give `make` or `layer` an app's STUN servers, or a test's stand-in connection.
 *
 * **Details**
 *
 * - `iceServers`: STUN (and later TURN) servers. `defaultIceServers` if left out; `[]` uses local
 *   addresses only.
 * - `openTimeout`: how long the channels may take to open before the link gives up: 20 seconds
 *   if left out.
 * - `makeConnection`: makes the connection. `new RTCPeerConnection(config)` if left out.
 *
 * **Example** (Links on local addresses only)
 *
 * ```ts
 * import type { RtcPeerConnector } from "arcadekit/net/browser";
 *
 * const local: RtcPeerConnector.Options = { iceServers: [], openTimeout: "5 seconds" };
 * local.iceServers?.length; // => 0
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
  /** STUN (and later TURN) servers. `defaultIceServers` if left out; `[]` uses local addresses only. */
  readonly iceServers?: readonly RTCIceServer[];
  /** How long the channels may take to open before the link gives up. 20 seconds if left out. */
  readonly openTimeout?: Duration.Input;
  /** Makes the connection. `new RTCPeerConnection(config)` if left out; a test passes a stand-in. */
  readonly makeConnection?: (config: RTCConfiguration) => PeerConnectionLike;
}

/**
 * Provides the WebRTC connector as the `PeerConnector` service.
 *
 * **When to use**
 *
 * Rarely by itself: a signalling room's `layer` provides it beside the browser's WebSocket.
 *
 * **Example** (The connector it provides)
 *
 * ```ts
 * import { PeerConnector, RtcPeerConnector } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   return PeerConnector.isPeerConnector(yield* PeerConnector.PeerConnector);
 * });
 * Effect.runSync(program.pipe(Effect.provide(RtcPeerConnector.layer()))); // => true
 * ```
 *
 * @category layers
 * @since 0.7.0
 */
export const layer = (options: Options = {}): Layer.Layer<PeerConnector> =>
  Layer.sync(PeerConnector, () => make(options));

// Both channels are negotiated with fixed ids, so each side creates its own and neither waits
// for `datachannel` events.
const LOCKSTEP_CHANNEL_ID = 0;
const MESSAGES_CHANNEL_ID = 1;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Makes the WebRTC connector: a link per peer, over an `RTCPeerConnection` with a `lockstep`
 * channel and a `messages` channel.
 *
 * **When to use**
 *
 * Where a signalling room needs links in a browser, through `layer`. A test passes a stand-in
 * connection as `makeConnection`.
 *
 * **Details**
 *
 * It makes no connection until `connect`. The initiator makes the offer, and each side applies
 * the other's signals one at a time, in order, since a candidate must wait for the description
 * before it. `connect` fails with a `PeerLinkError`: `setup` if making the connection, a channel
 * or a description throws, `failed` if ICE fails, `timeout` if the channels don't open in time. A
 * link's `closed` succeeds when either channel closes, the connection fails or its scope closes,
 * even long after it opened.
 *
 * **Example** (A connector that makes no connection yet)
 *
 * ```ts
 * import { PeerConnector, RtcPeerConnector } from "arcadekit/net/browser";
 *
 * let made = 0;
 * const connector = RtcPeerConnector.make({
 *   makeConnection: () => {
 *     made += 1;
 *     throw new Error("no WebRTC here");
 *   },
 * });
 * PeerConnector.isPeerConnector(connector); // => true
 * made; // => 0
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (options: Options = {}): PeerConnector => {
  const iceServers = [...(options.iceServers ?? defaultIceServers)];
  const openTimeout = options.openTimeout ?? Duration.seconds(20);
  const makeConnection =
    options.makeConnection ??
    ((config: RTCConfiguration): PeerConnectionLike =>
      new RTCPeerConnection(config));
  return makeConnector({
    connect: ({ peer, initiator, signals, sendSignal }) =>
      Effect.gen(function* () {
        const setupFailed = (cause: unknown) =>
          new PeerLinkError({
            peer,
            reason: "setup",
            message: `WebRTC setup with ${peer} failed: ${messageOf(cause)}`,
            cause,
          });
        // Each part has its own release, so one that can't be made closes those made before it.
        const connection = yield* Effect.acquireRelease(
          Effect.try({
            try: () => makeConnection({ iceServers }),
            catch: setupFailed,
          }),
          (made) => Effect.sync(() => made.close())
        );
        const lockstep = yield* openChannel(
          connection,
          "lockstep",
          {
            negotiated: true,
            id: LOCKSTEP_CHANNEL_ID,
            ordered: false,
            maxRetransmits: 0,
          },
          setupFailed
        );
        const messages = yield* openChannel(
          connection,
          "messages",
          { negotiated: true, id: MESSAGES_CHANNEL_ID },
          setupFailed
        );

        // What fails the link before it opens.
        const failed = yield* Deferred.make<never, PeerLinkError>();
        // The link has closed. Closing a connection fires no close event on its channels, so
        // `closed` waits on this rather than on them.
        const ended = yield* Deferred.make<undefined>();
        const end = () => Deferred.doneUnsafe(ended, Effect.undefined);
        // Closing the scope closes the link too.
        yield* Effect.addFinalizer(() => Effect.sync(end));

        yield* listen(connection, "icecandidate", (event) =>
          sendSignal(candidateSignal(event.candidate ?? null))
        );
        yield* listen(connection, "connectionstatechange", () => {
          if (connection.connectionState === "failed") {
            Deferred.doneUnsafe(
              failed,
              Effect.fail(
                new PeerLinkError({
                  peer,
                  reason: "failed",
                  message: `Couldn't connect to ${peer} directly. Without a TURN server, some networks can't connect.`,
                })
              )
            );
            end();
          }
        });
        for (const channel of [lockstep, messages]) {
          yield* Effect.acquireRelease(
            Effect.sync(() => channel.text.onClose(end)),
            (stop) => Effect.sync(stop)
          );
        }

        // Signals are applied one at a time, in order: a candidate must wait for the description
        // before it, which is set asynchronously.
        const apply = (signal: Signal.Signal) =>
          Effect.tryPromise({
            try: () => applySignal(connection, signal, sendSignal),
            catch: setupFailed,
          });
        const offer = Effect.tryPromise({
          try: async () => {
            const made = await connection.createOffer();
            await connection.setLocalDescription(made);
            sendSignal({ kind: "offer", sdp: made.sdp ?? "" });
          },
          catch: setupFailed,
        });
        yield* Effect.forkScoped(
          (initiator ? offer : Effect.void).pipe(
            Effect.andThen(
              Effect.forever(Effect.flatMap(Queue.take(signals), apply))
            ),
            // Once the link is open, nothing waits on this any more.
            Effect.catch((error) => Deferred.fail(failed, error))
          )
        );

        yield* bothOpen(lockstep.channel, messages.channel).pipe(
          Effect.raceFirst(Deferred.await(failed)),
          Effect.timeoutOrElse({
            duration: openTimeout,
            orElse: () =>
              Effect.fail(
                new PeerLinkError({
                  peer,
                  reason: "timeout",
                  message: `Couldn't connect to ${peer} directly in time. Without a TURN server, some networks can't connect.`,
                })
              ),
          })
        );
        return makePeerLink({
          peer,
          lockstep: lockstep.text,
          messages: messages.text,
          closed: Deferred.await(ended),
        });
      }),
  });
};

/** A data channel the scope closes, read as text from the moment it exists, so nothing early is lost. */
const openChannel = (
  connection: PeerConnectionLike,
  label: string,
  init: RTCDataChannelInit,
  setupFailed: (cause: unknown) => PeerLinkError
): Effect.Effect<
  { readonly channel: DataChannelLike; readonly text: PeerLink.TextChannel },
  PeerLinkError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => connection.createDataChannel(label, init),
      catch: setupFailed,
    }),
    (channel) => Effect.sync(() => channel.close())
  ).pipe(
    Effect.map((channel) => ({ channel, text: dataChannelText(channel) }))
  );

/** Listens on the connection until the scope closes. */
const listen = (
  connection: PeerConnectionLike,
  type: "icecandidate" | "connectionstatechange",
  listener: (event: { readonly candidate?: IceCandidateLike | null }) => void
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => connection.addEventListener(type, listener)),
    () => Effect.sync(() => connection.removeEventListener(type, listener))
  );

/** Succeeds once both channels are open: at once, if they already are. */
const bothOpen = (
  lockstep: DataChannelLike,
  messages: DataChannelLike
): Effect.Effect<void> =>
  Effect.callback((resume) => {
    const stop = () => {
      lockstep.removeEventListener("open", check);
      messages.removeEventListener("open", check);
    };
    const check = () => {
      if (lockstep.readyState === "open" && messages.readyState === "open") {
        stop();
        resume(Effect.void);
      }
    };
    lockstep.addEventListener("open", check);
    messages.addEventListener("open", check);
    check();
    return Effect.sync(stop);
  });

/** An `icecandidate` event's candidate as a signal; `null` is the end of candidates. */
const candidateSignal = (candidate: IceCandidateLike | null): Signal.Signal =>
  candidate === null
    ? {
        kind: "candidate",
        candidate: "",
        sdpMid: null,
        sdpMLineIndex: null,
        usernameFragment: null,
      }
    : {
        kind: "candidate",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      };

const applySignal = async (
  connection: PeerConnectionLike,
  signal: Signal.Signal,
  sendSignal: (signal: Signal.Signal) => void
): Promise<void> => {
  switch (signal.kind) {
    case "offer": {
      await connection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      sendSignal({ kind: "answer", sdp: answer.sdp ?? "" });
      return;
    }
    case "answer": {
      await connection.setRemoteDescription({
        type: "answer",
        sdp: signal.sdp,
      });
      return;
    }
    case "candidate": {
      // The end of candidates needs nothing: ICE finishes with what it has.
      if (signal.candidate !== "") {
        await connection.addIceCandidate({
          candidate: signal.candidate,
          sdpMid: signal.sdpMid,
          sdpMLineIndex: signal.sdpMLineIndex,
          usernameFragment: signal.usernameFragment,
        });
      }
    }
  }
};
