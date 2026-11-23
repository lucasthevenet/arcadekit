/**
 * Transports carry a session's messages to the other peers.
 *
 * A multiplayer session holds no socket. It receives the messages that arrived
 * and returns the ones to send, and the transport is the service that carries
 * them:
 *
 *   const program = Driver.run(
 *     Effect.gen(function* () {
 *       const session = yield* Session.make(Duel, { seed, me, others, delta: 1 / 60 })
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
 * - `Transport.text` makes a transport over anything else that carries text.
 * - `Transport.makeHub` is an in-memory network for tests, which delays and
 *   reorders messages as it is told.
 */
import { Context, Data, Effect, Exit, Layer, Scope } from "effect";

import type { Paced } from "../Driver";
import { Rng } from "../ecs/random";
import * as Message from "./Message";
import type { Session } from "./Session";

/**
 * A transport being listened on. Its two calls don't wait, so a tick that
 * uses them stays one synchronous step. Whatever listens behind the
 * transport, a channel or a socket, fills a buffer in its own time, and
 * `receive` returns the buffer.
 *
 * @category Models
 */
export interface Listener {
  /** Sends a message to every other peer. */
  readonly send: (message: Message.Message) => void;
  /**
   * Returns the messages that have arrived since the last call, in arrival
   * order, and removes them: the next call returns only newer ones. A
   * transport through a relay or a `BroadcastChannel` also returns notices of
   * who joined and who left.
   */
  readonly receive: () => readonly (Message.Message | Message.Notice)[];
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
>()("arcadekit/Transport") {}

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
 * A session connected to a transport, which a driver steps in the session's
 * place, at the session's `delta`. Its `tick` returns whether the session's
 * tick ran.
 *
 * @category Models
 */
export interface Connected extends Paced {
  readonly tick: () => boolean;
  /** The session's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => void;
  /**
   * The peers the transport has said left and that haven't joined again, in
   * order of name. The session waits for them, so tell the player.
   * A transport that reports no peer leaving keeps it empty.
   */
  readonly away: readonly string[];
  /**
   * Stops listening on the transport, then closes the session it connected.
   * A transport of the package throws when used after, and says that its
   * connection was closed. Closing it again does nothing. `Driver.run`
   * closes it when it ends.
   */
  readonly close: Effect.Effect<void>;
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
 * left is in `away` until it joins again.
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
export const connect = (
  session: Pick<
    Session<unknown>,
    "close" | "delta" | "frame" | "outgoing" | "receive" | "resend" | "tick"
  >
): Effect.Effect<Connected, never, Transport> =>
  Effect.flatMap(Transport, ({ listen: open }) =>
    Effect.suspend(() => {
      const scope = Scope.makeUnsafe();
      return Effect.onError(
        Effect.map(Scope.provide(open, scope), (transport) =>
          joined(session, transport, Scope.close(scope, Exit.void))
        ),
        (cause) => Scope.close(scope, Exit.failCause(cause))
      );
    })
  );

/** A session joined to a transport listened on, which `stop` stops. */
const joined = (
  session: Parameters<typeof connect>[0],
  transport: Listener,
  stop: Effect.Effect<void>
): Connected => {
  const away = new Set<string>();
  return {
    delta: session.delta,
    tick() {
      let again = false;
      for (const arrived of transport.receive()) {
        if ("from" in arrived) {
          // Whoever speaks is there, whatever the relay said before.
          away.delete(arrived.from);
          session.receive(arrived);
        } else if ("joined" in arrived) {
          away.delete(arrived.joined);
          again = true;
        } else {
          away.add(arrived.left);
        }
      }
      if (again) {
        for (const message of session.resend()) {
          transport.send(message);
        }
      }
      try {
        return session.tick();
      } finally {
        for (const message of session.outgoing()) {
          transport.send(message);
        }
      }
    },
    frame: session.frame,
    get away() {
      return Array.from(away).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
    close: Effect.andThen(stop, session.close),
  };
};

/**
 * A channel that carries text to the other peers: a WebSocket to a relay that
 * forwards each message to the others in a room, a data channel, or a port.
 *
 * @category Models
 */
export interface Wire {
  /** Sends text to every other peer. */
  readonly send: (text: string) => void;
  /**
   * Calls `onText` with each text that arrives from another peer. Returns a
   * function that stops listening.
   */
  readonly listen: (onText: (text: string) => void) => () => void;
}

/**
 * A transport over a wire, with a way to stop listening.
 *
 * @category Models
 */
export interface TextTransport extends Listener {
  /**
   * Stops listening to the wire. `send` and `receive` throw from then on, so
   * a game doesn't wait for messages that can no longer arrive.
   */
  readonly close: () => void;
  /**
   * The number of texts that arrived but weren't messages, and were dropped.
   * Nothing that comes off a wire is trusted.
   */
  readonly dropped: number;
}

/**
 * Makes a transport over anything that carries text. It sends messages as
 * `Message.encode` writes them, and reads arriving text with
 * `Message.decode`, or as a relay's notice with `Message.decodeNotice`. It
 * drops text that is neither, and counts it in `dropped`.
 *
 * The wire must deliver every message, in any order. A WebSocket does, and a
 * data channel must be configured to.
 *
 * It throws when it is used after `close`. It authenticates no sender, and
 * doesn't report that its wire closed, or tell the other peers that this one
 * joined or left, unless your code sends them a `Message.Notice`.
 *
 * @category Constructors
 */
export const text = (wire: Wire): TextTransport => {
  let inbox: (Message.Message | Message.Notice)[] = [];
  let dropped = 0;
  let open = true;
  const use = (): void => {
    if (!open) {
      throw new Error(
        "A transport over text was used after it was closed. Close it when the session it carries is done with it, as the close of a connection Transport.connect made closes the transports of the package."
      );
    }
  };
  const stop = wire.listen((arrived) => {
    const message = Message.decode(arrived);
    if (Exit.isSuccess(message)) {
      inbox.push(message.value);
      return;
    }
    const notice = Message.decodeNotice(arrived);
    if (Exit.isSuccess(notice)) {
      inbox.push(notice.value);
    } else {
      dropped++;
    }
  });
  return {
    send(message) {
      use();
      wire.send(Message.encode(message));
    },
    receive() {
      use();
      const messages = inbox;
      inbox = [];
      return messages;
    },
    close() {
      if (open) {
        open = false;
        stop();
      }
    },
    get dropped() {
      return dropped;
    },
  };
};

/**
 * The transport between the tabs, windows and workers of one browser, or the
 * threads of one process, over a `BroadcastChannel`. Every peer that opens the
 * same name hears every other. It needs no server, and doesn't reach other
 * machines. `me` is this peer's name, as its session has it.
 *
 * The channel opens when `Transport.connect` listens on the transport, and
 * closes when the connection is closed. A transport used after that throws
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
    listen: Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const channel = new BroadcastChannel(name);
          channel.postMessage(Message.encodeNotice({ joined: me }));
          const over = text({
            send: (message) => channel.postMessage(message),
            listen(onText) {
              channel.onmessage = (event: MessageEvent<unknown>) => {
                // Whatever else is posted under the name is not text, and
                // is dropped as what is not a message.
                onText(event.data as string);
              };
              return () => {
                channel.onmessage = null;
              };
            },
          });
          return { channel, over, open: true };
        }),
        (held) =>
          Effect.sync(() => {
            held.open = false;
            held.over.close();
            held.channel.postMessage(Message.encodeNotice({ left: me }));
            held.channel.close();
          })
      ),
      (held): Listener => {
        const use = (): TextTransport => {
          if (!held.open) {
            throw new Error(
              `The transport "${name}" was used after it was let go, and its channel closed: the connection Transport.connect made was closed, or the scope Transport.listen ran in had ended. It would hear nothing for ever: use it through a connection that is open.`
            );
          }
          return held.over;
        };
        return {
          send: (message) => use().send(message),
          receive: () => use().receive(),
        };
      }
    ),
  });

/**
 * A transport's socket is closed for good: it never opened, the relay refused
 * it, or the network was gone for longer than `reconnectFor`. `send` and
 * `receive` throw this error from then on. The tick that uses the transport
 * fails with it and its driver stops, instead of the game waiting for
 * messages that can never arrive. The relay tells the other peers that this
 * one left.
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

/** How long it waits before it connects again, at first and at most. */
const FIRST_WAIT = 50;
const LONGEST_WAIT = 2000;

/**
 * Whether a relay refused a socket for a reason a new one would meet too. A
 * name that is taken is not, for a socket that connects again: the relay may
 * not have seen the old one close yet.
 */
const refused = (code: number, reason: string, again: boolean): boolean =>
  code === 1007 ||
  code === 1009 ||
  (code === 1008 && !(again && reason === "name taken"));

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
 *   throws and says so.
 * - When a socket that was open drops, it connects again, waiting longer each
 *   time, up to two seconds, for as long as `reconnectFor` says. What is sent
 *   meanwhile is buffered. The relay tells the room it joined again, and the
 *   sessions send each other again what was lost, as `Transport.connect`
 *   says.
 * - A name that is taken is tried again too, since the relay may not have
 *   seen the old socket close yet.
 * - `send` and `receive` throw `Transport.Closed`, with the close code and the
 *   relay's reason, once the socket closes for good: when it never opened,
 *   when the relay refused it for any other reason, or when it could not
 *   connect again in time.
 *
 * It uses the standard `WebSocket`, available in pages, workers and Node 22.
 *
 * @category Layers
 */
export const layerWebSocket = (
  url: string,
  options: WebSocketOptions = {}
): Layer.Layer<Transport> => {
  const reconnectFor = options.reconnectFor ?? 30_000;
  return Layer.succeed(Transport, {
    listen: Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const held: {
            socket: WebSocket | undefined;
            over: TextTransport | undefined;
            open: boolean;
            closed: Closed | undefined;
            timer: ReturnType<typeof setTimeout> | undefined;
          } = {
            socket: undefined,
            over: undefined,
            open: true,
            closed: undefined,
            timer: undefined,
          };
          // What was sent while no socket was open.
          let waiting: string[] | undefined = [];
          let hear: (text: string) => void = () => {};
          let opened = false;
          // When it stops trying to connect again, while it tries.
          let until: number | undefined;
          let tries = 0;

          // `again` for a socket that connects again after one dropped.
          const dial = (again: boolean): void => {
            held.timer = undefined;
            const socket = new WebSocket(url);
            held.socket = socket;
            const dropped = (code: number, reason: string): void => {
              socket.onopen = null;
              socket.onclose = null;
              socket.onerror = null;
              socket.onmessage = null;
              waiting ??= [];
              if (!held.open) {
                return;
              }
              until ??= Date.now() + reconnectFor;
              if (
                !opened ||
                refused(code, reason, again) ||
                Date.now() >= until
              ) {
                held.closed = new Closed({ url, code, reason });
                return;
              }
              held.timer = setTimeout(
                () => dial(true),
                Math.min(FIRST_WAIT * 2 ** tries++, LONGEST_WAIT)
              );
            };
            socket.onopen = () => {
              opened = true;
              const kept = waiting ?? [];
              waiting = undefined;
              for (const sent of kept) {
                socket.send(sent);
              }
            };
            socket.onmessage = (event: MessageEvent<unknown>) => {
              // Heard from: the relay let it in, and it is connected again.
              until = undefined;
              tries = 0;
              // A frame that is not text is dropped as what is not a message.
              hear(event.data as string);
            };
            socket.onclose = (event: CloseEvent) => {
              dropped(event.code, event.reason);
            };
            // A connection that could not be made, or was cut, may say so
            // here alone: not every platform follows it with a close.
            socket.onerror = () => {
              dropped(1006, "");
            };
          };

          held.over = text({
            send(sent) {
              if (waiting === undefined) {
                held.socket!.send(sent);
              } else {
                waiting.push(sent);
              }
            },
            listen(onText) {
              hear = onText;
              return () => {
                hear = () => {};
              };
            },
          });
          dial(false);
          return held;
        }),
        (held) =>
          Effect.sync(() => {
            held.open = false;
            held.over?.close();
            clearTimeout(held.timer);
            const { socket } = held;
            if (socket !== undefined) {
              socket.onopen = null;
              socket.onclose = null;
              socket.onerror = null;
              socket.onmessage = null;
              socket.close(1000);
            }
          })
      ),
      (held): Listener => {
        const use = (): TextTransport => {
          if (!held.open) {
            throw new Error(
              `The transport to ${url} was used after it was let go, and its socket closed: the connection Transport.connect made was closed, or the scope Transport.listen ran in had ended. It would hear nothing for ever: use it through a connection that is open.`
            );
          }
          if (held.closed !== undefined) {
            throw held.closed;
          }
          return held.over!;
        };
        return {
          send: (message) => use().send(message),
          receive: () => use().receive(),
        };
      }
    ),
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
  /** Returns a layer that provides a peer's end. */
  readonly layer: (peer: string) => Layer.Layer<Transport>;
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
 * in transit for as many steps as its delay. Messages travel as text, so a
 * message that wouldn't survive a wire doesn't survive the hub either.
 *
 *   const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 1 })
 *   const ada = yield* Transport.connect(session).pipe(Effect.provide(hub.layer("ada")))
 *   hub.step()
 *   ada.tick()
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
    readonly text: string;
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
      text: Message.encodeNotice(notice),
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
        send(message) {
          if (cut.has(peer)) {
            return;
          }
          const encoded = Message.encode(message);
          for (const [other, theirs] of flights) {
            if (other !== peer && !cut.has(other)) {
              theirs.push({
                at: now + (min === max ? min : dice.int(min, max)),
                order: sent++,
                from: peer,
                text: encoded,
              });
            }
          }
        },
        receive() {
          const due = mine
            .filter((flight) => flight.at <= now)
            .toSorted((a, b) => a.at - b.at || a.order - b.order);
          if (due.length === 0) {
            return [];
          }
          const left = mine.filter((flight) => flight.at > now);
          mine.length = 0;
          mine.push(...left);
          const arrived: (Message.Message | Message.Notice)[] = [];
          for (const flight of due) {
            const message = Message.decode(flight.text);
            if (Exit.isSuccess(message)) {
              arrived.push(message.value);
              continue;
            }
            const notice = Message.decodeNotice(flight.text);
            if (Exit.isSuccess(notice)) {
              arrived.push(notice.value);
            }
          }
          return arrived;
        },
      };
      ports.set(peer, made);
    }
    return made;
  };
  return {
    port,
    layer: (peer) => layer(port(peer)),
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
