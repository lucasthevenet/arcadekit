import { HOST_ID } from "arcadekit/net/signalling";
import type { PeerId } from "arcadekit/net/signalling";
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Queue,
  Scheduler,
  Stream,
} from "effect";
import type { Scope } from "effect";

import { createRoom } from "./room";
import type { Room } from "./room";
import { createSocketRoom } from "./sockets";
import type { RoomSocket, SocketRoom } from "./sockets";

/**
 * A `SignallingRoom` Durable Object's work, as Effects: each socket's connection to the room,
 * and the room's expiry alarm. `worker.ts` runs them on the object's runtime. The room's rules
 * (`room.ts`) and the socket bookkeeping (`sockets.ts`) stay plain, called from inside them.
 */

type MessageListener = (event: { readonly data: unknown }) => void;
type Listen = ((type: "message", listener: MessageListener) => void) &
  ((type: "close" | "error", listener: () => void) => void);

/** A peer's WebSocket as a connection uses it. A Cloudflare `WebSocket` is one; tests pass a fake. */
export interface PeerSocket extends RoomSocket {
  readonly addEventListener: Listen;
  readonly removeEventListener: Listen;
}

/** The part of a Durable Object's storage the room uses: its one alarm. */
export interface AlarmStorage {
  readonly setAlarm: (atMs: number) => Promise<void>;
}

/** The room's expiry alarm couldn't be set, so its host couldn't open it. */
export class AlarmError extends Data.TaggedError("AlarmError")<{
  readonly cause: unknown;
}> {}

/** A Durable Object's room, and the sockets connected to it. */
export interface RoomConnections {
  /**
   * Connects `socket` to the object's room as `role`, then serves it until it closes. The
   * object's first connection makes the room, with join code `code`. Succeeds with the peer id
   * once the socket is in the room, or with `undefined` once the room has refused it with an
   * error.
   */
  readonly connect: (
    socket: PeerSocket,
    code: string,
    role: "host" | "guest"
  ) => Effect.Effect<PeerId | undefined, AlarmError>;
  /** The expiry alarm fired: ends the room if its time is up. */
  readonly expire: Effect.Effect<void>;
}

export const RoomConnections: Context.Service<
  RoomConnections,
  RoomConnections
> = Context.Service<RoomConnections>("survivor-demo/worker/RoomConnections");

/** `socket`'s text messages until it closes or fails. It is listened to until the scope closes. */
const listen = Effect.fnUntraced(function* (
  socket: PeerSocket
): Effect.fn.Return<Stream.Stream<string>, never, Scope.Scope> {
  const inbox = yield* Queue.unbounded<string, Cause.Done>();
  // The protocol is text; a binary message is read as an empty, invalid one.
  const onMessage = (event: { readonly data: unknown }) => {
    Queue.offerUnsafe(inbox, typeof event.data === "string" ? event.data : "");
  };
  const onClose = () => {
    Queue.endUnsafe(inbox);
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onClose);
    }),
    () =>
      Effect.sync(() => {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onClose);
      })
  );
  return Stream.fromQueue(inbox);
});

/** A Durable Object's room, once its first connection has made it. */
interface OpenRoom {
  readonly room: Room;
  readonly sockets: SocketRoom;
}

const setAlarm = (
  storage: AlarmStorage,
  atMs: number
): Effect.Effect<void, AlarmError> =>
  Effect.tryPromise({
    try: () => storage.setAlarm(atMs),
    catch: (cause) => new AlarmError({ cause }),
  });

/**
 * One socket's time in the room, as one fiber: the room admits it, a host's expiry alarm is
 * set, and the room gets its messages until it closes. `admitted` completes once the
 * socket is in the room or was refused, or fails with what kept it out.
 */
const connection = (
  storage: AlarmStorage,
  { room, sockets }: OpenRoom,
  socket: PeerSocket,
  role: "host" | "guest",
  admitted: Deferred.Deferred<PeerId | undefined, AlarmError>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const messages = yield* listen(socket);
    // Once the room has admitted the socket, however the connection ends, the room forgets it,
    // and if the socket didn't close by itself (the alarm failed, the runtime went), the worker
    // closes it. Admitting it and arranging that are one step, so no interruption falls between.
    const peer = yield* Effect.acquireRelease(
      Clock.clockWith((clock) =>
        Effect.sync(() =>
          sockets.open(socket, role, clock.currentTimeMillisUnsafe())
        )
      ),
      (admittedAs, exit) =>
        Effect.sync(() => {
          if (admittedAs === undefined) {
            return;
          }
          if (Exit.isSuccess(exit)) {
            sockets.closed(socket);
          } else {
            sockets.drop(socket);
          }
        })
    );
    if (peer === undefined) {
      // Refused: the socket has its error and is closed.
      return peer;
    }
    const expiresAtMs = room.expiresAtMs();
    if (peer === HOST_ID && expiresAtMs !== undefined) {
      // Nothing but the alarm ends a room nobody leaves, so the host isn't in until it's set.
      yield* setAlarm(storage, expiresAtMs);
    }
    yield* Deferred.succeed(admitted, peer);
    yield* Stream.runForEach(messages, (text) =>
      Clock.clockWith((clock) =>
        Effect.sync(() =>
          sockets.message(socket, text, clock.currentTimeMillisUnsafe())
        )
      )
    );
    return peer;
  }).pipe(
    Effect.scoped,
    // Until the socket is in the room, the request waiting on `admitted` hears how this
    // ended and reports it. After, nothing waits, so a crash is logged here.
    Effect.onExit((exit) =>
      Effect.flatMap(Deferred.done(admitted, exit), (heard) =>
        !heard && Exit.isFailure(exit) && Cause.hasDies(exit.cause)
          ? Effect.logError("A signalling connection crashed", exit.cause)
          : Effect.void
      )
    ),
    Effect.ignoreCause
  );

const makeRoomConnections = (storage: AlarmStorage) =>
  Effect.gen(function* () {
    // Every connection is a fiber in this set, so they all end with the object's runtime.
    const connections = yield* FiberSet.make();
    // A Durable Object is one join code's room, made by its first connection.
    let open: OpenRoom | undefined;

    return RoomConnections.of({
      connect: Effect.fnUntraced(function* (socket, code, role) {
        open ??= (() => {
          const room = createRoom(code);
          return { room, sockets: createSocketRoom(room) };
        })();
        const admitted = yield* Deferred.make<PeerId | undefined, AlarmError>();
        yield* FiberSet.run(
          connections,
          connection(storage, open, socket, role, admitted)
        );
        return yield* Deferred.await(admitted);
      }),
      expire: Clock.clockWith((clock) =>
        Effect.sync(() => open?.sockets.alarm(clock.currentTimeMillisUnsafe()))
      ),
    });
  });

/**
 * Everything a `SignallingRoom` Durable Object's runtime holds, over the object's storage. Its
 * scheduler is the synchronous one: Cloudflare can drop the timers a request leaves behind, and
 * a room's connections outlive the request that opened them, so each message is handled in the
 * event that brought it, not on a timer.
 */
export const roomLayer = (
  storage: AlarmStorage
): Layer.Layer<RoomConnections> =>
  Layer.effect(RoomConnections, makeRoomConnections(storage)).pipe(
    Layer.provideMerge(
      Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"))
    )
  );

/**
 * Connects `socket` to the room and answers the request that brought it: with `accepted`, the
 * response that hands the peer its end of the socket, once the socket is in the room or the
 * room refused it with an error; or with 503 if the room couldn't open, so the peer can try
 * again with a fresh code.
 */
export const acceptSocket = (
  socket: PeerSocket,
  code: string,
  role: "host" | "guest",
  accepted: Response
): Effect.Effect<Response, never, RoomConnections> =>
  RoomConnections.use((room) => room.connect(socket, code, role)).pipe(
    Effect.as(accepted),
    Effect.catchTag("AlarmError", (error) =>
      Effect.as(
        Effect.logError("Couldn't set the room's expiry alarm", error.cause),
        new Response("Try again", { status: 503 })
      )
    )
  );

/** The Durable Object's alarm fired: ends its room if the room's time is up. */
export const expireRoom: Effect.Effect<void, never, RoomConnections> =
  RoomConnections.use((room) => room.expire);
