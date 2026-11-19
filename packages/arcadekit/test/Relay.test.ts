import { Cause, Context, Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { Lockstep, Relay, Rollback, Transport } from "../src/index";
import { DELTA, game, moves, players, purseOf } from "./Peers";
import type { Game, Peer } from "./Peers";

const message = (from: string, tick: number, value = 0): Lockstep.Message => ({
  from,
  tick,
  actions: value === 0 ? [] : [{ name: "ls/Tip", payload: { amount: value } }],
});

const text = (from: string, tick: number, value = 0): string =>
  Lockstep.encode(message(from, tick, value));

const refusal = <A>(exit: Exit.Exit<A, Relay.Refused>): Relay.Refused => {
  if (Exit.isSuccess(exit)) {
    throw new Error("it was let through");
  }

  return Cause.squash(exit.cause) as Relay.Refused;
};

const ada = { room: "blue", peer: "ada" };
const grace = { room: "blue", peer: "grace" };
const edsger = { room: "blue", peer: "edsger" };
const linus = { room: "red", peer: "linus" };

describe("a relay's address", () => {
  it("names the room and the peer, and is read back by join", () => {
    expect(Relay.address("wss://relay.example.com/rooms", ada)).toBe(
      "wss://relay.example.com/rooms/blue?peer=ada"
    );
    // A slash at the end of the relay's own address changes nothing.
    expect(Relay.address("ws://localhost:8787/", ada)).toBe(
      "ws://localhost:8787/blue?peer=ada"
    );

    for (const member of [
      ada,
      { room: "the blue room/7", peer: "ada & grace?" },
      { room: "部屋", peer: "エイダ" },
    ]) {
      expect(
        Relay.join(Relay.address("wss://r.example/rooms", member), [])
      ).toStrictEqual(Exit.succeed(member));
    }

    // A host is often handed the path alone.
    expect(Relay.join("/rooms/blue?peer=ada", [])).toStrictEqual(
      Exit.succeed(ada)
    );
  });
});

describe("a peer that asks to come in", () => {
  it("is let in beside whoever is there, under a name nobody has", () => {
    expect(Relay.join("/blue?peer=grace", [ada, linus])).toStrictEqual(
      Exit.succeed(grace)
    );
    // The same name in another room is another peer.
    expect(Relay.join("/red?peer=ada", [ada, linus])).toStrictEqual(
      Exit.succeed({ room: "red", peer: "ada" })
    );
  });

  it("is refused when its name is taken in that room", () => {
    const refused = refusal(Relay.join("/blue?peer=ada", [ada, grace]));
    expect(refused).toStrictEqual(
      new Relay.Refused({
        reason: "name taken",
        message: 'A peer named "ada" is in the room "blue" already.',
        status: 409,
        code: 1008,
      })
    );
  });

  it("is refused when the room is full", () => {
    expect(
      refusal(Relay.join("/blue?peer=edsger", [ada, grace], { maxPeers: 2 }))
    ).toStrictEqual(
      new Relay.Refused({
        reason: "room full",
        message: 'The room "blue" has the 2 peers it takes.',
        status: 403,
        code: 1008,
      })
    );
    // Whoever is in another room does not count.
    expect(
      Exit.isSuccess(
        Relay.join("/blue?peer=grace", [ada, linus], { maxPeers: 2 })
      )
    ).toBe(true);

    // Eight, unless told.
    const eight = Array.from({ length: 8 }, (_, n) => ({
      room: "blue",
      peer: `p${n}`,
    }));

    expect(Exit.isSuccess(Relay.join("/blue?peer=x", eight.slice(1)))).toBe(
      true
    );
    expect(refusal(Relay.join("/blue?peer=x", eight)).reason).toBe("room full");
  });

  it("is refused when the room lets in only names it is not one of", () => {
    const options = { peers: ["ada", "grace"] };
    expect(Exit.isSuccess(Relay.join("/blue?peer=grace", [ada], options))).toBe(
      true
    );
    const refused = refusal(Relay.join("/blue?peer=mallory", [ada], options));
    expect(refused.reason).toBe("not a peer");
    expect(refused.status).toBe(403);
    expect(refused.message).toBe(
      '"mallory" is not one of the peers the room "blue" lets in.'
    );
  });

  it("is refused at an address that names no room or no peer", () => {
    for (const url of [
      "/blue",
      "/blue?peer=",
      "/?peer=ada",
      "?peer=ada",
      "/blue?name=ada",
      `/${"r".repeat(65)}?peer=ada`,
      `/blue?peer=${"p".repeat(65)}`,
      "/%E0%A4%A?peer=ada",
      "http://[bad/blue?peer=ada",
    ]) {
      const refused = refusal(Relay.join(url, []));
      expect(refused.reason, url).toBe("not an address");
      expect(refused.status, url).toBe(400);
    }

    // As long as a name may be.
    expect(
      Exit.isSuccess(
        Relay.join(`/${"r".repeat(64)}?peer=${"p".repeat(64)}`, [])
      )
    ).toBe(true);
  });
});

describe("what a member sent", () => {
  it("is passed on to every other member of its room, and to nobody else", () => {
    const deliveries = Relay.forward(ada, text("ada", 3, 2), [
      ada,
      grace,
      linus,
      edsger,
    ]);

    expect(deliveries).toStrictEqual(
      Exit.succeed([
        { to: grace, text: text("ada", 3, 2) },
        { to: edsger, text: text("ada", 3, 2) },
      ])
    );
    // Alone in its room, to nobody.
    expect(Relay.forward(linus, text("linus", 0), [ada, linus])).toStrictEqual(
      Exit.succeed([])
    );
  });

  it("is read whether it came as text or as bytes, and written out again as the message it is", () => {
    const bytes = new TextEncoder().encode(text("ada", 1));

    for (const data of [bytes, bytes.buffer]) {
      expect(Relay.forward(ada, data, [ada, grace])).toStrictEqual(
        Exit.succeed([{ to: grace, text: text("ada", 1) }])
      );
    }

    // What rides along and is no part of a message is not passed on.
    const padded = JSON.stringify({
      ...message("ada", 1),
      extra: "x".repeat(100),
    });

    expect(Relay.forward(ada, padded, [ada, grace])).toStrictEqual(
      Exit.succeed([{ to: grace, text: text("ada", 1) }])
    );
  });

  it("is refused when it says it is from anyone but the member that sent it", () => {
    const refused = refusal(
      Relay.forward(ada, text("grace", 3, 9), [ada, grace, edsger])
    );

    expect(refused).toStrictEqual(
      new Relay.Refused({
        reason: "speaks for another",
        message:
          '"ada" sent a message that says it is from "grace". A peer speaks for itself.',
        status: 403,
        code: 1008,
      })
    );
  });

  it("is refused when it is not a message", () => {
    for (const data of ["", "hello", "{}", JSON.stringify({ from: "ada" })]) {
      const refused = refusal(Relay.forward(ada, data, [ada, grace]));
      expect(refused.reason, data).toBe("not a message");
      expect(refused.code, data).toBe(1007);
    }
  });

  it("is refused when it is longer than the relay takes", () => {
    const long = JSON.stringify({
      ...message("ada", 1),
      actions: [{ name: "ls/Tip", payload: "x".repeat(200) }],
    });

    expect(Exit.isSuccess(Relay.forward(ada, long, [ada, grace]))).toBe(true);

    const refused = refusal(
      Relay.forward(ada, long, [ada, grace], { maxLength: 100 })
    );

    expect(refused.reason).toBe("too long");
    expect(refused.code).toBe(1009);

    // 65,536 characters, unless told.
    const huge = JSON.stringify({
      ...message("ada", 1),
      actions: [{ name: "ls/Tip", payload: "x".repeat(65_536) }],
    });

    expect(refusal(Relay.forward(ada, huge, [ada, grace])).reason).toBe(
      "too long"
    );
  });
});

describe("a relay that keeps its rooms itself", () => {
  it("sends what a peer sent to the others in its room", () => {
    const relay = Relay.make();
    const got: Record<string, string[]> = { ada: [], grace: [], linus: [] };

    const connect = (url: string, name: string) => {
      const connection = relay.connect(url, (sent) => got[name]!.push(sent));

      if (Exit.isFailure(connection)) {
        throw new Error("it was refused");
      }

      return connection.value;
    };

    const first = connect("/blue?peer=ada", "ada");
    const second = connect("/blue?peer=grace", "grace");
    const third = connect("/red?peer=linus", "linus");
    expect(first.member).toStrictEqual(ada);
    expect(relay.members("blue")).toStrictEqual([ada, grace]);
    expect(relay.rooms).toBe(2);
    expect(first.receive(text("ada", 0, 4))).toStrictEqual(Exit.void);
    expect(second.receive(text("grace", 0))).toStrictEqual(Exit.void);
    expect(third.receive(text("linus", 0))).toStrictEqual(Exit.void);
    expect(got).toStrictEqual({
      ada: [text("grace", 0)],
      grace: [text("ada", 0, 4)],
      linus: [],
    });
    // A refusal is the host's to act on: nothing is sent.
    expect(refusal(first.receive(text("grace", 1))).reason).toBe(
      "speaks for another"
    );
    expect(got.grace).toHaveLength(1);
  });

  it("refuses a name that is taken, and frees it when its peer has gone", () => {
    const relay = Relay.make({ maxPeers: 2 });
    const none = (): void => {};
    const first = relay.connect("/blue?peer=ada", none);
    expect(refusal(relay.connect("/blue?peer=ada", none)).reason).toBe(
      "name taken"
    );
    relay.connect("/blue?peer=grace", none);
    expect(refusal(relay.connect("/blue?peer=edsger", none)).reason).toBe(
      "room full"
    );

    if (Exit.isSuccess(first)) {
      first.value.close();
      // Closing twice frees nobody else's name.
      first.value.close();
    }

    expect(relay.members("blue")).toStrictEqual([grace]);
    const again = relay.connect("/blue?peer=ada", none);
    expect(Exit.isSuccess(again)).toBe(true);

    // The first connection's close, come late, does not take the new one out.
    if (Exit.isSuccess(first)) {
      first.value.close();
    }

    expect(relay.members("blue")).toStrictEqual([grace, ada]);
  });

  it("holds what its members send to the limits it was made with", () => {
    const relay = Relay.make({ maxLength: 60, peers: ["ada", "grace"] });
    const sent: string[] = [];
    const first = relay.connect("/blue?peer=ada", () => {});
    relay.connect("/blue?peer=grace", (arrived) => sent.push(arrived));
    expect(refusal(relay.connect("/blue?peer=edsger", () => {})).reason).toBe(
      "not a peer"
    );

    if (Exit.isFailure(first)) {
      throw new Error("ada was refused");
    }

    expect(first.value.receive(text("ada", 0))).toStrictEqual(Exit.void);
    expect(refusal(first.value.receive(text("ada", 1, 123_456))).reason).toBe(
      "too long"
    );
    expect(sent).toStrictEqual([text("ada", 0)]);
  });

  it("forgets a room when the last peer has left it", () => {
    const relay = Relay.make();
    const one = relay.connect("/blue?peer=ada", () => {});
    const two = relay.connect("/blue?peer=grace", () => {});
    expect(relay.rooms).toBe(1);

    if (Exit.isSuccess(one) && Exit.isSuccess(two)) {
      one.value.close();
      expect(relay.rooms).toBe(1);
      two.value.close();
    }

    expect(relay.rooms).toBe(0);
    expect(relay.members("blue")).toStrictEqual([]);
  });
});

// --- over real sockets --------------------------------------------------------

/** A relay behind a WebSocket server on this machine, on a port of its own. */
const serve = async (options?: Relay.Options) => {
  const relay = Relay.make(options);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    server.on("listening", () => resolve());
  });
  const closes: { peer: string; code: number }[] = [];
  server.on("connection", (socket, request) => {
    const connection = relay.connect(request.url ?? "", (sent) =>
      socket.send(sent)
    );

    if (Exit.isFailure(connection)) {
      const refused = Cause.squash(connection.cause) as Relay.Refused;
      socket.close(refused.code, refused.reason);

      return;
    }

    const { member } = connection.value;
    socket.on("message", (data, isBinary) => {
      const received = connection.value.receive(
        isBinary ? (data as Uint8Array) : String(data)
      );

      if (Exit.isFailure(received)) {
        const refused = Cause.squash(received.cause) as Relay.Refused;
        closes.push({ peer: member.peer, code: refused.code });
        socket.close(refused.code, refused.reason);
      }
    });
    socket.on("close", () => connection.value.close());
  });
  const { port } = server.address() as { port: number };

  return {
    relay,
    closes,
    url: `ws://127.0.0.1:${port}/rooms`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }

        server.close(() => resolve());
      }),
  };
};

const later = (ms = 5): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits, a few milliseconds at a time, until something holds. */
const until = async (holds: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    if (holds()) {
      return;
    }

    await later(5);
  }

  throw new Error(`timed out waiting until ${what}`);
};

describe("the transport between machines, a WebSocket to a relay", () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  /** A peer's transport, in a scope the test closes. */
  const open = (url: string) =>
    Effect.map(Layer.build(Transport.layerWebSocket(url)), (context) =>
      Context.get(context, Transport.Transport)
    );

  it("carries a message to the other peers of the room, and what was sent before it opened", async () => {
    const served = await serve();
    stop = served.stop;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const one = yield* open(Relay.address(served.url, ada));
          const two = yield* open(Relay.address(served.url, grace));
          const elsewhere = yield* open(Relay.address(served.url, linus));
          // Sent at once, before either socket has had the time to open.
          one.send(message("ada", 0, 3));
          one.send(message("ada", 1));
          two.send(message("grace", 0));

          const heard: Record<string, Lockstep.Message[]> = {
            ada: [],
            grace: [],
            linus: [],
          };

          yield* Effect.promise(() =>
            until(() => {
              heard.ada!.push(...one.receive());
              heard.grace!.push(...two.receive());
              heard.linus!.push(...elsewhere.receive());

              return heard.grace!.length === 2 && heard.ada!.length === 1;
            }, "the messages arrived")
          );
          expect(heard).toStrictEqual({
            ada: [message("grace", 0)],
            grace: [message("ada", 0, 3), message("ada", 1)],
            linus: [],
          });
          expect(served.relay.members("blue")).toStrictEqual([ada, grace]);
        })
      )
    );
    // Their scope closed, and their sockets with it: the room is empty.
    await until(() => served.relay.rooms === 0, "the relay saw them leave");
  });

  it("keeps two peers the same game, and tells each handler who the relay let in", async () => {
    const served = await serve();
    stop = served.stop;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seats: {
            name: string;
            app: Game;
            session: Rollback.Session;
            connected: Transport.Connected;
          }[] = [];

          for (const name of ["ada", "grace"]) {
            const app = yield* game();

            const session = Rollback.make(app, {
              peer: name,
              peers: ["ada", "grace"],
              delta: DELTA,
            });

            const transport = yield* Layer.build(
              Transport.layerWebSocket(
                Relay.address(served.url, { room: "match", peer: name })
              )
            );

            const connected = yield* Transport.connect(session).pipe(
              Effect.provide(transport)
            );

            seats.push({ name, app, session, connected });
          }

          const act = players(31);
          const [one, two] = seats as [(typeof seats)[0], (typeof seats)[0]];

          for (let i = 0; i < 60; i += 1) {
            for (const seat of seats) {
              if (i < 40) {
                act(seat as unknown as Peer);
              }

              seat.connected.tick();
              yield* Effect.promise(() => later(1));
            }
          }

          for (
            let i = 0;
            i < 300 &&
            (one.app.time.tick !== two.app.time.tick ||
              one.session.confirmed < one.app.time.tick - 1);
            i += 1
          ) {
            yield* Effect.promise(() => later(2));
            (one.app.time.tick <= two.app.time.tick
              ? one
              : two
            ).connected.tick();
          }

          expect(one.app.time.tick).toBe(two.app.time.tick);
          expect(one.app.time.tick).toBeGreaterThan(40);
          expect(one.app.world.hash()).toBe(two.app.world.hash());
          expect(one.app.actionLog).toStrictEqual(two.app.actionLog);
          expect(one.session.drifted).toBeUndefined();

          // Tips went to whoever issued them, by the name the relay knows.
          const tips = moves(one.app.actionLog).filter(
            (entry) => entry.name === "ls/Tip"
          );

          expect(tips.length).toBeGreaterThan(4);
          expect(tips.map((entry) => entry.from).toSorted()).toStrictEqual([
            ...tips.filter((entry) => entry.from === "ada").map(() => "ada"),
            ...tips
              .filter((entry) => entry.from === "grace")
              .map(() => "grace"),
          ]);
          expect(tips.some((entry) => entry.from === "ada")).toBe(true);
          expect(tips.some((entry) => entry.from === "grace")).toBe(true);
          expect(tips.every((entry) => entry.refused === undefined)).toBe(true);
          expect(purseOf(two.app)).toStrictEqual(purseOf(one.app));
        })
      )
    );
  });

  it("has the relay close a peer that speaks for another, and pass nothing on", async () => {
    const served = await serve();
    stop = served.stop;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const honest = yield* open(Relay.address(served.url, grace));
          const liar = yield* open(Relay.address(served.url, ada));
          liar.send(message("ada", 0));
          // In grace's name.
          liar.send(message("grace", 0, 99));
          yield* Effect.promise(() =>
            until(() => served.closes.length === 1, "the relay refused it")
          );
          expect(served.closes).toStrictEqual([{ peer: "ada", code: 1008 }]);
          yield* Effect.promise(() => later(20));
          // The message it sent as itself came through, and the other did not.
          expect(honest.receive()).toStrictEqual([message("ada", 0)]);
          // Its own transport says what became of it.
          let thrown: unknown;

          try {
            liar.receive();
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toStrictEqual(
            new Transport.Closed({
              url: Relay.address(served.url, ada),
              code: 1008,
              reason: "speaks for another",
            })
          );
          expect(() => liar.send(message("ada", 1))).toThrow(Transport.Closed);
        })
      )
    );
  });

  it("says why when the relay would not let it in", async () => {
    const served = await serve();
    stop = served.stop;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* open(Relay.address(served.url, ada));
          yield* Effect.promise(() =>
            until(() => served.relay.members("blue").length === 1, "ada is in")
          );
          const second = yield* open(Relay.address(served.url, ada));
          let thrown: unknown;
          yield* Effect.promise(() =>
            until(() => {
              try {
                second.receive();

                return false;
              } catch (error) {
                thrown = error;

                return true;
              }
            }, "the second was turned away")
          );
          expect(thrown).toBeInstanceOf(Transport.Closed);
          expect((thrown as Transport.Closed).message).toBe(
            `The transport's socket to ${Relay.address(served.url, ada)} is closed (code 1008: name taken). Every message has to arrive, so the game cannot go on over it.`
          );
          // The first is none the worse.
          expect(first.receive()).toStrictEqual([]);
        })
      )
    );
  });

  it("is told why in the few words a close frame has room for, however long the names", async () => {
    const served = await serve();
    stop = served.stop;

    // Every reason fits: a close frame carries 123 bytes at most, and a
    // server that is handed more throws.
    const reasons: Relay.Refused["reason"][] = [
      "not an address",
      "name taken",
      "room full",
      "not a peer",
      "not a message",
      "speaks for another",
      "too long",
    ];

    for (const reason of reasons) {
      expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(123);
    }

    const long = { room: "r".repeat(64), peer: "p".repeat(64) };
    expect(
      refusal(Relay.join(Relay.address("/rooms", long), [long])).message.length
    ).toBeGreaterThan(123);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* open(Relay.address(served.url, long));
          yield* Effect.promise(() =>
            until(() => served.relay.rooms === 1, "the first is in")
          );
          const taken = yield* open(Relay.address(served.url, long));
          const nowhere = yield* open(`${served.url}/blue`);

          const closedWith = (transport: Transport.Shape) =>
            Effect.promise(async () => {
              let thrown: unknown;
              await until(() => {
                try {
                  transport.receive();

                  return false;
                } catch (error) {
                  thrown = error;

                  return true;
                }
              }, "it was closed");

              return thrown as Transport.Closed;
            });

          expect((yield* closedWith(taken)).reason).toBe("name taken");
          expect((yield* closedWith(nowhere)).reason).toBe("not an address");
          // The server is still there for whoever comes next.
          const next = yield* open(Relay.address(served.url, ada));
          yield* Effect.promise(() =>
            until(() => served.relay.rooms === 2, "the next is in")
          );
          expect(next.receive()).toStrictEqual([]);
        })
      )
    );
  });

  it("says so when the relay is not there, or goes away", async () => {
    const served = await serve();
    const gone = Relay.address(served.url, ada);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* open(gone);
          yield* Effect.promise(() =>
            until(() => served.relay.rooms === 1, "it connected")
          );
          expect(transport.receive()).toStrictEqual([]);
          yield* Effect.promise(() => served.stop());
          yield* Effect.promise(() =>
            until(() => {
              try {
                transport.receive();

                return false;
              } catch {
                return true;
              }
            }, "it noticed")
          );
          expect(() => transport.send(message("ada", 0))).toThrow(
            Transport.Closed
          );
          // And one that never reaches a relay at all.
          const nowhere = yield* open(gone);
          let thrown: unknown;
          yield* Effect.promise(() =>
            until(() => {
              try {
                nowhere.receive();

                return false;
              } catch (error) {
                thrown = error;

                return true;
              }
            }, "it gave up")
          );
          expect((thrown as Transport.Closed).code).toBe(1006);
        })
      )
    );
  });

  it("says so when it is used after its scope has closed", async () => {
    const served = await serve();
    stop = served.stop;
    const url = Relay.address(served.url, ada);

    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Transport.Transport;
      }).pipe(Effect.provide(Transport.layerWebSocket(url)))
    );

    expect(() => kept.receive()).toThrow(
      /was used after its scope had closed, and its socket with it.*provide it to the whole program/u
    );
    expect(() => kept.send(message("ada", 0))).toThrow(/after its scope/u);
  });
});
