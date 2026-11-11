import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import type { RoomError } from "./errors";
import { browserRoomLayer, hostRoom, joinRoom } from "./signalling";
import type { SignallingRoom } from "./signalling";

/** How a Co-op client opens rooms: a host's own, and a guest's place in the one with a join code. */
export interface Rooms {
  readonly host: Effect.Effect<SignallingRoom, RoomError, Scope.Scope>;
  readonly join: (
    code: string
  ) => Effect.Effect<SignallingRoom, RoomError, Scope.Scope>;
}

// Named so the type files can be made one file at a time (isolatedDeclarations).
const CoopRoomsKey: Context.ServiceClass<
  CoopRooms,
  "arcadekit/net/CoopRooms",
  Rooms
> = Context.Service<CoopRooms, Rooms>()("arcadekit/net/CoopRooms");

/**
 * The app's co-op rooms, as a service: what a `Coop`'s layer opens a lobby through.
 * `browserCoopRoomsLayer` provides the browser's, over the signalling worker and WebRTC, and
 * `fakeCoopRooms().layer` (`arcadekit/net/testing`) a test's, in memory.
 */
export class CoopRooms extends CoopRoomsKey {}

/**
 * Provides the browser's rooms: the signalling worker at `url` (its base URL, `ws:` or `wss:`),
 * and WebRTC links through `iceServers`. The kit reads no environment: the app says both, in a
 * function the layer calls when it is built, so they can come from the page's location.
 *
 * ```ts
 * const rooms = browserCoopRoomsLayer(() => ({
 *   url: `wss://${location.host}`,
 *   iceServers: DEFAULT_ICE_SERVERS,
 * }));
 * MyCoop.layer.pipe(Layer.provide(rooms));
 * ```
 */
export const browserCoopRoomsLayer = (
  options: () => {
    readonly url: string;
    readonly iceServers: readonly RTCIceServer[];
  }
): Layer.Layer<CoopRooms> =>
  Layer.sync(CoopRooms, () => {
    const { url, iceServers } = options();
    const room = { url };
    const services = browserRoomLayer({ iceServers });
    return {
      host: hostRoom(room).pipe(Effect.provide(services)),
      join: (code) => joinRoom(room, code).pipe(Effect.provide(services)),
    };
  });
