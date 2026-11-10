import { DurableObject } from "cloudflare:workers";
import { Effect, ManagedRuntime } from "effect";

import { acceptSocket, expireRoom, roomLayer } from "./connections";
import type { RoomConnections } from "./connections";
import { checkRoomSize } from "./room";
import { handleRequest, readRoomRequest } from "./routes";
import type { Bindings } from "./routes";

/**
 * The signalling worker, for Cloudflare (#25, ADR-0012): it introduces the peers of a lockstep
 * run so they can open WebRTC data channels to each other, then gets out of the way. It never
 * sees game input. Exported as `arcadekit/net/worker`.
 *
 * An app's Worker is a few lines over it. It names the Durable Object class that
 * `signallingRoom` makes, since Cloudflare binds a class by its exported name, and it says
 * which of its bindings are the rooms and the site's files:
 *
 *     export class SignallingRoom extends signallingRoom() {}
 *     export default signallingWorker({ rooms: "ROOMS", assets: "ASSETS" });
 *
 * Each join code is one Durable Object of that class. The Worker's routes are in `routes.ts`.
 *
 * This file is only Cloudflare's entry points: each runs an Effect, and Cloudflare's own
 * objects (`WebSocketPair`, the 101 response, the object's storage) are made here.
 */

/** How an app sets up its rooms. */
export interface SignallingRoomOptions {
  /**
   * The most players a room holds, host included: a whole number from 2 to `MAX_ROOM_SIZE`
   * (16, in `arcadekit/net/signalling`). `DEFAULT_ROOM_SIZE` (4) if left out. `signallingRoom`
   * throws a `RangeError` for any other size.
   */
  readonly roomSize?: number;
}

/** A room's Durable Object class, as `signallingRoom` returns it for the app to extend. */
export type SignallingRoomClass = new (
  ctx: DurableObjectState,
  env: unknown
) => DurableObject<unknown>;

/**
 * The Durable Object class of one join code's room, for the app's Worker to extend and export
 * under the name its binding declares. It keeps the room in memory only: rooms live for
 * minutes, and the accepted (not hibernated) WebSockets keep the object alive while anyone is
 * connected.
 */
export const signallingRoom = (
  options: SignallingRoomOptions = {}
): SignallingRoomClass => {
  // A size no room can have fails here, when the Worker's module loads, not on a first join.
  const roomSize = checkRoomSize(options.roomSize);

  return class SignallingRoom extends DurableObject<unknown> {
    // Cloudflare owns this object's entry points, so they run their Effects on one runtime,
    // made with the object. The room's connections are fibers in it, past the request that
    // opened each. It lives as long as the object, which Cloudflare drops without telling it.
    private readonly runtime: ManagedRuntime.ManagedRuntime<
      RoomConnections,
      never
    >;

    constructor(ctx: DurableObjectState, env: unknown) {
      super(ctx, env);
      this.runtime = ManagedRuntime.make(roomLayer(ctx.storage, { roomSize }));
    }

    override async fetch(request: Request): Promise<Response> {
      const peer = readRoomRequest(request);
      if (peer === undefined) {
        return new Response("Bad request", { status: 400 });
      }
      const [client, server] = Object.values(new WebSocketPair()) as [
        WebSocket,
        WebSocket,
      ];
      server.accept();
      return await this.runtime.runPromise(
        acceptSocket(
          server,
          peer.code,
          peer.role,
          new Response(null, { status: 101, webSocket: client })
        )
      );
    }

    override async alarm(): Promise<void> {
      await this.runtime.runPromise(expireRoom);
    }
  };
};

/** Which of the app's Worker bindings the signalling worker uses, by name. */
export interface SignallingWorkerOptions<
  Rooms extends string,
  Assets extends string,
> {
  /** The Durable Object namespace of the app's `signallingRoom` class: one object per join code. */
  readonly rooms: Rooms;
  /** The site's files, which answer every path but the signalling routes. */
  readonly assets: Assets;
}

/** The bindings a `signallingWorker` reads from the Worker's `env`, under the app's names. */
export type SignallingWorkerEnv<
  Rooms extends string,
  Assets extends string,
> = Readonly<Record<Rooms, Bindings["ROOMS"]>> &
  Readonly<Record<Assets, Bindings["ASSETS"]>>;

/** A Worker's default export: its `fetch` handler. */
export interface SignallingWorker<Env> {
  readonly fetch: (request: Request, env: Env) => Promise<Response>;
}

/**
 * The app's Worker, to export as its default: `GET /host` and `GET /join/<code>` (WebSocket
 * upgrades) go to the rooms, and anything else to the site's files.
 */
export const signallingWorker = <
  const Rooms extends string,
  const Assets extends string,
>(
  options: SignallingWorkerOptions<Rooms, Assets>
): SignallingWorker<SignallingWorkerEnv<Rooms, Assets>> => ({
  // Nothing in the Worker outlives a request, and its bindings come with it, so each request
  // runs its own Effect.
  fetch: (request, env) =>
    Effect.runPromise(
      handleRequest(request, {
        ROOMS: env[options.rooms],
        ASSETS: env[options.assets],
      })
    ),
});
