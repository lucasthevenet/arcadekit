---
"arcadekit": minor
---

`Transport.layerWebSocket` is carried over the `Socket` of `effect/socket`, and connects again on a `Schedule`. It opens its sockets with the `Socket.WebSocketConstructor` that is provided, such as `NodeSocket.layerWebSocketConstructor` of `@effect/platform-node`, and with the standard `WebSocket` when none is. Its waits run on Effect's `Clock`, so a test can drive them with `TestClock` against a stub socket. A socket that has not opened after 10 seconds counts as one that could not connect, and a binary frame is read as UTF-8 text, where it was dropped.

Nothing breaks: the layer's signature, its options and `Transport.Closed` are the same, and so are the waits between tries, 50 ms doubling up to two seconds.
