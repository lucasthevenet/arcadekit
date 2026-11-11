// Lockstep over WebRTC in the browser (#25, ADR-0012): the signalling client that turns a join
// code into WebRTC links (host to every guest, guest to the host), and the `Transport` adapter
// that carries a lockstep session over those links. A room is a scoped Effect: its scope owns
// the socket and every link. The DOM-free lockstep session is in the root entry.
//
// It also has the `Coop` declaration: a game's engine, played by several players in lockstep
// from a lobby. Its class is the key of the Co-op client an app drives, one player's side of a
// run, over the app's rooms (`CoopRooms`).

export {
  type DataChannelLike,
  type PeerLink,
  PeerLinkError,
  type TextChannel,
  linksTransport,
} from "./channel";
export {
  type AnyCoop,
  Coop,
  type CoopCases,
  type CoopClass,
  type CoopClient,
  type CoopDebug,
  type CoopDefinition,
  type CoopId,
  type CoopService,
  CoopTicker,
  type RunCases,
} from "./coop";
export {
  type CoopEvent,
  type CoopFailure,
  LobbyChanged,
  type LobbyPlayer,
  type RunEvent,
  RunStarted,
  type SeatContext,
  SeatFailed,
  WaitingChanged,
} from "./coop-events";
export { CoopRooms, type Rooms, browserCoopRoomsLayer } from "./coop-rooms";
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
