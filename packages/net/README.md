# @arcadekit/net

Lockstep multiplayer for 2 to 4 players. `hostLockstep` and `joinLockstep` run one `GameSimulation` on every peer: each step runs once the host has confirmed every player's input for it, peers compare state hashes, and the host removes a player who stalls the run. A session talks through a `Transport`: `createMemoryNetwork` is the in-memory one for tests, with seeded latency, jitter and loss. `@arcadekit/net/browser` has the WebRTC one (`hostRoom` / `joinRoom`, the signalling client that turns a join code into peer links, and `linksTransport`), and `@arcadekit/net/signalling` the protocol a signalling server speaks, each message an Effect Schema with bounded fields.

Part of [arcadekit](https://github.com/lucasthevenet/arcadekit#readme). The root entry is DOM-free.

## Install

```bash
pnpm add @arcadekit/net @arcadekit/runtime effect
```

Peer dependency: `effect` (~4.1).

## Example

Two peers on the in-memory network play one run. Each player's input is a number, and the simulation adds them all:

```ts
import {
  createMemoryNetwork,
  hostLockstep,
  joinLockstep,
  jsonCodec,
} from "@arcadekit/net";
import type { ConfirmedStep } from "@arcadekit/net";
import type { GameSimulation } from "@arcadekit/runtime";

interface State {
  total: number;
}

const simulation: GameSimulation<null, State, number, never> = {
  create: () => ({ total: 0 }),
  step: (state, input) => {
    state.total += input;
  },
  drainEvents: () => [],
};

const network = createMemoryNetwork({ seed: 1, latencyMs: 30, jitterMs: 10 });
const shared = {
  simulation,
  config: null,
  contentHash: "content-v1",
  codec: jsonCodec<number>(),
  combine: (step: ConfirmedStep<number>) =>
    step.inputs.reduce((sum, { input }) => sum + input, 0),
  hash: (state: State) => state.total,
  inputDelay: 3,
  hashEvery: 30,
};

const host = hostLockstep(
  {
    ...shared,
    transport: network.connect("host"),
    local: { read: () => 1 },
    peers: ["guest"],
    seed: 7,
  },
  0
);
const guest = joinLockstep(
  {
    ...shared,
    transport: network.connect("guest"),
    local: { read: () => 2 },
    host: "host",
  },
  0
);

// Tick both sessions from a timer; here, 10 simulated seconds.
for (let now = 0; now < 10_000; now += 4) {
  network.advance(now);
  host.tick(now);
  guest.tick(now);
}
// Every step got both players' input: 1 + 2.
console.log(host.state?.total === 3 * host.stepIndex); // true
```

## Input codecs

A session sends each player's input through its `InputCodec`: `encode` turns it into JSON data, and `decode` checks it on the way in and returns a `Result` (from `effect`), never throwing. `jsonCodec` checks nothing; `schemaCodec(schema)` decodes with an Effect Schema and fails with the schema's message. The host decodes each peer's input as it arrives and removes a peer whose input fails (its session stops with a `removed` error whose `why` is `badInput`); a peer that can't decode a step from the host stops with a `badInput` error. A message that isn't one the protocol knows is dropped. A run holds at most 16 players.

In the browser, `hostRoom` and `joinRoom` connect peers by join code through a signalling server, and `linksTransport` carries the session over the WebRTC links they open. See [ADR-0012](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0012-delay-based-lockstep-over-a-host-star.md) (delay-based lockstep over a host star) and [ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md) (a step uses only exact math, so every browser computes the same run).
