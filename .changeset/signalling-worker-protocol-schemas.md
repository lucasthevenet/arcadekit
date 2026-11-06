---
"@arcadekit/net": minor
---

The signalling protocol (`@arcadekit/net/signalling`) is now Effect Schemas, and its parsers bound what they read.

- Each message is a Schema, exported under its type's name: `PeerId`, `Signal`, `ClientMessage`, `ServerMessage` and `ErrorReason` (a `Schema.Literals`, so `ErrorReason.literals` lists every reason), plus a new `JoinCode`. The types are the Schemas' types, with the same shapes and the same wire format as before. `parseClientMessage` and `parseServerMessage` still return the message or `undefined`.
- New `MAX_PEER_ID_LENGTH` (32) and `MAX_TOKEN_LENGTH` (256) are the bounds of a peer id and of an `sdpMid` or ICE username fragment, beside `MAX_MESSAGE_LENGTH` (16 KB) and `MAX_PLAYERS`.
- `normalizeJoinCode` checks a code with `JoinCode`.

Breaking:

- `@arcadekit/net/signalling` now imports `effect` at runtime (it was dependency-free). `effect` is already the package's peer dependency. Its Schemas are built when it loads, so importing anything from it, even a constant or a join-code helper, bundles Effect Schema: about 77 KB minified and 25 KB gzipped (a bundler that inlines constants may still leave it out for a numeric one such as `MAX_PLAYERS`).
- The parsers refuse messages they used to accept: a peer id over `MAX_PEER_ID_LENGTH` characters, an `sdpMid` or ICE username fragment over `MAX_TOKEN_LENGTH`, an SDP or candidate line over `MAX_MESSAGE_LENGTH`, an `sdpMLineIndex` outside 0 to 65535, and a `welcome` whose `code` isn't a join code or that lists more than `MAX_PLAYERS - 1` peers. A signalling server must send messages within these bounds: `hostRoom` and `joinRoom` ignore a server message they can't decode, so a `welcome` outside them leaves the room `connecting` with no error.
