/**
 * What the tests of several peers share: a small game, peers of it in one
 * process, and a network made by hand that delays and reorders.
 */
import { Cause, Data, Effect, Exit, Schema } from "effect";

import type * as Build from "../src/app/Build";
import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
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
} from "../src/index";
import type { Entity, QueryView } from "../src/index";
import { Message, Session } from "../src/net/index";
import type { ReadingWorld } from "../src/Services";

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
export const Drop = Action.define(
  "ls/Drop",
  Schema.Struct({ by: Player, value: Schema.Int })
);
export const Take = Action.define(
  "ls/Take",
  Schema.Struct({ by: Player, coin: EntityId })
);
export const Fire = Action.define("ls/Fire", Schema.Struct({}));
/** A gift to oneself: whose purse it goes to is whoever issued it. */
export const Tip = Action.define(
  "ls/Tip",
  Schema.Struct({ amount: Schema.Int })
);
export class Stranger extends Data.TaggedError("Stranger")<{
  readonly from: string | undefined;
}> {}
export const Mint = Action.define(
  "ls/Mint",
  Schema.Struct({ on: Schema.Date })
);
export const Whisper = Action.define(
  "ls/Whisper",
  Schema.Struct({ to: Schema.String })
);

export class NoSuchCoin extends Data.TaggedError("NoSuchCoin")<{
  readonly coin: Entity;
}> {}

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
    return yield* new NoSuchCoin({ coin });
  }
  (yield* Commands).despawn(coin);
  (yield* Taken.emits).emit({ value: held.value });
  const purse = yield* Purse.writes;
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
    return yield* new Stranger({ from });
  }
  (yield* Purse.writes)[from] += amount;
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
  (yield* Coins).each((coin) => {
    coin.x += random.next() - 0.5;
  });
});
/**
 * Counts what was taken from the events of it, and the coins that came to
 * be from a change query: both have a place of their own in what they
 * read, which a tick that is run again has to find where it was.
 */
export const Tally = System.tick("ls/Tally", function* () {
  const purse = yield* Purse.writes;
  for (const taken of (yield* Taken).read()) {
    purse.tallied += taken.value;
  }
  const born = (yield* Fresh).entities().length;
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
  (yield* Coins).each((coin) => {
    if (first) {
      coin.x += 1 + Math.random();
      first = false;
    }
  });
});
/** What each app's input stage heard refused, in the order it heard it. */
export const refusals: string[] = [];
export const Hear = System.input("ls/Hear", function* () {
  for (const refusal of (yield* Action.Rejected).read()) {
    refusals.push(refusal.action);
  }
});
export const Controls = Input.bind(
  "ls/Controls",
  Input.onPress("Space", Fire, {})
);

export const DELTA = 1 / 30;

/** The game every peer plays, and every save of it is loaded as. */
export const CoinGame = App.define({
  systems: [Tally, Drift, Bot, Fault, Controls, Hear] as const,
  handlers: [drop, take, tip, fire, mint, whisper] as const,
});
export const game = (seed = 5, checkpointEvery = 1) =>
  App.make(CoinGame, { seed, checkpointEvery });
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
  /** Its coins, as `app.read(Lying)` gives them, read again each time: a rollback ends a view. */
  readonly coins: QueryView<readonly [typeof Coin]>;
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
  /** How often each peer's log records a checkpoint, by name: 1 unless told. */
  readonly checkpointEvery?: Readonly<Record<string, number>>;
  /** How far the sessions run ahead: not at all unless told. */
  readonly ahead?: number;
  /** Whether each peer is given the others the other way round from the last. */
  readonly shuffled?: boolean;
}

export const withPeers = <A>(
  names: readonly string[],
  setup: Setup,
  use: (peers: Peer[]) => A
): A =>
  Effect.runSync(
    Effect.gen(function* () {
      const peers: Peer[] = [];
      const services = yield* Effect.context<never>();
      for (const name of names) {
        const source = Input.makeManualSource();
        const others = names.filter((other) => other !== name);
        const session = yield* Session.make(CoinGame, {
          seed: setup.seeds?.[name] ?? 5,
          checkpointEvery: setup.checkpointEvery?.[name] ?? 1,
          me: name,
          others:
            setup.shuffled === true && peers.length % 2 === 1
              ? others.toReversed()
              : others,
          delta: DELTA,
          ...(setup.delay === undefined ? {} : { delay: setup.delay }),
          ahead: setup.ahead ?? 0,
        }).pipe(Effect.provide(Input.layer(source)));
        const { app } = session;
        peers.push({
          name,
          app,
          world: yield* app.read(World),
          get coins() {
            return Effect.runSyncWith(services)(app.read(Lying));
          },
          session,
          hashes: [],
          source,
        });
      }
      return use(peers);
    })
  );

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
    tick: (delta: number): void => {
      app.input();
      const exit = reins.tickExit(delta);
      if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
      }
    },
    capture: (): Timeline.Moment => {
      const moment = Timeline.capture(app, { stages: true });
      if (Exit.isFailure(moment)) {
        throw new Error("the game could not be captured");
      }
      return moment.value;
    },
    rewind: (moment: Timeline.Moment): void => {
      Timeline.rewind(app, moment, { again: true });
    },
  };
};

/** Runs `use` with an app and its world, as `app.read(World)` gives it. */
export const withApp = <T extends Pick<App.Any, "read">, A, E = never>(
  make: Effect.Effect<T, E>,
  use: (app: T, world: ReadingWorld) => A
): A =>
  Effect.runSync(
    Effect.flatMap(make, (app) =>
      Effect.map(app.read(World), (world) => use(app, world))
    )
  );

/**
 * A network that is nothing like a wire: every message takes a random
 * number of rounds to arrive, so they overtake each other, and the ones
 * that arrive together arrive shuffled. Nothing is lost. Messages travel
 * as text.
 */
export const network = (seed: number, lag: { min: number; max: number }) => {
  const dice = new EcsWorld({ seed }).random;
  let now = 0;
  let inFlight: { at: number; to: string; text: string }[] = [];
  return {
    get inFlight() {
      return inFlight.length;
    },
    round(): void {
      now++;
    },
    send(to: readonly string[], messages: readonly Message.Message[]): void {
      for (const message of messages) {
        for (const name of to) {
          inFlight.push({
            at: now + dice.int(lag.min, lag.max),
            to: name,
            text: Message.encode(message),
          });
        }
      }
    },
    arrivals(to: string): Message.Message[] {
      const due = inFlight.filter((m) => m.to === to && m.at <= now);
      inFlight = inFlight.filter((m) => !(m.to === to && m.at <= now));
      return dice.shuffle(due).map((m) => {
        const message = Message.decode(m.text);
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
export const round = (
  peers: readonly Peer[],
  net: Network,
  only: readonly Peer[] = peers
): void => {
  net.round();
  for (const peer of only) {
    for (const message of net.arrivals(peer.name)) {
      peer.session.receive(message);
    }
    if (peer.session.tick()) {
      peer.hashes.push(peer.world.hash());
    }
    net.send(
      peers.filter((other) => other !== peer).map((other) => other.name),
      peer.session.outgoing()
    );
  }
};

/** Brings every peer to the tick the furthest has reached. */
export const catchUp = (peers: readonly Peer[], net: Network): number => {
  const furthest = Math.max(...peers.map((peer) => peer.app.time.tick));
  for (let i = 0; i < 1000; i++) {
    const behind = peers.filter((peer) => peer.app.time.tick < furthest);
    if (behind.length === 0) {
      return furthest;
    }
    round(peers, net, behind);
  }
  throw new Error("the peers never caught up with each other");
};

export const coinsOf = (peer: Peer): Entity[] => peer.coins.entities();

/** Each peer's player does something at random, from what its own world holds. */
export const players = (seed: number) => {
  const dice = new EcsWorld({ seed }).random;
  return (peer: Peer): void => {
    const by = peer.name as "ada" | "grace";
    const roll = dice.int(1, 6);
    if (roll <= 2) {
      peer.app.enqueue(Drop, { by, value: dice.int(1, 9) });
    } else if (roll === 4) {
      // Whose it is, the payload does not say.
      peer.app.enqueue(Tip, { amount: 1 });
    } else if (roll === 3) {
      const coins = coinsOf(peer);
      if (coins.length > 0) {
        // Both players go for the oldest coin: one of them is refused.
        peer.app.enqueue(Take, { by, coin: coins[0]! });
      }
    }
  };
};

export const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

/**
 * Rounds of a game that is expected to stop: every peer is handed what
 * arrived and tries its tick, until every one of them has failed. Returns
 * what each failed with, by name.
 */
export const untilStopped = (
  peers: readonly Peer[],
  net: Network,
  rounds: number
): Map<string, unknown> => {
  const stopped = new Map<string, unknown>();
  for (let i = 0; i < rounds && stopped.size < peers.length; i++) {
    net.round();
    for (const peer of peers) {
      for (const message of net.arrivals(peer.name)) {
        peer.session.receive(message);
      }
      const exit = peer.session.tickExit();
      if (Exit.isFailure(exit)) {
        stopped.set(peer.name, Cause.squash(exit.cause));
      }
      net.send(
        peers.filter((other) => other !== peer).map((other) => other.name),
        peer.session.outgoing()
      );
    }
  }
  return stopped;
};
