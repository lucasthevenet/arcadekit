import {
  afterEach,
  assert,
  describe,
  expect,
  expectTypeOf,
  it,
} from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Scope } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { WebSocketServer } from "ws";

import { Driver, Input, World } from "../src/index.ts";
import { Message, Relay, Session, Transport } from "../src/net/index.ts";
import { thrown, unwrap } from "./checks.ts";
import { CoinGame, HZ, moves, players, purseOf } from "./peers.ts";
import type { Peer } from "./peers.ts";

const message = (from: string, tick: number, value = 0): Message.Message => ({
  from,
  tick,
  actions: value === 0 ? [] : [{ name: "ls/Tip", payload: { amount: value } }],
});
const bytes = (
  from: string,
  tick: number,
  value = 0
): Uint8Array<ArrayBuffer> =>
  unwrap(Message.encode(message(from, tick, value)));
const notice = (told: Message.Notice): string => Message.encodeNotice(told);

/** The messages among what arrived, without the relay's notices. */
const messagesIn = (
  arrived: readonly (Message.Message | Message.Aside | Message.Notice)[]
): Message.Message[] =>
  arrived.filter((one): one is Message.Message => "tick" in one);

/** A peer whose session is joined to a transport, which steps it. */
interface Seat extends Peer {
  readonly connected: Transport.Connected<
    Effect.Error<ReturnType<Peer["session"]["tick"]>>
  >;
}

/** A peer of the game, joined to the room "match" of the relay at `url`. */
const seatAt = (url: string, name: string) =>
  Effect.gen(function* () {
    const source = Input.makeManualSource();
    const session = yield* Session.make(CoinGame, {
      seed: 5,
      checkpointEvery: 1,
      me: name,
      others: ["ada", "grace"].filter((other) => other !== name),
      hz: HZ,
    }).pipe(Effect.provide(Input.layer(source)));
    const connected = yield* Effect.acquireRelease(
      Transport.connect(session).pipe(
        Effect.provide(
          Transport.layerWebSocket(
            Relay.address(url, { room: "match", peer: name })
          )
        )
      ),
      (made) => made.close
    );
    const seat: Seat = {
      name,
      app: session.app,
      world: yield* session.app.read(World),
      session,
      hashes: [],
      source,
      connected,
    };
    return seat;
  });

const refusal = <A>(exit: Exit.Exit<A, Relay.Refused>): Relay.Refused => {
  if (Exit.isSuccess(exit)) {
    throw new Error("it was let through");
  }
  return Option.getOrThrowWith(
    Exit.findErrorOption(exit),
    () => new Error("it failed with no refusal", { cause: exit.cause })
  );
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
        Relay.join(
          Relay.address("wss://r.example/rooms", member),
          Relay.anyone,
          []
        )
      ).toEqual(Exit.succeed(member));
    }
    // A host is often handed the path alone.
    expect(Relay.join("/rooms/blue?peer=ada", Relay.anyone, [])).toEqual(
      Exit.succeed(ada)
    );
  });
});

describe("a peer that asks to come in", () => {
  it("is let in beside whoever is there, under a name nobody has", () => {
    expect(Relay.join("/blue?peer=grace", Relay.anyone, [ada, linus])).toEqual(
      Exit.succeed(grace)
    );
    // The same name in another room is another peer.
    expect(Relay.join("/red?peer=ada", Relay.anyone, [ada, linus])).toEqual(
      Exit.succeed({ room: "red", peer: "ada" })
    );
  });

  it("is let in under the name the host proved it holds, and refused under any other", () => {
    expect(Relay.join("/blue?peer=ada", "ada", [grace])).toEqual(
      Exit.succeed(ada)
    );
    expect(refusal(Relay.join("/blue?peer=grace", "ada", []))).toEqual(
      new Relay.Refused({
        reason: "not your name",
        message:
          'The address asks for the name "grace", and the host has proven only that the peer asking is "ada".',
        status: 403,
        code: 1008,
      })
    );
    // A relay that keeps its rooms itself holds it to the same.
    const relay = Relay.make();
    expect(
      refusal(relay.connect("/blue?peer=grace", "ada", () => {})).reason
    ).toBe("not your name");
    expect(relay.members("blue")).toEqual([]);
    expect(
      joined(relay.connect("/blue?peer=ada", "ada", () => {})).member
    ).toEqual(ada);
  });

  it("is refused when its name is taken in that room", () => {
    const refused = refusal(
      Relay.join("/blue?peer=ada", Relay.anyone, [ada, grace])
    );
    expect(refused).toEqual(
      new Relay.Refused({
        reason: "name taken",
        message: 'A peer named "ada" is in the room "blue" already.',
        status: 409,
        code: 1008,
      })
    );
  });

  it("is refused with the error typed, so a host reads it without a cast", () => {
    const refused = Exit.findErrorOption(
      Relay.join("/blue?peer=ada", Relay.anyone, [ada])
    );
    expectTypeOf(refused).toEqualTypeOf<Option.Option<Relay.Refused>>();
    expect(Option.map(refused, ({ reason }) => reason)).toEqual(
      Option.some("name taken")
    );
  });

  it("is refused when the room is full", () => {
    expect(
      refusal(
        Relay.join("/blue?peer=edsger", Relay.anyone, [ada, grace], {
          maxPeers: 2,
        })
      )
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
        Relay.join("/blue?peer=grace", Relay.anyone, [ada, linus], {
          maxPeers: 2,
        })
      )
    ).toBe(true);
    // Eight, unless told.
    const eight = Array.from({ length: 8 }, (_, n) => ({
      room: "blue",
      peer: `p${n}`,
    }));
    expect(
      Exit.isSuccess(Relay.join("/blue?peer=x", Relay.anyone, eight.slice(1)))
    ).toBe(true);
    expect(
      refusal(Relay.join("/blue?peer=x", Relay.anyone, eight)).reason
    ).toBe("room full");
  });

  it("is refused when the room lets in only names it is not one of", () => {
    const options = { peers: ["ada", "grace"] };
    expect(
      Exit.isSuccess(
        Relay.join("/blue?peer=grace", Relay.anyone, [ada], options)
      )
    ).toBe(true);
    const refused = refusal(
      Relay.join("/blue?peer=mallory", Relay.anyone, [ada], options)
    );
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
      const refused = refusal(Relay.join(url, Relay.anyone, []));
      expect(refused.reason, url).toBe("not an address");
      expect(refused.status, url).toBe(400);
    }
    // As long as a name may be.
    expect(
      Exit.isSuccess(
        Relay.join(
          `/${"r".repeat(64)}?peer=${"p".repeat(64)}`,
          Relay.anyone,
          []
        )
      )
    ).toBe(true);
  });
});

describe("what a member sent", () => {
  it("is passed on to every other member of its room, and to nobody else", () => {
    const sent = bytes("ada", 3, 2);
    const deliveries = Relay.forward(ada, sent, [ada, grace, linus, edsger]);
    expect(deliveries).toEqual(
      Exit.succeed([
        { to: grace, data: sent },
        { to: edsger, data: sent },
      ])
    );
    // Alone in its room, to nobody.
    expect(Relay.forward(linus, bytes("linus", 0), [ada, linus])).toEqual(
      Exit.succeed([])
    );
  });

  it("is passed on as the bytes it came in, unchanged, whether in a buffer of their own or a view of a larger one", () => {
    const sent = unwrap(
      Message.encode({
        ...message("ada", 0, 3),
        checkpoints: [{ tick: 0, hash: 7 }],
        made: { game: 3, hz: HZ, peers: ["ada", "grace"], start: 0 },
        heard: 0,
      })
    );
    const kept = sent.slice();
    const framed = new Uint8Array(sent.byteLength + 8);
    framed.set(sent, 4);
    for (const [data, buffer, offset] of [
      [sent, sent.buffer, 0],
      [kept.buffer, kept.buffer, 0],
      [new DataView(framed.buffer, 4, sent.byteLength), framed.buffer, 4],
    ] as const) {
      const [first, second] = joined(
        Relay.forward(ada, data, [ada, grace, edsger])
      );
      assert(first?.data instanceof Uint8Array);
      expect(second?.data).toBe(first.data);
      expect(first.data).toEqual(kept);
      expect(first.data.buffer).toBe(buffer);
      expect(first.data.byteOffset).toBe(offset);
    }
    expect(sent).toEqual(kept);
  });

  it("is refused when it says it is from anyone but the member that sent it", () => {
    const refused = refusal(
      Relay.forward(ada, bytes("grace", 3, 9), [ada, grace, edsger])
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

  it("is refused when it is not a message, text or bytes", () => {
    const sent = bytes("ada", 1);
    for (const [what, data] of [
      ["no text", ""],
      ["text", "hello"],
      ["a message as text", JSON.stringify(message("ada", 1))],
      ["no bytes", new Uint8Array()],
      ["noise", new Uint8Array([7, 7, 7, 7])],
      ["a message cut short", sent.subarray(0, -1)],
      ["a message padded", new Uint8Array([...sent, 0, 0])],
    ] as const) {
      const refused = refusal(Relay.forward(ada, data, [ada, grace]));
      expect(refused.reason, what).toBe("not a message");
      expect(refused.code, what).toBe(1007);
    }
  });

  it("is passed on when it is an aside, as a message is, and refused in another's name", () => {
    const said: Message.Aside = {
      from: "ada",
      topic: "arcadekit/Lobby",
      body: { n: 0, part: 7 },
    };
    const sent = unwrap(Message.encodeAside(said));
    expect(Relay.forward(ada, sent, [ada, grace, linus])).toEqual(
      Exit.succeed([{ to: grace, data: sent }])
    );
    expect(Message.decodeAside(sent)).toEqual(Exit.succeed(said));
    // An aside is no message, and a message no aside.
    expect(Exit.isFailure(Message.decode(sent))).toBe(true);
    expect(
      Exit.isFailure(
        Message.decodeAside(unwrap(Message.encode(message("ada", 0))))
      )
    ).toBe(true);
    const forged = unwrap(Message.encodeAside({ ...said, from: "grace" }));
    expect(refusal(Relay.forward(ada, forged, [ada, grace])).reason).toBe(
      "speaks for another"
    );
  });

  it("is refused when it is longer than the relay takes, in bytes", () => {
    const long = unwrap(
      Message.encode({
        ...message("ada", 1),
        actions: [{ name: "ls/Tip", payload: "é".repeat(200) }],
      })
    );
    const most = { maxLength: long.byteLength };
    expect(Exit.isSuccess(Relay.forward(ada, long, [ada, grace], most))).toBe(
      true
    );
    expect(
      refusal(
        Relay.forward(ada, long, [ada, grace], {
          maxLength: long.byteLength - 1,
        })
      )
    ).toEqual(
      new Relay.Refused({
        reason: "too long",
        message: `"ada" sent ${long.byteLength} bytes, and the relay takes ${long.byteLength - 1} at most.`,
        status: 400,
        code: 1009,
      })
    );
    // 65,536 bytes, unless told.
    expect(Exit.isSuccess(Relay.forward(ada, long, [ada, grace]))).toBe(true);
    const huge = unwrap(
      Message.encode({
        ...message("ada", 1),
        actions: [{ name: "ls/Tip", payload: "x".repeat(65_536) }],
      })
    );
    expect(refusal(Relay.forward(ada, huge, [ada, grace])).reason).toBe(
      "too long"
    );
  });
});

describe("who joins a room and who leaves it", () => {
  it("is told to every other member of the room, and the one who joins is told who is there", () => {
    expect(Relay.joined(edsger, [ada, grace, linus, edsger])).toEqual([
      { to: ada, data: notice({ joined: "edsger" }) },
      { to: grace, data: notice({ joined: "edsger" }) },
      { to: edsger, data: notice({ joined: "ada" }) },
      { to: edsger, data: notice({ joined: "grace" }) },
    ]);
    expect(Relay.left(edsger, [ada, grace, linus])).toEqual([
      { to: ada, data: notice({ left: "edsger" }) },
      { to: grace, data: notice({ left: "edsger" }) },
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
      JSON.stringify(message("ada", 0)),
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
    const got: Record<string, (string | Uint8Array)[]> = {
      ada: [],
      grace: [],
      linus: [],
    };
    const connect = (url: string, name: string) =>
      joined(relay.connect(url, Relay.anyone, (sent) => got[name]!.push(sent)));
    const first = connect("/blue?peer=ada", "ada");
    const second = connect("/blue?peer=grace", "grace");
    const third = connect("/red?peer=linus", "linus");
    expect(first.member).toEqual(ada);
    expect(relay.members("blue")).toEqual([ada, grace]);
    expect(relay.rooms).toBe(2);
    const fromAda = bytes("ada", 0, 4);
    expect(first.receive(fromAda)).toEqual(Exit.void);
    expect(second.receive(bytes("grace", 0))).toEqual(Exit.void);
    expect(third.receive(bytes("linus", 0))).toEqual(Exit.void);
    expect(got).toEqual({
      ada: [notice({ joined: "grace" }), bytes("grace", 0)],
      grace: [notice({ joined: "ada" }), fromAda],
      linus: [],
    });
    const passed = got.grace![1];
    assert(passed instanceof Uint8Array);
    expect(passed.buffer).toBe(fromAda.buffer);
    // A refusal is the host's to act on: nothing is sent.
    expect(refusal(first.receive(bytes("grace", 1))).reason).toBe(
      "speaks for another"
    );
    expect(got.grace).toHaveLength(2);
  });

  it("tells the room who joins it and who leaves it, and nobody else", () => {
    const relay = Relay.make();
    const got: Record<string, (string | Uint8Array)[]> = {
      ada: [],
      grace: [],
      linus: [],
    };
    const connect = (url: string, name: string) =>
      joined(relay.connect(url, Relay.anyone, (sent) => got[name]!.push(sent)));
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
    const first = joined(relay.connect("/blue?peer=ada", Relay.anyone, none));
    expect(
      refusal(relay.connect("/blue?peer=ada", Relay.anyone, none)).reason
    ).toBe("name taken");
    relay.connect("/blue?peer=grace", Relay.anyone, none);
    expect(
      refusal(relay.connect("/blue?peer=edsger", Relay.anyone, none)).reason
    ).toBe("room full");
    first.close();
    // Closing twice frees nobody else's name.
    first.close();
    expect(relay.members("blue")).toEqual([grace]);
    const again = relay.connect("/blue?peer=ada", Relay.anyone, none);
    expect(Exit.isSuccess(again)).toBe(true);
    // The first connection's close, come late, does not take the new one out.
    first.close();
    expect(relay.members("blue")).toEqual([grace, ada]);
  });

  it("holds what its members send to the limits it was made with", () => {
    const relay = Relay.make({
      maxLength: bytes("ada", 0).byteLength,
      peers: ["ada", "grace"],
    });
    const sent: (string | Uint8Array)[] = [];
    const first = joined(
      relay.connect("/blue?peer=ada", Relay.anyone, () => {})
    );
    relay.connect("/blue?peer=grace", Relay.anyone, (arrived) =>
      sent.push(arrived)
    );
    expect(
      refusal(relay.connect("/blue?peer=edsger", Relay.anyone, () => {})).reason
    ).toBe("not a peer");
    expect(first.receive(bytes("ada", 0))).toEqual(Exit.void);
    expect(refusal(first.receive(bytes("ada", 1, 123_456))).reason).toBe(
      "too long"
    );
    expect(sent).toEqual([notice({ joined: "ada" }), bytes("ada", 0)]);
  });

  it("forgets a room when the last peer has left it", () => {
    const relay = Relay.make();
    const one = relay.connect("/blue?peer=ada", Relay.anyone, () => {});
    const two = relay.connect("/blue?peer=grace", Relay.anyone, () => {});
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
    const connection = relay.connect(request.url ?? "", Relay.anyone, (sent) =>
      socket.send(sent)
    );
    if (Exit.isFailure(connection)) {
      const refused = refusal(connection);
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
        const refused = refusal(received);
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

/** What a transport fails with once its socket has closed, or undefined while it is open. */
const closedOf = (transport: Transport.Listener) =>
  Effect.match(transport.receive(), {
    onFailure: (closed) => closed,
    onSuccess: () => undefined,
  });

/** Waits until a transport's socket has closed, and gives what it fails with. */
const whenClosed = (transport: Transport.Listener, what: string) =>
  Effect.gen(function* () {
    yield* waitUntil(
      Effect.map(closedOf(transport), (closed) => closed !== undefined),
      what
    );
    return (yield* closedOf(transport))!;
  });

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

  it.effect(
    "carries a message to the other peers of the room, and what was sent before it opened",
    () =>
      Effect.gen(function* () {
        const served = yield* Effect.promise(() => serve());
        stop = served.stop;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const one = yield* listenOn(Relay.address(served.url, ada));
            const two = yield* listenOn(Relay.address(served.url, grace));
            const elsewhere = yield* listenOn(Relay.address(served.url, linus));
            // Sent at once, before either socket has had the time to open.
            yield* one.send(message("ada", 0, 3));
            yield* one.send(message("ada", 1));
            yield* two.send(message("grace", 0));
            const heard: Record<string, Message.Message[]> = {
              ada: [],
              grace: [],
              linus: [],
            };
            yield* waitUntil(
              Effect.gen(function* () {
                heard.ada!.push(...messagesIn(yield* one.receive()));
                heard.grace!.push(...messagesIn(yield* two.receive()));
                heard.linus!.push(...messagesIn(yield* elsewhere.receive()));
                return heard.grace!.length === 2 && heard.ada!.length === 1;
              }),
              "the messages arrived"
            );
            expect(heard).toEqual({
              ada: [message("grace", 0)],
              grace: [message("ada", 0, 3), message("ada", 1)],
              linus: [],
            });
            expect(served.relay.members("blue")).toEqual([ada, grace]);
          })
        );
        // Their scope closed, and their sockets with it: the room is empty.
        yield* Effect.promise(() =>
          until(() => served.relay.rooms === 0, "the relay saw them leave")
        );
      })
  );

  it.effect(
    "keeps two peers the same game, and tells each handler who the relay let in",
    () =>
      Effect.gen(function* () {
        const served = yield* Effect.promise(() => serve());
        stop = served.stop;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const seats: Seat[] = [];
            for (const name of ["ada", "grace"]) {
              seats.push(yield* seatAt(served.url, name));
            }
            const act = players(31);
            const [one, two] = seats as [Seat, Seat];
            for (let i = 0; i < 60; i++) {
              for (const seat of seats) {
                if (i < 40) {
                  yield* act(seat);
                }
                yield* seat.connected.tick();
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
              yield* (
                one.app.time.tick <= two.app.time.tick ? one : two
              ).connected.tick();
            }
            expect(one.app.time.tick).toBe(two.app.time.tick);
            expect(one.app.time.tick).toBeGreaterThan(40);
            expect(one.world.hash()).toBe(two.world.hash());
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
            expect(tips.every((entry) => entry.refused === undefined)).toBe(
              true
            );
            expect(purseOf(two.world)).toEqual(purseOf(one.world));
          })
        );
      })
  );

  it.live(
    "connects again when its socket drops, and the peers play on to the same game",
    () =>
      Effect.gen(function* () {
        const served = yield* Effect.promise(() => serve());
        stop = served.stop;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const seats: Seat[] = [];
            for (const name of ["ada", "grace"]) {
              seats.push(yield* seatAt(served.url, name));
            }
            const act = players(41);
            const [one, two] = seats as [Seat, Seat];
            const play = (rounds: number) =>
              Effect.gen(function* () {
                for (let i = 0; i < rounds; i++) {
                  for (const seat of seats) {
                    yield* act(seat);
                    yield* seat.connected.tick();
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
              yield* (
                one.app.time.tick <= two.app.time.tick ? one : two
              ).connected.tick();
            }
            expect(one.app.time.tick).toBe(two.app.time.tick);
            expect(one.app.time.tick).toBeGreaterThanOrEqual(80);
            expect(one.world.hash()).toBe(two.world.hash());
            expect(one.app.actionLog).toEqual(two.app.actionLog);
            expect(moves(one.app.actionLog).length).toBeGreaterThan(20);
            expect(one.session.drifted).toBeUndefined();
            expect(one.connected.away).toEqual([]);
            expect(two.connected.away).toEqual([]);
            // What both have heard is let go of.
            expect(one.session.stats.unheard).toBeLessThan(20);
          })
        );
      })
  );

  it.effect(
    "tells the others when a peer has left for good, and keeps what it sent for when it comes back",
    () =>
      Effect.gen(function* () {
        const served = yield* Effect.promise(() => serve());
        stop = served.stop;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* Session.make(CoinGame, {
              seed: 5,
              me: "ada",
              others: ["grace"],
              hz: HZ,
              ahead: 0,
            });
            const connected = yield* Effect.acquireRelease(
              Transport.connect(session).pipe(
                Effect.provide(
                  Transport.layerWebSocket(Relay.address(served.url, ada))
                )
              ),
              (made) => made.close
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
                yield* waitUntil(
                  Effect.gen(function* () {
                    yield* connected.tick();
                    return served.relay.members("blue").length === 2;
                  }),
                  "grace is in"
                );
                served.drop("grace");
                yield* whenClosed(visitor, "grace gave up");
              })
            );
            yield* waitUntil(
              Effect.gen(function* () {
                yield* connected.tick();
                return connected.away.length === 1;
              }),
              "ada was told"
            );
            expect(connected.away).toEqual(["grace"]);
            // Ada waits for her, with what she has to say kept.
            expect(session.waitingFor).toEqual(["grace"]);
            expect(session.stats.unheard).toBeGreaterThan(0);
          })
        );
      })
  );

  it.effect(
    "has the relay close a peer that speaks for another, and pass nothing on",
    () =>
      Effect.gen(function* () {
        const served = yield* Effect.promise(() => serve());
        stop = served.stop;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const honest = yield* listenOn(Relay.address(served.url, grace));
            const liar = yield* listenOn(Relay.address(served.url, ada));
            yield* liar.send(message("ada", 0));
            // In grace's name.
            yield* liar.send(message("grace", 0, 99));
            yield* Effect.promise(() =>
              until(() => served.closes.length === 1, "the relay refused it")
            );
            expect(served.closes).toEqual([{ peer: "ada", code: 1008 }]);
            yield* Effect.promise(() => later(20));
            // The message it sent as itself came through, and the other did
            // not. Once the relay closed it, it is gone from the room.
            expect(yield* honest.receive()).toEqual([
              { joined: "ada" },
              message("ada", 0),
              { left: "ada" },
            ]);
            // Its own transport says what became of it.
            const closed = new Transport.Closed({
              url: Relay.address(served.url, ada),
              code: 1008,
              reason: "speaks for another",
            });
            expect(yield* closedOf(liar)).toEqual(closed);
            expect(yield* Effect.flip(liar.send(message("ada", 1)))).toEqual(
              closed
            );
          })
        );
      })
  );

  it.effect("says why when the relay would not let it in", () =>
    Effect.gen(function* () {
      const served = yield* Effect.promise(() => serve());
      stop = served.stop;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* listenOn(Relay.address(served.url, ada));
          yield* Effect.promise(() =>
            until(() => served.relay.members("blue").length === 1, "ada is in")
          );
          const second = yield* listenOn(Relay.address(served.url, ada));
          const closed = yield* whenClosed(
            second,
            "the second was turned away"
          );
          expect(closed).toBeInstanceOf(Transport.Closed);
          expect(closed.message).toBe(
            `The transport's socket to ${Relay.address(served.url, ada)} is closed (code 1008: name taken). Every message has to arrive, so the game cannot go on over it.`
          );
          // The first is none the worse.
          expect(yield* first.receive()).toEqual([]);
        })
      );
    })
  );

  it.effect(
    "is told why in the few words a close frame has room for, however long the names",
    () =>
      Effect.gen(function* () {
        const served = yield* Effect.promise(() => serve());
        stop = served.stop;
        // Every reason fits: a close frame carries 123 bytes at most, and a
        // server that is handed more throws.
        const reasons: Relay.Refused["reason"][] = [
          "not an address",
          "not your name",
          "name taken",
          "room full",
          "not a peer",
          "not a message",
          "speaks for another",
          "too long",
        ];
        for (const reason of reasons) {
          expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(
            123
          );
        }
        const long = { room: "r".repeat(64), peer: "p".repeat(64) };
        expect(
          refusal(
            Relay.join(Relay.address("/rooms", long), Relay.anyone, [long])
          ).message.length
        ).toBeGreaterThan(123);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* listenOn(Relay.address(served.url, long));
            yield* Effect.promise(() =>
              until(() => served.relay.rooms === 1, "the first is in")
            );
            const taken = yield* listenOn(Relay.address(served.url, long));
            const nowhere = yield* listenOn(`${served.url}/blue`);
            expect((yield* whenClosed(taken, "it was closed")).reason).toBe(
              "name taken"
            );
            expect((yield* whenClosed(nowhere, "it was closed")).reason).toBe(
              "not an address"
            );
            // The server is still there for whoever comes next.
            const next = yield* listenOn(Relay.address(served.url, ada));
            yield* Effect.promise(() =>
              until(() => served.relay.rooms === 2, "the next is in")
            );
            expect(yield* next.receive()).toEqual([]);
          })
        );
      })
  );

  it.effect(
    "says so when it is used after its connection was closed, or the scope it was listened on in",
    () =>
      Effect.gen(function* () {
        const served = yield* Effect.promise(() => serve());
        stop = served.stop;
        const url = Relay.address(served.url, ada);
        const session = yield* Session.make(CoinGame, {
          seed: 5,
          me: "ada",
          others: ["grace"],
          hz: HZ,
        });
        const connected = yield* Transport.connect(session).pipe(
          Effect.provide(Transport.layerWebSocket(url))
        );
        yield* Effect.promise(() =>
          until(() => served.relay.members("blue").length === 1, "ada is in")
        );
        yield* connected.close;
        yield* Effect.promise(() =>
          until(() => served.relay.members("blue").length === 0, "ada has left")
        );
        expect(yield* thrown(connected.tick())).toThrow(
          new RegExp(
            `The transport to ${url.replaceAll(/[.?]/gu, "\\$&")} was used after it was let go, and its socket closed: the connection Transport\\.connect made was closed`,
            "u"
          )
        );
        const kept = yield* Effect.scoped(listenOn(url));
        expect(yield* thrown(kept.send(message("ada", 0)))).toThrow(
          /or the scope Transport\.listen ran in had ended/u
        );
      })
  );
});

/** A WebSocket that a test opens, speaks through and drops by hand. */
class Stub implements Socket.WebSocketLike {
  readyState: number;
  readonly sent: (string | Uint8Array)[] = [];
  readonly closedWith: number[] = [];
  private readonly listeners = new Map<
    string,
    Set<(event: Socket.WebSocketEvent) => void>
  >();
  constructor(down: boolean) {
    this.readyState = down ? 3 : 0;
  }
  addEventListener(
    type: string,
    listener: (event: Socket.WebSocketEvent) => void
  ): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(
    type: string,
    listener: (event: Socket.WebSocketEvent) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }
  private emit(type: string, event: Socket.WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  say(said: string): void {
    this.emit("message", { data: said });
  }
  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  close(code = 1000): void {
    this.closedWith.push(code);
    this.readyState = 3;
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
}

describe("the transport between machines, when its socket drops", () => {
  const url = "ws://relay.test/rooms/blue/ada";

  /** A relay made of stubs: each socket the transport dials is kept, and is born closed while the relay is down. */
  const stubbed = (options?: Transport.WebSocketOptions) => {
    const relay = { down: false, dialed: [] as Stub[] };
    const listen = Transport.listen.pipe(
      Effect.provide(Transport.layerWebSocket(url, options)),
      Effect.provideService(Socket.WebSocketConstructor, () => {
        const stub = new Stub(relay.down);
        relay.dialed.push(stub);
        return stub;
      })
    );
    const last = (): Stub => relay.dialed.at(-1)!;
    return { relay, listen, last };
  };

  const run = <E>(program: Effect.Effect<void, E, Scope.Scope>) =>
    Effect.scoped(program).pipe(Effect.provide(TestClock.layer()));

  it.effect(
    "connects again, waiting longer each time up to two seconds, and sends what was sent meanwhile once it does",
    () =>
      run(
        Effect.gen(function* () {
          const { relay, listen, last } = stubbed();
          const transport = yield* listen;
          yield* transport.send(message("ada", 0));
          yield* TestClock.adjust(0);
          const first = last();
          first.open();
          yield* TestClock.adjust(0);
          expect(first.sent).toEqual([bytes("ada", 0)]);
          first.say(notice({ joined: "grace" }));
          first.drop();
          relay.down = true;
          yield* transport.send(message("ada", 1));
          const dialedAt = [50, 150, 350, 750, 1550, 3150, 5150, 7150];
          let now = 0;
          for (const [i, at] of dialedAt.entries()) {
            yield* TestClock.adjust(at - 1 - now);
            expect(relay.dialed.length).toBe(i + 1);
            yield* TestClock.adjust(1);
            expect(relay.dialed.length).toBe(i + 2);
            now = at;
          }
          relay.down = false;
          yield* TestClock.adjust(2000);
          const again = last();
          again.open();
          yield* TestClock.adjust(0);
          expect(again.sent).toEqual([bytes("ada", 1)]);
          expect(yield* transport.receive()).toEqual([{ joined: "grace" }]);
          expect(first.closedWith).toEqual([1000]);
        })
      )
  );

  it.effect(
    "starts again from the shortest wait, and the whole of reconnectFor, once it has heard from the relay",
    () =>
      run(
        Effect.gen(function* () {
          const { relay, listen, last } = stubbed({ reconnectFor: 1000 });
          const transport = yield* listen;
          yield* TestClock.adjust(0);
          for (let drops = 0; drops < 3; drops++) {
            last().open();
            yield* TestClock.adjust(0);
            last().say(notice({ joined: "grace" }));
            last().drop();
            relay.down = true;
            const dialed = relay.dialed.length;
            yield* TestClock.adjust(49);
            expect(relay.dialed.length).toBe(dialed);
            yield* TestClock.adjust(1);
            expect(relay.dialed.length).toBe(dialed + 1);
            yield* TestClock.adjust(950);
            expect(yield* transport.receive()).toEqual([{ joined: "grace" }]);
            // The relay is back for the next try, 1,550 ms after the drop.
            relay.down = false;
            yield* TestClock.adjust(550);
          }
        })
      )
  );

  it.effect(
    "gives up and says so when it cannot connect again within reconnectFor",
    () =>
      run(
        Effect.gen(function* () {
          const { relay, listen, last } = stubbed({ reconnectFor: 1000 });
          const transport = yield* listen;
          yield* TestClock.adjust(0);
          last().open();
          yield* TestClock.adjust(0);
          last().drop();
          relay.down = true;
          yield* TestClock.adjust(1000);
          expect(yield* closedOf(transport)).toBeUndefined();
          yield* TestClock.adjust(1000);
          expect(yield* closedOf(transport)).toEqual(
            new Transport.Closed({ url, code: 1006, reason: "" })
          );
          expect(yield* Effect.flip(transport.send(message("ada", 0)))).toEqual(
            new Transport.Closed({ url, code: 1006, reason: "" })
          );
          const dialed = relay.dialed.length;
          yield* TestClock.adjust(10_000);
          expect(relay.dialed.length).toBe(dialed);
        })
      )
  );

  it.effect("never connects again with a reconnectFor of 0", () =>
    run(
      Effect.gen(function* () {
        const { relay, listen, last } = stubbed({ reconnectFor: 0 });
        const transport = yield* listen;
        yield* TestClock.adjust(0);
        last().open();
        yield* TestClock.adjust(0);
        last().say(notice({ joined: "grace" }));
        last().drop(1001, "going away");
        yield* TestClock.adjust(0);
        expect(yield* closedOf(transport)).toEqual(
          new Transport.Closed({ url, code: 1001, reason: "going away" })
        );
        yield* TestClock.adjust(10_000);
        expect(relay.dialed.length).toBe(1);
      })
    )
  );

  it.effect("gives up at once on a relay it never reached", () =>
    run(
      Effect.gen(function* () {
        const { relay, listen } = stubbed();
        relay.down = true;
        const transport = yield* listen;
        yield* TestClock.adjust(0);
        expect(yield* closedOf(transport)).toEqual(
          new Transport.Closed({ url, code: 1006, reason: "" })
        );
        yield* TestClock.adjust(60_000);
        expect(relay.dialed.length).toBe(1);
      })
    )
  );

  it.effect(
    "tries a taken name again while it connects again, since the relay may not have seen its old socket close, and not the first time",
    () =>
      run(
        Effect.gen(function* () {
          const { relay, listen, last } = stubbed();
          const transport = yield* listen;
          yield* TestClock.adjust(0);
          last().open();
          yield* TestClock.adjust(0);
          last().say(notice({ joined: "grace" }));
          last().drop();
          yield* TestClock.adjust(50);
          last().open();
          yield* TestClock.adjust(0);
          last().drop(1008, "name taken");
          yield* TestClock.adjust(100);
          expect(relay.dialed.length).toBe(3);
          last().open();
          yield* TestClock.adjust(0);
          last().say(notice({ joined: "grace" }));
          yield* TestClock.adjust(0);
          expect(yield* transport.receive()).toEqual([
            { joined: "grace" },
            { joined: "grace" },
          ]);
          // Refused for any other reason, it gives up.
          last().drop(1008, "speaks for another");
          yield* TestClock.adjust(0);
          expect(yield* closedOf(transport)).toEqual(
            new Transport.Closed({
              url,
              code: 1008,
              reason: "speaks for another",
            })
          );

          const second = stubbed();
          const taken = yield* second.listen;
          yield* TestClock.adjust(0);
          second.last().open();
          yield* TestClock.adjust(0);
          second.last().drop(1008, "name taken");
          yield* TestClock.adjust(0);
          expect(yield* closedOf(taken)).toEqual(
            new Transport.Closed({ url, code: 1008, reason: "name taken" })
          );
          yield* TestClock.adjust(10_000);
          expect(second.relay.dialed.length).toBe(1);
        })
      )
  );

  it.effect(
    "fails Driver.run of the game with Transport.Closed, which the program catches by its tag",
    () =>
      run(
        Effect.gen(function* () {
          const display = Driver.makeManualDisplay();
          const dialed: Stub[] = [];
          const online = Driver.run(
            Effect.flatMap(
              Session.make(CoinGame, {
                seed: 5,
                me: "ada",
                others: ["grace"],
                hz: HZ,
              }),
              (session) => Transport.connect(session)
            )
          ).pipe(
            Effect.catchTag("TransportClosed", (closed) =>
              Effect.succeed(closed)
            ),
            Effect.provide(Transport.layerWebSocket(url)),
            Effect.provideService(Socket.WebSocketConstructor, () => {
              const stub = new Stub(false);
              dialed.push(stub);
              return stub;
            }),
            Effect.provideService(Driver.Display, display)
          );
          const fiber = yield* Effect.forkChild(online, {
            startImmediately: true,
          });
          yield* TestClock.adjust(0);
          dialed.at(-1)!.open();
          yield* TestClock.adjust(0);
          let now = 0;
          for (let i = 0; i < 5; i++) {
            display.frame(now);
            now += 1000 / 30;
          }
          // The relay refuses it, and a new socket would be refused too.
          dialed.at(-1)!.drop(1008, "speaks for another");
          yield* TestClock.adjust(0);
          display.frame(now);
          expect(yield* Fiber.join(fiber)).toEqual(
            new Transport.Closed({
              url,
              code: 1008,
              reason: "speaks for another",
            })
          );
          // The run closed the connection as it ended, and with it the socket.
          expect(display.pending).toBe(0);
          expect(dialed).toHaveLength(1);
        })
      )
  );
});
