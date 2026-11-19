import { Context, Effect, Layer, Result } from "effect";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { App, Driver, Lockstep, Rollback, Transport } from "../src/index";
import {
  DELTA,
  Drop,
  driftOf,
  game,
  moves,
  players,
  setGlitch,
  withApp,
} from "./peers";
import type { Game } from "./peers";

const message = (from: string, tick: number, value = 0): Lockstep.Message => ({
  from,
  tick,
  actions:
    value === 0 ? [] : [{ name: "ls/Drop", payload: { by: from, value } }],
});

interface Seat {
  readonly name: string;
  readonly app: Game;
  readonly session: Rollback.Session;
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
      const app = yield* game();
      const options = { peer: name, peers: names, delta: DELTA };
      const session =
        ahead === undefined
          ? Lockstep.make(app, options)
          : Rollback.make(app, { ...options, ahead });
      // Each peer is a program of its own, with a transport that lasts as
      // long as it does: here they share a scope, so each one's layer is
      // built into it.
      const transport = yield* Layer.build(layerOf(name));
      const connected = yield* Transport.connect(session).pipe(
        Effect.provide(transport)
      );
      seats.push({ name, app, session, connected });
    }
    return seats;
  });

describe("a hub, the network in memory", () => {
  it("carries what one port sends to every other, and not back", () => {
    const hub = Transport.makeHub();
    const ada = hub.port("ada");
    const grace = hub.port("grace");
    const edsger = hub.port("edsger");
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
        order.push(...grace.receive().map((arrived) => arrived.tick));
      }
      for (let i = 0; i < 6; i++) {
        hub.step();
        order.push(...grace.receive().map((arrived) => arrived.tick));
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
          expect(grace.receive().map((sent) => sent.tick)).toEqual([0, 1, 2]);
          for (let tick = 0; tick <= 2; tick++) {
            grace.send(message("grace", tick));
          }
          expect(ada!.connected.tick()).toBe(true);
          expect(ada!.connected.tick()).toBe(true);
          expect(ada!.connected.tick()).toBe(true);
          expect(ada!.app.time.tick).toBe(3);
          expect(moves(ada!.app.actionLog)).toHaveLength(1);
          expect(grace.receive().map((sent) => sent.tick)).toEqual([3, 4]);
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
                  act(seat);
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
            const [ada, grace] = seats;
            assert(ada !== undefined && grace !== undefined);
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
            if (ahead !== undefined) {
              expect(ada.session.rewinds).toBeGreaterThan(0);
            }
            withApp(game(), (alone) => {
              App.replay(alone, ada.app.actionLog, {
                delta: DELTA,
                ticks: ada.app.time.tick,
              });
              expect(alone.world.hash()).toBe(ada.app.world.hash());
            });
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
            expect(driftOf(stopped, "ada").hashes).toEqual(
              driftOf(stopped, "grace").hashes
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
          const app = yield* game();
          let drawn = 0;
          const connected = yield* Transport.connect({
            ...Lockstep.make(app, {
              peer: "ada",
              peers: ["ada"],
              delta: DELTA,
            }),
            frame: () => {
              drawn++;
            },
          }).pipe(Effect.provide(hub.layer("ada")));
          Driver.fixedStep(connected, { hz: 30 })(DELTA);
          expect(drawn).toBe(1);
          expect(app.time.tick).toBe(1);
        })
      )
    );
  });

  it("does not compile without a transport", () => {
    withApp(game(), (app) => {
      const session = Lockstep.make(app, {
        peer: "ada",
        peers: ["ada"],
        delta: DELTA,
      });
      expect(() =>
        Effect.runSync(
          // @ts-expect-error A game of several peers is given a transport.
          Transport.connect(session)
        )
      ).toThrow(/Transport/u);
      const hub = Transport.makeHub();
      const made = Effect.runSync(
        Transport.connect(session).pipe(
          Effect.provide(Transport.layer(hub.port("ada")))
        )
      );
      expect(made.tick()).toBe(true);
    });
  });
});

describe("a transport over text", () => {
  it("sends a message as text, and reads the texts that are messages", () => {
    const sent: string[] = [];
    let deliver: (arrived: unknown) => void = () => {};
    let listening = 0;
    const transport = Transport.text({
      send: (text) => {
        sent.push(text);
      },
      listen(onArrival) {
        deliver = onArrival;
        listening++;
        return () => {
          listening--;
        };
      },
    });
    transport.send(message("ada", 3, 2));
    expect(sent).toEqual([Lockstep.encode(message("ada", 3, 2))]);
    deliver(Lockstep.encode(message("grace", 0)));
    deliver("not a message");
    deliver(JSON.stringify({ from: "grace", tick: -1, actions: [] }));
    deliver(new ArrayBuffer(8));
    deliver(Lockstep.encode(message("grace", 1, 5)));
    // What is not a message is dropped, and counted.
    expect(transport.receive()).toEqual([
      message("grace", 0),
      message("grace", 1, 5),
    ]);
    expect(transport.dropped).toBe(3);
    expect(transport.receive()).toEqual([]);
    expect(listening).toBe(1);
    transport.close();
    expect(listening).toBe(0);
  });
});

/** A turn of the event loop or two: a channel delivers in its own time. */
const later = (ms = 5): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
          const open = Effect.map(
            Layer.build(Transport.layerBroadcastChannel(name)),
            (context) => Context.get(context, Transport.Transport)
          );
          const ada = yield* open;
          const grace = yield* open;
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
      Lockstep.encode(message("ada", 0, 7)),
      Lockstep.encode(message("grace", 0)),
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
        readonly record: (typeof made)[number];
        constructor(name: string) {
          this.record = { name, closed: false, onmessage: null, posted: [] };
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
            const context = yield* Layer.build(
              Transport.layerBroadcastChannel("game/room")
            );
            const transport = Context.get(context, Transport.Transport);
            expect(made).toHaveLength(1);
            expect(made[0]!.name).toBe("game/room");
            expect(typeof made[0]!.onmessage).toBe("function");
            expect(made[0]!.closed).toBe(false);
            transport.send(message("ada", 0));
            expect(made[0]!.posted).toEqual([
              Lockstep.encode(message("ada", 0)),
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

  it("stops hearing when its scope has closed", async () => {
    const name = nextRoom();
    const outside = new BroadcastChannel(name);
    // Provided to the one line that asks for it, and gone with that line.
    const kept = await Effect.runPromise(
      Transport.Transport.pipe(
        Effect.provide(Transport.layerBroadcastChannel(name))
      )
    );
    outside.postMessage(Lockstep.encode(message("grace", 0)));
    await later(20);
    // It says so, in place of a game that waits for ever.
    expect(() => kept.receive()).toThrow(
      /was used after its scope had closed.*provide it to the whole program/u
    );
    expect(() => kept.send(message("ada", 0))).toThrow(
      /was used after its scope had closed/u
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
          const [ada, grace] = seats;
          assert(ada !== undefined && grace !== undefined);
          for (let i = 0; i < 60; i++) {
            for (const seat of seats) {
              if (i < 40) {
                act(seat);
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
