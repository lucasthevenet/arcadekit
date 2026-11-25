/**
 * A room of the relay, as a Cloudflare Durable Object declared with
 * Alchemy: one object per room, which Cloudflare puts to sleep between two
 * messages while it keeps the room's sockets open.
 *
 * It keeps nothing in memory. Who is in the room is read back from the
 * sockets themselves each time: every socket carries its member, which
 * Cloudflare holds with the socket while the object sleeps. That is all
 * `Relay.join`, `Relay.forward`, `Relay.joined` and `Relay.left` ask to be
 * told.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Cause, Effect, Exit } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as Relay from "../../../src/net/Relay";

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

      /** Sends each delivery to the socket of the member it is for. */
      const deliver = (
        deliveries: readonly Relay.Delivery[],
        sockets: readonly {
          readonly member: Relay.Member;
          readonly socket: Cloudflare.WebSocket;
        }[]
      ) =>
        Effect.gen(function* () {
          for (const { data, to } of deliveries) {
            const peer = sockets.find(({ member }) => member.peer === to.peer);
            if (peer !== undefined) {
              yield* peer.socket.send(data);
            }
          }
        });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const everyone = yield* present;
          // Anyone may take any free name here. A game's relay proves the
          // name from what the request carries, a token or a session, and
          // passes it instead of Relay.anyone.
          const joined = Relay.join(
            request.url,
            Relay.anyone,
            everyone.map(({ member }) => member)
          );
          if (Exit.isFailure(joined)) {
            // Turned away at the door, with the status and the reason. A
            // page learns only that it did not connect: a host that closes
            // an accepted socket instead can tell it why, but a socket
            // closed in the same breath as it is accepted was left
            // half-closed by workerd when this was tried.
            const refused = Cause.squash(joined.cause) as Relay.Refused;
            return HttpServerResponse.text(refused.message, {
              status: refused.status,
            });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* socket.setAttachment(Relay.Member, joined.value);
          // The room is told who came in, and the newcomer who is there.
          const now = [...everyone, { member: joined.value, socket }];
          yield* deliver(
            Relay.joined(
              joined.value,
              now.map(({ member }) => member)
            ),
            now
          );
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
            const refused = Cause.squash(deliveries.cause) as Relay.Refused;
            yield* socket.close(refused.code, refused.reason);
            return;
          }
          yield* deliver(deliveries.value, everyone);
        }),

        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string
        ) {
          // Nothing to forget: the socket was all there was of the peer.
          yield* socket.close(code, reason);
          const gone = yield* socket
            .getAttachment(Relay.Member)
            .pipe(Effect.option);
          if (gone._tag === "Some") {
            // The others, by name: the closing socket may still be listed.
            const others = (yield* present).filter(
              ({ member }) => member.peer !== gone.value.peer
            );
            yield* deliver(
              Relay.left(
                gone.value,
                others.map(({ member }) => member)
              ),
              others
            );
          }
        }),
      };
    });
  })
) {}
