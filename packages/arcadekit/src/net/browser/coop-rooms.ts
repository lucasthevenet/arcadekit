/**
 * Co-op rooms: how a Co-op client opens its rooms, a host's own and a guest's place in one with a
 * join code.
 *
 * It is a service, the app's: a `Coop`'s `layer` needs it. `layer` provides the browser's, over
 * the signalling worker and WebRTC; `arcadekit/net/testing`'s `FakeCoopRooms` provides a test's,
 * in memory. The kit reads no environment, so the app says where its worker is and which STUN
 * servers it uses. Opening a room is Effect, owned by the seat's scope, and traced under
 * `CoopRooms.host` and `CoopRooms.join`.
 *
 * @since 0.7.0
 */
import {
  Context,
  Effect,
  Inspectable,
  Layer,
  Pipeable,
  Predicate,
} from "effect";
import type { Scope, Types } from "effect";

import {
  host as openHostRoom,
  join as openGuestRoom,
  layer as roomLayer,
} from "./signalling-room";
import type * as SignallingRoom from "./signalling-room";

const TypeId = "~arcadekit/net/browser/CoopRooms";

/**
 * How a Co-op client opens rooms: `host` opens a host's own, and `join(code)` a guest's place in
 * the room with that join code.
 *
 * **When to use**
 *
 * Name it to type a client's rooms, and provide its key, `CoopRooms.CoopRooms`, to a `Coop`'s
 * `layer`: with `layer` in a browser, and with `arcadekit/net/testing`'s `FakeCoopRooms` in a
 * test.
 *
 * **Details**
 *
 * Each succeeds with the room once the worker welcomes this peer, and its scope owns the room and
 * its links: the Co-op client opens each in its seat's scope, so leaving closes it. Each fails
 * with the room's `RoomError`.
 *
 * **Example** (Rooms that turn every peer away)
 *
 * ```ts
 * import { CoopRooms, SignallingRoom } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const full = new SignallingRoom.RoomError({ reason: "full", message: "That room is full." });
 * const rooms = CoopRooms.make({ host: Effect.fail(full), join: () => Effect.fail(full) });
 * const error = Effect.runSync(Effect.flip(rooms.join("K7MQ2X")).pipe(Effect.scoped));
 * error.reason; // => "full"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface CoopRooms extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** Opens a host's own room. */
  readonly host: Effect.Effect<
    SignallingRoom.SignallingRoom,
    SignallingRoom.RoomError,
    Scope.Scope
  >;
  /** Opens a guest's place in the room with join code `code`. */
  readonly join: (
    code: string
  ) => Effect.Effect<
    SignallingRoom.SignallingRoom,
    SignallingRoom.RoomError,
    Scope.Scope
  >;
}

/**
 * The key of the app's co-op rooms, as a service: what a `Coop`'s `layer` opens a lobby through.
 *
 * **When to use**
 *
 * Provide it to a `Coop`'s `layer`, once per app: `layer` in a browser, and
 * `FakeCoopRooms.layer(hub)` in a test.
 *
 * **Details**
 *
 * It is keyed `arcadekit/net/browser/CoopRooms`, and its type is the rooms':
 * `Layer.Layer<CoopRooms.CoopRooms>`.
 *
 * **Example** (Reading the app's rooms)
 *
 * ```ts
 * import { CoopRooms } from "arcadekit/net/browser";
 * import { Effect, Layer } from "effect";
 *
 * const none = CoopRooms.make({ host: Effect.never, join: () => Effect.never });
 * const program = Effect.gen(function* () {
 *   return yield* CoopRooms.CoopRooms;
 * });
 * Effect.runSync(program.pipe(Effect.provide(Layer.succeed(CoopRooms.CoopRooms, none)))) === none; // => true
 * ```
 *
 * @category services
 * @since 0.7.0
 */
export const CoopRooms: Context.Service<CoopRooms, CoopRooms> =
  Context.Service<CoopRooms>("arcadekit/net/browser/CoopRooms");

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON() {
    return { _id: "CoopRooms" };
  },
};

/**
 * Checks whether a value is a Co-op client's rooms.
 *
 * **When to use**
 *
 * Narrow an unknown value before opening a room through it.
 *
 * **Example** (Recognising rooms)
 *
 * ```ts
 * import { CoopRooms } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * CoopRooms.isCoopRooms(CoopRooms.make({ host: Effect.never, join: () => Effect.never })); // => true
 * CoopRooms.isCoopRooms({ host: Effect.never }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isCoopRooms = (value: unknown): value is CoopRooms =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes rooms from the two Effects that open them.
 *
 * **When to use**
 *
 * To open rooms some other way than the signalling worker: a test's, as `FakeCoopRooms` does, or
 * an app's own wrapper around the browser's.
 *
 * **Details**
 *
 * A trace shows each room opened as `CoopRooms.host` or `CoopRooms.join`.
 *
 * **Example** (Rooms that never open)
 *
 * ```ts
 * import { CoopRooms } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const rooms = CoopRooms.make({ host: Effect.never, join: () => Effect.never });
 * rooms.toJSON(); // => { _id: "CoopRooms" }
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (calls: Pick<CoopRooms, "host" | "join">): CoopRooms => {
  const self = Object.create(Proto) as Types.Mutable<CoopRooms>;
  self.host = calls.host.pipe(Effect.withSpan("CoopRooms.host"));
  self.join = Effect.fn("CoopRooms.join")(function* (code: string) {
    return yield* calls.join(code);
  });
  return self;
};

/**
 * Provides the browser's rooms: the signalling worker at `url` (its base URL, `ws:` or `wss:`),
 * and WebRTC links through `iceServers`.
 *
 * **When to use**
 *
 * Once, in an app that plays co-op, under its `Coop`'s `layer`.
 *
 * **Details**
 *
 * The kit reads no environment: the app says both, in a function the layer calls when it is
 * built, so they can come from the page's location. Each room opened gets the browser's
 * WebSocket and WebRTC, as a signalling room's `layer` gives them.
 *
 * **Example** (The page's own worker)
 *
 * ```ts
 * import { CoopRooms, RtcPeerConnector } from "arcadekit/net/browser";
 * import { Effect } from "effect";
 *
 * const rooms = CoopRooms.layer(() => ({
 *   url: "wss://game.example.com",
 *   iceServers: RtcPeerConnector.defaultIceServers,
 * }));
 * const program = Effect.gen(function* () {
 *   return CoopRooms.isCoopRooms(yield* CoopRooms.CoopRooms);
 * });
 * Effect.runSync(program.pipe(Effect.provide(rooms))); // => true
 * ```
 *
 * @category layers
 * @since 0.7.0
 */
export const layer = (
  options: () => {
    readonly url: string;
    readonly iceServers: readonly RTCIceServer[];
  }
): Layer.Layer<CoopRooms> =>
  Layer.sync(CoopRooms, () => {
    const { url, iceServers } = options();
    const room = { url };
    const services = roomLayer({ iceServers });
    return make({
      host: openHostRoom(room).pipe(Effect.provide(services)),
      join: (code) => openGuestRoom(room, code).pipe(Effect.provide(services)),
    });
  });
