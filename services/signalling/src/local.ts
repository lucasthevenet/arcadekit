import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import {
  MAX_MESSAGE_LENGTH,
  joinCodeFromBytes,
  normalizeJoinCode,
} from "./protocol";
import { createRoom } from "./room";
import type { Room, RoomOptions } from "./room";
import { createSocketRoom } from "./sockets";
import type { RoomSocket, SocketRoom } from "./sockets";

/**
 * The signalling worker's routes in Node, for development and tests: `/host` and
 * `/join/<code>` over WebSocket, with the same room rules (`room.ts`) and socket adapter
 * (`sockets.ts`) as the Durable Object, and a timer for its expiry alarm. So co-op works on one
 * machine or a LAN with no Cloudflare account. Rooms live in this process's memory.
 */
export interface LocalSignalling {
  /** The base URL peers connect to, such as `ws://127.0.0.1:8787`. */
  readonly url: string;
  readonly port: number;
  /** Closes every socket and stops listening. */
  readonly close: () => Promise<void>;
}

export interface LocalSignallingOptions extends RoomOptions {
  /** 0 picks a free port. Defaults to 8787, the URL the demo uses by default. */
  readonly port?: number;
  /** The interface to listen on. Defaults to `127.0.0.1`; `0.0.0.0` serves the LAN. */
  readonly host?: string;
}

const refuse = (socket: Duplex, status: string) => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
};

interface OpenRoom {
  readonly room: Room;
  readonly sockets: SocketRoom;
  timer: NodeJS.Timeout | undefined;
}

export const startLocalSignalling = async (
  options: LocalSignallingOptions = {}
): Promise<LocalSignalling> => {
  const host = options.host ?? "127.0.0.1";
  const rooms = new Map<string, OpenRoom>();
  const wss = new WebSocketServer({
    noServer: true,
    // The room refuses anything over MAX_MESSAGE_LENGTH itself; this only bounds the frames.
    maxPayload: MAX_MESSAGE_LENGTH * 4,
  });

  const roomFor = (code: string): OpenRoom => {
    let open = rooms.get(code);
    if (open === undefined) {
      const room = createRoom(code, options);
      open = { room, sockets: createSocketRoom(room), timer: undefined };
      rooms.set(code, open);
    }
    return open;
  };

  const enter = (ws: WebSocket, code: string, role: "host" | "guest") => {
    const open = roomFor(code);
    const socket: RoomSocket = {
      send: (text) => ws.send(text),
      close: (closeCode, reason) => ws.close(closeCode, reason),
    };
    ws.on("message", (data, isBinary) => {
      // The protocol is text; a binary message is read as an empty, invalid one, as the worker does.
      open.sockets.message(socket, isBinary ? "" : data.toString(), Date.now());
    });
    ws.on("close", () => open.sockets.closed(socket));
    ws.on("error", () => open.sockets.closed(socket));
    open.sockets.open(socket, role, Date.now());

    const expiresAt = open.room.expiresAtMs();
    if (expiresAt === undefined) {
      // A guest asked for a code no host opened: forget the empty room.
      rooms.delete(code);
    } else if (open.timer === undefined) {
      // The Durable Object's alarm: end the room when it expires, then forget it.
      open.timer = setTimeout(
        () => {
          open.sockets.alarm(Date.now());
          rooms.delete(code);
        },
        Math.max(0, expiresAt - Date.now())
      );
      open.timer.unref();
    }
  };

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "http://local");
    let code: string | undefined;
    let role: "host" | "guest";
    if (pathname === "/host") {
      role = "host";
      // A fresh code, never one a live room in this process holds.
      do {
        code = joinCodeFromBytes(randomBytes(32));
      } while (code === undefined || rooms.has(code));
    } else {
      role = "guest";
      const match = /^\/join\/(?<code>[^/]+)$/u.exec(pathname);
      try {
        code = match
          ? normalizeJoinCode(decodeURIComponent(match.groups!.code!))
          : undefined;
      } catch {
        code = undefined;
      }
    }
    if (code === undefined) {
      refuse(socket, "404 Not Found");
      return;
    }
    const roomCode = code;
    wss.handleUpgrade(request, socket, head, (ws) => enter(ws, roomCode, role));
  };

  const server = createServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain" });
    response.end("Expected a WebSocket upgrade");
  });
  server.on("upgrade", upgrade);

  server.listen(options.port ?? 8787, host);
  // Rejects if listening fails (the port is taken).
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port,
    close: async () => {
      for (const open of rooms.values()) {
        clearTimeout(open.timer);
      }
      rooms.clear();
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      server.close();
      await once(server, "close");
    },
  };
};
