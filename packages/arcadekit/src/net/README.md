# arcadekit/net

Lockstep multiplayer for 2 to 4 players. `LockstepSession.host` and `LockstepSession.join` run one declared `Game.Simulation` on every peer: each step runs once the host has confirmed every player's input for it, peers compare state hashes, and the host removes a player who stalls the run. A session talks through a `Transport`: a `MemoryNetwork` in memory for tests, or WebRTC links in `arcadekit/net/browser`, where a `Coop` declaration runs all of it for one player of a whole co-op game. [`arcadekit/net/worker`](worker/README.md), the signalling server for Cloudflare, has a page of its own.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free. Each entry's modules are namespaces, as Effect's are (`import { LockstepSession, MemoryNetwork } from "arcadekit/net"`), and `Coop` is a builder a game writes bare. [Lockstep](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/lockstep.md) says how a run stays the same on every peer.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Its modules

| Entry | Namespace | What it holds | Guide |
| --- | --- | --- | --- |
| `arcadekit/net` | [`LockstepSession`](lockstep-session.ts) | A session a program ticks: `host`, `join`, `send` and `subscribe` | [Lockstep sessions](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/lockstep-sessions.md) |
| `arcadekit/net` | [`ScopedLockstepSession`](scoped-lockstep-session.ts) | The same session in an Effect program, owned by a scope and run on Effect's `Clock` | [Lockstep sessions](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/lockstep-sessions.md#in-an-effect-program) |
| `arcadekit/net` | [`Ticker`](ticker.ts) | What ticks a scoped session: a timer, a worker's timer or animation frames | [Lockstep sessions](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/lockstep-sessions.md#in-an-effect-program) |
| `arcadekit/net` | [`Transport`](transport.ts) | How a session's messages travel between the peers of one run | [Lockstep](https://github.com/lucasthevenet/arcadekit/blob/main/docs/concepts/lockstep.md) |
| `arcadekit/net` | [`MemoryNetwork`](memory-network.ts) | The peers of one process on a simulated network, with seeded latency, jitter and loss, for tests | [Lockstep sessions](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/lockstep-sessions.md) |
| `arcadekit/net/browser` | `Coop` | A game's engine declared for several players: the class is the key of its Co-op client | [A Co-op game](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/coop.md) |
| `arcadekit/net/browser` | [`CoopClient`](browser/coop-client.ts), [`CoopEvent`](browser/coop-event.ts) | One player's side of a co-op game, as an app drives it, and what its seat reports | [A Co-op game](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/coop.md) |
| `arcadekit/net/browser` | [`CoopRooms`](browser/coop-rooms.ts), [`CoopTicker`](browser/coop-ticker.ts) | How a Co-op client opens its rooms, and what ticks its run | [A Co-op game](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/coop.md) |
| `arcadekit/net/browser` | [`SignallingRoom`](browser/signalling-room.ts) | A room on a signalling server, which turns a join code into peer links | [Peers over WebRTC](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/webrtc.md) |
| `arcadekit/net/browser` | [`PeerLink`](browser/peer-link.ts), [`PeerConnector`](browser/peer-connector.ts), [`RtcPeerConnector`](browser/rtc-peer-connector.ts) | One WebRTC connection between two peers, and what makes it | [Peers over WebRTC](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/webrtc.md) |
| `arcadekit/net/browser` | [`RtcTransport`](browser/rtc-transport.ts) | A session's transport over a room's peer links | [Peers over WebRTC](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/webrtc.md) |
| `arcadekit/net/testing` | [`FakeCoopRooms`](testing/fake-coop-rooms.ts), [`ManualTicker`](testing/manual-ticker.ts), [`PageTimers`](testing/page-timers.ts), [`TestGame`](testing/test-game.ts) | Rooms in memory, a ticker a test drives, an Effect on faked timers, and a game for a `Coop`'s tests | [Testing a Co-op game](https://github.com/lucasthevenet/arcadekit/blob/main/docs/testing/coop.md) |
| `arcadekit/net/signalling` | [`ClientMessage`](signalling/client-message.ts), [`ServerMessage`](signalling/server-message.ts), [`Signal`](signalling/signal.ts), [`JoinCode`](signalling/join-code.ts), [`PeerId`](signalling/peer-id.ts), [`Room`](signalling/room.ts) | The protocol a signalling server speaks, each message an Effect Schema with bounded fields | [The protocol](worker/README.md#the-protocol) |

## Example

Two peers on the in-memory network play one run, ticked by hand. Each player's input is a number, and the simulation adds them all:

```ts
import * as Game from "arcadekit/game";
import { LockstepSession, MemoryNetwork } from "arcadekit/net";
import { Schema } from "effect";

class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Number),
  create: () => ({ total: 0 }),
  step: (state, input) => {
    for (const add of input.players) {
      state.total += add ?? 0;
    }
  },
}) {}

const network = MemoryNetwork.make({ seed: 1, latencyMs: 30 });
const shared = {
  simulation: Sum,
  config: null,
  contentHash: "content-v1",
  hash: (state: Game.StateOf<typeof Sum>) => state.total,
  inputDelay: 3,
  hashEvery: 30,
};
const host = LockstepSession.host(
  {
    ...shared,
    transport: MemoryNetwork.connect(network, "host"),
    local: { read: () => 1 },
    peers: ["guest"],
    seed: 7,
  },
  0
);
const guest = LockstepSession.join(
  {
    ...shared,
    transport: MemoryNetwork.connect(network, "guest"),
    local: { read: () => 2 },
    host: "host",
    players: ["host", "guest"],
  },
  0
);

for (let now = 0; now < 10_000; now += 4) {
  MemoryNetwork.advance(network, now);
  host.tick(now);
  guest.tick(now);
}
console.log(host.state?.total === 3 * host.stepIndex); // true
```
