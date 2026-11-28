/**
 * What the tests of several peers share: a small game, peers of it in one
 * process, and a network made by hand that delays and reorders.
 */
import { Cause, Effect, Exit, Schema } from "effect";

import { World as EcsWorld } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Field,
  Input,
  Query,
  Random,
  Singleton,
  System,
  Time,
  Timeline,
  World,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import type * as Build from "../src/internal/build.ts";
import { Message, Session } from "../src/net/index.ts";
import type { ReadingWorld } from "../src/Services.ts";

// --- a small game: players drop coins, which drift about, and take them --------

export const Coin = Component.define("ls/Coin", {
  value: Field.i32,
  x: Field.f32,
});
export const Coins = Query.all(Coin).pipe(Query.writes(Coin));
/** The coins, read from outside the game. */
export const Lying = Query.all(Coin);
export const Purse = Singleton.define(
  "ls/Purse",
  {
    ada: Field.i32,
    grace: Field.i32,
    taken: Field.i32,
    tallied: Field.i32,
    born: Field.i32,
  },
  { ada: 0, grace: 0, taken: 0, tallied: 0, born: 0 }
);
/** A coin was taken: read by a system that runs before whoever emits it. */
export const Taken = Event.define(
  "ls/Taken",
  Schema.Struct({ value: Schema.Int })
);
const Fresh = Query.all(Coin).pipe(Query.added(Coin));

export const Player = Schema.Literals(["ada", "grace", "edsger"]);
export const Drop = Action.define("ls/Drop", {
  payload: Schema.Struct({ by: Player, value: Schema.Int }),
});
export class NoSuchCoin extends Schema.TaggedError<NoSuchCoin>()("NoSuchCoin", {
  coin: EntityId,
}) {}
export const Take = Action.define("ls/Take", {
  payload: Schema.Struct({ by: Player, coin: EntityId }),
  error: NoSuchCoin,
});
// oxlint-disable-next-line arcadekit/no-empty-payload -- the logs that Lockstep.test.ts and Origin.test.ts expect hold its payload as {}.
export const Fire = Action.define("ls/Fire", { payload: Schema.Struct({}) });
export class Stranger extends Schema.TaggedError<Stranger>()("Stranger", {
  from: Schema.UndefinedOr(Schema.String),
}) {}
/** A gift to oneself: whose purse it goes to is whoever issued it. */
export const Tip = Action.define("ls/Tip", {
  payload: Schema.Struct({ amount: Schema.Int }),
  error: Stranger,
});
export const Mint = Action.define("ls/Mint", {
  payload: Schema.Struct({ on: Schema.Date }),
});
export const Whisper = Action.define("ls/Whisper", {
  payload: Schema.Struct({ to: Schema.String }),
});

export const drop = Action.handler(Drop, function* ({ value }) {
  const random = yield* Random;
  return (yield* Commands.spawns(Coin)).spawn(
    Coin.of({ value, x: random.next() })
  );
});
export const take = Action.handler(Take, function* ({ by, coin }) {
  const world = yield* World;
  const held = world.get(coin, Coin);
  if (held === undefined) {
    return yield* NoSuchCoin.make({ coin });
  }
  (yield* Commands).despawn(coin);
  (yield* Event.Emitter(Taken)).emit({ value: held.value });
  const purse = yield* Singleton.Write(Purse);
  purse.taken += 1;
  if (by === "ada") {
    purse.ada += held.value;
  } else {
    purse.grace += held.value;
  }
  return held.value;
});
export const tip = Action.handler(Tip, function* ({ amount }, { from }) {
  if (from !== "ada" && from !== "grace") {
    return yield* Stranger.make({ from });
  }
  (yield* Singleton.Write(Purse))[from] += amount;
  return from;
});
export const fire = Action.handler(Fire, function* () {
  (yield* Commands.spawns(Coin)).spawn(Coin.of({ value: 100, x: 0 }));
});
export const mint = Action.handler(Mint, function* ({ on }) {
  (yield* Commands.spawns(Coin)).spawn(
    Coin.of({ value: on.getUTCFullYear(), x: 0 })
  );
});
export const whisper = Action.handler(Whisper, function* () {
  // Nothing: it is here to be enqueued.
});

export const Drift = System.tick("ls/Drift", function* () {
  const random = yield* Random;
  (yield* Query.View(Coins)).each((coin) => {
    coin.x += random.next() - 0.5;
  });
});
/**
 * Counts what was taken from the events of it, and the coins that came to
 * be from a change query: both have a place of their own in what they
 * read, which a tick that is run again has to find where it was.
 */
export const Tally = System.tick("ls/Tally", function* () {
  const purse = yield* Singleton.Write(Purse);
  for (const taken of (yield* Event.Reader(Taken)).read()) {
    purse.tallied += taken.value;
  }
  const born = (yield* Query.View(Fresh)).entities().length;
  if (born > 0) {
    purse.born += born;
  }
});
/** The simulation's own player: it drops a coin now and then. */
export const Bot = System.tick("ls/Bot", function* () {
  if ((yield* Time).tick % 7 === 3) {
    (yield* Action.Actions).enqueue(Drop, {
      by: "edsger" as const,
      value: 1,
    });
  }
});
/**
 * A bug of the kind that drift detection is for: on one tick, in the worlds
 * it is set for, a system moves a coin by a number that is not the game's.
 */
let glitch:
  | { tick: number; apps: ReadonlySet<{ readonly time: object }> | "all" }
  | undefined;
/** Sets the bug, in these apps, or takes it away. */
export const setGlitch = (to: typeof glitch): void => {
  glitch = to;
};
export const Fault = System.tick("ls/Fault", function* () {
  const time = yield* Time;
  if (glitch === undefined || time.tick !== glitch.tick) {
    return;
  }
  // An app's `time` is the one its systems are handed.
  if (
    glitch.apps !== "all" &&
    ![...glitch.apps].some((app) => app.time === time)
  ) {
    return;
  }
  let first = true;
  (yield* Query.View(Coins)).each((coin) => {
    if (first) {
      coin.x += 1 + Math.random();
      first = false;
    }
  });
});
/** What each app's input stage heard refused, in the order it heard it. */
export const refusals: string[] = [];
/** The coins each app's input stage heard a peer refused, typed. */
export const untaken: Action.Refused<
  { readonly by: string; readonly coin: Entity },
  NoSuchCoin
>[] = [];
export const Hear = System.input("ls/Hear", function* () {
  for (const refusal of (yield* Event.Reader(Action.Rejected)).read()) {
    refusals.push(refusal.action);
  }
  untaken.push(...(yield* Event.Reader(Action.rejected(Take))).read());
});
/** The space bar fires: an action of the game's own, as a game of several peers issues one. */
export const Controls = System.input("ls/Controls", function* () {
  if ((yield* Input.Devices).pressed.includes("Space")) {
    (yield* Action.Actions).enqueue(Fire, {});
  }
});

export const HZ = 30;
export const DELTA = 1 / HZ;

/** The game every peer plays, and every save of it is loaded as. */
export const CoinGame = App.define({
  systems: [Tally, Drift, Bot, Fault, Controls, Hear] as const,
  handlers: [drop, take, tip, fire, mint, whisper] as const,
});
export const game = (seed = 5, hashEvery = 1) =>
  App.make(CoinGame, { seed, hashEvery });
export type Game = Effect.Success<ReturnType<typeof game>>;

/** What each of the two players has in the purse. */
export const purseOf = (
  world: ReadingWorld
): { ada: number; grace: number } => {
  const { ada, grace } = world.singleton(Purse);
  return { ada, grace };
};

/** What a tick of the game fails with, and the actions it takes. */
type Parts = Game extends App.App<infer E, infer HU> ? { e: E; hu: HU } : never;
/** The app of a session of the game, which the session steps. */
export type SteeredGame = App.Steered<Parts["e"], Parts["hu"]>;

export interface Peer {
  readonly name: string;
  /** The session's app. */
  readonly app: SteeredGame;
  /** Its world, as `app.read(World)` gives it. */
  readonly world: ReadingWorld;
  /** A session, whether or not it runs ahead. */
  readonly session: Session.Session<Parts["e"], Parts["hu"]>;
  /** The world's hash after each tick this peer ran: `hashes[0]` is after the first. */
  readonly hashes: number[];
  readonly source: Input.ManualSource;
}

export interface Setup {
  readonly delay?: number;
  /** The seed of each peer's game, by name: all the same unless told. */
  readonly seeds?: Readonly<Record<string, number>>;
  /** How often each peer's log records a hash check, by name: 1 unless told. */
  readonly hashEvery?: Readonly<Record<string, number>>;
  /** How far the sessions run ahead: not at all unless told. */
  readonly ahead?: number;
  /** Whether each peer is given the others the other way round from the last. */
  readonly shuffled?: boolean;
}

export const withPeers = <A, E = never>(
  names: readonly string[],
  setup: Setup,
  use: (peers: Peer[]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const peers: Peer[] = [];
    for (const name of names) {
      const source = Input.makeManualSource();
      const others = names.filter((other) => other !== name);
      const session = yield* Session.make(CoinGame, {
        seed: setup.seeds?.[name] ?? 5,
        hashEvery: setup.hashEvery?.[name] ?? 1,
        me: name,
        others:
          setup.shuffled === true && peers.length % 2 === 1
            ? others.toReversed()
            : others,
        hz: HZ,
        ...(setup.delay === undefined ? {} : { delay: setup.delay }),
        ahead: setup.ahead ?? 0,
      }).pipe(Effect.provide(Input.layer(source)));
      const { app } = session;
      peers.push({
        name,
        app,
        world: yield* app.read(World),
        session,
        hashes: [],
        source,
      });
    }
    return yield* use(peers);
  });

/**
 * Takes an app over as a session does, to go back and run the same ticks
 * again: its ticks, each after the input stage, with the captures and the
 * rewinds a session makes. What is enqueued on the app is queued for the
 * next tick, as it was.
 */
export const steered = <E, HU>({ app, take }: Build.Built<E, HU>) => {
  const reins: Build.Reins<E> = take((name, payload) => {
    reins.deliver(name, payload);
  });
  return {
    app,
    tick: Effect.fnUntraced(function* (delta: number) {
      yield* app.input();
      yield* reins.tick(delta);
    }),
    capture: () => Timeline.capture(app, { stages: true }),
    rewind: (moment: Timeline.Moment) =>
      Timeline.rewind(app, moment, { again: true }),
  };
};

/** Runs `use` with an app and its world, as `app.read(World)` gives it. */
export const withApp = <
  T extends Pick<App.Any, "read">,
  A,
  E = never,
  E2 = never,
>(
  make: Effect.Effect<T, E>,
  use: (app: T, world: ReadingWorld) => Effect.Effect<A, E2>
) =>
  Effect.flatMap(make, (app) =>
    Effect.flatMap(app.read(World), (world) => use(app, world))
  );

/**
 * A network that is nothing like a wire: every message takes a random
 * number of rounds to arrive, so they overtake each other, and the ones
 * that arrive together arrive shuffled. Nothing is lost. Messages travel
 * as bytes.
 */
export const network = (seed: number, lag: { min: number; max: number }) => {
  const dice = new EcsWorld({ seed }).random;
  let now = 0;
  let inFlight: { at: number; to: string; bytes: Uint8Array }[] = [];
  return {
    get inFlight() {
      return inFlight.length;
    },
    round(): void {
      now++;
    },
    send: Effect.fnUntraced(function* (
      to: readonly string[],
      messages: readonly Message.Message[]
    ) {
      for (const message of messages) {
        const bytes = yield* Message.encode(message);
        for (const name of to) {
          inFlight.push({
            at: now + dice.int(lag.min, lag.max),
            to: name,
            bytes,
          });
        }
      }
    }),
    arrivals(to: string): Message.Message[] {
      const due = inFlight.filter((m) => m.to === to && m.at <= now);
      inFlight = inFlight.filter((m) => !(m.to === to && m.at <= now));
      return dice.shuffle(due).map((m) => {
        const message = Message.decode(m.bytes);
        if (Exit.isFailure(message)) {
          throw new Error("a message did not survive the wire");
        }
        return message.value;
      });
    },
  };
};
export type Network = ReturnType<typeof network>;

/** One round: every peer is handed what arrived, tries its tick, and sends. */
export const round = Effect.fnUntraced(function* (
  peers: readonly Peer[],
  net: Network,
  only: readonly Peer[] = peers
) {
  net.round();
  for (const peer of only) {
    for (const message of net.arrivals(peer.name)) {
      peer.session.receive(message);
    }
    if (yield* peer.session.tick()) {
      peer.hashes.push(peer.world.hash());
    }
    yield* net.send(
      peers.filter((other) => other !== peer).map((other) => other.name),
      peer.session.outgoing()
    );
  }
});

/** Brings every peer to the tick the furthest has reached. */
export const catchUp = Effect.fnUntraced(function* (
  peers: readonly Peer[],
  net: Network
) {
  const furthest = Math.max(...peers.map((peer) => peer.app.time.tick));
  for (let i = 0; i < 1000; i++) {
    const behind = peers.filter((peer) => peer.app.time.tick < furthest);
    if (behind.length === 0) {
      return furthest;
    }
    yield* round(peers, net, behind);
  }
  throw new Error("the peers never caught up with each other");
});

/** A peer's coins, read again each time: a rollback ends a view. */
export const coinsOf = (peer: Peer) =>
  Effect.map(peer.app.read(Query.View(Lying)), (coins) => coins.entities());

/** Each peer's player does something at random, from what its own world holds. */
export const players = (seed: number) => {
  const dice = new EcsWorld({ seed }).random;
  return Effect.fnUntraced(function* (peer: Peer) {
    const by = peer.name as "ada" | "grace";
    const roll = dice.int(1, 6);
    if (roll <= 2) {
      yield* peer.app.enqueue(Drop, { by, value: dice.int(1, 9) });
    } else if (roll === 4) {
      // Whose it is, the payload does not say.
      yield* peer.app.enqueue(Tip, { amount: 1 });
    } else if (roll === 3) {
      const coins = yield* coinsOf(peer);
      if (coins.length > 0) {
        // Both players go for the oldest coin: one of them is refused.
        yield* peer.app.enqueue(Take, { by, coin: coins[0]! });
      }
    }
  });
};

export const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isHashCheck(entry));

/**
 * Rounds of a game that is expected to stop: every peer is handed what
 * arrived and tries its tick, until every one of them has failed. Returns
 * what each failed with, by name.
 */
export const untilStopped = Effect.fnUntraced(function* (
  peers: readonly Peer[],
  net: Network,
  rounds: number
) {
  const stopped = new Map<string, unknown>();
  for (let i = 0; i < rounds && stopped.size < peers.length; i++) {
    net.round();
    for (const peer of peers) {
      for (const message of net.arrivals(peer.name)) {
        peer.session.receive(message);
      }
      const exit = yield* Effect.exit(peer.session.tick());
      if (Exit.isFailure(exit)) {
        stopped.set(peer.name, Cause.squash(exit.cause));
      }
      yield* net.send(
        peers.filter((other) => other !== peer).map((other) => other.name),
        peer.session.outgoing()
      );
    }
  }
  return stopped;
});
