/**
 * Checks a relay, wherever it runs: two peers of a small game play through
 * it and have to end on the same world, and the relay has to refuse a name
 * that is taken and a message in another's name.
 *
 *   pnpm --filter arcadekit relay:check ws://localhost:8787
 *
 * The address is the relay's own, to which a room and a peer are added:
 * the Node relay of `examples/relay.ts`, the Worker of
 * `examples/relay-cloudflare` with `/rooms` after it, or one of your own.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Context, Effect, Layer, Schema } from "effect";

import type { Lockstep } from "../src/index";
import {
  Action,
  App,
  Field,
  Relay,
  Rollback,
  Singleton,
  Transport,
} from "../src/index";

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

const Tip = Action.define("check/Tip", Schema.Struct({ amount: Schema.Int }));

const tip = Action.handler(Tip, function* ({ amount }, { from }) {
  if (from !== "ada" && from !== "grace") {
    return yield* Effect.fail(new Error(`a tip from ${from}`));
  }

  (yield* Purse)[from] += amount;
});

const wait = (ms: number) =>
  Effect.promise(() => new Promise((r) => setTimeout(r, ms)));

/** A peer's own transport, for as long as the scope it is opened in. */
const open = (peer: string, inRoom = room) =>
  Effect.map(
    Layer.build(
      Transport.layerWebSocket(Relay.address(base, { room: inRoom, peer }))
    ),
    (context) => Context.get(context, Transport.Transport)
  );

/** Waits until a transport's socket has closed, and gives why. */
const closed = (transport: Transport.Transport) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i += 1) {
      try {
        transport.receive();
      } catch (error) {
        if (error instanceof Transport.Closed) {
          return error;
        }

        throw error;
      }

      yield* wait(10);
    }

    return yield* Effect.die(new Error("the relay left the socket open"));
  });

const check = Effect.gen(function* () {
  // --- two peers play a game through it ------------------------------------
  const seats = [];

  for (const peer of ["ada", "grace"]) {
    const app = yield* App.make({
      handlers: [tip],
      components: [Purse],
      checkpointEvery: 1,
    });

    const session = Rollback.make(app, {
      peer,
      peers: ["ada", "grace"],
      delta: 1 / 30,
    });

    const transport = yield* Layer.build(
      Transport.layerWebSocket(Relay.address(base, { room, peer }))
    );

    const connected = yield* Transport.connect(session).pipe(
      Effect.provide(transport)
    );

    seats.push({ peer, app, session, connected });
  }

  const [ada, grace] = seats as [(typeof seats)[0], (typeof seats)[0]];

  for (let round = 0; round < 60; round += 1) {
    for (const seat of seats) {
      if (round < 40 && round % 5 === (seat.peer === "ada" ? 0 : 2)) {
        seat.app.enqueue(Tip, { amount: 1 });
      }

      seat.connected.tick();
      yield* wait(5);
    }
  }

  // To rest: a tick at a time, with longer between two than a message takes.
  for (
    let i = 0;
    i < 200 &&
    (ada.app.time.tick !== grace.app.time.tick ||
      ada.session.confirmed < ada.app.time.tick - 1);
    i += 1
  ) {
    yield* wait(30);
    (ada.app.time.tick <= grace.app.time.tick ? ada : grace).connected.tick();
  }

  const purse = { ...ada.app.world.singleton(Purse) };

  if (
    ada.app.time.tick !== grace.app.time.tick ||
    ada.app.world.hash() !== grace.app.world.hash() ||
    purse.ada !== 8 ||
    purse.grace !== 8
  ) {
    return yield* Effect.die(
      new Error(
        `the peers did not end on the same game: ticks ${ada.app.time.tick} and ${grace.app.time.tick}, purse ${JSON.stringify(purse)}`
      )
    );
  }

  console.log(
    `✓ two peers played ${ada.app.time.tick} ticks through it and hold the same world (${ada.session.rewinds + grace.session.rewinds} rewinds)`
  );

  // --- a name that is taken ---------------------------------------------------
  // A host either closes the socket and says why, or turns the request
  // away before there is a socket, which a peer sees as no connection.
  const taken = yield* closed(yield* open("ada"));

  if (taken.reason !== "name taken" && taken.code !== 1006) {
    return yield* Effect.die(
      new Error(`a second "ada" was closed with: ${taken.message}`)
    );
  }

  console.log(
    taken.code === 1006
      ? "✓ a second peer of the same name was turned away at the door"
      : `✓ a second peer of the same name was refused (${taken.code}: ${taken.reason})`
  );

  // --- a message in another's name --------------------------------------------
  const other = `${room}-liar`;
  const honest = yield* open("grace", other);
  const liar = yield* open("ada", other);
  yield* wait(300);
  const forged: Lockstep.Message = { from: "grace", tick: 0, actions: [] };
  liar.send(forged);
  const refused = yield* closed(liar);
  yield* wait(100);

  if (refused.reason !== "speaks for another" || honest.receive().length > 0) {
    return yield* Effect.die(
      new Error(
        `a message in another's name was not refused: ${refused.message}`
      )
    );
  }

  console.log(
    `✓ a message in another's name was refused, and not passed on (${refused.code}: ${refused.reason})`
  );
  console.log(`The relay at ${base} does what a relay does.`);
});

NodeRuntime.runMain(Effect.scoped(check));
