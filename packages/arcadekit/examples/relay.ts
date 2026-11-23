/**
 * A relay on this machine: `pnpm --filter arcadekit relay`, then give each
 * peer `Transport.layerWebSocket(Relay.address("ws://<this machine>:8787", { room, peer }))`.
 *
 * It is `Relay.make()` behind a WebSocket server, and all there is to
 * hosting the relay where a process stays in memory. Where one does not,
 * a Durable Object or a function behind a gateway, the host keeps who is
 * connected and calls `Relay.join` and `Relay.forward` itself.
 *
 * It proves nothing of who connects, `Relay.anyone`, which suits a network
 * of machines that trust each other. A relay open to strangers proves each
 * peer's name from the request and passes that name instead.
 */
import { Cause, Exit } from "effect";
import { WebSocketServer } from "ws";

import { Relay } from "../src/net/index";

const port = Number(process.env.PORT ?? 8787);
const relay = Relay.make();
const server = new WebSocketServer({ port });

server.on("connection", (socket, request) => {
  const connection = relay.connect(request.url ?? "", Relay.anyone, (text) =>
    socket.send(text)
  );
  if (Exit.isFailure(connection)) {
    const refused = Cause.squash(connection.cause) as Relay.Refused;
    console.log(`refused: ${refused.message}`);
    socket.close(refused.code, refused.reason);
    return;
  }
  const { member } = connection.value;
  console.log(`${member.peer} is in ${member.room}`);
  socket.on("message", (data, isBinary) => {
    // What ws hands over: a buffer, an ArrayBuffer, or its fragments.
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : new Uint8Array(data);
    const received = connection.value.receive(
      isBinary ? bytes : new TextDecoder().decode(bytes)
    );
    if (Exit.isFailure(received)) {
      const refused = Cause.squash(received.cause) as Relay.Refused;
      console.log(`closed ${member.peer}: ${refused.message}`);
      socket.close(refused.code, refused.reason);
    }
  });
  socket.on("close", () => {
    connection.value.close();
    console.log(`${member.peer} has left ${member.room}`);
  });
});

server.on("listening", () => {
  console.log(`A relay is listening on ws://localhost:${port}`);
});
