import {
  JoinCode,
  joinCodeFromBytes,
  joinCodeFromPath,
} from "arcadekit/net/signalling";
import { Data, Effect, Option, Schema } from "effect";

/**
 * The Worker's routes (#25, ADR-0012):
 *
 * - `GET /host` (a WebSocket upgrade) picks a fresh join code and opens its room as the host.
 * - `GET /join/<code>` (a WebSocket upgrade) joins that room as a guest.
 * - Anything else is the site, from the static assets.
 *
 * Each join code is one `SignallingRoom` Durable Object, which gets the peer's request with
 * `roomRequest`.
 */

/** What the Worker's fetch uses of its bindings. `worker.ts`'s `Env` is one; tests pass fakes. */
export interface Bindings {
  /** The site's files, which Alchemy binds. */
  readonly ASSETS: {
    readonly fetch: (request: Request) => Promise<Response>;
  };
  /** The rooms' Durable Objects, one per join code. */
  readonly ROOMS: {
    readonly getByName: (code: string) => {
      readonly fetch: (request: Request) => Promise<Response>;
    };
  };
}

/**
 * A binding the Worker handed a request to failed: the site's files (`ASSETS`) or a room's
 * Durable Object (`ROOMS`).
 */
export class BindingError extends Data.TaggedError("BindingError")<{
  readonly binding: keyof Bindings;
  readonly cause: unknown;
}> {}

const RoomSearch = Schema.Struct({
  code: JoinCode,
  role: Schema.Literals(["host", "guest"]),
});
type RoomSearch = typeof RoomSearch.Type;

const decodeRoomSearch = Schema.decodeUnknownOption(RoomSearch);

/** The request a room's Durable Object gets for a peer's: the same request at `/`, with its join code and role. */
export const roomRequest = (
  request: Request,
  code: string,
  role: RoomSearch["role"]
): Request => {
  const url = new URL(request.url);
  url.pathname = "/";
  url.search = new URLSearchParams({ code, role }).toString();
  return new Request(url, request);
};

/** The join code and role `roomRequest` gave a request; `undefined` for any other request. */
export const readRoomRequest = (request: Request): RoomSearch | undefined =>
  Option.getOrUndefined(
    decodeRoomSearch(Object.fromEntries(new URL(request.url).searchParams))
  );

const text = (status: number, body: string) => new Response(body, { status });

const forward = (
  binding: keyof Bindings,
  fetch: () => Promise<Response>
): Effect.Effect<Response, BindingError> =>
  Effect.tryPromise({
    try: fetch,
    catch: (cause) => new BindingError({ binding, cause }),
  });

/** A fresh join code from random bytes; `undefined` in the unlikely case they run out. */
const freshCode = Effect.sync(() =>
  joinCodeFromBytes(crypto.getRandomValues(new Uint8Array(32)))
);

/**
 * The Worker's answer to `request`. A binding that fails is logged and answered 503, so the
 * peer tries again.
 */
export const handleRequest: (
  request: Request,
  env: Bindings
) => Effect.Effect<Response> = Effect.fnUntraced(
  function* (request: Request, env: Bindings) {
    const { pathname } = new URL(request.url);
    const isHost = pathname === "/host";
    if (!isHost && !pathname.startsWith("/join/")) {
      return yield* forward("ASSETS", () => env.ASSETS.fetch(request));
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return text(426, "Expected a WebSocket upgrade");
    }
    const code = isHost ? yield* freshCode : joinCodeFromPath(pathname);
    if (code === undefined) {
      return isHost ? text(503, "Try again") : text(404, "Not found");
    }
    const room = roomRequest(request, code, isHost ? "host" : "guest");
    return yield* forward("ROOMS", () => env.ROOMS.getByName(code).fetch(room));
  },
  Effect.catchTag("BindingError", (error) =>
    Effect.as(
      Effect.logError(
        `The Worker's ${error.binding} binding failed`,
        error.cause
      ),
      text(503, "Try again")
    )
  )
);
