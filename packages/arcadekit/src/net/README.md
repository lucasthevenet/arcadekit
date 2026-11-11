# arcadekit/net

Lockstep multiplayer for 2 to 4 players. `hostLockstep` and `joinLockstep` run one `Game.Simulation` on every peer: each step runs once the host has confirmed every player's input for it, peers compare state hashes, and the host removes a player who stalls the run. A session is a host of the declared simulation, as `Game.Engine` is: it steps it through a `Game.Loop`, takes from its `Game.PlayerInputs` step input ([`arcadekit/game`](../game/README.md#several-players)) what one player sends and how the players' inputs make a step's, and carries a player's [commands](#commands) to every peer's rules at one step. In an Effect program, `hostLockstepScoped` and `joinLockstepScoped` make the same session, owned by a scope and run on Effect's `Clock` until it fails with its `LockstepError`. A session talks through a `Transport`: `createMemoryNetwork` is the in-memory one for tests, with seeded latency, jitter and loss. `arcadekit/net/browser` has the WebRTC one (`hostRoom` / `joinRoom`, the scoped signalling client that turns a join code into peer links, and `linksTransport`), and `arcadekit/net/signalling` the protocol a signalling server speaks, each message an Effect Schema with bounded fields. [`arcadekit/net/worker`](worker/README.md) is that server for Cloudflare, with a README of its own. For a whole co-op game, a `Coop` declaration in `arcadekit/net/browser` runs all of this for one player from the game's engine, and `arcadekit/net/testing` has its test helpers: see [Co-op](#co-op).

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

- **What crosses the network** for one player's step is its payload: a JSON list of the player's input, as the one-player Schema encodes it, then the commands it sent for that step, if any. `[{"moveX":0,"moveZ":1}]` is a step with no command, which is nearly every step. Every peer, the host included, steps on what the payload decodes to, so a step sees the same input everywhere even where JSON loses detail (-0 becomes 0).
- **A player with nothing to read** has null for its input: a `local` source may return null for a step, as the Co-op client's does while nothing is attached. Its payload is `[null]`, and every peer's rules see null at that player's slot.
- **A step's input** is made from the step the host confirmed: each player's input goes to `players[slot]`, and each player removed at that step is in `leaving`, in ascending order. The player order is the run's, host first, as the lobby agreed it: the host, then the `peers` the host passes, which is the list a guest passes as `players`. A player's slot is its index there for the whole run, whoever leaves. It is not `session.players`, which lists who is still in the run: the host's start message says only that, so a guest that first hears it after a player was removed still needs the whole order. So the run's config lists what each player plays in the same order. One object is refilled each step, so combining allocates nothing.
- **A payload that doesn't decode** is handled where it arrives, never in a step: an input that is no input, a command the simulation doesn't declare, more commands than a step carries, or anything that is not a list. The host removes a peer whose payload fails (its session stops with a `removed` error whose `why` is `badInput`), and a peer that can't decode a step from the host stops with a `badInput` error. So does a host whose own input doesn't survive the wire, such as a NaN, which JSON carries as null. A message that isn't one the protocol knows is dropped. A run holds at most 16 players.
- **A simulation whose step input is not a `Game.PlayerInputs`** has nothing to send for one player. `hostLockstep` and `joinLockstep` refuse it, a struct with `players` and `leaving` written by hand included: they throw, with nothing left listening. Before that it is a type error on `simulation` that names `Game.PlayerInputs`, when the call infers its types from the simulation. Options typed ahead with the step input's type named get the throw alone. A [`Coop`](#co-op) refuses such an engine the same two ways, when it is declared.

## Commands

What a player decides outside what its devices hold, such as an upgrade to pick or a pause to hold, is a `Game.Command` of the simulation, as it is for one player. `session.send(command, settled?)` is `Game.Loop`'s `send` without the slot, since a session knows whose it is.

- **It rides one step.** The command goes with its sender's payload for the next step the session schedules, `inputDelay` ahead as its input is. The host confirms that step once, with the command in it, so every peer applies the command once, at the start of that step: the commands of the players before the sender in player order first, and each player's in the order sent. No peer picks the step from its own clock, and a resent message brings no second copy.
- **Every peer's rules answer alike.** Each peer's `apply` handler takes the command or refuses it with one of the rejections it declares, from the same state. Only the sender's peer has a sender to tell: `settled` is called there, once the session is out of the tick that ran the step, with `undefined`, the rejection, or a `CommandDropped`.
- **Every send ends.** A send whose session stops, is disposed or throws out of a tick before this peer's rules answer is told `CommandDropped` with `runEnded`, and so is one sent after. A command sent while a guest's session is still `joining` waits, and rides the run's first steps.
- **It can be taken back while it has no step.** `send` returns a function for that. Once the command rides a step, which takes about one step's time and longer while the run waits on a player, it is every peer's, and taking it back only keeps `settled` from being called.
- **At most four commands ride one player's step.** A fifth rides the next step, in the order sent. A peer that sends five in one is removed, as for any payload that doesn't decode.
- **A command must survive JSON.** `send` throws, where the mistake is, for a command no peer could decode: a NaN in a `Schema.Number` field, which JSON carries as null. It also throws for a command the simulation doesn't declare.
- **A removed player hears for its own peer only.** If the host confirmed the step of a player's command and then removed that player, the peers still in the run applied the command, and its sender is told `runEnded`: its own rules never ran the step.

```ts
import * as Game from "arcadekit/game";
import { createMemoryNetwork, hostLockstep, joinLockstep } from "arcadekit/net";
import { Schema } from "effect";

// The jar has room for `room` more coins: fewer than the deposit.
class JarFull extends Game.Rejection("JarFull", { room: Schema.Int }) {}

class Deposit extends Game.Command(
  "Deposit",
  { amount: Schema.Int },
  { rejects: [JarFull] }
) {}

// A jar of ten coins that either player may put coins in. A step itself does nothing.
class Jar extends Game.Simulation("Jar", {
  input: Game.PlayerInputs(Schema.Number),
  commands: [Deposit],
  create: () => ({ coins: 0 }),
  step: () => {},
  apply: {
    Deposit: (jar, { amount }) => {
      if (jar.coins + amount > 10) {
        return new JarFull({ room: 10 - jar.coins });
      }
      jar.coins += amount;
    },
  },
}) {}

const network = createMemoryNetwork({ seed: 1, latencyMs: 30, jitterMs: 10 });
const shared = {
  simulation: Jar,
  config: null,
  contentHash: "content-v1",
  local: { read: () => 0 },
  hash: (jar: Game.StateOf<typeof Jar>) => jar.coins,
  inputDelay: 3,
  hashEvery: 30,
};
const host = hostLockstep(
  { ...shared, transport: network.connect("host"), peers: ["guest"], seed: 7 },
  0
);
const guest = joinLockstep(
  {
    ...shared,
    transport: network.connect("guest"),
    host: "host",
    players: ["host", "guest"],
  },
  0
);

// Seven coins each, into a jar of ten. The guest's command rides the run's first step and the
// host's a later one, so every peer's rules take the guest's and refuse the host's.
host.send(new Deposit({ amount: 7 }), (outcome) => {
  if (outcome?._tag === "JarFull") {
    console.log(`host: refused, room for ${outcome.room} more`); // room for 3 more
  }
});
guest.send(new Deposit({ amount: 7 }), (outcome) => {
  console.log("guest:", outcome?._tag ?? "taken"); // taken
});

for (let now = 0; now < 1000; now += 4) {
  network.advance(now);
  host.tick(now);
  guest.tick(now);
}
console.log(host.state?.coins, guest.state?.coins); // 7 7
```

## In an Effect program

`hostLockstepScoped(options)` and `joinLockstepScoped(options)` take the same options and return `Effect<ScopedLockstepSession, never, Scope>`. Closing the scope stops the session listening to its transport, and so does starting when it throws (the Effect dies with what was thrown). The session's time is Effect's `Clock` (its monotonic time; a `TestClock` in tests): the start and every tick read it.

`session.run(ticker?)` ticks the session until it stops, then fails with its `LockstepError`; interrupting it stops the ticking. After a desync it fails a second after the stop, which `status` and `error` show at once: until then its ticks resend the desync, which the transport may lose, so that every peer stops with it. Run it in the session's scope: a run still going once that closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock, for tests and servers. A `Ticker` is `(onTick) => stop`: a timer, a dedicated worker's timer (a hidden tab throttles the main thread's to about once a second, which stalls the others), animation frames, or all of those. `onTick` ticks the session before it returns, so the ticker can read the session right after, or tick before drawing, and no Effect runs per tick: the run ends once the `onTick` it stops in has returned, so the rest of that tick runs before the program's handlers and finalizers. `session.listen(onEvent)` hears the run's events and samples until its scope closes, each call on its own, even with the same `onEvent`. `session.send(command)` is the plain session's `send` as an Effect, in the shape of an engine's: it succeeds when this peer's rules took the command, fails with the rejection they refused it with, and fails with `CommandDropped` when they gave no answer, which closing the session's scope makes sure of. It completes after the tick of the command's step, and interrupting it takes the command back while it has no step yet. Its `status`, `error`, `waitingFor`, `players`, `state` and `stepIndex` are plain reads, as on the plain session.

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

A game for several players, each in their own browser, is declared with **`Coop`** (`arcadekit/net/browser`): the game's [engine](../game/README.md#in-the-browser), played in lockstep from a lobby. The class is the key of the **Co-op client** an app drives, one player's side of it: the lobby over the signalling worker and WebRTC, then a lockstep run stepped on a worker's timer (so a hidden tab keeps up), drawn on animation frames while attached. The lobby's screens stay in the app.

```ts
import * as Game from "arcadekit/game/browser";
import { Coop, browserCoopRoomsLayer } from "arcadekit/net/browser";
import { Effect, Schema } from "effect";

interface Palette {
  readonly colours: readonly string[];
}

interface Tally {
  readonly colours: readonly string[];
  total: number;
}

// More than a player may add at once.
class TooMuch extends Game.Rejection("TooMuch", { most: Schema.Int }) {}

// What a player decides: to add `amount` at once.
class AddNow extends Game.Command(
  "AddNow",
  { amount: Schema.Int },
  { rejects: [TooMuch] }
) {}

// The player at slot `by` added `amount` at once.
class Added extends Game.Event("Added", {
  by: Schema.Int,
  amount: Schema.Int,
}) {}

// The total reached a hundred: the run is over.
class Filled extends Game.Event("Filled", { total: Schema.Int }) {}

// The rules: every player adds a number each step, and may add more with a command.
class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Int),
  events: [Added, Filled],
  commands: [AddNow],
  create: ({ colours }: Palette): Tally => ({ colours, total: 0 }),
  step: (state, input, { report }) => {
    if (state.total >= 100) {
      return;
    }
    for (const add of input.players) {
      state.total += add ?? 0;
    }
    if (state.total >= 100) {
      report(new Filled({ total: state.total }));
    }
  },
  apply: {
    AddNow: (state, { amount }, { player, report }) => {
      if (amount > 10) {
        return new TooMuch({ most: 10 });
      }
      state.total += amount;
      report(new Added({ by: player, amount }));
    },
  },
}) {}

// One player's input source, as a game writes it once: this one adds 1 each step.
const sumDevice = (): Game.InputSource<number> => ({
  read: () => 1,
  dispose: () => {},
});

// The game in the browser. Its view is told which seat is the local player's, and reads it when
// it draws: slot 0 under the engine, the slot the lobby gave under a Coop.
class SumEngine extends Game.Engine("SumEngine", {
  simulation: Sum,
  view: (container, _uses, { local }) => ({
    render: (state) => {
      container.textContent =
        state === null
          ? "No run"
          : `${state.colours[local.slot]}: ${state.total}`;
    },
    dispose: () => {},
  }),
  // The engine's input is the whole step's: for one player, that player's source at slot 0.
  input: () => {
    const device = sumDevice();
    return { ...Game.soloInput(device), dispose: device.dispose };
  },
}) {}

// The same game for several players.
class SumCoop extends Coop("SumCoop", {
  engine: SumEngine,
  // One player's input source, the same one: what it reads rides each step this player
  // schedules.
  input: sumDevice,
  content: Effect.succeed({ colours: ["red", "blue"] }),
  picks: (content) => content.colours,
  config: (_content, colours) => ({ colours }),
  hash: (state) => state.total,
  ends: [Filled],
}) {}

const play = Effect.gen(function* () {
  const coop = yield* SumCoop;
  // Everything a seat reports, by tag: the client's own events, and the run's under `run`,
  // each with the local player.
  yield* coop.listen(
    SumCoop.match({
      LobbyChanged: ({ code, players, canStart }) =>
        console.log(code, players, canStart),
      RunStarted: ({ slot, names }) => console.log(`You are ${names[slot]}`),
      WaitingChanged: ({ waitingFor }) =>
        console.log("Waiting for", waitingFor),
      SeatFailed: ({ reason, message }) => console.error(reason, message),
      run: {
        Added: ({ by, amount }, { local }) =>
          console.log(
            by === local.slot ? "You" : local.names[by],
            `added ${amount}`
          ),
        Filled: ({ total }) => console.log(`Done at ${total}`),
      },
    })
  );
  yield* coop.host("red");
  // The app calls `coop.start` once the lobby's `canStart` is true. In the run, a click adds
  // five at once: every peer's rules take the command at one step, and this player hears.
  const addNow = coop.send(new AddNow({ amount: 5 })).pipe(
    Effect.catchTag("TooMuch", ({ most }) => Effect.log(`At most ${most}`)),
    Effect.catchTag("CommandDropped", () => Effect.void)
  );
  document.body.addEventListener("click", () => Effect.runFork(addNow));
  return yield* coop.attach(document.body);
}).pipe(
  Effect.scoped,
  Effect.provide(SumCoop.layer),
  // The app's rooms: the signalling worker and its STUN servers.
  Effect.provide(
    browserCoopRoomsLayer(() => ({
      url: "wss://signalling.example.com",
      iceServers: [{ urls: "stun:stun.example.com:3478" }],
    }))
  )
);

Effect.runFork(play);
```

What the declaration holds, every type of it taken from the engine's simulation and from `content`:

- **`engine`** is the game: its simulation, what its view is made from (`uses`) and the view. Both hosts play it. The engine seats its one player at slot 0, and the Co-op client at the slot the lobby gave: the view's third argument is `{ local }`, read when it draws, so the client never makes a view again. The simulation's `input` is a [`Game.PlayerInputs`](../game/README.md#several-players).
- **`input`** makes one player's input source, where the engine's `input` reads the whole step's. The word is shared on purpose: they are one source, and the engine's is `Game.soloInput` of this one, which puts it at slot 0. It is made on each attach, after the view, with what the engine uses, so a view and an input can share what one attach made. With nothing attached, the player's input is null for each step, which the rules see at its slot.
- **`content`** loads what a run is played with, once per seat: a [`Content`](../content/README.md) declaration's `load`. Every peer loads its own, and the client compares their hashes, so it is JSON data. **`picks`** lists the valid lobby picks, string ids such as heroes, and **`config`** makes the run's config from the content and the players' picks, by slot.
- **`hash`** digests the whole state: peers compare it every `lockstep.hashEvery` steps (60), and a mismatch stops the run as a desync. **`maxPlayers`** is the most players a run takes (a room's 4 unless it says), and `lockstep.inputDelay` the steps ahead input is scheduled (4).
- **`ends`** lists the events that end a run, of those the simulation reports. After one, the others leaving is no failure: the seat stops quietly, with the run's end still on screen.

A `Coop` refuses what can't work when it is declared: an engine whose simulation's `input` was not declared with `Game.PlayerInputs` is a type error on `engine` that names it, and a throw as the module loads for what a cast gets past; so is an `ends` entry the simulation doesn't report (its sample included, which a run reports all the time), and a `maxPlayers` no room can have (a room holds 2 to 16).

`SumCoop.layer` provides the client. It needs what the engine uses, what `content` needs, and the app's rooms:

- **`CoopRooms`** is the service a lobby is opened through. `browserCoopRoomsLayer(() => ({ url, iceServers }))` provides the browser's, over the signalling worker and WebRTC; the kit reads no environment, so the app says the worker's URL and its STUN servers, in a function the layer calls when it is built. `fakeCoopRooms().layer` provides a test's.
- **`CoopTicker`** is what ticks a run: a reference, whose default is a timer in a dedicated worker, made and stopped with each run. A test provides `manualTicker().layer`.
- **`Game.Frames`** is the frame clock while attached, as for an engine.

The client's commands return at once, except `leave`, which returns once the seat has closed. One stream of events says what happened:

- `host(pick)`, `join(code, pick)` and `leave` choose the **seat**: this player's place in one room, from its host or join on. A new seat says nothing until every seat before it has closed. A **lobby pick** is a string id the game lists in `picks(content)`. `choose(pick)` changes it, and `start` starts the run if the lobby's `canStart` is true: at least two players, at most the game's `maxPlayers`, each with a pick. At the start the host replaces a pick its game doesn't have with the first, and leaves out a guest that linked too late to fit in `maxPlayers` (it fails with `leftOut`). A guest whose game doesn't have one of the picks fails with `unknownPick`, and one whose game takes fewer players fails with `tooManyPlayers`.
- `send(command)` is how a player tells the run anything besides its device's input: an upgrade pick, a pause it holds for everyone. It is an engine's `send` in shape and in type. The command [rides the player's next step](#commands), every peer's rules take or refuse it alike at that step, and the Effect succeeds when the local player's own took it, fails with the rejection they refused it with, and fails with `CommandDropped` when they gave no answer: there is no run yet (`noRun`), or the run stopped or the player left first (`runEnded`). The kit knows nothing of pausing: a game that has a pause declares a command for it, and its app keeps the screen.
- `listen` reports a seat in order: `LobbyChanged` events (who is in the lobby, and whether it can start), one `RunStarted` (the local player's slot, and every player's name), then the run's own events and `WaitingChanged` (who stepping waits on, once the run has stood at one step for 300 ms; a run that steps waits on nobody, however far behind another peer's it is), then at most one `SeatFailed`, which is its last: it has the kit's `message` and a `reason` tag an app can re-word. The four are Schema classes, so an app puts one in a Message or its Model as it is.
- **`SumCoop.match({ ... })`** turns all of it into one value, as a simulation's `match` does for an engine: a case for each of the client's events by its tag, and under `run` a case for each of the run's events and its sample, which gets `{ local }` beside the event: the local player of the seat that heard it, which stays that seat's if the event is kept. A run's events reach every seat as the rules reported them, so the app says which are the local player's: `hero === local.slot`. The run's cases have their own place, so a game may name an event as it likes. A missing case is a type error, and a case for an event that doesn't exist (one a renamed event left behind, or a run's case written beside the client's own) is refused when `match` is called, as the app's module loads, with a message that says where it goes.
- **Who a run waits on to decide** something, such as an upgrade to pick, is the game's to say: its sample does, as survivors' HUD has a `choosing` flag for each hero, and the app names the players from it. The client reports only who stepping waits on.
- `attach(element)` draws and reads input until interrupted, as an engine's does: it runs what the engine uses, makes the view, then the input source. `attach` and `listen` have `arcadekit/foldkit`'s `AttachableEngine` shapes, so `engineEntry({ engine: SumCoop, toMessage: SumCoop.match({ ... }), ... })` mounts co-op as it mounts an engine. A failed attach leaves the seat; a detach doesn't.

What every peer of a run must agree on is on the class as plain values and functions, `SumCoop.definition.hash`, `picks`, `config`, `maxPlayers` and `lockstep`, so a test reads them in Node, and the rules themselves are the engine's simulation, checked with scenarios.

### Testing a Co-op game

`arcadekit/net/testing` runs a Co-op client in Node, with no browser: `fakeCoopRooms()` is a signalling worker and WebRTC in memory (with `drop(peer)` and `closeHost()` to cut links) and `manualTicker()` a ticker the test drives, each with the `layer` a `Coop`'s layer takes. Frames come from `manualFrames()` in [`arcadekit/game/testing`](../game/README.md#testing-an-engine), provided as `Game.Frames`. It also has a small game to run: `TestGame`, a declared simulation with lobby picks, an offer each player answers with a command the rules may refuse (`AnswerOffer`, `NothingOwed`), a pause a player holds with another (`HoldPause`) and an end (`RunEnded`), with its content (`testContent`) and its state hash (`hashTestState`). It has no Co-op client of its own: a test makes one as an app does, from a `Coop`'s `layer`, its own game's or one declared over `TestGame`.

```ts
import * as Game from "arcadekit/game/browser";
import { manualFrames } from "arcadekit/game/testing";
import { Coop } from "arcadekit/net/browser";
import {
  RunEnded,
  TestGame,
  fakeCoopRooms,
  hashTestState,
  manualTicker,
  testContent,
} from "arcadekit/net/testing";
import { Context, Effect, Layer } from "effect";

// A Coop to test: the kit's test game, drawn nowhere.
class TestEngine extends Game.Engine("TestEngine", {
  simulation: TestGame,
  view: () => ({ render: () => {}, dispose: () => {} }),
  input: () => ({
    read: () => ({ players: [{ add: 1 }], leaving: [] }),
    dispose: () => {},
  }),
}) {}

class TestCoop extends Coop("TestCoop", {
  engine: TestEngine,
  input: () => ({ read: () => ({ add: 1 }), dispose: () => {} }),
  content: Effect.succeed(testContent),
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  hash: hashTestState,
  ends: [RunEnded],
}) {}

const hub = fakeCoopRooms();
const timer = manualTicker();

// One player's client: the Coop's layer over the fake rooms, the manual ticker and manual frames.
const player = Layer.build(
  TestCoop.layer.pipe(
    Layer.provide(hub.layer),
    Layer.provide(timer.layer),
    Layer.provide(Layer.succeed(Game.Frames, manualFrames()))
  )
).pipe(Effect.map((context) => Context.get(context, TestCoop)));

// The scope owns both clients, and closing it leaves: the whole test runs inside it.
const twoPlayers = Effect.gen(function* () {
  const host = yield* player;
  const guest = yield* player;
  yield* host.listen((event) => console.log("host", event._tag));
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

See [ADR-0012](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0012-delay-based-lockstep-over-a-host-star.md) (delay-based lockstep over a host star), [ADR-0019](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md) (the kit owns co-op from the signalling worker to the client; the screens stay in the app), [ADR-0021](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0021-co-op-is-declared-from-the-games-engine.md) (co-op is declared from the game's engine, and heard through one `match`) and [ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md) (a step uses only exact math, so every browser computes the same run).
