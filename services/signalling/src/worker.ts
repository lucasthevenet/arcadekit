import { DurableObject } from "cloudflare:workers";

import { joinCodeFromBytes, normalizeJoinCode } from "./protocol";
import { createRoom } from "./room";
import type { Room } from "./room";
import { createSocketRoom } from "./sockets";
import type { SocketRoom } from "./sockets";

/**
 * The signalling worker (#25, ADR-0012): introduces the peers of a lockstep run so they can open
 * WebRTC data channels to each other, then gets out of the way. It never sees game input.
 *
 * - `GET /host` (a WebSocket upgrade) picks a fresh join code and opens its room as the host.
 * - `GET /join/<code>` (a WebSocket upgrade) joins that room as a guest.
 *
 * Each join code is one `SignallingRoom` Durable Object. `alchemy.run.ts` declares the Worker
 * and the `ROOMS` namespace binding.
 */
export interface Env {
  readonly ROOMS: DurableObjectNamespace<SignallingRoom>;
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> | Response => {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    if (url.pathname === "/host") {
      const code = joinCodeFromBytes(
        crypto.getRandomValues(new Uint8Array(32))
      );
      if (code === undefined) {
        return new Response("Try again", { status: 503 });
      }
      return toRoom(env, request, code, "host");
    }
    const match = /^\/join\/(?<code>[^/]+)$/u.exec(url.pathname);
    const code = match ? joinCodeFromPath(match.groups!.code!) : undefined;
    if (code === undefined) {
      return new Response("Not found", { status: 404 });
    }
    return toRoom(env, request, code, "guest");
  },
};

/** The join code in a `/join/<code>` path segment, or `undefined` for a malformed escape. */
const joinCodeFromPath = (segment: string): string | undefined => {
  try {
    return normalizeJoinCode(decodeURIComponent(segment));
  } catch {
    return undefined;
  }
};

const toRoom = (
  env: Env,
  request: Request,
  code: string,
  role: "host" | "guest"
): Promise<Response> => {
  const url = new URL(request.url);
  url.pathname = "/";
  url.search = new URLSearchParams({ code, role }).toString();
  return env.ROOMS.getByName(code).fetch(new Request(url, request));
};

/**
 * One join code's room. It keeps the room in memory only: rooms live for minutes, and the
 * accepted (not hibernated) WebSockets keep the object alive while anyone is connected. The
 * room's rules are in `room.ts` and the socket bookkeeping in `sockets.ts`; this class only
 * wires Cloudflare's WebSockets and alarm to them.
 */
export class SignallingRoom extends DurableObject<Env> {
  private open:
    | { readonly room: Room; readonly sockets: SocketRoom }
    | undefined;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const role = url.searchParams.get("role");
    if (code === null || (role !== "host" && role !== "guest")) {
      return new Response("Bad request", { status: 400 });
    }
    if (this.open === undefined) {
      const room = createRoom(code);
      this.open = { room, sockets: createSocketRoom(room) };
    }
    const { room, sockets } = this.open;

    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    server.accept();
    server.addEventListener("message", (event) => {
      // The protocol is text; a binary message is read as an empty, invalid one.
      const text = typeof event.data === "string" ? event.data : "";
      sockets.message(server, text, Date.now());
    });
    server.addEventListener("close", () => sockets.closed(server));
    server.addEventListener("error", () => sockets.closed(server));
    sockets.open(server, role, Date.now());

    const expiresAt = room.expiresAtMs();
    if (role === "host" && expiresAt !== undefined) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override alarm(): void {
    this.open?.sockets.alarm(Date.now());
  }
}
