# arcadekit/net

Lockstep multiplayer for 2 to 4 players. `hostLockstep` and `joinLockstep` run one `Game.Simulation` on every peer: each step runs once the host has confirmed every player's input for it, peers compare state hashes, and the host removes a player who stalls the run. A session is a host of the declared simulation, as `Game.Engine` is: it steps it through a `Game.Loop`, and takes from its `Game.PlayerInputs` step input ([`arcadekit/game`](../game/README.md#several-players)) what one player sends and how the players' inputs make a step's. In an Effect program, `hostLockstepScoped` and `joinLockstepScoped` make the same session, owned by a scope and run on Effect's `Clock` until it fails with its `LockstepError`. A session talks through a `Transport`: `createMemoryNetwork` is the in-memory one for tests, with seeded latency, jitter and loss. `arcadekit/net/browser` has the WebRTC one (`hostRoom` / `joinRoom`, the scoped signalling client that turns a join code into peer links, and `linksTransport`), and `arcadekit/net/signalling` the protocol a signalling server speaks, each message an Effect Schema with bounded fields. [`arcadekit/net/worker`](worker/README.md) is that server for Cloudflare, with a README of its own. For a whole co-op game, `makeCoopClient` in `arcadekit/net/browser` runs all of this for one player from the game's `CoopRules`, and `arcadekit/net/testing` has its test helpers: see [Co-op](#co-op).

An entry of the [`arcadekit`](../../README.md) package. The root entry is DOM-free.

## Install

```bash
pnpm add arcadekit effect
```

Peer dependency: `effect` (~4.1).

## Example

Two peers on the in-memory network play one run. Each player's input is a number, and the simulation adds them all:

```ts
import * as Game from "arcadekit/game";
import { createMemoryNetwork, hostLockstep, joinLockstep } from "arcadekit/net";
import { Schema } from "effect";

// The step input is every player's number, by slot: a session sends each player's own.
class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Number),
  create: () => ({ total: 0 }),
  step: (state, input) => {
    for (const add of input.players) {
      state.total += add ?? 0;
    }
  },
}) {}

const network = createMemoryNetwork({ seed: 1, latencyMs: 30, jitterMs: 10 });
const shared = {
  simulation: Sum,
  config: null,
  contentHash: "content-v1",
  hash: (state: Game.StateOf<typeof Sum>) => state.total,
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
    // The run's player order, host first: the host, then its `peers`.
    players: ["host", "guest"],
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

## The players' inputs

The simulation declares its step input with `Game.PlayerInputs(OnePlayersInput)`, and the session does the rest: no game passes a codec or a way to combine inputs.

- **What crosses the network** is one player's input, as the one-player Schema encodes it: JSON data. Every peer, the host included, steps on what that Schema decodes, so a step sees the same input everywhere even where JSON loses detail (-0 becomes 0).
- **A step's input** is made from the step the host confirmed: each player's input goes to `players[slot]`, and each player removed at that step is in `leaving`, in ascending order. The player order is the run's, host first, as the lobby agreed it: the host, then the `peers` the host passes, which is the list a guest passes as `players`. A player's slot is its index there for the whole run, whoever leaves. It is not `session.players`, which lists who is still in the run: the host's start message says only that, so a guest that first hears it after a player was removed still needs the whole order. So the run's config lists what each player plays in the same order. One object is refilled each step, so combining allocates nothing.
- **An input that doesn't decode** is handled where it arrives, never in a step. The host removes a peer whose input fails (its session stops with a `removed` error whose `why` is `badInput`), and a peer that can't decode a step from the host stops with a `badInput` error. So does a host whose own input doesn't survive the wire, such as a NaN, which JSON carries as null. A message that isn't one the protocol knows is dropped. A run holds at most 16 players.
- **A simulation whose step input is not a `Game.PlayerInputs`** has nothing to send for one player. `hostLockstep` and `joinLockstep` refuse it, a struct with `players` and `leaving` written by hand included: they throw, with nothing left listening. Before that it is a type error on `simulation` that names `Game.PlayerInputs`, when the call infers its types from the simulation. Options typed ahead with the step input's type named get the throw alone, and so does `CoopRules`, where `makeCoopClient` throws.

## In an Effect program

`hostLockstepScoped(options)` and `joinLockstepScoped(options)` take the same options and return `Effect<ScopedLockstepSession, never, Scope>`. Closing the scope stops the session listening to its transport, and so does starting when it throws (the Effect dies with what was thrown). The session's time is Effect's `Clock` (its monotonic time; a `TestClock` in tests): the start and every tick read it.

`session.run(ticker?)` ticks the session until it stops, then fails with its `LockstepError`; interrupting it stops the ticking. After a desync it fails a second after the stop, which `status` and `error` show at once: until then its ticks resend the desync, which the transport may lose, so that every peer stops with it. Run it in the session's scope: a run still going once that closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock, for tests and servers. A `Ticker` is `(onTick) => stop`: a timer, a dedicated worker's timer (a hidden tab throttles the main thread's to about once a second, which stalls the others), animation frames, or all of those. `onTick` ticks the session before it returns, so the ticker can read the session right after, or tick before drawing, and no Effect runs per tick: the run ends once the `onTick` it stops in has returned, so the rest of that tick runs before the program's handlers and finalizers. `session.listen(onEvent)` hears the run's events and samples until its scope closes, each call on its own, even with the same `onEvent`. Its `status`, `error`, `waitingFor`, `players`, `state` and `stepIndex` are plain reads, as on the plain session.

The example's two peers again, as one Effect program:

```ts
import * as Game from "arcadekit/game";
import {
  createMemoryNetwork,
  hostLockstepScoped,
  joinLockstepScoped,
} from "arcadekit/net";
import type { Ticker } from "arcadekit/net";
import { Effect, Schema } from "effect";

class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Number),
  create: () => ({ total: 0 }),
  step: (state, input) => {
    for (const add of input.players) {
      state.total += add ?? 0;
    }
  },
}) {}

const network = createMemoryNetwork({ seed: 1, latencyMs: 30, jitterMs: 10 });
const shared = {
  simulation: Sum,
  config: null,
  contentHash: "content-v1",
  hash: (state: Game.StateOf<typeof Sum>) => state.total,
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
    players: ["host", "guest"],
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

## In the browser

`hostRoom` and `joinRoom` connect peers by join code through a signalling server, and `linksTransport` carries the session over the WebRTC links they open. Each is a scoped Effect that succeeds once the server welcomes the peer, with its join `code` and its own id (`self`). Its scope owns the socket until the start and every peer link after it, so closing the scope is leaving, and a room that fails has already closed what it opened.

- `room.events` is a `Stream` of who joins, links and leaves. It ends with `started`. A room that fails before the start fails the stream, or the acquire, with a `RoomError` whose `reason` says why: `no-welcome` when the server doesn't answer in time, `bad-server-message` when it speaks another version of the protocol, and so on. Events wait until they are read, and leaving interrupts a reader that is still reading.
- `room.start` asks the server to start the run (host only). At the start, `linksTransport(room.self, room.links())` is the session's `Transport`.
- A `PeerLink` has two channels: `lockstep`, unordered and unreliable, for the session, and `messages`, reliable and ordered, for what the app says around a run. Its `closed` succeeds once either channel closes, the connection fails or the link's scope closes.
- `browserRoomLayer(rtc)` provides what a room needs: WebRTC links (`PeerConnector`, from `rtcPeerConnector`) and the global WebSocket (`Socket.WebSocketConstructor` from `effect/socket`). Tests provide fakes of both.

```ts
import * as Game from "arcadekit/game";
import { hostLockstepScoped } from "arcadekit/net";
import type { Ticker } from "arcadekit/net";
import {
  browserRoomLayer,
  hostRoom,
  linksTransport,
} from "arcadekit/net/browser";
import { Effect, Schema, Stream } from "effect";

class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Number),
  create: () => ({ total: 0 }),
  step: (state, input) => {
    for (const add of input.players) {
      state.total += add ?? 0;
    }
  },
}) {}

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
    simulation: Sum,
    config: null,
    contentHash: "content-v1",
    hash: (state) => state.total,
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

## Co-op

A **Co-op game** is a game plus its lockstep parts, and the **Co-op client** runs one for one player: the lobby over the signalling worker and WebRTC, then a lockstep run stepped on a worker's timer (so a hidden tab keeps up), drawn on animation frames while attached. The game supplies its genre half; the lobby screens stay in the app.

- `CoopRules<G>` (`arcadekit/net`) is the DOM-free half, kept beside the simulation and tested in Node. `G` is a `CoopTypes` bag the game declares once: `Config`, `State`, `Event`, `PlayerInput`, `Answer`, `LocalEvent` and `Content`. Its `simulation` is the game's declared `Game.Simulation` class, whose step input is a `Game.PlayerInputs` of `PlayerInput`: the client's lockstep run steps it as an engine would, sends each player's own input and combines them by slot. A player's decision does not reach it as a `Game.Command` yet: an answer and a pause ride the step input.
- `CoopGame<G, LoadError>` (`arcadekit/net/browser`) adds `content`, an Effect run once per seat, and `presentation`, an Effect run once per attach that gives `createInput` and `createView`. The view gets a live `LocalPlayer`, and reads `local.slot` when it renders: the client never makes a view again.
- `makeCoopClient(game, { rooms })` is a scoped Effect. `browserCoopRooms({ url, iceServers })` opens its rooms; the kit reads no environment, so the app passes the worker's URL and its STUN servers.

The client's commands return at once, except `leave`, which returns once the seat has closed. One stream of events says what happened:

- `host(pick)`, `join(code, pick)` and `leave` choose the seat. A new seat says nothing until every seat before it has closed. A **lobby pick** is a string id the game lists in `picks(content)`, such as a hero. `choose(pick)` changes it, and `start` starts the run if the `lobby` event's `canStart` is true: at least two players, at most the game's `maxPlayers`, each with a pick. At the start the host replaces a pick its game doesn't have with the first, and leaves out a guest that linked too late to fit in `maxPlayers` (it fails with `leftOut`). A guest whose game doesn't have one of the picks fails with `unknownPick`, and one whose game takes fewer players fails with `tooManyPlayers`.
- `answer(answer)` is the one thing a player tells the run besides its device's input: it goes with every step's input until the game's `settled` says it can no longer apply. `setPaused` holds the pause the same way.
- `listen` reports a seat in order: `lobby` events, one `started`, then `run` events (what the game's `localEvent` makes of the run's) and `waiting` events (who stepping waits on, and who else owes an answer), then at most one `failed`, which is its last. `failed` has the kit's `message` and a `reason` tag an app can re-word.
- `attach(element)` draws and reads input until interrupted, as an engine's does, and `attach` and `listen` have `arcadekit/foldkit`'s `AttachableEngine` shapes. A failed attach leaves the seat; a detach doesn't.

```ts
import * as Game from "arcadekit/game";
import type { CoopRules, CoopTypes } from "arcadekit/net";
import { browserCoopRooms, makeCoopClient } from "arcadekit/net/browser";
import type { CoopGame } from "arcadekit/net/browser";
import { Effect, Schema } from "effect";

interface Palette {
  readonly colours: readonly string[];
}

interface Tally {
  readonly colours: readonly string[];
  total: number;
}

// The rules: every player adds a number each step.
class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Number),
  create: ({ colours }: Palette): Tally => ({ colours, total: 0 }),
  step: (state, input) => {
    for (const add of input.players) {
      state.total += add ?? 0;
    }
  },
}) {}

// No answers, and no events.
interface SumCoop extends CoopTypes {
  readonly Config: Palette;
  readonly State: Tally;
  readonly Event: never;
  readonly PlayerInput: number;
  readonly Answer: never;
  readonly LocalEvent: never;
  readonly Content: Palette;
}

// The DOM-free half: beside the simulation, tested in Node.
const sumRules: CoopRules<SumCoop> = {
  simulation: Sum,
  hash: (state) => state.total,
  picks: (content) => content.colours,
  config: (_content, picks) => ({ colours: picks }),
  localInput: () => (device) => device ?? 0,
  settled: () => true,
  choosing: () => false,
  localEvent: () => null,
  runEnded: () => false,
};

// The browser half: the content to load, and how to read input and draw.
const sumGame: CoopGame<SumCoop> = {
  ...sumRules,
  content: Effect.succeed({ colours: ["red", "blue"] }),
  presentation: Effect.sync(() => ({
    createInput: () => ({ read: () => 1, dispose: () => {} }),
    createView: (container, local) => ({
      render: (state) => {
        container.textContent =
          state === null
            ? "No run"
            : `${state.colours[local.slot]}: ${state.total}`;
      },
      dispose: () => {},
    }),
  })),
};

const play = Effect.gen(function* () {
  const coop = yield* makeCoopClient(sumGame, {
    rooms: browserCoopRooms({
      url: "wss://signalling.example.com",
      iceServers: [{ urls: "stun:stun.example.com:3478" }],
    }),
  });
  yield* coop.listen((event) => {
    if (event.type === "lobby") {
      console.log(event.code, event.players, event.canStart);
    } else if (event.type === "failed") {
      console.error(event.reason, event.message);
    }
  });
  yield* coop.host("red");
  // The app calls `coop.start` once the lobby's `canStart` is true.
  return yield* coop.attach(document.body);
}).pipe(Effect.scoped);

Effect.runFork(play);
```

### Testing a Co-op game

`arcadekit/net/testing` runs a Co-op client in Node, with no browser: `fakeCoopRooms()` is a signalling worker and WebRTC in memory (with `drop(peer)` and `closeHost()` to cut links), `manualTicker()` a ticker the test drives, and `testCoopGame()` a small game with lobby picks, an offer to answer, a pause and an end, whose rules are the declared `TestGame`. Frames come from `manualFrames()` in `arcadekit/runtime/testing`.

```ts
import { makeCoopClient } from "arcadekit/net/browser";
import {
  fakeCoopRooms,
  manualTicker,
  testCoopGame,
} from "arcadekit/net/testing";
import { Effect } from "effect";

const hub = fakeCoopRooms();
const timer = manualTicker();

// The scope owns both clients, and closing it leaves: the whole test runs inside it.
const twoPlayers = Effect.gen(function* () {
  const options = { rooms: hub.rooms, ticker: timer.ticker };
  const host = yield* makeCoopClient(testCoopGame(), options);
  const guest = yield* makeCoopClient(testCoopGame(), options);
  yield* host.listen((event) => console.log("host", event.type));
  // `host` and `join` return at once: give each a moment to do its work.
  yield* host.host("red");
  yield* Effect.sleep("10 millis");
  yield* guest.join(hub.code, "green");
  yield* Effect.sleep("10 millis");
  yield* host.start;
  // A tick runs the steps the Clock says are due, so let time pass between ticks.
  for (let tick = 0; tick < 50; tick++) {
    yield* Effect.sleep("4 millis");
    timer.tick();
  }
  // About 12 steps in those 200 ms, and both players' lobby picks: [ 'red', 'green' ].
  console.log(host.debug().stepIndex, guest.debug().state?.picks);
}).pipe(Effect.scoped);

Effect.runFork(twoPlayers);
```

A test on fake timers also gives the clients a `Clock` that reads the faked time and a Scheduler that runs fibers on microtasks, as the kit's own client tests do ([co-op-findings.md](https://github.com/lucasthevenet/arcadekit/blob/main/docs/co-op-findings.md), finding 2).

See [ADR-0012](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0012-delay-based-lockstep-over-a-host-star.md) (delay-based lockstep over a host star), [ADR-0019](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md) (the kit owns co-op from the signalling worker to the client; the screens stay in the app) and [ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md) (a step uses only exact math, so every browser computes the same run).
