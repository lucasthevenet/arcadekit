/**
 * A relay on this machine: `pnpm --filter arcadekit relay`, then give each
 * peer `Transport.layerWebSocket(Relay.address("ws://<this machine>:8787", { room, peer }))`.
 *
 * It is `Relay.make()` behind a WebSocket server, and all there is to
 * hosting the relay where a process stays in memory. Where one does not,
 * a Durable Object or a function behind a gateway, the host keeps who is
 * connected and calls `Relay.join` and `Relay.forward` itself.
 */
import { Cause, Exit } from "effect";
import { WebSocketServer } from "ws";

import { Relay } from "../src/index";

const port = Number(process.env.PORT ?? 8787);
const relay = Relay.make();
const server = new WebSocketServer({ port });

server.on("connection", (socket, request) => {
  const connection = relay.connect(request.url ?? "", (text) =>
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
    const received = connection.value.receive(
      isBinary ? (data as Uint8Array) : String(data)
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
