---
"arcadekit": minor
---

What a game played on several machines needs is a folder of modules, `arcadekit/net`, as Effect lays out its own: `import { Session, Transport } from "arcadekit/net"`, and each module as an entry of its own, `arcadekit/net/Session`. A game with one player loads none of it, and a relay server imports `arcadekit/net/Relay` and no session with it.

What breaks:

- `Session`, `Transport` and `Relay` are no longer exported by `arcadekit`: import them from `arcadekit/net`. The entries `arcadekit/Session`, `arcadekit/Transport` and `arcadekit/Relay` are `arcadekit/net/Session`, `arcadekit/net/Transport` and `arcadekit/net/Relay`.
- `arcadekit/Netcode` is gone, split by what it held: `Netcode.Message`, `Netcode.Issued`, `Netcode.encode` and `Netcode.decode` are `Message`'s, `Netcode.Drifted` is `Drift.Drifted`, and `Netcode.Peer` is `Peer.Peer`, all from `arcadekit/net`.

How peers find that they have drifted apart is a value of its own, `Drift.make({ peer, peers, start })`, which a session's peer tells what it takes and what it hears. It behaves as it did inside the peer, and nothing breaks by it.
