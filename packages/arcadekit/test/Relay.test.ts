import { Cause, Effect, Exit, Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { Message, Relay, Session, Transport } from "../src/net/index";
import { CoinGame, DELTA, moves, players, purseOf } from "./peers";
import type { Peer, SteeredGame } from "./peers";

const message = (from: string, tick: number, value = 0): Message.Message => ({
  from,
  tick,
  actions: value === 0 ? [] : [{ name: "ls/Tip", payload: { amount: value } }],
});
const text = (from: string, tick: number, value = 0): string =>
  Message.encode(message(from, tick, value));
const notice = (told: Message.Notice): string => Message.encodeNotice(told);

/** The messages among what arrived, without the relay's notices. */
const messagesIn = (
  arrived: readonly (Message.Message | Message.Notice)[]
): Message.Message[] =>
  arrived.filter((one): one is Message.Message => "from" in one);

const refusal = <A>(exit: Exit.Exit<A, Relay.Refused>): Relay.Refused => {
  if (Exit.isSuccess(exit)) {
    throw new Error("it was let through");
  }
  return Cause.squash(exit.cause) as Relay.Refused;
};

const joined = <A>(exit: Exit.Exit<A, Relay.Refused>): A => {
  if (Exit.isFailure(exit)) {
    throw new Error("it was refused", { cause: Cause.squash(exit.cause) });
  }
  return exit.value;
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
      ).toEqual(Exit.succeed(member));
    }
    // A host is often handed the path alone.
    expect(Relay.join("/rooms/blue?peer=ada", [])).toEqual(Exit.succeed(ada));
  });
});

describe("a peer that asks to come in", () => {
  it("is let in beside whoever is there, under a name nobody has", () => {
    expect(Relay.join("/blue?peer=grace", [ada, linus])).toEqual(
      Exit.succeed(grace)
    );
    // The same name in another room is another peer.
    expect(Relay.join("/red?peer=ada", [ada, linus])).toEqual(
      Exit.succeed({ room: "red", peer: "ada" })
    );
  });

  it("is refused when its name is taken in that room", () => {
    const refused = refusal(Relay.join("/blue?peer=ada", [ada, grace]));
    expect(refused).toEqual(
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
    ).toEqual(
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
    expect(deliveries).toEqual(
      Exit.succeed([
        { to: grace, text: text("ada", 3, 2) },
        { to: edsger, text: text("ada", 3, 2) },
      ])
    );
    // Alone in its room, to nobody.
    expect(Relay.forward(linus, text("linus", 0), [ada, linus])).toEqual(
      Exit.succeed([])
    );
  });

  it("is read whether it came as text or as bytes, and written out again as the message it is", () => {
    const bytes = new TextEncoder().encode(text("ada", 1));
    for (const data of [bytes, bytes.buffer]) {
      expect(Relay.forward(ada, data, [ada, grace])).toEqual(
        Exit.succeed([{ to: grace, text: text("ada", 1) }])
      );
    }
    // What rides along and is no part of a message is not passed on.
    const padded = JSON.stringify({
      ...message("ada", 1),
      extra: "x".repeat(100),
    });
    expect(Relay.forward(ada, padded, [ada, grace])).toEqual(
      Exit.succeed([{ to: grace, text: text("ada", 1) }])
    );
    // Every part of one is, what the peer was made with among them.
    const first = Message.encode({
      ...message("ada", 0),
      checkpoints: [{ tick: 0, hash: 7 }],
      made: { game: 3, delta: DELTA, peers: ["ada", "grace"], start: 0 },
    });
    expect(Relay.forward(ada, first, [ada, grace])).toEqual(
      Exit.succeed([{ to: grace, text: first }])
    );
  });

  it("is refused when it says it is from anyone but the member that sent it", () => {
    const refused = refusal(
      Relay.forward(ada, text("grace", 3, 9), [ada, grace, edsger])
    );
    expect(refused).toEqual(
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

describe("who joins a room and who leaves it", () => {
  it("is told to every other member of the room, and the one who joins is told who is there", () => {
    expect(Relay.joined(edsger, [ada, grace, linus, edsger])).toEqual([
      { to: ada, text: notice({ joined: "edsger" }) },
      { to: grace, text: notice({ joined: "edsger" }) },
      { to: edsger, text: notice({ joined: "ada" }) },
      { to: edsger, text: notice({ joined: "grace" }) },
    ]);
    expect(Relay.left(edsger, [ada, grace, linus])).toEqual([
      { to: ada, text: notice({ left: "edsger" }) },
      { to: grace, text: notice({ left: "edsger" }) },
    ]);
    // Alone in the room, nobody is told anything.
    expect(Relay.joined(linus, [ada, linus])).toEqual([]);
    expect(Relay.left(linus, [ada])).toEqual([]);
  });

  it("can't be said by a member: a notice is not a message", () => {
    expect(
      refusal(Relay.forward(ada, notice({ left: "grace" }), [ada, grace]))
        .reason
    ).toBe("not a message");
  });

  it("goes to text and comes back, and a message is not one", () => {
    for (const told of [{ joined: "ada" }, { left: "grace" }] as const) {
      expect(Message.decodeNotice(Message.encodeNotice(told))).toEqual(
        Exit.succeed(told)
      );
    }
    for (const text of [
      Message.encode(message("ada", 0)),
      "{}",
      JSON.stringify({ joined: 1 }),
      "nothing",
    ]) {
      expect(Exit.isFailure(Message.decodeNotice(text)), text).toBe(true);
    }
  });
});

describe("a relay that keeps its rooms itself", () => {
  it("sends what a peer sent to the others in its room", () => {
    const relay = Relay.make();
    const got: Record<string, string[]> = { ada: [], grace: [], linus: [] };
    const connect = (url: string, name: string) =>
      joined(relay.connect(url, (sent) => got[name]!.push(sent)));
    const first = connect("/blue?peer=ada", "ada");
    const second = connect("/blue?peer=grace", "grace");
    const third = connect("/red?peer=linus", "linus");
    expect(first.member).toEqual(ada);
    expect(relay.members("blue")).toEqual([ada, grace]);
    expect(relay.rooms).toBe(2);
    expect(first.receive(text("ada", 0, 4))).toEqual(Exit.void);
    expect(second.receive(text("grace", 0))).toEqual(Exit.void);
    expect(third.receive(text("linus", 0))).toEqual(Exit.void);
    expect(got).toEqual({
      ada: [notice({ joined: "grace" }), text("grace", 0)],
      grace: [notice({ joined: "ada" }), text("ada", 0, 4)],
      linus: [],
    });
    // A refusal is the host's to act on: nothing is sent.
    expect(refusal(first.receive(text("grace", 1))).reason).toBe(
      "speaks for another"
    );
    expect(got.grace).toHaveLength(2);
  });

  it("tells the room who joins it and who leaves it, and nobody else", () => {
    const relay = Relay.make();
    const got: Record<string, string[]> = { ada: [], grace: [], linus: [] };
    const connect = (url: string, name: string) =>
      joined(relay.connect(url, (sent) => got[name]!.push(sent)));
    const first = connect("/blue?peer=ada", "ada");
    connect("/red?peer=linus", "linus");
    connect("/blue?peer=grace", "grace");
    first.close();
    // Ada comes back: grace is told, and ada is told who is there.
    const again = connect("/blue?peer=ada", "ada");
    // The old connection's close, come late, says nothing of the new one.
    first.close();
    expect(got).toEqual({
      ada: [notice({ joined: "grace" }), notice({ joined: "grace" })],
      grace: [
        notice({ joined: "ada" }),
        notice({ left: "ada" }),
        notice({ joined: "ada" }),
      ],
      linus: [],
    });
    again.close();
    expect(got.grace!.at(-1)).toBe(notice({ left: "ada" }));
  });

  it("refuses a name that is taken, and frees it when its peer has gone", () => {
    const relay = Relay.make({ maxPeers: 2 });
    const none = (): void => {};
    const first = joined(relay.connect("/blue?peer=ada", none));
    expect(refusal(relay.connect("/blue?peer=ada", none)).reason).toBe(
      "name taken"
    );
    relay.connect("/blue?peer=grace", none);
    expect(refusal(relay.connect("/blue?peer=edsger", none)).reason).toBe(
      "room full"
    );
    first.close();
    // Closing twice frees nobody else's name.
    first.close();
    expect(relay.members("blue")).toEqual([grace]);
    const again = relay.connect("/blue?peer=ada", none);
    expect(Exit.isSuccess(again)).toBe(true);
    // The first connection's close, come late, does not take the new one out.
    first.close();
    expect(relay.members("blue")).toEqual([grace, ada]);
  });

  it("holds what its members send to the limits it was made with", () => {
    const relay = Relay.make({ maxLength: 60, peers: ["ada", "grace"] });
    const sent: string[] = [];
    const first = joined(relay.connect("/blue?peer=ada", () => {}));
    relay.connect("/blue?peer=grace", (arrived) => sent.push(arrived));
    expect(refusal(relay.connect("/blue?peer=edsger", () => {})).reason).toBe(
      "not a peer"
    );
    expect(first.receive(text("ada", 0))).toEqual(Exit.void);
    expect(refusal(first.receive(text("ada", 1, 123_456))).reason).toBe(
      "too long"
    );
    expect(sent).toEqual([notice({ joined: "ada" }), text("ada", 0)]);
  });

  it("forgets a room when the last peer has left it", () => {
    const relay = Relay.make();
    const one = relay.connect("/blue?peer=ada", () => {});
    const two = relay.connect("/blue?peer=grace", () => {});
    expect(relay.rooms).toBe(1);
    joined(one).close();
    expect(relay.rooms).toBe(1);
    joined(two).close();
    expect(relay.rooms).toBe(0);
    expect(relay.members("blue")).toEqual([]);
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
  // Each peer's socket, as the server holds it, to cut.
  const sockets = new Map<string, { terminate: () => void }>();
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
    sockets.set(member.peer, socket);
    socket.on("message", (data, isBinary) => {
      // What ws hands over: a buffer, an ArrayBuffer, or its fragments.
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : new Uint8Array(data);
      const received = connection.value.receive(
        isBinary ? bytes : new TextDecoder().decode(bytes)
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
    /** Cuts a peer's socket, as a network that fails does, with no close frame. */
    drop: (peer: string): void => {
      sockets.get(peer)?.terminate();
    },
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
  for (let i = 0; i < 400; i++) {
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
  const listenOn = (url: string, options?: Transport.WebSocketOptions) =>
    Transport.listen.pipe(
      Effect.provide(Transport.layerWebSocket(url, options))
    );

  it("carries a message to the other peers of the room, and what was sent before it opened", async () => {
    const served = await serve();
    stop = served.stop;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const one = yield* listenOn(Relay.address(served.url, ada));
          const two = yield* listenOn(Relay.address(served.url, grace));
          const elsewhere = yield* listenOn(Relay.address(served.url, linus));
          // Sent at once, before either socket has had the time to open.
          one.send(message("ada", 0, 3));
          one.send(message("ada", 1));
          two.send(message("grace", 0));
          const heard: Record<string, Message.Message[]> = {
            ada: [],
            grace: [],
            linus: [],
          };
          yield* Effect.promise(() =>
            until(() => {
              heard.ada!.push(...messagesIn(one.receive()));
              heard.grace!.push(...messagesIn(two.receive()));
              heard.linus!.push(...messagesIn(elsewhere.receive()));
              return heard.grace!.length === 2 && heard.ada!.length === 1;
            }, "the messages arrived")
          );
          expect(heard).toEqual({
            ada: [message("grace", 0)],
            grace: [message("ada", 0, 3), message("ada", 1)],
            linus: [],
          });
          expect(served.relay.members("blue")).toEqual([ada, grace]);
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
            app: SteeredGame;
            session: Peer["session"];
            connected: Transport.Connected;
          }[] = [];
          for (const name of ["ada", "grace"]) {
            const session = yield* Session.make(CoinGame, {
              seed: 5,
              checkpointEvery: 1,
              peer: name,
              peers: ["ada", "grace"],
              delta: DELTA,
            });
            const connected = yield* Transport.connect(session).pipe(
              Effect.provide(
                Transport.layerWebSocket(
                  Relay.address(served.url, { room: "match", peer: name })
                )
              )
            );
            seats.push({ name, app: session.app, session, connected });
          }
          const act = players(31);
          const [one, two] = seats as [(typeof seats)[0], (typeof seats)[0]];
          for (let i = 0; i < 60; i++) {
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
            i++
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
          expect(one.app.actionLog).toEqual(two.app.actionLog);
          expect(one.session.drifted).toBeUndefined();
          // Tips went to whoever issued them, by the name the relay knows.
          const tips = moves(one.app.actionLog).filter(
            (entry) => entry.name === "ls/Tip"
          );
          expect(tips.length).toBeGreaterThan(4);
          expect(
            tips
              .map((entry) => entry.from)
              .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))
          ).toEqual([
            ...tips.filter((entry) => entry.from === "ada").map(() => "ada"),
            ...tips
              .filter((entry) => entry.from === "grace")
              .map(() => "grace"),
          ]);
          expect(tips.some((entry) => entry.from === "ada")).toBe(true);
          expect(tips.some((entry) => entry.from === "grace")).toBe(true);
          expect(tips.every((entry) => entry.refused === undefined)).toBe(true);
          expect(purseOf(two.app)).toEqual(purseOf(one.app));
        })
      )
    );
  });

  it("connects again when its socket drops, and the peers play on to the same game", async () => {
    const served = await serve();
    stop = served.stop;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seats: {
            name: string;
            app: SteeredGame;
            session: Peer["session"];
            connected: Transport.Connected;
          }[] = [];
          for (const name of ["ada", "grace"]) {
            const session = yield* Session.make(CoinGame, {
              seed: 5,
              checkpointEvery: 1,
              peer: name,
              peers: ["ada", "grace"],
              delta: DELTA,
            });
            const connected = yield* Transport.connect(session).pipe(
              Effect.provide(
                Transport.layerWebSocket(
                  Relay.address(served.url, { room: "match", peer: name })
                )
              )
            );
            seats.push({ name, app: session.app, session, connected });
          }
          const act = players(41);
          const [one, two] = seats as [(typeof seats)[0], (typeof seats)[0]];
          const play = (rounds: number) =>
            Effect.gen(function* () {
              for (let i = 0; i < rounds; i++) {
                for (const seat of seats) {
                  act(seat as unknown as Peer);
                  seat.connected.tick();
                  yield* Effect.promise(() => later(1));
                }
              }
            });
          yield* play(30);
          // Grace's socket goes, with whatever was on its way, then ada's.
          served.drop("grace");
          yield* play(30);
          served.drop("ada");
          yield* play(30);
          for (
            let i = 0;
            i < 400 &&
            (one.app.time.tick !== two.app.time.tick ||
              one.session.confirmed < one.app.time.tick - 1 ||
              one.app.time.tick < 80);
            i++
          ) {
            yield* Effect.promise(() => later(2));
            (one.app.time.tick <= two.app.time.tick
              ? one
              : two
            ).connected.tick();
          }
          expect(one.app.time.tick).toBe(two.app.time.tick);
          expect(one.app.time.tick).toBeGreaterThanOrEqual(80);
          expect(one.app.world.hash()).toBe(two.app.world.hash());
          expect(one.app.actionLog).toEqual(two.app.actionLog);
          expect(moves(one.app.actionLog).length).toBeGreaterThan(20);
          expect(one.session.drifted).toBeUndefined();
          expect(one.connected.away).toEqual([]);
          expect(two.connected.away).toEqual([]);
          // What both have heard is let go of.
          expect(one.session.unheard).toBeLessThan(20);
        })
      )
    );
  });

  it("tries a taken name again while it connects again, since the relay may not have seen its old socket close", async () => {
    // A relay that is slow to see a socket close: it refuses the name once.
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });
    let connections = 0;
    const open: { terminate: () => void }[] = [];
    server.on("connection", (socket) => {
      connections++;
      if (connections === 2) {
        socket.close(1008, "name taken");
        return;
      }
      open.push(socket);
      socket.send(Message.encodeNotice({ joined: "grace" }));
    });
    stop = () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      });
    const { port } = server.address() as { port: number };
    const url = Relay.address(`ws://127.0.0.1:${port}/rooms`, ada);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* Transport.listen.pipe(
            Effect.provide(Transport.layerWebSocket(url))
          );
          const heard: unknown[] = [];
          yield* Effect.promise(() =>
            until(() => {
              heard.push(...transport.receive());
              return heard.length === 1;
            }, "it was let in")
          );
          open[0]!.terminate();
          yield* Effect.promise(() =>
            until(() => {
              heard.push(...transport.receive());
              return heard.length === 2;
            }, "it was let in again")
          );
          expect(connections).toBe(3);
          expect(heard).toEqual([{ joined: "grace" }, { joined: "grace" }]);
        })
      )
    );
  });

  it("tells the others when a peer has left for good, and keeps what it sent for when it comes back", async () => {
    const served = await serve();
    stop = served.stop;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(CoinGame, {
            seed: 5,
            peer: "ada",
            peers: ["ada", "grace"],
            delta: DELTA,
            ahead: 0,
          });
          const connected = yield* Transport.connect(session).pipe(
            Effect.provide(
              Transport.layerWebSocket(Relay.address(served.url, ada))
            )
          );
          // Grace comes, and goes for good: her transport gives up at once.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const visitor = yield* listenOn(
                Relay.address(served.url, grace),
                {
                  reconnectFor: 0,
                }
              );
              yield* Effect.promise(() =>
                until(() => {
                  connected.tick();
                  return served.relay.members("blue").length === 2;
                }, "grace is in")
              );
              served.drop("grace");
              yield* Effect.promise(() =>
                until(
                  () => Result.isFailure(Result.try(() => visitor.receive())),
                  "grace gave up"
                )
              );
            })
          );
          yield* Effect.promise(() =>
            until(() => {
              connected.tick();
              return connected.away.length === 1;
            }, "ada was told")
          );
          expect(connected.away).toEqual(["grace"]);
          // Ada waits for her, with what she has to say kept.
          expect(session.waitingFor).toEqual(["grace"]);
          expect(session.unheard).toBeGreaterThan(0);
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
          const honest = yield* listenOn(Relay.address(served.url, grace));
          const liar = yield* listenOn(Relay.address(served.url, ada));
          liar.send(message("ada", 0));
          // In grace's name.
          liar.send(message("grace", 0, 99));
          yield* Effect.promise(() =>
            until(() => served.closes.length === 1, "the relay refused it")
          );
          expect(served.closes).toEqual([{ peer: "ada", code: 1008 }]);
          yield* Effect.promise(() => later(20));
          // The message it sent as itself came through, and the other did
          // not. Once the relay closed it, it is gone from the room.
          expect(honest.receive()).toEqual([
            { joined: "ada" },
            message("ada", 0),
            { left: "ada" },
          ]);
          // Its own transport says what became of it.
          const received = Result.try(() => liar.receive());
          expect(
            Result.isFailure(received) ? received.failure : "it did not throw"
          ).toEqual(
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
          const first = yield* listenOn(Relay.address(served.url, ada));
          yield* Effect.promise(() =>
            until(() => served.relay.members("blue").length === 1, "ada is in")
          );
          const second = yield* listenOn(Relay.address(served.url, ada));
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
          expect(first.receive()).toEqual([]);
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
          yield* listenOn(Relay.address(served.url, long));
          yield* Effect.promise(() =>
            until(() => served.relay.rooms === 1, "the first is in")
          );
          const taken = yield* listenOn(Relay.address(served.url, long));
          const nowhere = yield* listenOn(`${served.url}/blue`);
          const closedWith = (transport: Transport.Listener) =>
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
          const next = yield* listenOn(Relay.address(served.url, ada));
          yield* Effect.promise(() =>
            until(() => served.relay.rooms === 2, "the next is in")
          );
          expect(next.receive()).toEqual([]);
        })
      )
    );
  });

  it("says so when the relay is not there, or goes away for longer than it tries to connect again", async () => {
    const served = await serve();
    const gone = Relay.address(served.url, ada);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* listenOn(gone, { reconnectFor: 200 });
          yield* Effect.promise(() =>
            until(() => served.relay.rooms === 1, "it connected")
          );
          expect(transport.receive()).toEqual([]);
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
          const nowhere = yield* listenOn(gone);
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
    const kept = await Effect.runPromise(Effect.scoped(listenOn(url)));
    expect(() => kept.receive()).toThrow(
      /was used after the scope it was opened in had closed, and its socket with it.*drive the session in that program/u
    );
    expect(() => kept.send(message("ada", 0))).toThrow(
      /after the scope it was opened in/u
    );
  });
});
