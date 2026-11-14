# Lockstep sessions

A lockstep session runs one declared simulation on every peer of a run ([Lockstep](../concepts/lockstep.md)). `LockstepSession.host` and `LockstepSession.join` make the plain session, which its program ticks, and `ScopedLockstepSession` makes the same one for an Effect program. A test runs its peers on a `MemoryNetwork`, in memory, with seeded latency, jitter and loss.

## Two peers

Two peers on the in-memory network play one run. Each player's input is a number, and the simulation adds them all:

```ts
import * as Game from "arcadekit/game";
import { LockstepSession, MemoryNetwork } from "arcadekit/net";
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

const network = MemoryNetwork.make({ seed: 1, latencyMs: 30, jitterMs: 10 });
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
    // The run's player order, host first: the host, then its `peers`.
    players: ["host", "guest"],
  },
  0
);

// Tick both sessions from a timer; here, 10 simulated seconds.
for (let now = 0; now < 10_000; now += 4) {
  MemoryNetwork.advance(network, now);
  host.tick(now);
  guest.tick(now);
}
// Every step got both players' input: 1 + 2.
console.log(host.state?.total === 3 * host.stepIndex); // true
```

## Commands

What a player decides outside what its devices hold, such as an upgrade to pick or a pause to hold, is a `Game.Command` of the simulation, as it is for one player. `session.send(command, settled?)` is `Game.Loop`'s `send` without the slot, since a session knows whose it is.

- **It rides one step.** The command goes with its sender's payload for the next step the session schedules, `inputDelay` ahead as its input is. The host confirms that step once, with the command in it, so every peer applies the command once, at the start of that step: the commands of the players before the sender in player order first, and each player's in the order sent. No peer picks the step from its own clock, and a resent message brings no second copy.
- **Every peer's rules answer alike.** Each peer's `apply` handler takes the command or refuses it with one of the rejections it declares, from the same state. Only the sender's peer has a sender to tell: `settled` is called there, once the session is out of the tick that ran the step, with `undefined`, the rejection, or a `CommandDropped`.
- **Its sender hears after its session's listeners.** A session's listeners (`subscribe`) are called inside the tick, and `settled` after it. So whenever a sender hears the rules' answer, taken or refused, the listeners of its session have heard everything that tick's steps reported, the command's step among them: a sender that listens knows what its command's step did. A tick that throws before it has told that step tells the sender `CommandDropped`: no sender hears the rules' answer to a command whose step its listeners did not hear.
- **Every send ends.** A send whose session stops, is disposed or throws out of a tick before this peer's rules answer is told `CommandDropped` with `runEnded`, and so is one sent after. A command sent while a guest's session is still `joining` waits, and rides the run's first steps.
- **It can be taken back while it has no step.** `send` returns a function for that. Once the command rides a step, which takes about one step's time and longer while the run waits on a player, it is every peer's, and taking it back only keeps `settled` from being called.
- **At most four commands ride one player's step.** A fifth rides the next step, in the order sent. A peer that sends five in one is removed, as for any payload that doesn't decode.
- **A command must survive JSON.** `send` throws, where the mistake is, for a command no peer could decode: a NaN in a `Schema.Number` field, which JSON carries as null. It also throws for a command the simulation doesn't declare.
- **A removed player hears for its own peer only.** If the host confirmed the step of a player's command and then removed that player, the peers still in the run applied the command, and its sender is told `runEnded`: its own rules never ran the step.

```ts
import * as Game from "arcadekit/game";
import { LockstepSession, MemoryNetwork } from "arcadekit/net";
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

const network = MemoryNetwork.make({ seed: 1, latencyMs: 30, jitterMs: 10 });
const shared = {
  simulation: Jar,
  config: null,
  contentHash: "content-v1",
  local: { read: () => 0 },
  hash: (jar: Game.StateOf<typeof Jar>) => jar.coins,
  inputDelay: 3,
  hashEvery: 30,
};
const host = LockstepSession.host(
  {
    ...shared,
    transport: MemoryNetwork.connect(network, "host"),
    peers: ["guest"],
    seed: 7,
  },
  0
);
const guest = LockstepSession.join(
  {
    ...shared,
    transport: MemoryNetwork.connect(network, "guest"),
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
  MemoryNetwork.advance(network, now);
  host.tick(now);
  guest.tick(now);
}
console.log(host.state?.coins, guest.state?.coins); // 7 7
```

## Listening to a run

`session.subscribe(listener)` hears what the run reports, its events and its samples, as `Game.Loop`'s `subscribe` does, and returns a function that stops it.

- **A session reports from its ticks, and from nowhere else.** A listener is called inside a tick, with what that tick's steps reported.
- **A listener in place before the first tick hears the run from its start**: what the simulation's `create` reports, then the first sample. A guest's run starts in a tick, the one that has the host's start message. A host's has started by the time `LockstepSession.host` returns, with its state there to draw, and nothing can have subscribed by then: the session keeps what that start reported and tells it at its first tick, before the tick does anything else. So a host's listener and a guest's hear one run alike.
- **Nothing is told twice.** A listener that comes after the first tick hears what comes after it.
- **A listener hears a tick before a sender does.** What a tick's steps reported is told inside the tick, a step's events and then a sample if one is due, and the senders whose commands those steps answered are told once the tick's work is over ([Commands](#commands)).

```ts
import * as Game from "arcadekit/game";
import { LockstepSession, MemoryNetwork } from "arcadekit/net";
import { Schema } from "effect";

class RaceBegan extends Game.Event("RaceBegan", { laps: Schema.Int }) {}
class Standings extends Game.Event("Standings", { metres: Schema.Number }) {}

// `create` reports the start, and the sample says how far the cars have come together.
class Race extends Game.Simulation("Race", {
  input: Game.PlayerInputs(Schema.Number),
  events: [RaceBegan],
  create: (config: { readonly laps: number }, { report }) => {
    report(new RaceBegan({ laps: config.laps }));
    return { metres: 0 };
  },
  step: (state, input) => {
    for (const speed of input.players) {
      state.metres += speed ?? 0;
    }
  },
  sample: {
    event: Standings,
    every: "100 millis",
    read: (state) => ({ metres: state.metres }),
  },
}) {}

const network = MemoryNetwork.make({ seed: 1 });
const host = LockstepSession.host(
  {
    simulation: Race,
    config: { laps: 3 },
    contentHash: "content-v1",
    transport: MemoryNetwork.connect(network, "host"),
    local: { read: () => 1 },
    hash: (state) => state.metres,
    inputDelay: 3,
    hashEvery: 30,
    peers: ["guest"],
    seed: 7,
  },
  0
);
// The run has started, and nothing has been told yet.
console.log(host.state?.metres); // 0
// Before the first tick: it hears the run from its start.
host.subscribe(
  Race.match({
    RaceBegan: ({ laps }) => console.log(`${laps} laps`),
    Standings: ({ metres }) => console.log(`${metres} m`),
  })
);
host.tick(4); // 3 laps, then 0 m
```

## In an Effect program

`ScopedLockstepSession.host(options)` and `ScopedLockstepSession.join(options)` take the same options and return `Effect<ScopedLockstepSession.ScopedLockstepSession, never, Scope>`. Closing the scope stops the session listening to its transport, and so does starting when it throws (the Effect dies with what was thrown). The session's time is Effect's `Clock` (its monotonic time; a `TestClock` in tests): the start and every tick read it.

`session.run(ticker?)` ticks the session until it stops, then fails with its `LockstepError`; interrupting it stops the ticking. After a desync it fails a second after the stop, which `status` and `error` show at once: until then its ticks resend the desync, which the transport may lose, so that every peer stops with it. Run it in the session's scope: a run still going once that closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock, for tests and servers. A `Ticker.Ticker` is `(onTick) => stop`: a timer, a dedicated worker's timer (a hidden tab throttles the main thread's to about once a second, which stalls the others), animation frames, or all of those. `onTick` ticks the session before it returns, so the ticker can read the session right after, or tick before drawing, and no Effect runs per tick: the run ends once the `onTick` it stops in has returned, so the rest of that tick runs before the program's handlers and finalizers. `session.listen(onEvent)` hears the run's events and samples until its scope closes, each call on its own, even with the same `onEvent`: it is the plain session's `subscribe`, so listen before `run`, whose first tick tells what the run's start reported, to hear the run [from its start](#listening-to-a-run). `session.send(command)` is the plain session's `send` as an Effect, in the shape of an engine's: it succeeds when this peer's rules took the command, fails with the rejection they refused it with, and fails with `CommandDropped` when they gave no answer, which closing the session's scope makes sure of. It completes after the tick of the command's step, when a `listen` callback has heard what that tick reported, and interrupting it takes the command back while it has no step yet. Its `status`, `error`, `waitingFor`, `players`, `state` and `stepIndex` are plain reads, as on the plain session.

[The two peers](#two-peers) again, as one Effect program:

```ts
import * as Game from "arcadekit/game";
import { MemoryNetwork, ScopedLockstepSession } from "arcadekit/net";
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

const network = MemoryNetwork.make({ seed: 1, latencyMs: 30, jitterMs: 10 });
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
const every4ms: Ticker.Ticker = (onTick) => {
  const timer = setInterval(() => {
    MemoryNetwork.advance(network, performance.now());
    onTick();
  }, 4);
  return () => clearInterval(timer);
};

const play = Effect.gen(function* () {
  const host = yield* ScopedLockstepSession.host({
    ...shared,
    transport: MemoryNetwork.connect(network, "host"),
    local: { read: () => 1 },
    peers: ["guest"],
    seed: 7,
  });
  const guest = yield* ScopedLockstepSession.join({
    ...shared,
    transport: MemoryNetwork.connect(network, "guest"),
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

The plain session is the protocol, and the scoped one a shell around it. Test the protocol on plain sessions ticked by hand, as in [Two peers](#two-peers), and an Effect program's sessions on a `TestClock`.
