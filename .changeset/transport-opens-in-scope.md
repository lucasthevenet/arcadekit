---
"arcadekit": minor
---

A transport opens in the scope of the program that connects it, not where its layer is provided. The `Transport` service holds `open`, an effect that opens the channel or the socket in the current scope and closes it with that scope, and `Transport.connect(session)` opens it. `Transport.layerBroadcastChannel` and `Transport.layerWebSocket` provided to `Transport.connect` alone closed once the session was joined, and the first tick threw; now the channel lasts as long as the program that drives the session, wherever the layer is provided. `Transport.open` opens the transport for a program that sends and receives itself. A transport made with `Transport.text` throws when it is used after `close`, as the two layers do after their scope.

What breaks:

- `Transport.connect(session)` requires a `Scope`: run it inside `Effect.scoped`, as a program that drives a session already is.
- `yield* Transport.Transport` gives `{ open }`, not the transport: `yield* Transport.open` gives the transport, in the current scope.
- A layer that listens opens nothing when it is built: `Layer.build(Transport.layerWebSocket(url))` no longer opens the socket.
