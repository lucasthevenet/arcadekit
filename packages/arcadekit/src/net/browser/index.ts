// arcadekit/net/browser: lockstep over WebRTC in the browser (#25, ADR-0012), and co-op. A
// `SignallingRoom` turns a join code into WebRTC links (host to every guest, guest to the host)
// through the signalling worker, made by a `PeerConnector` (`RtcPeerConnector`, WebRTC's), and
// `RtcTransport` carries a lockstep session over those links. A room is a scoped Effect: its scope
// owns the socket and every link. The DOM-free lockstep session is in the root entry.
//
// It also has the `Coop` declaration: a game's engine, played by several players in lockstep from
// a lobby. Its class is the key of the `CoopClient` an app drives, one player's side of a run,
// over the app's `CoopRooms`, ticked by `CoopTicker`, and heard as `CoopEvent`s. `Coop` is a
// builder a game writes bare, with its types; every other module is a namespace. Plain where a
// tick or a frame runs (ADR-0024); the lobby, the links and the run's lifecycle are Effect.

export {
  type AnyCoop,
  Coop,
  type CoopCases,
  type CoopClass,
  type CoopDefinition,
  type CoopId,
  type CoopService,
  type RunCases,
} from "./coop";
export * as CoopClient from "./coop-client";
export * as CoopEvent from "./coop-event";
export * as CoopRooms from "./coop-rooms";
export * as CoopTicker from "./coop-ticker";
export * as PeerConnector from "./peer-connector";
export * as PeerLink from "./peer-link";
export * as RtcPeerConnector from "./rtc-peer-connector";
export * as RtcTransport from "./rtc-transport";
export * as SignallingRoom from "./signalling-room";
