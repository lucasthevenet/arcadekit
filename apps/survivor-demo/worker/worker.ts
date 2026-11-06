import { DurableObject } from "cloudflare:workers";
import { Effect, ManagedRuntime } from "effect";

import { acceptSocket, expireRoom, roomLayer } from "./connections";
import type { RoomConnections } from "./connections";
import { handleRequest, readRoomRequest } from "./routes";
import type { Bindings } from "./routes";

/**
 * The survivors demo's Worker (#25, ADR-0012). It serves the site's files and is the signalling
 * worker: it introduces the peers of a lockstep run so they can open WebRTC data channels to
 * each other, then gets out of the way. It never sees game input. Its routes are in `routes.ts`.
 *
 * Each join code is one `SignallingRoom` Durable Object. `alchemy.run.ts` declares the Worker,
 * routes only the signalling paths to it ahead of the assets, and binds `ROOMS`; Alchemy
 * supplies `ASSETS`.
 *
 * This file is only Cloudflare's entry points: each runs an Effect, and Cloudflare's own
 * objects (`WebSocketPair`, the 101 response, the object's storage) are made here.
 */
export interface Env extends Bindings {
  readonly ROOMS: DurableObjectNamespace<SignallingRoom>;
  readonly ASSETS: Fetcher;
}

export default {
  // Nothing in the Worker outlives a request, and its bindings come with it, so each request
  // runs its own Effect.
  fetch: (request: Request, env: Env): Promise<Response> =>
    Effect.runPromise(handleRequest(request, env)),
};

/**
 * One join code's room. It keeps the room in memory only: rooms live for minutes, and the
 * accepted (not hibernated) WebSockets keep the object alive while anyone is connected.
 */
export class SignallingRoom extends DurableObject<Env> {
  // Cloudflare owns this object's entry points, so they run their Effects on one runtime, made
  // with the object. The room's connections are fibers in it, past the request that opened
  // each. It lives as long as the object, which Cloudflare drops without telling it.
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    RoomConnections,
    never
  >;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = ManagedRuntime.make(roomLayer(ctx.storage));
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
}
