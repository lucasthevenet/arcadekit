/**
 * A room of the relay, as a Cloudflare Durable Object declared with
 * Alchemy: one object per room, which Cloudflare puts to sleep between two
 * messages while it keeps the room's sockets open.
 *
 * It keeps nothing in memory. Who is in the room is read back from the
 * sockets themselves each time: every socket carries its member, which
 * Cloudflare holds with the socket while the object sleeps. That is all
 * `Relay.join` and `Relay.forward` ask to be told.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Cause, Effect, Exit, Result } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as Relay from "../../../src/Relay";

export default class Room extends Cloudflare.DurableObject<Room>()(
  "Rooms",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      /** Everyone connected to this room, each with the socket to reach them by. */
      const present = Effect.gen(function* () {
        const members: {
          readonly member: Relay.Member;
          readonly socket: Cloudflare.WebSocket;
        }[] = [];
        for (const socket of yield* state.getWebSockets()) {
          // A socket that was refused, and is closing, has none.
          const member = yield* socket
            .getAttachment(Relay.Member)
            .pipe(Effect.option);
          if (member._tag === "Some") {
            members.push({ member: member.value, socket });
          }
        }
        return members;
      });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const everyone = yield* present;
          // Whether this peer may have this name is settled before this
          // line, with whatever the request carries: a token, a session.
          const joined = Relay.join(
            request.url,
            everyone.map(({ member }) => member)
          );
          if (Exit.isFailure(joined)) {
            // Turned away at the door, with the status and the reason. A
            // page learns only that it did not connect: a host that closes
            // an accepted socket instead can tell it why, but a socket
            // closed in the same breath as it is accepted was left
            // half-closed by workerd when this was tried.
            const refused = Result.getOrThrow(Cause.findError(joined.cause));
            return HttpServerResponse.text(refused.message, {
              status: refused.status,
            });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* socket.setAttachment(Relay.Member, joined.value);
          return response;
        }).pipe(Effect.orDie),

        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          data: string | ArrayBuffer
        ) {
          const from = yield* socket
            .getAttachment(Relay.Member)
            .pipe(Effect.option);
          if (from._tag === "None") {
            return;
          }
          const everyone = yield* present;
          const deliveries = Relay.forward(
            from.value,
            data,
            everyone.map(({ member }) => member)
          );
          if (Exit.isFailure(deliveries)) {
            const refused = Result.getOrThrow(
              Cause.findError(deliveries.cause)
            );
            yield* socket.close(refused.code, refused.reason);
            return;
          }
          for (const { text, to } of deliveries.value) {
            const peer = everyone.find(({ member }) => member.peer === to.peer);
            if (peer !== undefined) {
              yield* peer.socket.send(text);
            }
          }
        }),

        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string
        ) {
          // Nothing to forget: the socket was all there was of the peer.
          yield* socket.close(code, reason);
        }),
      };
    });
  })
) {}
