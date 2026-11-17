/**
 * The relay's front door: a Worker that sends each peer on to the Durable
 * Object of the room its address names, `/rooms/<room>?peer=<name>`.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import Room from "./room";

export default Cloudflare.Worker(
  "Relay",
  { main: import.meta.url },
  Effect.gen(function* () {
    const rooms = yield* Room;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.headers.upgrade !== "websocket") {
          return HttpServerResponse.text(
            "This is a relay for arcadekit games. Connect to /rooms/<room>?peer=<name> with a WebSocket.",
            { status: 426 }
          );
        }
        // One object per room, by the room's name: the last part of the path.
        const { pathname } = new URL(request.url, "https://relay");
        const room = pathname.split("/").findLast((part) => part !== "") ?? "";
        return yield* rooms.getByName(room).fetch(request);
      }),
    };
  })
);
