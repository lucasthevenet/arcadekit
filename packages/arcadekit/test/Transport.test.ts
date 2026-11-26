import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "@effect/vitest";
import { Context, Effect, Layer, Result } from "effect";

import { App, Driver, Input, Journal, Plugin, World } from "../src/index.ts";
import { Drift, Message, Session, Transport } from "../src/net/index.ts";
import { thrown } from "./checks.ts";
import { CoinGame, DELTA, Drop, moves, players, setGlitch } from "./peers.ts";
import type { Peer } from "./peers.ts";

const message = (from: string, tick: number, value = 0): Message.Message => ({
  from,
  tick,
  actions:
    value === 0 ? [] : [{ name: "ls/Drop", payload: { by: from, value } }],
});

/** The messages among what arrived, without a relay's notices. */
const messagesIn = (
  arrived: readonly (Message.Message | Message.Notice)[]
): Message.Message[] =>
  arrived.filter((one): one is Message.Message => "from" in one);

/** A peer whose session is joined to a transport, which steps it. */
interface Seat extends Peer {
  readonly connected: Transport.Connected<
    Effect.Error<ReturnType<Peer["session"]["tick"]>>
  >;
}

/** Peers of the game, each joined to a layer of its own. */
const seated = (
  names: readonly string[],
  layerOf: (name: string) => ReturnType<typeof Transport.layer>,
  ahead: number | undefined,
  options?: Transport.ConnectOptions
) =>
  Effect.gen(function* () {
    const seats: Seat[] = [];
    for (const name of names) {
      const source = Input.makeManualSource();
      const session = yield* Session.make(CoinGame, {
        seed: 5,
        checkpointEvery: 1,
        me: name,
        others: names.filter((other) => other !== name),
        delta: DELTA,
        ahead: ahead ?? 0,
      }).pipe(Effect.provide(Input.layer(source)));
      // Provided to the one line that connects, and held in the scope of
      // the program, which closes it.
      const connected = yield* Effect.acquireRelease(
        Transport.connect(session, options).pipe(Effect.provide(layerOf(name))),
        (made) => made.close
      );
      seats.push({
        name,
        app: session.app,
        world: yield* session.app.read(World),
        session,
        hashes: [],
        source,
        connected,
      });
    }
    return seats;
  });

describe("a hub, the network in memory", () => {
  it("carries what one port sends to every other, and not back", () => {
    const hub = Transport.makeHub();
    const [ada, grace, edsger] = ["ada", "grace", "edsger"].map((name) =>
      hub.port(name)
    ) as [Transport.Listener, Transport.Listener, Transport.Listener];
    ada.send(message("ada", 0, 3));
    ada.send(message("ada", 1));
    expect(hub.inFlight).toBe(4);
    expect(grace.receive()).toEqual([message("ada", 0, 3), message("ada", 1)]);
    // Taken: asked again, there is nothing.
    expect(grace.receive()).toEqual([]);
    expect(edsger.receive()).toEqual([message("ada", 0, 3), message("ada", 1)]);
    expect(ada.receive()).toEqual([]);
    expect(hub.inFlight).toBe(0);
    // A port is the same port each time it is asked for.
    expect(hub.port("ada")).toBe(ada);
  });

  it("loses what is on its way to and from a peer it cuts off, and tells the others, until it comes back", () => {
    const hub = Transport.makeHub({ delay: 1 });
    const [ada, grace, edsger] = ["ada", "grace", "edsger"].map((name) =>
      hub.port(name)
    ) as [Transport.Listener, Transport.Listener, Transport.Listener];
    ada.send(message("ada", 0));
    grace.send(message("grace", 0));
    hub.disconnect("grace");
    // Gone: ada's message to grace, and grace's to everyone.
    expect(hub.inFlight).toBe(3);
    grace.send(message("grace", 1));
    ada.send(message("ada", 1));
    hub.step();
    expect(grace.receive()).toEqual([]);
    expect(ada.receive()).toEqual([{ left: "grace" }]);
    expect(edsger.receive()).toEqual([
      { left: "grace" },
      message("ada", 0),
      message("ada", 1),
    ]);
    hub.reconnect("grace");
    hub.step();
    expect(grace.receive()).toEqual([{ joined: "ada" }, { joined: "edsger" }]);
    expect(ada.receive()).toEqual([{ joined: "grace" }]);
    expect(edsger.receive()).toEqual([{ joined: "grace" }]);
    grace.send(message("grace", 2));
    hub.step();
    expect(ada.receive()).toEqual([message("grace", 2)]);
    // Twice is once, and a peer without a port is no peer of it.
    hub.reconnect("grace");
    expect(ada.receive()).toEqual([]);
    expect(() => hub.disconnect("linus")).toThrow(/no port for "linus"/u);
  });

  it("reaches a peer only from the moment it has a port", () => {
    const hub = Transport.makeHub();
    const ada = hub.port("ada");
    ada.send(message("ada", 0));
    const grace = hub.port("grace");
    ada.send(message("ada", 1));
    expect(grace.receive()).toEqual([message("ada", 1)]);
  });

  it("keeps a message on its way for as many steps as its delay", () => {
    const hub = Transport.makeHub({ delay: 2 });
    const ada = hub.port("ada");
    const grace = hub.port("grace");
    ada.send(message("ada", 0));
    expect(grace.receive()).toEqual([]);
    hub.step();
    ada.send(message("ada", 1));
    expect(grace.receive()).toEqual([]);
    hub.step();
    expect(grace.receive()).toEqual([message("ada", 0)]);
    expect(hub.inFlight).toBe(1);
    hub.step();
    expect(grace.receive()).toEqual([message("ada", 1)]);
  });

  it("lets messages overtake each other when the delay is a range, the same way for the same seed", () => {
    const run = (seed: number): number[] => {
      const hub = Transport.makeHub({ delay: { min: 0, max: 6 }, seed });
      const ada = hub.port("ada");
      const grace = hub.port("grace");
      const order: number[] = [];
      for (let tick = 0; tick < 40; tick++) {
        ada.send(message("ada", tick));
        hub.step();
        order.push(...messagesIn(grace.receive()).map((one) => one.tick));
      }
      for (let i = 0; i < 6; i++) {
        hub.step();
        order.push(...messagesIn(grace.receive()).map((one) => one.tick));
      }
      return order;
    };
    const order = run(1);
    // Every one arrived, once, and not in the order they were sent.
    expect(order.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, tick) => tick)
    );
    expect(order).not.toEqual(order.toSorted((a, b) => a - b));
    expect(run(1)).toEqual(order);
    expect(run(2)).not.toEqual(order);
  });

  it("refuses a delay that is no number of steps", () => {
    for (const delay of [-1, 1.5, { min: 3, max: 2 }, { min: -1, max: 2 }]) {
      expect(() => Transport.makeHub({ delay })).toThrow(
        /A hub's delay is a whole number of steps/u
      );
    }
  });
});

describe("a session joined to a transport", () => {
  afterEach(() => {
    setGlitch(undefined);
  });

  it.effect("is handed what arrived, steps, and sends what it has to say", () =>
    Effect.gen(function* () {
      const hub = Transport.makeHub();
      const grace = hub.port("grace");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const [ada] = yield* seated(
            ["ada", "grace"],
            (name) => hub.layer(name),
            undefined
          );
          yield* ada!.app.enqueue(Drop, { by: "ada", value: 4 });
          // It waits for grace, and has said its piece all the same.
          expect(yield* ada!.connected.tick()).toBe(false);
          expect(messagesIn(grace.receive()).map((sent) => sent.tick)).toEqual([
            0, 1, 2,
          ]);
          for (let tick = 0; tick <= 2; tick++) {
            grace.send(message("grace", tick));
          }
          expect(yield* ada!.connected.tick()).toBe(true);
          expect(yield* ada!.connected.tick()).toBe(true);
          expect(yield* ada!.connected.tick()).toBe(true);
          expect(ada!.app.time.tick).toBe(3);
          expect(moves(ada!.app.actionLog)).toHaveLength(1);
          expect(messagesIn(grace.receive()).map((sent) => sent.tick)).toEqual([
            3, 4,
          ]);
        })
      );
    })
  );

  it.effect(
    "keeps peers the same game under a driver, with lockstep and with rollback",
    () =>
      Effect.gen(function* () {
        for (const ahead of [undefined, 8]) {
          const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 7 });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const seats = yield* seated(
                ["ada", "grace"],
                (name) => hub.layer(name),
                ahead
              );
              const steps = seats.map((seat) =>
                Driver.fixedStep(seat.connected)
              );
              const act = players(11);
              const frame = Effect.fnUntraced(function* (acting: boolean) {
                hub.step();
                for (const [index, seat] of seats.entries()) {
                  if (acting) {
                    yield* act(seat);
                  }
                  yield* steps[index]!(DELTA);
                }
              });
              for (let i = 0; i < 200; i++) {
                yield* frame(true);
              }
              // To rest, and then to the same tick.
              for (let i = 0; i < 30; i++) {
                yield* frame(false);
              }
              const [ada, grace] = seats as [Seat, Seat];
              for (
                let i = 0;
                i < 50 && ada.app.time.tick !== grace.app.time.tick;
                i++
              ) {
                hub.step();
                yield* (
                  ada.app.time.tick < grace.app.time.tick ? ada : grace
                ).connected.tick();
              }
              expect(ada.app.time.tick).toBe(grace.app.time.tick);
              expect(ada.app.time.tick).toBeGreaterThan(
                ahead === undefined ? 60 : 200
              );
              expect(ada.world.hash()).toBe(grace.world.hash());
              expect(ada.app.actionLog).toEqual(grace.app.actionLog);
              expect(moves(ada.app.actionLog).length).toBeGreaterThan(30);
              expect(ada.session.drifted).toBeUndefined();
              // Only a game played with rollback goes back.
              expect(ada.session.rewinds > 0).toBe(ahead !== undefined);
              const whole = yield* ada.app.record();
              const alone = yield* Journal.replay(whole, CoinGame, {
                checkpointEvery: 1,
              });
              expect((yield* alone.read(World)).hash()).toBe(ada.world.hash());
            })
          );
        }
      })
  );

  it.effect(
    "plays on to the same game when a peer is cut off and comes back, with what was lost sent again",
    () =>
      Effect.gen(function* () {
        for (const ahead of [undefined, 8]) {
          const hub = Transport.makeHub({ delay: { min: 0, max: 3 }, seed: 9 });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const seats = yield* seated(
                ["ada", "edsger", "grace"],
                (name) => hub.layer(name),
                ahead
              );
              const [ada, edsger, grace] = seats as [Seat, Seat, Seat];
              const act = players(13);
              const frame = Effect.fnUntraced(function* (acting: boolean) {
                hub.step();
                for (const seat of seats) {
                  if (acting) {
                    yield* act(seat);
                  }
                  yield* seat.connected.tick();
                }
              });
              for (let i = 0; i < 60; i++) {
                yield* frame(true);
              }
              // Grace's socket drops, with what was on its way to and from it.
              hub.disconnect("grace");
              for (let i = 0; i < 40; i++) {
                yield* frame(true);
              }
              expect(ada.connected.away).toEqual(["grace"]);
              expect(edsger.connected.away).toEqual(["grace"]);
              expect(grace.connected.away).toEqual([]);
              // The others went no further than grace's word allows.
              expect(ada.session.waitingFor).toEqual(["grace"]);
              hub.reconnect("grace");
              for (let i = 0; i < 100; i++) {
                yield* frame(true);
              }
              expect(ada.connected.away).toEqual([]);
              for (let i = 0; i < 30; i++) {
                yield* frame(false);
              }
              for (
                let i = 0;
                i < 100 &&
                new Set(seats.map((seat) => seat.app.time.tick)).size > 1;
                i++
              ) {
                hub.step();
                const furthest = Math.max(
                  ...seats.map((seat) => seat.app.time.tick)
                );
                for (const seat of seats) {
                  if (seat.app.time.tick < furthest) {
                    yield* seat.connected.tick();
                  }
                }
              }
              expect(edsger.app.time.tick).toBe(ada.app.time.tick);
              expect(grace.app.time.tick).toBe(ada.app.time.tick);
              expect(ada.app.time.tick).toBeGreaterThan(100);
              for (const seat of [edsger, grace]) {
                expect(seat.world.hash()).toBe(ada.world.hash());
                expect(seat.app.actionLog).toEqual(ada.app.actionLog);
                expect(seat.session.drifted).toBeUndefined();
              }
              expect(moves(ada.app.actionLog).length).toBeGreaterThan(30);
              // Grace's moves are in the game from before, during and after.
              const hers = moves(ada.app.actionLog).filter(
                (entry) => entry.from === "grace"
              );
              expect(hers.length).toBeGreaterThan(10);
              // Once every peer has heard it, nothing is kept.
              for (let i = 0; i < 10; i++) {
                yield* frame(false);
              }
              for (const seat of seats) {
                expect(seat.session.unheard).toBeLessThanOrEqual(
                  seat.session.delay + (ahead ?? 0) + 6
                );
              }
            })
          );
        }
      })
  );

  it.effect(
    "fails the tick with the peers that stayed away longer than awayFor",
    () =>
      Effect.gen(function* () {
        const hub = Transport.makeHub();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const [ada, grace] = (yield* seated(
              ["ada", "grace"],
              (name) => hub.layer(name),
              undefined,
              { awayFor: 1000 }
            )) as [Seat, Seat];
            const frame = Effect.fnUntraced(function* () {
              hub.step();
              yield* ada.connected.tick();
              yield* grace.connected.tick();
            });
            for (let i = 0; i < 10; i++) {
              yield* frame();
            }
            // Back before a second has passed: the wait starts over.
            hub.disconnect("grace");
            for (let i = 0; i < 20; i++) {
              yield* frame();
            }
            hub.reconnect("grace");
            for (let i = 0; i < 40; i++) {
              yield* frame();
            }
            expect(ada.connected.away).toEqual([]);
            hub.disconnect("grace");
            // A second is 30 ticks of 1 / 30: the tick that hears she left,
            // and 29 more.
            for (let i = 0; i < 30; i++) {
              hub.step();
              yield* ada.connected.tick();
            }
            expect(ada.connected.away).toEqual(["grace"]);
            const ticked = yield* Effect.result(ada.connected.tick());
            const thrown = Result.isFailure(ticked)
              ? ticked.failure
              : "it did not throw";
            expect(thrown).toEqual(
              new Transport.Left({ peers: ["grace"], awayFor: 1000 })
            );
            expect(thrown).toBeInstanceOf(Transport.Left);
            expect(String(thrown)).toContain(
              "grace left and did not come back within 1000 ms, so the game cannot go on."
            );
          })
        );
      })
  );

  it.effect(
    "sends a stopped session's last word, so that every peer stops",
    () =>
      Effect.gen(function* () {
        // With no delay the second peer finds the difference in the very tick
        // it would have said its own hash in: unless that tick sends as it
        // fails, the first never hears it, and waits.
        for (const delay of [0, { min: 0, max: 3 }]) {
          const hub = Transport.makeHub({ delay, seed: 3 });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const seats = yield* seated(
                ["ada", "grace"],
                (name) => hub.layer(name),
                undefined
              );
              setGlitch({ tick: 9, apps: "all" });
              yield* seats[0]!.app.enqueue(Drop, { by: "ada", value: 1 });
              const stopped = new Map<string, unknown>();
              for (let i = 0; i < 200 && stopped.size < 2; i++) {
                hub.step();
                for (const seat of seats) {
                  const ticked = yield* Effect.result(seat.connected.tick());
                  if (Result.isFailure(ticked)) {
                    stopped.set(seat.name, ticked.failure);
                  }
                }
              }
              // Both, and with the same report.
              expect(stopped.get("ada")).toBeInstanceOf(Drift.Drifted);
              expect(stopped.get("grace")).toBeInstanceOf(Drift.Drifted);
              expect((stopped.get("ada") as Drift.Drifted).hashes).toEqual(
                (stopped.get("grace") as Drift.Drifted).hashes
              );
              setGlitch(undefined);
            })
          );
        }
      })
  );

  it.effect("draws the game through the session", () =>
    Effect.gen(function* () {
      const hub = Transport.makeHub();
      const session = yield* Session.make(CoinGame, {
        seed: 5,
        checkpointEvery: 1,
        me: "ada",
        others: [],
        delta: DELTA,
        ahead: 0,
      });
      let drawn = 0;
      const connected = yield* Transport.connect({
        ...session,
        frame: () =>
          Effect.sync(() => {
            drawn++;
          }),
      }).pipe(Effect.provide(hub.layer("ada")));
      yield* Driver.fixedStep(connected)(DELTA);
      expect(drawn).toBe(1);
      expect(session.app.time.tick).toBe(1);
    })
  );

  it.effect("does not compile without a transport", () =>
    Effect.gen(function* () {
      const session = yield* Session.make(CoinGame, {
        seed: 5,
        checkpointEvery: 1,
        me: "ada",
        others: [],
        delta: DELTA,
        ahead: 0,
      });
      // A game of several peers is given a transport, and one without it
      // finds none.
      expectTypeOf<
        Effect.Services<ReturnType<typeof Transport.connect>>
      >().toEqualTypeOf<Transport.Transport>();
      const none = Context.empty() as Context.Context<Transport.Transport>;
      expect(
        yield* thrown(Effect.provideContext(Transport.connect(session), none))
      ).toThrow(/Transport/u);
      const hub = Transport.makeHub();
      // It needs no scope: the connection listens in one of its own.
      const made = yield* Transport.connect(session).pipe(
        Effect.provide(Transport.layer(hub.port("ada")))
      );
      expect(yield* made.tick()).toBe(true);
    })
  );
});

describe("a transport over a wire", () => {
  it("sends a message as bytes, and reads the bytes that are messages and the text that is a notice", () => {
    const sent: Uint8Array[] = [];
    let deliver: (data: string | Uint8Array) => void = () => {};
    let listening = 0;
    const transport = Transport.fromWire({
      send: (bytes) => {
        sent.push(bytes);
      },
      listen(onData) {
        deliver = onData;
        listening++;
        return () => {
          listening--;
        };
      },
    });
    transport.send(message("ada", 3, 2));
    expect(sent).toEqual([Message.encode(message("ada", 3, 2))]);
    deliver(Message.encode(message("grace", 0)));
    deliver(Message.encodeNotice({ left: "edsger" }));
    deliver("not a message");
    deliver(JSON.stringify(message("grace", 2)));
    deliver(new Uint8Array([1, 2, 3]));
    deliver(Message.encode(message("grace", 1, 5)));
    // What is neither is dropped, and counted.
    expect(transport.receive()).toEqual([
      message("grace", 0),
      { left: "edsger" },
      message("grace", 1, 5),
    ]);
    expect(transport.dropped).toBe(3);
    expect(transport.receive()).toEqual([]);
    expect(listening).toBe(1);
    transport.close();
    expect(listening).toBe(0);
    // Closed, it says so, in place of a game that waits for ever.
    expect(() => transport.receive()).toThrow(
      /A transport over a wire was used after it was closed/u
    );
    expect(() => transport.send(message("ada", 4))).toThrow(
      /used after it was closed/u
    );
    expect(sent).toHaveLength(1);
    transport.close();
    expect(listening).toBe(0);
  });
});

/** A turn of the event loop or two: a channel delivers in its own time. */
const later = (ms = 5): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits, a few milliseconds at a time, until something holds. */
const until = async (holds: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (holds()) {
      return;
    }
    await later(5);
  }
  throw new Error(`timed out waiting until ${what}`);
};

/** Waits, a few milliseconds at a time, until what `holds` runs says it does. */
const waitUntil = <E>(
  holds: Effect.Effect<boolean, E>,
  what: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (yield* Effect.orDie(holds)) {
        return;
      }
      yield* Effect.promise(() => later(5));
    }
    return yield* Effect.die(new Error(`timed out waiting until ${what}`));
  });

/** A session connected to a transport, whose tick fails with `Drift.Drifted`, as a type. */
declare const drifting: Transport.Connected<Drift.Drifted>;

describe("a session connected to a transport", () => {
  it("is run by Driver.run, which fails with what its tick fails with, each by its tag", () => {
    const run = () => Driver.run(Effect.succeed(drifting));
    expectTypeOf<Effect.Error<ReturnType<typeof run>>>().toEqualTypeOf<
      Drift.Drifted | Transport.Left
    >();
  });
});

describe("the transport between tabs, a BroadcastChannel", () => {
  const nextRoom = (): string => `arcadekit-test/${crypto.randomUUID()}`;

  it.effect(
    "carries messages to whoever opened the same name, and closes with its scope",
    () =>
      Effect.gen(function* () {
        const name = nextRoom();
        const stranger = new BroadcastChannel(name);
        const heard: unknown[] = [];
        stranger.onmessage = (event: MessageEvent<unknown>) => {
          heard.push(event.data);
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const listen = (peer: string) =>
              Transport.listen.pipe(
                Effect.provide(Transport.layerBroadcastChannel(name, peer))
              );
            const ada = yield* listen("ada");
            const grace = yield* listen("grace");
            ada.send(message("ada", 0, 7));
            grace.send(message("grace", 0));
            // Whatever else is posted under the name is not a message.
            stranger.postMessage({ not: "a message" });
            stranger.postMessage("nor is this");
            yield* Effect.promise(() => later(20));
            expect(grace.receive()).toEqual([message("ada", 0, 7)]);
            expect(ada.receive()).toEqual([
              { joined: "grace" },
              message("grace", 0),
            ]);
            expect(grace.receive()).toEqual([]);
          })
        );
        yield* Effect.promise(() => later(20));
        // Messages as bytes and notices as text, as any wire would carry them.
        expect(heard).toEqual([
          Message.encodeNotice({ joined: "ada" }),
          Message.encodeNotice({ joined: "grace" }),
          Message.encode(message("ada", 0, 7)),
          Message.encode(message("grace", 0)),
          Message.encodeNotice({ left: "grace" }),
          Message.encodeNotice({ left: "ada" }),
        ]);
        stranger.close();
      })
  );

  it.effect(
    "closes its channel, and stops listening to it, when its scope closes",
    () =>
      Effect.gen(function* () {
        // A stand-in for the page's own, which notes what is done to it.
        const made: {
          name: string;
          closed: boolean;
          onmessage: unknown;
          posted: unknown[];
        }[] = [];
        vi.stubGlobal(
          "BroadcastChannel",
          class {
            readonly record;
            constructor(name: string) {
              this.record = {
                name,
                closed: false,
                onmessage: null as unknown,
                posted: [] as unknown[],
              };
              made.push(this.record);
            }
            set onmessage(listener: unknown) {
              this.record.onmessage = listener;
            }
            postMessage(data: unknown): void {
              this.record.posted.push(data);
            }
            close(): void {
              this.record.closed = true;
            }
          }
        );
        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const layer = Transport.layerBroadcastChannel(
                  "game/room",
                  "ada"
                );
                // A layer opens nothing: opening the transport does.
                yield* Layer.build(layer);
                expect(made).toHaveLength(0);
                const transport = yield* Transport.listen.pipe(
                  Effect.provide(layer)
                );
                expect(made).toHaveLength(1);
                expect(made[0]!.name).toBe("game/room");
                expect(typeof made[0]!.onmessage).toBe("function");
                expect(made[0]!.closed).toBe(false);
                transport.send(message("ada", 0));
                expect(made[0]!.posted).toEqual([
                  Message.encodeNotice({ joined: "ada" }),
                  Message.encode(message("ada", 0)),
                ]);
              })
            );
            expect(made[0]!.posted.at(-1)).toBe(
              Message.encodeNotice({ left: "ada" })
            );
            expect(made[0]!.closed).toBe(true);
            expect(made[0]!.onmessage).toBeNull();
          }),
          Effect.sync(() => vi.unstubAllGlobals())
        );
      })
  );

  it.effect(
    "lasts as long as its connection, whatever its layer is provided to, and closes the session with it, saying so when used after",
    () =>
      Effect.gen(function* () {
        const name = nextRoom();
        const outside = new BroadcastChannel(name);
        const heard: unknown[] = [];
        outside.onmessage = (event: MessageEvent<unknown>) => {
          heard.push(event.data);
        };
        const log: string[] = [];
        const Held = Plugin.make("tr/Held", {
          layer: Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.sync(() => log.push("acquired")),
              () => Effect.sync(() => log.push("released"))
            )
          ),
        });
        // Provided to the one line that connects, in a scope that is gone once
        // the line has run: it lasts all the same.
        const connected = yield* Effect.scoped(
          Effect.flatMap(
            Session.make(App.define({ plugins: [Held] }), {
              seed: 5,
              me: "ada",
              others: ["grace"],
              delta: DELTA,
            }),
            (session) =>
              Transport.connect(session).pipe(
                Effect.provide(Transport.layerBroadcastChannel(name, "ada"))
              )
          )
        );
        expect(yield* connected.tick()).toBe(true);
        yield* Effect.promise(() =>
          until(
            () => heard.length > 1,
            "the notice that ada joined, and its first message, were heard"
          )
        );
        expect(log).toEqual(["acquired"]);
        yield* connected.close;
        expect(log).toEqual(["acquired", "released"]);
        // Closing it again does nothing.
        yield* connected.close;
        expect(log).toEqual(["acquired", "released"]);
        outside.postMessage(Message.encode(message("grace", 0)));
        yield* Effect.promise(() => later(20));
        // It says so, in place of a game that waits for ever.
        expect(yield* thrown(connected.tick())).toThrow(
          /The transport "arcadekit-test\/.*" was used after it was let go, and its channel closed: the connection Transport\.connect made was closed/u
        );
        // As one listened on in a scope does once the scope has closed.
        const kept = yield* Effect.scoped(
          Transport.listen.pipe(
            Effect.provide(Transport.layerBroadcastChannel(name, "ada"))
          )
        );
        expect(() => kept.send(message("ada", 0))).toThrow(
          /or the scope Transport\.listen ran in had ended/u
        );
        outside.close();
      })
  );

  it.effect(
    "says a peer left when its connection closes, and joined when it listens again",
    () =>
      Effect.gen(function* () {
        const name = nextRoom();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const [ada, grace] = (yield* seated(
              ["ada", "grace"],
              (peer) => Transport.layerBroadcastChannel(name, peer),
              8
            )) as [Seat, Seat];
            yield* ada.connected.tick();
            yield* grace.connected.tick();
            yield* grace.connected.close;
            yield* waitUntil(
              Effect.gen(function* () {
                yield* ada.connected.tick();
                return ada.connected.away.length > 0;
              }),
              "ada heard that grace left"
            );
            expect(ada.connected.away).toEqual(["grace"]);
            yield* Transport.listen.pipe(
              Effect.provide(Transport.layerBroadcastChannel(name, "grace"))
            );
            yield* waitUntil(
              Effect.gen(function* () {
                yield* ada.connected.tick();
                return ada.connected.away.length === 0;
              }),
              "ada heard that grace joined again"
            );
          })
        );
      })
  );

  it.effect(
    "fails the tick once a peer whose tab closed stays away longer than awayFor",
    () =>
      Effect.gen(function* () {
        const name = nextRoom();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const [ada, grace] = (yield* seated(
              ["ada", "grace"],
              (peer) => Transport.layerBroadcastChannel(name, peer),
              8,
              { awayFor: 0 }
            )) as [Seat, Seat];
            yield* ada.connected.tick();
            yield* grace.connected.close;
            let thrown: unknown;
            yield* waitUntil(
              Effect.gen(function* () {
                const ticked = yield* Effect.result(ada.connected.tick());
                thrown = Result.isFailure(ticked) ? ticked.failure : undefined;
                return thrown !== undefined;
              }),
              "ada's tick failed"
            );
            expect(thrown).toEqual(
              new Transport.Left({ peers: ["grace"], awayFor: 0 })
            );
          })
        );
      })
  );

  it.effect("keeps two peers the same game, each ticking in its own time", () =>
    Effect.gen(function* () {
      const name = nextRoom();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const seats = yield* seated(
            ["ada", "grace"],
            (peer) => Transport.layerBroadcastChannel(name, peer),
            8
          );
          const act = players(21);
          const [ada, grace] = seats as [Seat, Seat];
          for (let i = 0; i < 60; i++) {
            for (const seat of seats) {
              if (i < 40) {
                yield* act(seat);
              }
              yield* seat.connected.tick();
              // The other end hears in its own time, not in this loop's.
              yield* Effect.promise(() => later(1));
            }
          }
          for (
            let i = 0;
            i < 200 &&
            (ada.app.time.tick !== grace.app.time.tick ||
              ada.session.confirmed < ada.app.time.tick - 1);
            i++
          ) {
            yield* Effect.promise(() => later(2));
            yield* (
              ada.app.time.tick <= grace.app.time.tick ? ada : grace
            ).connected.tick();
          }
          expect(ada.app.time.tick).toBe(grace.app.time.tick);
          expect(ada.app.time.tick).toBeGreaterThan(40);
          expect(moves(ada.app.actionLog).length).toBeGreaterThan(10);
          expect(ada.world.hash()).toBe(grace.world.hash());
          expect(ada.app.actionLog).toEqual(grace.app.actionLog);
          expect(ada.session.drifted).toBeUndefined();
          expect(grace.session.drifted).toBeUndefined();
        })
      );
    })
  );
});
