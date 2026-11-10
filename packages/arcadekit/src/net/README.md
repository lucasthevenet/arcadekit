# arcadekit/net

Lockstep multiplayer for 2 to 4 players. `hostLockstep` and `joinLockstep` run one `GameSimulation` on every peer: each step runs once the host has confirmed every player's input for it, peers compare state hashes, and the host removes a player who stalls the run. In an Effect program, `hostLockstepScoped` and `joinLockstepScoped` make the same session, owned by a scope and run on Effect's `Clock` until it fails with its `LockstepError`. A session talks through a `Transport`: `createMemoryNetwork` is the in-memory one for tests, with seeded latency, jitter and loss. `arcadekit/net/browser` has the WebRTC one (`hostRoom` / `joinRoom`, the scoped signalling client that turns a join code into peer links, and `linksTransport`), and `arcadekit/net/signalling` the protocol a signalling server speaks, each message an Effect Schema with bounded fields. [`arcadekit/net/worker`](worker/README.md) is that server for Cloudflare, with a README of its own.

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect
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
} from "arcadekit/net";
import type { ConfirmedStep } from "arcadekit/net";
import type { GameSimulation } from "arcadekit/runtime";

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

## In an Effect program

`hostLockstepScoped(options)` and `joinLockstepScoped(options)` take the same options and return `Effect<ScopedLockstepSession, never, Scope>`. Closing the scope stops the session listening to its transport, and so does starting when it throws (the Effect dies with what was thrown). The session's time is Effect's `Clock` (its monotonic time; a `TestClock` in tests): the start and every tick read it.

`session.run(ticker?)` ticks the session until it stops, then fails with its `LockstepError`; interrupting it stops the ticking. After a desync it fails a second after the stop, which `status` and `error` show at once: until then its ticks resend the desync, which the transport may lose, so that every peer stops with it. Run it in the session's scope: a run still going once that closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock, for tests and servers. A `Ticker` is `(onTick) => stop`: a timer, a dedicated worker's timer (a hidden tab throttles the main thread's to about once a second, which stalls the others), animation frames, or all of those. `onTick` ticks the session before it returns, so the ticker can read the session right after, or tick before drawing, and no Effect runs per tick: the run ends once the `onTick` it stops in has returned, so the rest of that tick runs before the program's handlers and finalizers. `session.listen(onEvent)` hears the run's events and samples until its scope closes, each call on its own, even with the same `onEvent`. Its `status`, `error`, `waitingFor`, `players`, `state` and `stepIndex` are plain reads, as on the plain session.

The example's two peers again, as one Effect program:

```ts
import {
  createMemoryNetwork,
  hostLockstepScoped,
  joinLockstepScoped,
  jsonCodec,
} from "arcadekit/net";
import type { ConfirmedStep, Ticker } from "arcadekit/net";
import type { GameSimulation } from "arcadekit/runtime";
import { Effect } from "effect";

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

// A main-thread timer; in the browser, time it in a dedicated worker. The in-memory network
// delivers what is due when advanced; a WebRTC transport needs nothing of the kind.
const every4ms: Ticker = (onTick) => {
  const timer = setInterval(() => {
    network.advance(performance.now());
    onTick();
  }, 4);
  return () => clearInterval(timer);
};

const play = Effect.gen(function* () {
  const host = yield* hostLockstepScoped({
    ...shared,
    transport: network.connect("host"),
    local: { read: () => 1 },
    peers: ["guest"],
    seed: 7,
  });
  const guest = yield* joinLockstepScoped({
    ...shared,
    transport: network.connect("guest"),
    local: { read: () => 2 },
    host: "host",
  });
  // Neither run succeeds: each ticks until its session stops.
  yield* Effect.all([host.run(every4ms), guest.run(every4ms)], {
    concurrency: "unbounded",
  });
}).pipe(
  Effect.catchTag("LockstepError", (error) => Effect.logError(error.message)),
  Effect.scoped
);

Effect.runFork(play);
```

The plain session is the protocol, and the scoped one a shell around it. Test the protocol on plain sessions ticked by hand, as in the example above, and an Effect program's sessions on a `TestClock`.

## Input codecs

A session sends each player's input through its `InputCodec`: `encode` turns it into JSON data, and `decode` checks it on the way in and returns a `Result` (from `effect`), never throwing. `jsonCodec` checks nothing; `schemaCodec(schema)` decodes with an Effect Schema and fails with the schema's message. The host decodes each peer's input as it arrives and removes a peer whose input fails (its session stops with a `removed` error whose `why` is `badInput`); a peer that can't decode a step from the host stops with a `badInput` error. A message that isn't one the protocol knows is dropped. A run holds at most 16 players.

## In the browser

`hostRoom` and `joinRoom` connect peers by join code through a signalling server, and `linksTransport` carries the session over the WebRTC links they open. Each is a scoped Effect that succeeds once the server welcomes the peer, with its join `code` and its own id (`self`). Its scope owns the socket until the start and every peer link after it, so closing the scope is leaving, and a room that fails has already closed what it opened.

- `room.events` is a `Stream` of who joins, links and leaves. It ends with `started`. A room that fails before the start fails the stream, or the acquire, with a `RoomError` whose `reason` says why: `no-welcome` when the server doesn't answer in time, `bad-server-message` when it speaks another version of the protocol, and so on. Events wait until they are read, and leaving interrupts a reader that is still reading.
- `room.start` asks the server to start the run (host only). At the start, `linksTransport(room.self, room.links())` is the session's `Transport`.
- A `PeerLink` has two channels: `lockstep`, unordered and unreliable, for the session, and `messages`, reliable and ordered, for what the app says around a run. Its `closed` succeeds once either channel closes, the connection fails or the link's scope closes.
- `browserRoomLayer(rtc)` provides what a room needs: WebRTC links (`PeerConnector`, from `rtcPeerConnector`) and the global WebSocket (`Socket.WebSocketConstructor` from `effect/socket`). Tests provide fakes of both.

```ts
import { hostLockstepScoped, jsonCodec } from "arcadekit/net";
import type { ConfirmedStep, Ticker } from "arcadekit/net";
import {
  browserRoomLayer,
  hostRoom,
  linksTransport,
} from "arcadekit/net/browser";
import type { GameSimulation } from "arcadekit/runtime";
import { Effect, Stream } from "effect";

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

// Time it in a dedicated worker in a real game: a hidden tab throttles the main thread's timers.
const every4ms: Ticker = (onTick) => {
  const timer = setInterval(onTick, 4);
  return () => clearInterval(timer);
};

const host = Effect.gen(function* () {
  // Succeeds once the signalling server welcomes this peer. The scope owns the room and its links.
  const room = yield* hostRoom({ url: "wss://game.example.com" });
  console.log(`Join code: ${room.code}`);
  // Start once a guest's link is open. The events end with `started`.
  yield* Stream.runForEach(room.events, (event) =>
    event.type === "peer-connected" ? room.start : Effect.void
  );
  const session = yield* hostLockstepScoped({
    simulation,
    config: null,
    contentHash: "content-v1",
    codec: jsonCodec<number>(),
    combine: (step: ConfirmedStep<number>) =>
      step.inputs.reduce((sum, { input }) => sum + input, 0),
    hash: (state: State) => state.total,
    inputDelay: 3,
    hashEvery: 30,
    transport: linksTransport(room.self, room.links()),
    local: { read: () => 1 },
    peers: room.links().map((link) => link.peer),
    seed: 7,
  });
  yield* session.run(every4ms);
}).pipe(
  Effect.catchTag("RoomError", (error) => Effect.logError(error.message)),
  Effect.catchTag("LockstepError", (error) => Effect.logError(error.message)),
  Effect.scoped,
  Effect.provide(browserRoomLayer())
);

Effect.runFork(host);
```

See [ADR-0012](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0012-delay-based-lockstep-over-a-host-star.md) (delay-based lockstep over a host star) and [ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md) (a step uses only exact math, so every browser computes the same run).
