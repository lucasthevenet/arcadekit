import { Context, Deferred, Duration, Effect, Queue } from "effect";
import type { Scope } from "effect";

import type { Signal } from "../signalling/protocol";
import type { PeerId } from "../transport";
import { PeerLinkError, dataChannelText } from "./channel";
import type { DataChannelLike, PeerLink, TextChannel } from "./channel";

/** What `PeerConnector.connect` is told about one peer to connect to. */
export interface PeerLinkOptions {
  readonly peer: PeerId;
  /** True on the side that makes the offer: the host, in the star. */
  readonly initiator: boolean;
  /** Signals from the peer, in the order the worker relayed them. The connection applies them one at a time. */
  readonly signals: Queue.Dequeue<Signal>;
  /** Sends a signal to the peer through the signalling worker. Plain: it is called for each ICE candidate. */
  readonly sendSignal: (signal: Signal) => void;
}

/** Makes peer links: `rtcPeerConnector` over WebRTC; tests pass a fake. */
export interface PeerConnectorApi {
  /**
   * Connects to one peer and succeeds with its link once both channels are open. The scope owns
   * the connection and both data channels from the moment each is made, and closing it closes
   * them all, however `connect` ended. Run each attempt in its own scope (`Effect.scoped`) to
   * release a failed one at once. Fails with PeerLinkError if setting up throws, ICE fails, or
   * the channels don't open in time.
   */
  readonly connect: (
    options: PeerLinkOptions
  ) => Effect.Effect<PeerLink, PeerLinkError, Scope.Scope>;
}

// Named so the type files can be made one file at a time (isolatedDeclarations).
const PeerConnectorKey: Context.ServiceClass<
  PeerConnector,
  "arcadekit/net/PeerConnector",
  PeerConnectorApi
> = Context.Service<PeerConnector, PeerConnectorApi>()(
  "arcadekit/net/PeerConnector"
);

/** How `hostRoom` and `joinRoom` make their peer links. `browserRoomLayer` provides the WebRTC one. */
export class PeerConnector extends PeerConnectorKey {}

/** An ICE candidate's fields, as an `icecandidate` event carries them. */
export interface IceCandidateLike {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
}

/** The parts of `RTCPeerConnection` that `rtcPeerConnector` uses: what a test fakes. */
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

/** Free public STUN, enough for most home networks. No TURN: two symmetric NATs can't connect (ADR-0012). */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export interface RtcOptions {
  /** STUN (and later TURN) servers. Defaults to `DEFAULT_ICE_SERVERS`; `[]` uses local addresses only. */
  readonly iceServers?: readonly RTCIceServer[];
  /** How long the channels may take to open before the link gives up. Defaults to 20 seconds. */
  readonly openTimeout?: Duration.Input;
  /** Makes the connection. Defaults to `new RTCPeerConnection(config)`; tests pass a fake. */
  readonly makeConnection?: (config: RTCConfiguration) => PeerConnectionLike;
}

// Both channels are negotiated with fixed ids, so each side creates its own and neither waits
// for `datachannel` events.
const LOCKSTEP_CHANNEL_ID = 0;
const MESSAGES_CHANNEL_ID = 1;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Connects to peers over WebRTC, as a `PeerConnector`. Each link has two data channels:
 *
 * - `lockstep`, unordered with no retransmits. The lockstep session sends, on every tick, every
 *   input and step the other side hasn't acknowledged, so a lost message is covered by the next
 *   one a few milliseconds later. A reliable, ordered channel would instead hold every later
 *   message back until the lost one is retransmitted (head-of-line blocking), stalling steps by
 *   a round trip or more for nothing.
 * - `messages`, reliable and ordered, for the app's few messages around a run (the lobby).
 *
 * A link's `closed` succeeds when either channel closes, the connection fails or its scope closes,
 * even long after it opened.
 */
export const rtcPeerConnector = (
  options: RtcOptions = {}
): PeerConnectorApi => {
  const iceServers = [...(options.iceServers ?? DEFAULT_ICE_SERVERS)];
  const openTimeout = options.openTimeout ?? Duration.seconds(20);
  const makeConnection =
    options.makeConnection ??
    ((config: RTCConfiguration): PeerConnectionLike =>
      new RTCPeerConnection(config));
  return {
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
        const apply = (signal: Signal) =>
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
        return {
          peer,
          lockstep: lockstep.text,
          messages: messages.text,
          closed: Deferred.await(ended),
        };
      }),
  };
};

/** A data channel the scope closes, read as text from the moment it exists, so nothing early is lost. */
const openChannel = (
  connection: PeerConnectionLike,
  label: string,
  init: RTCDataChannelInit,
  setupFailed: (cause: unknown) => PeerLinkError
): Effect.Effect<
  { readonly channel: DataChannelLike; readonly text: TextChannel },
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
const candidateSignal = (candidate: IceCandidateLike | null): Signal =>
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
  signal: Signal,
  sendSignal: (signal: Signal) => void
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
