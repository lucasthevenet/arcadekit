import { Effect, Layer, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, Driver, Journal } from "../src/index";
import { Drift, Message, Session, Transport } from "../src/net/index";
import {
  CoinGame,
  DELTA,
  Drop,
  moves,
  players,
  setGlitch,
  withApp,
} from "./peers";
import type { Peer, SteeredGame } from "./peers";

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

interface Seat {
  readonly name: string;
  readonly app: SteeredGame;
  readonly session: Peer["session"];
  readonly connected: Transport.Connected;
}

/** Peers of the game, each joined to a layer of its own. */
const seated = (
  names: readonly string[],
  layerOf: (name: string) => ReturnType<typeof Transport.layer>,
  ahead: number | undefined
) =>
  Effect.gen(function* () {
    const seats: Seat[] = [];
    for (const name of names) {
      const session = yield* Session.make(CoinGame, {
        seed: 5,
        checkpointEvery: 1,
        peer: name,
        peers: names,
        delta: DELTA,
        ahead: ahead ?? 0,
      });
      // Provided to the one line that connects: the transport is opened
      // in the scope of the program, and lasts as long as it does.
      const connected = yield* Transport.connect(session).pipe(
        Effect.provide(layerOf(name))
      );
      seats.push({ name, app: session.app, session, connected });
    }
    return seats;
  });

/** As the players of `peers.ts` see a peer. */
const asPeer = (seat: Seat): Peer => seat as unknown as Peer;

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

  it("is handed what arrived, steps, and sends what it has to say", () => {
    const hub = Transport.makeHub();
    const grace = hub.port("grace");
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const [ada] = yield* seated(
            ["ada", "grace"],
            (name) => hub.layer(name),
            undefined
          );
          ada!.app.enqueue(Drop, { by: "ada", value: 4 });
          // It waits for grace, and has said its piece all the same.
          expect(ada!.connected.tick()).toBe(false);
          expect(messagesIn(grace.receive()).map((sent) => sent.tick)).toEqual([
            0, 1, 2,
          ]);
          for (let tick = 0; tick <= 2; tick++) {
            grace.send(message("grace", tick));
          }
          expect(ada!.connected.tick()).toBe(true);
          expect(ada!.connected.tick()).toBe(true);
          expect(ada!.connected.tick()).toBe(true);
          expect(ada!.app.time.tick).toBe(3);
          expect(moves(ada!.app.actionLog)).toHaveLength(1);
          expect(messagesIn(grace.receive()).map((sent) => sent.tick)).toEqual([
            3, 4,
          ]);
        })
      )
    );
  });

  it("keeps peers the same game under a driver, with lockstep and with rollback", () => {
    for (const ahead of [undefined, 8]) {
      const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 7 });
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const seats = yield* seated(
              ["ada", "grace"],
              (name) => hub.layer(name),
              ahead
            );
            const steps = seats.map((seat) =>
              Driver.fixedStep(seat.connected, { hz: 30 })
            );
            const act = players(11);
            const frame = (acting: boolean): void => {
              hub.step();
              seats.forEach((seat, index) => {
                if (acting) {
                  act(asPeer(seat));
                }
                steps[index]!(DELTA);
              });
            };
            for (let i = 0; i < 200; i++) {
              frame(true);
            }
            // To rest, and then to the same tick.
            for (let i = 0; i < 30; i++) {
              frame(false);
            }
            const [ada, grace] = seats as [Seat, Seat];
            for (
              let i = 0;
              i < 50 && ada.app.time.tick !== grace.app.time.tick;
              i++
            ) {
              hub.step();
              (ada.app.time.tick < grace.app.time.tick
                ? ada
                : grace
              ).connected.tick();
            }
            expect(ada.app.time.tick).toBe(grace.app.time.tick);
            expect(ada.app.time.tick).toBeGreaterThan(
              ahead === undefined ? 60 : 200
            );
            expect(ada.app.world.hash()).toBe(grace.app.world.hash());
            expect(ada.app.actionLog).toEqual(grace.app.actionLog);
            expect(moves(ada.app.actionLog).length).toBeGreaterThan(30);
            expect(ada.session.drifted).toBeUndefined();
            // Only a game played with rollback goes back.
            expect(ada.session.rewinds > 0).toBe(ahead !== undefined);
            const whole = ada.app.record();
            const alone = yield* Journal.replay(whole, (start) =>
              App.make(CoinGame, { ...start, checkpointEvery: 1 })
            );
            expect(alone.world.hash()).toBe(ada.app.world.hash());
          })
        )
      );
    }
  });

  it("plays on to the same game when a peer is cut off and comes back, with what was lost sent again", () => {
    for (const ahead of [undefined, 8]) {
      const hub = Transport.makeHub({ delay: { min: 0, max: 3 }, seed: 9 });
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const seats = yield* seated(
              ["ada", "edsger", "grace"],
              (name) => hub.layer(name),
              ahead
            );
            const [ada, edsger, grace] = seats as [Seat, Seat, Seat];
            const act = players(13);
            const frame = (acting: boolean): void => {
              hub.step();
              for (const seat of seats) {
                if (acting) {
                  act(asPeer(seat));
                }
                seat.connected.tick();
              }
            };
            for (let i = 0; i < 60; i++) {
              frame(true);
            }
            // Grace's socket drops, with what was on its way to and from it.
            hub.disconnect("grace");
            for (let i = 0; i < 40; i++) {
              frame(true);
            }
            expect(ada.connected.away).toEqual(["grace"]);
            expect(edsger.connected.away).toEqual(["grace"]);
            expect(grace.connected.away).toEqual([]);
            // The others went no further than grace's word allows.
            expect(ada.session.waitingFor).toEqual(["grace"]);
            hub.reconnect("grace");
            for (let i = 0; i < 100; i++) {
              frame(true);
            }
            expect(ada.connected.away).toEqual([]);
            for (let i = 0; i < 30; i++) {
              frame(false);
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
                  seat.connected.tick();
                }
              }
            }
            expect(edsger.app.time.tick).toBe(ada.app.time.tick);
            expect(grace.app.time.tick).toBe(ada.app.time.tick);
            expect(ada.app.time.tick).toBeGreaterThan(100);
            for (const seat of [edsger, grace]) {
              expect(seat.app.world.hash()).toBe(ada.app.world.hash());
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
              frame(false);
            }
            for (const seat of seats) {
              expect(seat.session.unheard).toBeLessThanOrEqual(
                seat.session.delay + (ahead ?? 0) + 6
              );
            }
          })
        )
      );
    }
  });

  it("sends a stopped session's last word, so that every peer stops", () => {
    // With no delay the second peer finds the difference in the very tick
    // it would have said its own hash in: unless that tick sends as it
    // fails, the first never hears it, and waits.
    for (const delay of [0, { min: 0, max: 3 }]) {
      const hub = Transport.makeHub({ delay, seed: 3 });
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const seats = yield* seated(
              ["ada", "grace"],
              (name) => hub.layer(name),
              undefined
            );
            setGlitch({ tick: 9, worlds: "all" });
            seats[0]!.app.enqueue(Drop, { by: "ada", value: 1 });
            const stopped = new Map<string, unknown>();
            for (let i = 0; i < 200 && stopped.size < 2; i++) {
              hub.step();
              for (const seat of seats) {
                const ticked = Result.try(() => seat.connected.tick());
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
        )
      );
    }
  });

  it("draws the game through the session", () => {
    const hub = Transport.makeHub();
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(CoinGame, {
            seed: 5,
            checkpointEvery: 1,
            peer: "ada",
            peers: ["ada"],
            delta: DELTA,
            ahead: 0,
          });
          let drawn = 0;
          const connected = yield* Transport.connect({
            ...session,
            frame: () => {
              drawn++;
            },
          }).pipe(Effect.provide(hub.layer("ada")));
          Driver.fixedStep(connected, { hz: 30 })(DELTA);
          expect(drawn).toBe(1);
          expect(session.app.time.tick).toBe(1);
        })
      )
    );
  });

  it("does not compile without a transport", () => {
    withApp(
      Session.make(CoinGame, {
        seed: 5,
        checkpointEvery: 1,
        peer: "ada",
        peers: ["ada"],
        delta: DELTA,
        ahead: 0,
      }),
      (session) => {
        expect(() =>
          Effect.runSync(
            // @ts-expect-error A game of several peers is given a transport.
            Transport.connect(session)
          )
        ).toThrow(/Transport/u);
        const hub = Transport.makeHub();
        const made = Effect.runSync(
          Effect.scoped(
            Transport.connect(session).pipe(
              Effect.provide(Transport.layer(hub.port("ada")))
            )
          )
        );
        expect(made.tick()).toBe(true);
        // Nor without the scope the transport is opened in. A hand-made
        // transport is open already, so this one runs all the same.
        Effect.runSync(
          // @ts-expect-error A transport is opened in a scope.
          Transport.connect(session).pipe(
            Effect.provide(Transport.layer(hub.port("ada")))
          )
        );
      }
    );
  });
});

describe("a transport over text", () => {
  it("sends a message as text, and reads the texts that are messages", () => {
    const sent: string[] = [];
    let deliver: (text: string) => void = () => {};
    let listening = 0;
    const transport = Transport.text({
      send: (text) => {
        sent.push(text);
      },
      listen(onText) {
        deliver = onText;
        listening++;
        return () => {
          listening--;
        };
      },
    });
    transport.send(message("ada", 3, 2));
    expect(sent).toEqual([Message.encode(message("ada", 3, 2))]);
    deliver(Message.encode(message("grace", 0)));
    deliver("not a message");
    deliver(JSON.stringify({ from: "grace", tick: -1, actions: [] }));
    deliver(Message.encode(message("grace", 1, 5)));
    // What is not a message is dropped, and counted.
    expect(transport.receive()).toEqual([
      message("grace", 0),
      message("grace", 1, 5),
    ]);
    expect(transport.dropped).toBe(2);
    expect(transport.receive()).toEqual([]);
    expect(listening).toBe(1);
    transport.close();
    expect(listening).toBe(0);
    // Closed, it says so, in place of a game that waits for ever.
    expect(() => transport.receive()).toThrow(
      /A transport over text was used after it was closed/u
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

describe("the transport between tabs, a BroadcastChannel", () => {
  const nextRoom = (): string => `arcadekit-test/${crypto.randomUUID()}`;

  it("carries messages to whoever opened the same name, and closes with its scope", async () => {
    const name = nextRoom();
    const stranger = new BroadcastChannel(name);
    const heard: unknown[] = [];
    stranger.onmessage = (event: MessageEvent<unknown>) => {
      heard.push(event.data);
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const listen = Transport.listen.pipe(
            Effect.provide(Transport.layerBroadcastChannel(name))
          );
          const ada = yield* listen;
          const grace = yield* listen;
          ada.send(message("ada", 0, 7));
          grace.send(message("grace", 0));
          // Whatever else is posted under the name is not a message.
          stranger.postMessage({ not: "text" });
          stranger.postMessage("nor is this");
          yield* Effect.promise(() => later(20));
          expect(grace.receive()).toEqual([message("ada", 0, 7)]);
          expect(ada.receive()).toEqual([message("grace", 0)]);
          expect(grace.receive()).toEqual([]);
        })
      )
    );
    // As text, as any wire would carry it.
    expect(heard).toEqual([
      Message.encode(message("ada", 0, 7)),
      Message.encode(message("grace", 0)),
    ]);
    stranger.close();
  });

  it("closes its channel, and stops listening to it, when its scope closes", () => {
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
    try {
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const layer = Transport.layerBroadcastChannel("game/room");
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
              Message.encode(message("ada", 0)),
            ]);
          })
        )
      );
      expect(made[0]!.closed).toBe(true);
      expect(made[0]!.onmessage).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lasts as long as the program that opened it, whatever its layer is provided to", async () => {
    const name = nextRoom();
    const outside = new BroadcastChannel(name);
    const heard: unknown[] = [];
    outside.onmessage = (event: MessageEvent<unknown>) => {
      heard.push(event.data);
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Provided to the one line that connects, and open after it.
          const session = yield* Session.make(CoinGame, {
            seed: 5,
            peer: "ada",
            peers: ["ada", "grace"],
            delta: DELTA,
          });
          const connected = yield* Transport.connect(session).pipe(
            Effect.provide(Transport.layerBroadcastChannel(name))
          );
          expect(connected.tick()).toBe(true);
          yield* Effect.promise(() =>
            until(() => heard.length > 0, "the first message was heard")
          );
        })
      )
    );
    outside.close();
  });

  it("stops hearing when the scope it was opened in has closed, and says so", async () => {
    const name = nextRoom();
    const outside = new BroadcastChannel(name);
    // Opened in a scope that is gone once the line has run.
    const kept = await Effect.runPromise(
      Effect.scoped(
        Transport.listen.pipe(
          Effect.provide(Transport.layerBroadcastChannel(name))
        )
      )
    );
    outside.postMessage(Message.encode(message("grace", 0)));
    await later(20);
    // It says so, in place of a game that waits for ever.
    expect(() => kept.receive()).toThrow(
      /was used after the scope it was opened in had closed.*drive the session in that program/u
    );
    expect(() => kept.send(message("ada", 0))).toThrow(
      /was used after the scope it was opened in had closed/u
    );
    outside.close();
  });

  it("keeps two peers the same game, each ticking in its own time", async () => {
    const name = nextRoom();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seats = yield* seated(
            ["ada", "grace"],
            () => Transport.layerBroadcastChannel(name),
            8
          );
          const act = players(21);
          const [ada, grace] = seats as [Seat, Seat];
          for (let i = 0; i < 60; i++) {
            for (const seat of seats) {
              if (i < 40) {
                act(asPeer(seat));
              }
              seat.connected.tick();
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
            (ada.app.time.tick <= grace.app.time.tick
              ? ada
              : grace
            ).connected.tick();
          }
          expect(ada.app.time.tick).toBe(grace.app.time.tick);
          expect(ada.app.time.tick).toBeGreaterThan(40);
          expect(moves(ada.app.actionLog).length).toBeGreaterThan(10);
          expect(ada.app.world.hash()).toBe(grace.app.world.hash());
          expect(ada.app.actionLog).toEqual(grace.app.actionLog);
          expect(ada.session.drifted).toBeUndefined();
          expect(grace.session.drifted).toBeUndefined();
        })
      )
    );
  });
});
