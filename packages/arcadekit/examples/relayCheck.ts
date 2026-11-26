/**
 * Checks a relay, wherever it runs: two peers of a small game play through
 * it and have to end on the same world, two peers that know only the room
 * meet in its lobby, agree on a map and a seed, and play the same game, the
 * relay has to refuse a name that is taken and a message in another's name,
 * and it has to tell a room who joined it and who left.
 *
 *   pnpm --filter arcadekit relay:check ws://localhost:8787
 *
 * The address is the relay's own, to which a room and a peer are added:
 * the Node relay of `examples/relay.ts`, the Worker of
 * `examples/relay-cloudflare` with `/rooms` after it, or one of your own.
 */
import { NodeRuntime, NodeSocket } from "@effect/platform-node";
import { Console, Effect, Fiber, Random, Result, Schema } from "effect";

import { Action, App, Field, Singleton, World } from "../src/index.ts";
import { Lobby, Message, Relay, Session, Transport } from "../src/net/index.ts";

const base = process.argv[2];
if (base === undefined) {
  console.error("usage: relay:check <the relay's address, ws:// or wss://>");
  process.exit(2);
}
// A room of its own for each run, so that two checks do not meet.
const room = `check-${Math.random().toString(36).slice(2, 10)}`;

const Purse = Singleton.define(
  "check/Purse",
  { ada: Field.i32, grace: Field.i32 },
  { ada: 0, grace: 0 }
);
class NotSeated extends Schema.TaggedError<NotSeated>()("NotSeated", {
  from: Schema.UndefinedOr(Schema.String),
}) {}
const Tip = Action.define("check/Tip", Schema.Struct({ amount: Schema.Int }), {
  error: NotSeated,
});
const tip = Action.handler(Tip, function* ({ amount }, { from }) {
  if (from !== "ada" && from !== "grace") {
    return yield* NotSeated.make({ from });
  }
  (yield* Purse.writes)[from] += amount;
});

const wait = (ms: number) =>
  Effect.promise(() => new Promise((r) => setTimeout(r, ms)));

/** A peer's own transport, for as long as the scope it is opened in. */
const listenAs = (peer: string, inRoom = room) =>
  Transport.listen.pipe(
    Effect.provide(
      Transport.layerWebSocket(Relay.address(base, { room: inRoom, peer }))
    )
  );

/** Waits until a transport's socket has closed, and gives why. */
const closed = (transport: Transport.Listener) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      // A transport whose socket has closed fails, and says why.
      const heard = yield* Effect.result(transport.receive());
      if (Result.isFailure(heard)) {
        return heard.failure;
      }
      yield* wait(10);
    }
    return yield* Effect.die(new Error("the relay left the socket open"));
  });

const check = Effect.gen(function* () {
  // --- two peers play a game through it ------------------------------------
  const seats = [];
  for (const peer of ["ada", "grace"]) {
    const session = yield* Session.make(App.define({ handlers: [tip] }), {
      checkpointEvery: 1,
      me: peer,
      others: [peer === "ada" ? "grace" : "ada"],
      hz: 30,
    });
    // Held in the check's scope, which closes each when the check ends.
    const connected = yield* Effect.acquireRelease(
      Transport.connect(session).pipe(
        Effect.provide(
          Transport.layerWebSocket(Relay.address(base, { room, peer }))
        )
      ),
      (made) => made.close
    );
    seats.push({ peer, app: session.app, session, connected });
  }
  const [ada, grace] = seats as [(typeof seats)[0], (typeof seats)[0]];
  for (let round = 0; round < 60; round++) {
    for (const seat of seats) {
      if (round < 40 && round % 5 === (seat.peer === "ada" ? 0 : 2)) {
        yield* seat.app.enqueue(Tip, { amount: 1 });
      }
      yield* seat.connected.tick();
      yield* wait(5);
    }
  }
  // To rest: a tick at a time, with longer between two than a message takes.
  for (
    let i = 0;
    i < 200 &&
    (ada.app.time.tick !== grace.app.time.tick ||
      ada.session.confirmed < ada.app.time.tick - 1);
    i++
  ) {
    yield* wait(30);
    yield* (
      ada.app.time.tick <= grace.app.time.tick ? ada : grace
    ).connected.tick();
  }
  const purse = { ...(yield* ada.app.read(Purse)) };
  const hashOf = (app: typeof ada.app) =>
    Effect.map(app.read(World), (world) => world.hash());
  if (
    ada.app.time.tick !== grace.app.time.tick ||
    (yield* hashOf(ada.app)) !== (yield* hashOf(grace.app)) ||
    purse.ada !== 8 ||
    purse.grace !== 8
  ) {
    return yield* Effect.die(
      new Error(
        `the peers did not end on the same game: ticks ${ada.app.time.tick} and ${grace.app.time.tick}, purse ${JSON.stringify(purse)}`
      )
    );
  }
  yield* Console.log(
    `✓ two peers played ${ada.app.time.tick} ticks through it and hold the same world (${ada.session.stats.rewinds + grace.session.stats.rewinds} rewinds)`
  );

  // --- two peers that know only the room meet in its lobby ------------------
  // Each names itself, and nobody gives a seed: the lobby makes one.
  const lobbyRoom = `${room}-lobby`;
  const Settings = Schema.Struct({ map: Schema.String });
  const met = [];
  for (let i = 0; i < 2; i++) {
    const me = `peer-${(yield* Random.nextIntBetween(0, 2_147_483_647)).toString(36)}`;
    const lobby = yield* Lobby.join({
      me,
      players: 2,
      settings: Settings,
    }).pipe(
      Effect.provide(
        Transport.layerWebSocket(
          Relay.address(base, { room: lobbyRoom, peer: me })
        )
      )
    );
    met.push(lobby);
  }
  const [first, second] = met as [(typeof met)[0], (typeof met)[0]];
  const starting = [
    yield* Effect.forkChild(first.start),
    yield* Effect.forkChild(second.start),
  ];
  yield* first.set({ map: "dunes" });
  for (let i = 0; i < 200 && second.settings === undefined; i++) {
    yield* wait(10);
  }
  yield* first.ready();
  yield* second.ready();
  const starts = [];
  for (const fiber of starting) {
    starts.push(
      yield* Fiber.join(fiber).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.die(new Error("the peers in the lobby never agreed")),
        })
      )
    );
  }
  const [one, two] = starts as [(typeof starts)[0], (typeof starts)[0]];
  if (
    one.seed !== two.seed ||
    one.settings.map !== "dunes" ||
    two.settings.map !== "dunes"
  ) {
    return yield* Effect.die(
      new Error(
        `the peers in the lobby did not agree: ${JSON.stringify(starts)}`
      )
    );
  }
  const played = [];
  for (const [at, lobby] of met.entries()) {
    const session = yield* Session.make(App.define({ handlers: [tip] }), {
      ...starts[at]!,
      checkpointEvery: 1,
      hz: 30,
    });
    played.push({
      session,
      connected: yield* Effect.acquireRelease(
        lobby.connect(session),
        (made) => made.close
      ),
    });
  }
  for (let round = 0; round < 40; round++) {
    for (const seat of played) {
      yield* seat.connected.tick();
      yield* wait(5);
    }
  }
  const [a, b] = played as [(typeof played)[0], (typeof played)[0]];
  for (
    let i = 0;
    i < 200 &&
    (a.session.app.time.tick !== b.session.app.time.tick ||
      a.session.confirmed < a.session.app.time.tick - 1);
    i++
  ) {
    yield* wait(30);
    yield* (
      a.session.app.time.tick <= b.session.app.time.tick ? a : b
    ).connected.tick();
  }
  if (
    a.session.app.time.tick !== b.session.app.time.tick ||
    (yield* hashOf(a.session.app)) !== (yield* hashOf(b.session.app))
  ) {
    return yield* Effect.die(
      new Error("the peers that met in the lobby did not play the same game")
    );
  }
  yield* Console.log(
    `✓ two peers that knew only the room met in its lobby, agreed on a map and the seed ${one.seed}, and played ${a.session.app.time.tick} ticks of the same game`
  );

  // --- a name that is taken ---------------------------------------------------
  // A host either closes the socket and says why, or turns the request
  // away before there is a socket, which a peer sees as no connection.
  const taken = yield* closed(yield* listenAs("ada"));
  if (taken.reason !== "name taken" && taken.code !== 1006) {
    return yield* Effect.die(
      new Error(`a second "ada" was closed with: ${taken.message}`)
    );
  }
  yield* Console.log(
    taken.code === 1006
      ? "✓ a second peer of the same name was turned away at the door"
      : `✓ a second peer of the same name was refused (${taken.code}: ${taken.reason})`
  );

  // --- a message in another's name --------------------------------------------
  const other = `${room}-liar`;
  const honest = yield* listenAs("grace", other);
  const liar = yield* listenAs("ada", other);
  yield* wait(300);
  const forged: Message.Message = { from: "grace", tick: 0, actions: [] };
  yield* liar.send(forged);
  const refused = yield* closed(liar);
  yield* wait(100);
  const told = yield* honest.receive();
  if (
    refused.reason !== "speaks for another" ||
    told.some((arrived) => "from" in arrived)
  ) {
    return yield* Effect.die(
      new Error(
        `a message in another's name was not refused: ${refused.message}`
      )
    );
  }
  yield* Console.log(
    `✓ a message in another's name was refused, and not passed on (${refused.code}: ${refused.reason})`
  );

  // --- who joins the room and who leaves it -----------------------------------
  const notices = JSON.stringify(told);
  if (notices !== JSON.stringify([{ joined: "ada" }, { left: "ada" }])) {
    return yield* Effect.die(
      new Error(
        `grace was not told that ada joined the room and left it, but: ${notices}`
      )
    );
  }
  yield* Console.log("✓ the room was told that a peer joined it and left it");
  yield* Console.log(`The relay at ${base} does what a relay does.`);
});

NodeRuntime.runMain(
  Effect.scoped(check).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor)
  )
);
