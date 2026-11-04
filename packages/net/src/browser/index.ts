// Lockstep over WebRTC in the browser (#25, ADR-0012): the signalling client that turns a join
// code into WebRTC links (host to every guest, guest to the host), and the `Transport` adapter
// that carries a lockstep session over those links. The DOM-free lockstep session is in the
// root entry.

export {
  type PeerLink,
  type TextChannel,
  dataChannelText,
  linksTransport,
} from "./channel";
export {
  type ConnectPeer,
  type ConnectPeerOptions,
  DEFAULT_ICE_SERVERS,
  type PeerConnecting,
  type RtcOptions,
  rtcConnectPeer,
} from "./rtc";
export {
  type RoomEvent,
  type RoomFailure,
  type RoomStatus,
  type SignallingOptions,
  type SignallingRoom,
  type SignallingSocket,
  type SignallingSocketHandlers,
  hostRoom,
  joinRoom,
} from "./signalling";
