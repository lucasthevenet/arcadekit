/**
 * Transports carry a session's messages to the other peers.
 *
 * A multiplayer session holds no socket. It receives the messages that arrived
 * and returns the ones to send, and the transport is the service that carries
 * them:
 *
 *   const program = Driver.run(
 *     Effect.gen(function* () {
 *       const session = yield* Session.make(Duel, { seed, me, others, hz: 60 })
 *       return yield* Transport.connect(session)
 *     })
 *   ).pipe(Effect.provide(Transport.layerBroadcastChannel("game/room-7", me)))
 *
 * `Transport.connect` listens on the transport and returns what a driver
 * steps. Each tick, it passes the session what has arrived, runs the
 * session's tick, and sends what the session produced. The service holds no
 * channel, only how to listen on one, so its layer can be provided anywhere.
 * The channel lasts until the connection is closed, which closes the session
 * too. `Driver.run` closes the connection when the game ends.
 *
 * A transport needs only that every message arrives, in any order. A game
 * gets one from these:
 *
 * - `Transport.layerWebSocket` connects machines through a relay,
 *   `arcadekit/net/Relay`.
 * - `Transport.layerBroadcastChannel` connects the tabs, windows and workers
 *   of one browser.
 * - `Transport.fromWire` listens on anything else that carries
 *   bytes and text.
 * - `Transport.makeHub` is an in-memory network for tests, which delays and
 *   reorders messages as it is told.
 */
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Schedule,
  Scope,
} from "effect";
import { Socket } from "effect/socket";

import { Rng } from "../ecs/random.ts";
import type * as Save from "../Save.ts";
import type * as Drift from "./Drift.ts";
import * as Message from "./Message.ts";
import type { Session } from "./Session.ts";

/**
 * A transport being listened on. Its two calls don't wait, so a tick that
 * uses them stays one synchronous step. Whatever listens behind the
 * transport, a channel or a socket, fills a buffer in its own time, and
 * `receive` returns the buffer.
 *
 * Both fail with `Transport.Closed` once what carries the messages has closed
 * for good, so the tick that uses them fails with it too, and a program
 * catches it by its tag.
 *
 * @category Models
 */
export interface Listener {
  /** Sends a message, or an aside, to every other peer. */
  readonly send: (
    message: Message.Message | Message.Aside
  ) => Effect.Effect<void, Closed>;
  /**
   * Returns the messages that have arrived since the last call, in arrival
   * order, and removes them: the next call returns only newer ones, asides
   * among them. A transport through a relay or a `BroadcastChannel` also
   * returns notices of who joined and who left.
   */
  readonly receive: () => Effect.Effect<
    readonly (Message.Message | Message.Aside | Message.Notice)[],
    Closed
  >;
}

/**
 * The service that says how this peer listens on its transport. A
 * multiplayer game that isn't given one doesn't compile. There is no default,
 * since every way of reaching the other peers is an explicit choice.
 *
 * It holds no channel. `listen` opens one in the scope it is run in, and closes
 * it with that scope. Whatever the layer is provided to, the channel lasts as
 * long as what listens on it. For a connection that `Transport.connect` made,
 * that is until the connection is closed.
 *
 * @category Services
 */
export class Transport extends Context.Service<
  Transport,
  { readonly listen: Effect.Effect<Listener, never, Scope.Scope> }
>()("arcadekit/net/Transport.Transport") {}

/**
 * Listens on this peer's transport in the current scope, and stops when that
 * scope closes. `Transport.connect` listens in a scope of its own instead.
 *
 * **When to use**
 *
 * Use when a program sends and receives messages itself.
 *
 * @category Running
 */
export const listen: Effect.Effect<Listener, never, Transport | Scope.Scope> =
  Effect.flatMap(Transport, (transport) => transport.listen);

/**
 * Returns a layer that provides a transport made by hand, already listened
 * on. The layer doesn't close it: the program that made it does.
 *
 * @category Layers
 */
export const layer = (transport: Listener): Layer.Layer<Transport> =>
  Layer.succeed(Transport, { listen: Effect.succeed(transport) });

/**
 * A session connected to a transport: the session, which a driver steps, and
 * who the transport has said is away. A program that runs it with
 * `Driver.run` is handed it in `ready`, and reads from it what a player is
 * shown: its app, `waitingFor`, `away`, `drifted` and `confirmed`.
 *
 * @typeParam E What a tick of its app can fail with.
 * @typeParam HU The actions its handlers accept.
 * @category Models
 */
export interface Connected<E = never, HU = never> extends Omit<
  Session<E, HU>,
  "tick"
> {
  /**
   * Hands the session what arrived, runs the session's tick, and sends what
   * it produced. It succeeds with whether the session's tick ran. It fails
   * with what the session's tick fails with, with `Transport.Left` when a
   * peer stayed away for longer than `awayFor`, and with `Transport.Closed`
   * once the transport's socket has closed for good.
   */
  readonly tick: () => Effect.Effect<
    boolean,
    E | Drift.Unlike | Drift.Drifted | Save.Refused | Left | Closed
  >;
  /**
   * The peers the transport has said left and that haven't joined again, in
   * order of name. The session waits for them, for as long as `awayFor`
   * says, so tell the player. A transport that reports no peer leaving keeps
   * it empty.
   */
  readonly away: readonly string[];
  /**
   * Stops listening on the transport, then closes the session it connected.
   * A transport of the package dies when used after, and says that its
   * connection was closed. Closing it again does nothing. `Driver.run`
   * closes it when it ends.
   */
  readonly close: Effect.Effect<void>;
}

/**
 * Options for a session connected to a transport.
 *
 * @category Options
 */
export interface ConnectOptions {
  /**
   * How long a peer may be away, in milliseconds of the connection's ticks,
   * before a tick fails with `Transport.Left`. Defaults to 60,000, longer
   * than a WebSocket's `reconnectFor`, so a peer that is connecting again is
   * waited for. With 0 a tick fails as soon as a peer leaves.
   */
  readonly awayFor?: number;
}

/**
 * Peers left the room and did not join it again within `awayFor`. The tick
 * that finds it fails with this error and its driver stops, instead of the
 * game waiting for ever for peers that are gone.
 *
 * @category Errors
 */
export class Left extends Data.TaggedError("TransportLeft")<{
  /** The peers that stayed away too long, in order of name. */
  readonly peers: readonly string[];
  /** How long, in milliseconds, a peer was allowed to be away. */
  readonly awayFor: number;
}> {
  override get message(): string {
    return `${this.peers.join(", ")} left and did not come back within ${this.awayFor} ms, so the game cannot go on.`;
  }
}

/**
 * Listens on the transport, and connects a session to it. Each tick of the
 * result passes the session every message that has arrived, runs the
 * session's tick, and sends what the session produced, whether the tick ran,
 * waited or failed. So a session that stops because the peers drifted apart
 * tells the others first.
 *
 * A relay says a peer joined the room when it comes back after its socket
 * dropped, and tells that peer of each peer already there. On such a notice,
 * the session sends again what some peer hasn't heard. A peer the relay says
 * left is in `away` until it joins again. A tick that finds a peer away for
 * as long as `options.awayFor` fails with `Transport.Left`, naming every
 * such peer, so the driver stops.
 *
 *   yield* Driver.frames(yield* Transport.connect(session))
 *
 * The connection listens in a scope of its own, as an app does, and stands
 * in for the session. Its `close` stops listening and closes the session,
 * and `Driver.run` closes it when it ends. The scope of the program that
 * connects has no effect on how long the transport lasts.
 *
 * @category Running
 */
export const connect = <E, HU>(
  session: Session<E, HU>,
  options: ConnectOptions = {}
): Effect.Effect<Connected<E, HU>, never, Transport> =>
  Effect.flatMap(Transport, ({ listen: open }) =>
    Effect.suspend(() => {
      const scope = Scope.makeUnsafe();
      return Effect.onError(
        Effect.map(Scope.provide(open, scope), (transport) =>
          joined(
            session,
            transport,
            Scope.close(scope, Exit.void),
            options.awayFor ?? 60_000
          )
        ),
        (cause) => Scope.close(scope, Exit.failCause(cause))
      );
    })
  );

/** A session joined to a transport listened on, which `stop` stops. */
const joined = <E, HU>(
  session: Session<E, HU>,
  transport: Listener,
  stop: Effect.Effect<void>,
  awayFor: number
): Connected<E, HU> => {
  // Per peer away, the connection's tick it was said to leave at.
  const away = new Map<string, number>();
  const allowed = (awayFor / 1000) * session.hz;
  let ticks = 0;
  const names = (peers: Iterable<string>): string[] =>
    Array.from(peers).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sendAll = Effect.fnUntraced(function* (
    messages: readonly Message.Message[]
  ) {
    for (const message of messages) {
      yield* transport.send(message);
    }
  });
  const ticking = Effect.gen(function* () {
    let again = false;
    for (const arrived of yield* transport.receive()) {
      if ("topic" in arrived) {
        // Not the game's: a lobby's word, late.
        continue;
      }
      if ("from" in arrived) {
        // Whoever speaks is there, whatever the relay said before.
        away.delete(arrived.from);
        session.receive(arrived);
      } else if ("joined" in arrived) {
        away.delete(arrived.joined);
        again = true;
      } else if (!away.has(arrived.left)) {
        away.set(arrived.left, ticks);
      }
    }
    const gone = names(
      Array.from(away)
        .filter(([, since]) => ticks - since >= allowed)
        .map(([peer]) => peer)
    );
    if (gone.length > 0) {
      return yield* new Left({ peers: gone, awayFor });
    }
    ticks++;
    if (again) {
      yield* sendAll(session.resend());
    }
    // What the session produced is sent whether its tick ran, waited or
    // failed. A tick that failed fails with its own error, sent or not.
    const ticked = yield* Effect.exit(session.tick());
    const sent = yield* Effect.exit(sendAll(session.outgoing()));
    if (Exit.isFailure(ticked)) {
      return yield* ticked;
    }
    yield* sent;
    return ticked.value;
  });
  return {
    app: session.app,
    me: session.me,
    peers: session.peers,
    hz: session.hz,
    delay: session.delay,
    ahead: session.ahead,
    receive: session.receive,
    outgoing: session.outgoing,
    resend: session.resend,
    tick: () => ticking,
    frame: session.frame,
    get drifted() {
      return session.drifted;
    },
    get waitingFor() {
      return session.waitingFor;
    },
    get confirmed() {
      return session.confirmed;
    },
    get lead() {
      return session.lead;
    },
    stats: session.stats,
    get away() {
      return names(away.keys());
    },
    close: Effect.andThen(stop, session.close),
  };
};

/**
 * A channel that carries bytes and text to the other peers: a WebSocket to a
 * relay that forwards each message to the others in a room, a data channel,
 * or a port. Messages go as bytes, and a relay's notices come as text.
 *
 * @category Models
 */
export interface Wire {
  /** Sends a message's bytes to every other peer. */
  readonly send: (bytes: Uint8Array<ArrayBuffer>) => void;
  /**
   * Calls `onData` with each frame that arrives from another peer: bytes as
   * a `Uint8Array` and text as a string, as they were sent. Returns a
   * function that stops listening.
   */
  readonly listen: (onData: (data: string | Uint8Array) => void) => () => void;
}

/**
 * The bytes of a message a session made. A session writes every tick and hash
 * as a whole number and every payload in its JSON form, so one that isn't a
 * message is a defect.
 */
const bytesOf = (
  message: Message.Message | Message.Aside
): Uint8Array<ArrayBuffer> => {
  const bytes =
    "topic" in message ? Message.encodeAside(message) : Message.encode(message);
  if (Exit.isFailure(bytes)) {
    throw Cause.squash(bytes.cause);
  }
  return bytes.value;
};

/**
 * What a frame from another peer is: a message or an aside in bytes, a
 * relay's notice in text, or neither.
 */
const arrival = (
  data: string | Uint8Array
): Message.Message | Message.Aside | Message.Notice | undefined => {
  if (typeof data === "string") {
    const notice = Message.decodeNotice(data);
    return Exit.isSuccess(notice) ? notice.value : undefined;
  }
  const message = Message.decode(data);
  if (Exit.isSuccess(message)) {
    return message.value;
  }
  const aside = Message.decodeAside(data);
  return Exit.isSuccess(aside) ? aside.value : undefined;
};

/**
 * Listens on anything that carries bytes and text, in the current scope, and
 * stops listening when the scope closes. It sends messages in the bytes
 * `Message.encode` writes. It reads arriving bytes with `Message.decode`, and
 * arriving text as a relay's notice with `Message.decodeNotice`, and drops
 * what is neither, since nothing that comes off a wire is trusted.
 *
 *   const layer = Layer.succeed(Transport.Transport, {
 *     listen: Transport.fromWire(wire),
 *   })
 *
 * The wire must deliver every message, in any order. A WebSocket does, and a
 * data channel must be configured to.
 *
 * It dies when it is used after its scope closed. It authenticates no
 * sender, and doesn't report that its wire closed, or tell the other peers
 * that this one joined or left, unless your code sends them a
 * `Message.Notice`.
 *
 * @category Constructors
 */
export const fromWire = (
  wire: Wire
): Effect.Effect<Listener, never, Scope.Scope> =>
  Effect.gen(function* () {
    let inbox: (Message.Message | Message.Aside | Message.Notice)[] = [];
    let open = true;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        wire.listen((data) => {
          const arrived = arrival(data);
          if (arrived !== undefined) {
            inbox.push(arrived);
          }
        })
      ),
      (stop) =>
        Effect.sync(() => {
          open = false;
          stop();
        })
    );
    const use = (): void => {
      if (!open) {
        throw new Error(
          "A transport over a wire was used after the scope it listened in had ended. Use it through a connection that is open: Transport.connect listens in a scope of its own, which its close ends."
        );
      }
    };
    return {
      send: (message) =>
        Effect.sync(() => {
          use();
          wire.send(bytesOf(message));
        }),
      receive: () =>
        Effect.sync(() => {
          use();
          const messages = inbox;
          inbox = [];
          return messages;
        }),
    };
  });

/**
 * The transport between the tabs, windows and workers of one browser, or the
 * threads of one process, over a `BroadcastChannel`. Every peer that opens the
 * same name hears every other. It needs no server, and doesn't reach other
 * machines. `me` is this peer's name, as its session has it.
 *
 * The channel opens when `Transport.connect` listens on the transport, and
 * closes when the connection is closed. A transport used after that dies
 * and says so.
 *
 * As a relay does, it tells the other peers that this one joined when the
 * channel opens, and that it left when the channel closes. `Browser.runMain`
 * closes it when the page is closed for good. A tab that is killed, or a
 * worker that is terminated, says nothing.
 *
 * Unlike a relay, nothing authenticates the sender here. A peer can send a
 * message in another peer's name, and the peers then stop as drifted.
 *
 * @category Layers
 */
export const layerBroadcastChannel = (
  name: string,
  me: string
): Layer.Layer<Transport> =>
  Layer.succeed(Transport, {
    listen: Effect.gen(function* () {
      let open = true;
      const channel = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const made = new BroadcastChannel(name);
          made.postMessage(Message.encodeNotice({ joined: me }));
          return made;
        }),
        (made) =>
          Effect.sync(() => {
            open = false;
            made.postMessage(Message.encodeNotice({ left: me }));
            made.close();
          })
      );
      // Closed before the channel, which says this peer left as it closes.
      const over = yield* fromWire({
        send: (bytes) => channel.postMessage(bytes),
        listen(onData) {
          channel.onmessage = ({ data }: MessageEvent<unknown>) => {
            if (typeof data === "string" || data instanceof Uint8Array) {
              onData(data);
            }
          };
          return () => {
            channel.onmessage = null;
          };
        },
      });
      const use = Effect.suspend(() =>
        open
          ? Effect.succeed(over)
          : Effect.die(
              new Error(
                `The transport "${name}" was used after it was let go, and its channel closed: the connection Transport.connect made was closed, or the scope Transport.listen ran in had ended. It would hear nothing for ever: use it through a connection that is open.`
              )
            )
      );
      return {
        send: (message) => Effect.flatMap(use, (wired) => wired.send(message)),
        receive: () => Effect.flatMap(use, (wired) => wired.receive()),
      } satisfies Listener;
    }),
  });

/**
 * A transport's socket is closed for good: it never opened, the relay refused
 * it, or the network was gone for longer than `reconnectFor`. `send` and
 * `receive` fail with this error from then on. The tick that uses the
 * transport fails with it, and so does `Driver.run`, instead of the game
 * waiting for messages that can never arrive. The relay tells the other
 * peers that this one left.
 *
 * @category Errors
 */
export class Closed extends Data.TaggedError("TransportClosed")<{
  /** The address the socket was opened to. */
  readonly url: string;
  /** The WebSocket close code: 1006 when the connection was lost or never established. */
  readonly code: number;
  /** The reason given by whoever closed the socket, if any: a relay explains why it refused. */
  readonly reason: string;
}> {
  override get message(): string {
    return `The transport's socket to ${this.url} is closed (code ${this.code}${this.reason === "" ? "" : `: ${this.reason}`}). Every message has to arrive, so the game cannot go on over it.`;
  }
}

/**
 * Options for a transport over a WebSocket.
 *
 * @category Options
 */
export interface WebSocketOptions {
  /**
   * How long it keeps trying to connect again once its socket has dropped, in
   * milliseconds. Defaults to 30,000. With 0 it never does, and a socket that
   * drops ends the game for this peer.
   */
  readonly reconnectFor?: number;
}

/** How long it waits before it connects again to a relay it has heard from. */
const FIRST_WAIT = "50 millis";

/**
 * Whether a relay refused a socket for a reason a new one would meet too. A
 * name that is taken is not, for a socket that connects again: the relay may
 * not have seen the old one close yet.
 */
const refused = (code: number, reason: string, again: boolean): boolean =>
  code === 1007 ||
  code === 1009 ||
  (code === 1008 && !(again && reason === "name taken"));

/** The close code and reason a socket ended with: 1006 when it was lost. */
const endOf = (
  error: Socket.SocketError
): { readonly code: number; readonly reason: string } =>
  error.reason._tag === "SocketCloseError"
    ? { code: error.reason.code, reason: error.reason.closeReason ?? "" }
    : { code: 1006, reason: "" };

/**
 * The transport between machines: a WebSocket to a relay, which forwards each
 * message to the other peers of the room. `url` is the relay's address for this
 * peer in its room, as `Relay.address` writes it:
 *
 *   Transport.layerWebSocket(
 *     Relay.address("wss://relay.example.com/rooms", { room: "blue", peer: "ada" })
 *   )
 *
 * - The socket opens when `Transport.connect` listens on the transport. Messages
 *   sent before it opens are buffered and sent once it does.
 * - It closes when the connection is closed. A transport used after that
 *   dies and says so.
 * - When a socket that was open drops, it connects again, waiting longer each
 *   time, up to two seconds, for as long as `reconnectFor` says. What is sent
 *   meanwhile is buffered. The relay tells the room it joined again, and the
 *   sessions send each other again what was lost, as `Transport.connect`
 *   says. Once it hears from the relay again, a later drop is given the whole
 *   of `reconnectFor` again.
 * - A name that is taken is tried again too, since the relay may not have
 *   seen the old socket close yet.
 * - `send` and `receive` fail with `Transport.Closed`, with the close code and the
 *   relay's reason, once the socket closes for good: when it never opened,
 *   when the relay refused it for any other reason, or when it could not
 *   connect again in time.
 *
 * It opens its sockets with the `Socket.WebSocketConstructor` of
 * `effect/socket` where one is provided, and otherwise with the standard
 * `WebSocket`, available in pages, workers and Node 22.
 *
 * @category Layers
 */
export const layerWebSocket = (
  url: string,
  options: WebSocketOptions = {}
): Layer.Layer<Transport> => {
  const reconnectFor = options.reconnectFor ?? 30_000;
  const backoff = Schedule.min([
    Schedule.exponential("100 millis"),
    Schedule.spaced("2 seconds"),
  ]).pipe(Schedule.upTo({ duration: reconnectFor }));
  return Layer.succeed(Transport, {
    listen: Effect.gen(function* () {
      const made = yield* Effect.serviceOption(Socket.WebSocketConstructor);
      const socket = yield* Option.match(made, {
        onNone: () =>
          Effect.provide(
            Socket.makeWebSocket(url),
            Socket.layerWebSocketConstructorGlobal
          ),
        onSome: (construct) =>
          Effect.provideService(
            Socket.makeWebSocket(url),
            Socket.WebSocketConstructor,
            construct
          ),
      });
      const outbox = yield* Queue.unbounded<Uint8Array>();
      let hear: (data: string | Uint8Array) => void = () => {};
      const over = yield* fromWire({
        send(bytes) {
          Queue.offerUnsafe(outbox, bytes);
        },
        listen(onData) {
          hear = onData;
          return () => {
            hear = () => {};
          };
        },
      });
      let listening = true;
      // What `send` and `receive` fail or die with once the socket closed
      // for good.
      let failure: Effect.Effect<never, Closed> | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          listening = false;
        })
      );

      const writer = yield* socket.writer;
      yield* Queue.takeAll(outbox).pipe(
        Effect.flatMap(writer.writeAll),
        Effect.ignore,
        Effect.forever,
        Effect.forkScoped
      );

      let opened = false;
      // Whether this socket connects again after one dropped, and whether
      // the relay has said anything to it.
      let again = false;
      let heard = false;
      const reconnects = (error: Socket.SocketError): boolean => {
        const { code, reason } = endOf(error);
        return opened && reconnectFor > 0 && !refused(code, reason, again);
      };
      const dial = Effect.scoped(
        Effect.gen(function* () {
          again = opened;
          heard = false;
          const { pull } = yield* socket.reader;
          opened = true;
          return yield* Effect.forever(
            Effect.map(pull, (frames) => {
              heard = true;
              for (const frame of frames) {
                hear(frame);
              }
            })
          );
        })
      );
      yield* dial.pipe(
        Effect.retry({
          schedule: backoff,
          while: (error) => !heard && reconnects(error),
        }),
        Effect.retry({
          schedule: Schedule.spaced(FIRST_WAIT),
          while: (error) => heard && reconnects(error),
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const squashed = Cause.squash(cause);
            failure = Socket.isSocketError(squashed)
              ? Effect.fail(new Closed({ url, ...endOf(squashed) }))
              : Effect.die(squashed);
          })
        ),
        Effect.forkScoped
      );

      const use = Effect.suspend(() => {
        if (!listening) {
          return Effect.die(
            new Error(
              `The transport to ${url} was used after it was let go, and its socket closed: the connection Transport.connect made was closed, or the scope Transport.listen ran in had ended. It would hear nothing for ever: use it through a connection that is open.`
            )
          );
        }
        return failure ?? Effect.succeed(over);
      });
      return {
        send: (message) => Effect.flatMap(use, (wired) => wired.send(message)),
        receive: () => Effect.flatMap(use, (wired) => wired.receive()),
      } satisfies Listener;
    }),
  });
};

/**
 * Options for how a hub treats the messages sent through it.
 *
 * @category Testing
 */
export interface HubOptions {
  /**
   * How many steps a message takes to arrive: a number, or a range to draw
   * each message's delay from, so that a message sent later can arrive first.
   * Defaults to 0, so a message is there on the next `receive`.
   */
  readonly delay?: number | { readonly min: number; readonly max: number };
  /** The seed delays are drawn from: the same seed produces the same network. */
  readonly seed?: number;
}

/**
 * An in-memory network for tests: every peer has a port, and what one sends
 * reaches every other.
 *
 * @category Testing
 */
export interface Hub {
  /**
   * Returns a peer's end of the network. A peer receives messages sent from the
   * moment it has a port.
   */
  readonly port: (peer: string) => Listener;
  /** Advances time by one step: every message in transit is one step closer. */
  readonly step: () => void;
  /**
   * Cuts a peer off, as when its socket drops. What is on its way to it or
   * from it is lost. Until it reconnects, it hears nothing, and what it sends
   * is lost. The other peers are told it left, as a relay tells them.
   */
  readonly disconnect: (peer: string) => void;
  /**
   * Connects a peer that was cut off again. The others are told it joined,
   * and it is told of each of them, as a relay tells them, so that each sends
   * again what was lost.
   */
  readonly reconnect: (peer: string) => void;
  /** The number of messages in transit or not yet received. */
  readonly inFlight: number;
}

/**
 * Makes an in-memory network. Nothing is lost unless a peer is cut off with
 * `disconnect`, and time moves only when the test calls `step`. A message is
 * in transit for as many steps as its delay. Messages travel as bytes and
 * notices as text, so a message that wouldn't survive a wire doesn't survive
 * the hub either.
 *
 *   const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 1 })
 *   const ada = yield* Transport.connect(session).pipe(Effect.provide(Transport.layer(hub.port("ada"))))
 *   hub.step()
 *   yield* ada.tick()
 *
 * @category Testing
 */
export const makeHub = (options: HubOptions = {}): Hub => {
  const dice = new Rng(options.seed ?? 0);
  const delay = options.delay ?? 0;
  const min = typeof delay === "number" ? delay : delay.min;
  const max = typeof delay === "number" ? delay : delay.max;
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min < 0 ||
    max < min
  ) {
    throw new Error(
      `A hub's delay is a whole number of steps, 0 or more, or a range of them, and this one is ${min} to ${max}.`
    );
  }
  let now = 0;
  let sent = 0;
  interface Flight {
    readonly at: number;
    readonly order: number;
    readonly from: string | undefined;
    readonly data: string | Uint8Array;
  }
  // Per peer, what is on its way to it.
  const flights = new Map<string, Flight[]>();
  // The peers cut off from the network.
  const cut = new Set<string>();
  const ports = new Map<string, Listener>();
  /** What the hub says of a peer, at once, as a relay does. */
  const tell = (to: string, notice: Message.Notice): void => {
    flights.get(to)?.push({
      at: now,
      order: sent++,
      from: undefined,
      data: Message.encodeNotice(notice),
    });
  };
  const known = (peer: string): void => {
    if (!flights.has(peer)) {
      throw new Error(
        `The hub has no port for "${peer}": a peer is on the network from the moment it has one.`
      );
    }
  };
  const port = (peer: string): Listener => {
    let made = ports.get(peer);
    if (made === undefined) {
      const mine: Flight[] = [];
      flights.set(peer, mine);
      made = {
        send: (message) =>
          Effect.sync(() => {
            if (cut.has(peer)) {
              return;
            }
            const encoded = bytesOf(message);
            for (const [other, theirs] of flights) {
              if (other !== peer && !cut.has(other)) {
                theirs.push({
                  at: now + (min === max ? min : dice.int(min, max)),
                  order: sent++,
                  from: peer,
                  data: encoded,
                });
              }
            }
          }),
        receive: () =>
          Effect.sync(() => {
            const due = mine
              .filter((flight) => flight.at <= now)
              .toSorted((a, b) => a.at - b.at || a.order - b.order);
            if (due.length === 0) {
              return [] as (Message.Message | Message.Aside | Message.Notice)[];
            }
            const left = mine.filter((flight) => flight.at > now);
            mine.length = 0;
            mine.push(...left);
            const arrived: (
              | Message.Message
              | Message.Aside
              | Message.Notice
            )[] = [];
            for (const flight of due) {
              const one = arrival(flight.data);
              if (one !== undefined) {
                arrived.push(one);
              }
            }
            return arrived;
          }),
      };
      ports.set(peer, made);
    }
    return made;
  };
  return {
    port,
    step() {
      now++;
    },
    disconnect(peer) {
      known(peer);
      if (cut.has(peer)) {
        return;
      }
      cut.add(peer);
      // What was on its way to it, and from it, is lost.
      flights.get(peer)!.length = 0;
      for (const [other, theirs] of flights) {
        const kept = theirs.filter((flight) => flight.from !== peer);
        theirs.length = 0;
        theirs.push(...kept);
        if (other !== peer && !cut.has(other)) {
          tell(other, { left: peer });
        }
      }
    },
    reconnect(peer) {
      known(peer);
      if (!cut.delete(peer)) {
        return;
      }
      for (const other of flights.keys()) {
        if (other !== peer && !cut.has(other)) {
          tell(other, { joined: peer });
          tell(peer, { joined: other });
        }
      }
    },
    get inFlight() {
      let count = 0;
      for (const mine of flights.values()) {
        count += mine.length;
      }
      return count;
    },
  };
};
