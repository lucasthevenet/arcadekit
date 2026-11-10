// Lockstep over WebRTC in the browser (#25, ADR-0012): the signalling client that turns a join
// code into WebRTC links (host to every guest, guest to the host), and the `Transport` adapter
// that carries a lockstep session over those links. A room is a scoped Effect: its scope owns
// the socket and every link. The DOM-free lockstep session is in the root entry.

export {
  type DataChannelLike,
  type PeerLink,
  PeerLinkError,
  type TextChannel,
  linksTransport,
} from "./channel";
export { RoomError, type RoomFailure } from "./errors";
export {
  DEFAULT_ICE_SERVERS,
  type IceCandidateLike,
  type PeerConnectionLike,
  PeerConnector,
  type PeerConnectorApi,
  type PeerLinkOptions,
  type RtcOptions,
  rtcPeerConnector,
} from "./rtc";
export {
  type RoomEvent,
  type RoomOptions,
  type RoomServices,
  type SignallingRoom,
  browserRoomLayer,
  hostRoom,
  joinRoom,
} from "./signalling";
