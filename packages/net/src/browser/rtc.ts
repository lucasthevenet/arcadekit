import type { Signal } from "@gamekit/signalling/protocol";

import type { PeerId } from "../transport";
import { dataChannelText } from "./channel";
import type { PeerLink } from "./channel";

/** What `ConnectPeer` is told about one peer to connect to. */
export interface ConnectPeerOptions {
  readonly peer: PeerId;
  /** True on the side that makes the offer: the host, in the star. */
  readonly initiator: boolean;
  /** Sends a signal to the peer through the signalling worker. */
  readonly sendSignal: (signal: Signal) => void;
  /** Called once, when both of the link's channels are open. */
  readonly onOpen: (link: PeerLink) => void;
  /** Called once if the connection can't be made or fails before it opens. */
  readonly onFail: (reason: string) => void;
}

/** A connection being made to one peer. */
export interface PeerConnecting {
  /** A signal arrived from the peer. */
  readonly receive: (signal: Signal) => void;
  /** Gives up, or closes the link once open. */
  readonly close: () => void;
}

/**
 * Makes a connection to one peer from signals, and reports its link. The signalling client's
 * seam: `rtcConnectPeer` is the WebRTC one; tests pass a fake.
 */
export type ConnectPeer = (options: ConnectPeerOptions) => PeerConnecting;

/** Free public STUN, enough for most home networks. No TURN: two symmetric NATs can't connect (ADR-0012). */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export interface RtcOptions {
  /** STUN (and later TURN) servers. Defaults to `DEFAULT_ICE_SERVERS`; `[]` uses local addresses only. */
  readonly iceServers?: readonly RTCIceServer[];
  /** How long to wait for the channels to open before giving up. Defaults to 20 000 ms. */
  readonly timeoutMs?: number;
}

// Both channels are negotiated with fixed ids, so each side creates its own and neither waits
// for `datachannel` events.
const LOCKSTEP_CHANNEL_ID = 0;
const MESSAGES_CHANNEL_ID = 1;

/**
 * Connects to a peer over WebRTC, as a `ConnectPeer`. Each link has two data channels:
 *
 * - `lockstep`, unordered with no retransmits. The lockstep session sends, on every tick, every
 *   input and step the other side hasn't acknowledged, so a lost message is covered by the next
 *   one a few milliseconds later. A reliable, ordered channel would instead hold every later
 *   message back until the lost one is retransmitted (head-of-line blocking), stalling steps by
 *   a round trip or more for nothing.
 * - `messages`, reliable and ordered, for the app's few messages around a run (the lobby).
 */
export const rtcConnectPeer =
  (rtc: RtcOptions = {}): ConnectPeer =>
  ({ peer, initiator, sendSignal, onOpen, onFail }) => {
    const connection = new RTCPeerConnection({
      iceServers: [...(rtc.iceServers ?? DEFAULT_ICE_SERVERS)],
    });
    const lockstep = connection.createDataChannel("lockstep", {
      negotiated: true,
      id: LOCKSTEP_CHANNEL_ID,
      ordered: false,
      maxRetransmits: 0,
    });
    const messages = connection.createDataChannel("messages", {
      negotiated: true,
      id: MESSAGES_CHANNEL_ID,
    });
    // Listening from the start, so nothing that arrives before `onOpen` is lost.
    const lockstepText = dataChannelText(lockstep);
    const messagesText = dataChannelText(messages);
    let state: "connecting" | "open" | "closed" = "connecting";

    const close = () => {
      state = "closed";
      clearTimeout(timeout);
      lockstep.close();
      messages.close();
      connection.close();
    };

    const fail = (reason: string) => {
      if (state !== "connecting") {
        return;
      }
      close();
      onFail(reason);
    };

    const timeout = setTimeout(
      () =>
        fail(
          `Couldn't connect to ${peer} directly in time. Without a TURN server, some networks can't connect.`
        ),
      rtc.timeoutMs ?? 20_000
    );

    const checkOpen = () => {
      if (
        state === "connecting" &&
        lockstep.readyState === "open" &&
        messages.readyState === "open"
      ) {
        state = "open";
        clearTimeout(timeout);
        onOpen({
          peer,
          lockstep: lockstepText,
          messages: messagesText,
          close,
        });
      }
    };
    lockstep.addEventListener("open", checkOpen);
    messages.addEventListener("open", checkOpen);

    connection.addEventListener("icecandidate", (event) => {
      const { candidate } = event;
      sendSignal(
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
            }
      );
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed") {
        fail(
          `Couldn't connect to ${peer} directly. Without a TURN server, some networks can't connect.`
        );
      }
    });

    // Signals are handled one at a time, in order: a candidate must wait for the description
    // before it, which is set asynchronously.
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (work: () => Promise<void>) => {
      queue = queue.then(work).catch((error: unknown) => {
        fail(
          `WebRTC setup with ${peer} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    };

    if (initiator) {
      enqueue(async () => {
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        sendSignal({ kind: "offer", sdp: offer.sdp ?? "" });
      });
    }

    return {
      receive: (signal) => {
        if (state === "closed") {
          return;
        }
        enqueue(async () => {
          switch (signal.kind) {
            case "offer": {
              await connection.setRemoteDescription({
                type: "offer",
                sdp: signal.sdp,
              });
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
        });
      },
      close,
    };
  };
