/**
 * The signalling worker, for Cloudflare (#25): it introduces the peers of a lockstep run
 * so they can open WebRTC data channels to each other, then gets out of the way. It never sees
 * game input.
 *
 * An app's Worker is a few lines over it. It names the Durable Object class that `room` makes,
 * since Cloudflare binds a class by its exported name, and it says which of its bindings are the
 * rooms and the site's files. Each join code is one Durable Object of that class.
 *
 * This file is Cloudflare's entry points, and the one file of the kit that runs an Effect itself:
 * Cloudflare owns the entry points, so each runs its Effect there. The Worker's
 * `fetch` runs each request with `Effect.runPromise`, since nothing outlives a request; the
 * Durable Object builds one `ManagedRuntime` with the object, since its connections outlive the
 * request that opened them. Cloudflare's own objects (`WebSocketPair`, the 101 response) are made
 * here. The room's rules and its connections are in `internal/`.
 *
 * @since 0.7.0
 */
import { DurableObject } from "cloudflare:workers";
import { Effect, ManagedRuntime } from "effect";

import { acceptSocket, expireRoom, roomLayer } from "./internal/connections";
import type { RoomConnections } from "./internal/connections";
import { checkRoomSize } from "./internal/room";
import { handleRequest, readRoomRequest } from "./internal/routes";
import type { Bindings } from "./internal/routes";

/**
 * How an app sets up its rooms.
 *
 * **When to use**
 *
 * To give `room` a room size other than 4.
 *
 * **Details**
 *
 * `roomSize` is the most players a room holds, host included: a whole number from 2 to
 * `Room.maxSize` (16, in `arcadekit/net/signalling`), and `Room.defaultSize` (4) if left out. A
 * lockstep run has its own limit on the wire, which is not this setting.
 *
 * **Example** (Rooms of eight)
 *
 * ```ts
 * import { SignallingWorker } from "arcadekit/net/worker";
 *
 * const options: SignallingWorker.RoomOptions = { roomSize: 8 };
 * options.roomSize; // => 8
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface RoomOptions {
  /** The most players a room holds, host included: 2 to 16. 4 if left out. */
  readonly roomSize?: number;
}

/**
 * A room's Durable Object class, as `room` returns it for the app to extend.
 *
 * **When to use**
 *
 * Rarely: an app extends what `room` returns, and Cloudflare constructs it.
 *
 * **Example** (A room's class)
 *
 * ```ts
 * import { SignallingWorker } from "arcadekit/net/worker";
 *
 * const Rooms: SignallingWorker.RoomClass = SignallingWorker.room();
 * typeof Rooms; // => "function"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type RoomClass = new (
  ctx: DurableObjectState,
  env: unknown
) => DurableObject<unknown>;

/**
 * The Durable Object class of one join code's room, for the app's Worker to extend and export
 * under the name its binding declares.
 *
 * **When to use**
 *
 * Once, in the app's Worker, beside `make`.
 *
 * **Details**
 *
 * It keeps the room in memory only: rooms live for minutes, and the accepted (not hibernated)
 * WebSockets keep the object alive while anyone is connected. Each object builds one
 * `ManagedRuntime` and runs its `fetch` and `alarm` on it, so a room's connections are fibers
 * that outlive the request that opened each. A room size no room can have throws a `RangeError`
 * here, when the Worker's module loads, so a wrong size fails the deploy and is never changed to
 * another one.
 *
 * **Example** (A room of up to four players)
 *
 * ```ts
 * import { SignallingWorker } from "arcadekit/net/worker";
 *
 * class SignallingRoom extends SignallingWorker.room({ roomSize: 4 }) {}
 * typeof SignallingRoom; // => "function"
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const room = (options: RoomOptions = {}): RoomClass => {
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

/**
 * Which of the app's Worker bindings the signalling worker uses, by name.
 *
 * **When to use**
 *
 * To hand `make` the names the app declares its bindings under.
 *
 * **Example** (The demo's bindings)
 *
 * ```ts
 * import { SignallingWorker } from "arcadekit/net/worker";
 *
 * const options: SignallingWorker.Options<"ROOMS", "ASSETS"> = { rooms: "ROOMS", assets: "ASSETS" };
 * options.rooms; // => "ROOMS"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options<Rooms extends string, Assets extends string> {
  /** The Durable Object namespace of the app's room class: one object per join code. */
  readonly rooms: Rooms;
  /** The site's files, which answer every path but the signalling routes. */
  readonly assets: Assets;
}

/**
 * The bindings a signalling worker reads from the Worker's `env`, under the app's names.
 *
 * **When to use**
 *
 * To type the `env` the app's own code hands the worker's `fetch`.
 *
 * **Example** (The bindings' names, from the options)
 *
 * ```ts
 * import type { SignallingWorker } from "arcadekit/net/worker";
 *
 * type Env = SignallingWorker.Env<"ROOMS", "ASSETS">;
 * const names: readonly (keyof Env)[] = ["ROOMS", "ASSETS"];
 * names.length; // => 2
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type Env<Rooms extends string, Assets extends string> = Readonly<
  Record<Rooms, Bindings["ROOMS"]>
> &
  Readonly<Record<Assets, Bindings["ASSETS"]>>;

/**
 * A Worker's default export: its `fetch` handler, as Cloudflare calls it with each request and
 * the Worker's `env`.
 *
 * **When to use**
 *
 * Rarely: `make` gives one, and the app exports it as its default.
 *
 * **Example** (The handler's one entry point)
 *
 * ```ts
 * import { SignallingWorker } from "arcadekit/net/worker";
 *
 * const worker: SignallingWorker.Handler<SignallingWorker.Env<"ROOMS", "ASSETS">> =
 *   SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
 * typeof worker.fetch; // => "function"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Handler<WorkerEnv> {
  readonly fetch: (request: Request, env: WorkerEnv) => Promise<Response>;
}

/**
 * The app's Worker, to export as its default: `GET /host` and `GET /join/<code>` (WebSocket
 * upgrades) go to the rooms, and anything else to the site's files.
 *
 * **When to use**
 *
 * Once, as the default export of the app's Worker, beside the room class it extends from `room`.
 *
 * **Details**
 *
 * `GET /host` picks a fresh join code and opens its room as the host; `GET /join/<code>` joins
 * that room as a guest. A request to either that is no WebSocket upgrade is answered 426, a join
 * code that can't be one 404, and a binding that fails is logged and answered 503, so the peer
 * tries again. Nothing in the Worker outlives a request, and its bindings come with it, so each
 * request runs its own Effect.
 *
 * **Example** (A path that is the site's)
 *
 * ```ts
 * import { SignallingWorker } from "arcadekit/net/worker";
 *
 * const worker = SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
 * const asked: string[] = [];
 * const env = {
 *   ROOMS: { getByName: () => ({ fetch: async () => new Response(null, { status: 500 }) }) },
 *   ASSETS: {
 *     fetch: async (request: Request) => {
 *       asked.push(new URL(request.url).pathname);
 *       return new Response("<!doctype html>");
 *     },
 *   },
 * };
 * void worker.fetch(new Request("https://game.example.com/index.html"), env);
 * asked; // => ["/index.html"]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <const Rooms extends string, const Assets extends string>(
  options: Options<Rooms, Assets>
): Handler<Env<Rooms, Assets>> => ({
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
