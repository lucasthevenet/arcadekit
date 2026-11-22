/**
 * Transports carry a session's messages to the other peers.
 *
 * A multiplayer session holds no socket. It receives the messages that arrived
 * and returns the ones to send, and the transport is the service that carries
 * them:
 *
 *   const program = Effect.gen(function* () {
 *     const session = yield* Session.make(Duel, { seed, peer, peers, delta: 1 / 60 })
 *     return yield* Driver.frames(yield* Transport.connect(session), { hz: 60 })
 *   }).pipe(
 *     Effect.scoped,
 *     Effect.provide(Transport.layerBroadcastChannel("game/room-7"))
 *   )
 *
 * `Transport.connect` listens on the transport in the scope of the program
 * that calls it, and returns what a driver steps: each tick, it passes the
 * session what has arrived, runs the session's tick, and sends what the
 * session produced. The service itself holds no channel, only how to listen
 * on one, so its layer can be provided anywhere: the channel lasts as long as
 * the program that drives the session.
 *
 * A transport needs little from its channel: every message must arrive, in any
 * order. `Transport.layerWebSocket` connects machines through a relay
 * (`arcadekit/Relay`); `Transport.layerBroadcastChannel` connects the tabs and
 * workers of one browser; `Transport.text` creates a transport over anything
 * else that carries text; and `Transport.makeHub` is an in-memory network for
 * tests, which delays and reorders messages as configured.
 */
import { Context, Data, Effect, Exit, Layer } from "effect";
import type { Scope } from "effect";

import type { Tickable } from "../Driver";
import { Rng } from "../ecs/random";
import * as Message from "./Message";
import type { Peer } from "./Peer";

/**
 * A transport being listened on. Both of its operations are plain calls: nothing here
 * waits, so a tick that uses them stays one synchronous step. Whatever listens
 * behind the transport, a channel or a socket, fills a buffer in its own time,
 * and `receive` returns the buffer.
 *
 * @category Models
 */
export interface Listener {
  /** Sends a message to every other peer. */
  readonly send: (message: Message.Message) => void;
  /**
   * Returns the messages that have arrived since the last call, in arrival
   * order, and removes them: the next call returns only newer ones.
   */
  readonly receive: () => readonly Message.Message[];
}

/**
 * This peer's transport: how to listen on it. A multiplayer game must be given
 * one, and one without doesn't compile: there is no default, since every way of
 * reaching the other peers is an explicit choice.
 *
 * It holds no channel. `listen` opens one in the scope it is run in, and closes
 * it with that scope, so whatever the layer is provided to, the channel lasts
 * as long as the program that listens on it.
 *
 * @category Services
 */
export class Transport extends Context.Service<
  Transport,
  { readonly listen: Effect.Effect<Listener, never, Scope.Scope> }
>()("arcadekit/Transport") {}

/**
 * Listens on this peer's transport in the current scope, as
 * `Transport.connect` does: for a program that sends and receives messages
 * itself.
 *
 * @category Running
 */
export const listen: Effect.Effect<Listener, never, Transport | Scope.Scope> =
  Effect.flatMap(Transport, (transport) => transport.listen);

/**
 * Returns a layer that provides a hand-made transport, listened on already.
 *
 * @category Layers
 */
export const layer = (transport: Listener): Layer.Layer<Transport> =>
  Layer.succeed(Transport, { listen: Effect.succeed(transport) });

/**
 * A session connected to a transport, which a driver steps in the session's
 * place. Its `tick` returns whether the session's tick ran.
 *
 * @category Models
 */
export interface Connected extends Tickable {
  readonly tick: (delta?: number) => boolean;
  /** The session's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => void;
}

/**
 * Listens on the transport in the current scope and connects a session to it. Each
 * tick of the result passes the session every message that has arrived, runs
 * the session's tick, and sends what the session produced, whether the tick
 * ran, waited or failed: a session that stops because the peers drifted apart
 * tells the others first.
 *
 *   yield* Driver.frames(yield* Transport.connect(session), { hz: 60 })
 *
 * The transport closes with the scope, so drive the session in the program
 * that connected it.
 *
 * @category Running
 */
export const connect: (
  session: Pick<Peer<unknown>, "frame" | "outgoing" | "receive" | "tick">
) => Effect.Effect<Connected, never, Transport | Scope.Scope> =
  Effect.fnUntraced(function* (session) {
    const transport = yield* listen;
    return {
      tick(delta) {
        for (const message of transport.receive()) {
          session.receive(message);
        }
        try {
          return session.tick(delta);
        } finally {
          for (const message of session.outgoing()) {
            transport.send(message);
          }
        }
      },
      frame: session.frame,
    };
  });

/**
 * A channel that carries text to the other peers: a WebSocket to a relay that
 * forwards each message to the others in a room, a data channel, or a port.
 *
 * @category Models
 */
export interface Wire {
  /** Sends a text to every other peer. */
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
   * Stops listening to the wire. `send` and `receive` throw from then on, in
   * place of a game that would wait for messages that can no longer arrive.
   */
  readonly close: () => void;
  /**
   * The number of texts that arrived but weren't messages, and were dropped.
   * Nothing that comes off a wire is trusted.
   */
  readonly dropped: number;
}

/**
 * Makes a transport over anything that carries text. Messages are sent in the
 * format `Message.encode` writes, and arriving text is read with
 * `Message.decode`: text that isn't a message is dropped and counted.
 *
 * The wire must deliver every message, in any order. A WebSocket does; a data
 * channel must be configured to.
 *
 * It throws when it is used after `close`. It authenticates no sender, and
 * doesn't report that its wire closed, unless your code does.
 *
 * @category Constructors
 */
export const text = (wire: Wire): TextTransport => {
  let inbox: Message.Message[] = [];
  let dropped = 0;
  let open = true;
  const use = (): void => {
    if (!open) {
      throw new Error(
        "A transport over text was used after it was closed. Close it when the session it carries is done with it: with the scope of the program that drives the session, as Transport.connect does."
      );
    }
  };
  const stop = wire.listen((arrived) => {
    const message = Message.decode(arrived);
    if (Exit.isSuccess(message)) {
      inbox.push(message.value);
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
 * machines.
 *
 * The channel opens when `Transport.connect` listens on the transport, and
 * closes with the scope it was opened in. A transport used after that throws and says
 * so.
 *
 * Unlike a relay, nothing authenticates the sender here: a peer can send a
 * message in another peer's name, and the peers then stop as drifted.
 *
 * @category Layers
 */
export const layerBroadcastChannel = (name: string): Layer.Layer<Transport> =>
  Layer.succeed(Transport, {
    listen: Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const channel = new BroadcastChannel(name);
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
            held.channel.close();
          })
      ),
      (held): Listener => {
        const use = (): TextTransport => {
          if (!held.open) {
            throw new Error(
              `The transport "${name}" was used after the scope it was opened in had closed, and its channel with it. Transport.connect listens on it in the scope of the program that calls it: drive the session in that program.`
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
 * A transport's socket is no longer open: the relay or the network closed it.
 * `send` and `receive` throw this error from then on, so the tick that uses the
 * transport fails with it and its driver stops, instead of the game waiting for
 * messages that can never arrive. Only the peer whose socket closed is
 * notified: the others wait.
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
 * - It closes with the scope it was opened in; a transport used after that
 *   says so.
 * - Once the socket closes for any other reason, `send` and `receive` throw
 *   `Transport.Closed`, with the close code and the relay's reason. It doesn't
 *   reconnect: a message lost in transit would be lost for good, and nothing
 *   requests it again.
 *
 * It uses the standard `WebSocket`, available in pages, workers and Node 22.
 *
 * @category Layers
 */
export const layerWebSocket = (url: string): Layer.Layer<Transport> =>
  Layer.succeed(Transport, {
    listen: Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new WebSocket(url);
          const held: {
            readonly socket: WebSocket;
            over: TextTransport | undefined;
            open: boolean;
            closed: Closed | undefined;
          } = { socket, over: undefined, open: true, closed: undefined };
          // What was sent before the socket opened.
          let waiting: string[] | undefined = [];
          socket.onopen = () => {
            const kept = waiting ?? [];
            waiting = undefined;
            for (const sent of kept) {
              socket.send(sent);
            }
          };
          socket.onclose = (event: CloseEvent) => {
            held.closed ??= new Closed({
              url,
              code: event.code,
              reason: event.reason,
            });
          };
          // A connection that could not be made, or was cut, may say so
          // here alone: not every platform follows it with a close.
          socket.onerror = () => {
            held.closed ??= new Closed({ url, code: 1006, reason: "" });
          };
          held.over = text({
            send(sent) {
              if (waiting === undefined) {
                socket.send(sent);
              } else {
                waiting.push(sent);
              }
            },
            listen(onText) {
              socket.onmessage = (event: MessageEvent<unknown>) => {
                // A frame that is not text is dropped as what is not a message.
                onText(event.data as string);
              };
              return () => {
                socket.onmessage = null;
              };
            },
          });
          return held;
        }),
        (held) =>
          Effect.sync(() => {
            held.open = false;
            held.over?.close();
            held.socket.onclose = null;
            held.socket.onerror = null;
            held.socket.close(1000);
          })
      ),
      (held): Listener => {
        const use = (): TextTransport => {
          if (!held.open) {
            throw new Error(
              `The transport to ${url} was used after the scope it was opened in had closed, and its socket with it. Transport.connect listens on it in the scope of the program that calls it: drive the session in that program.`
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

/**
 * Options for how a hub treats the messages sent through it.
 *
 * @category Testing
 */
export interface HubOptions {
  /**
   * How many steps a message takes to arrive: a number, or a range each
   * message's delay is drawn from, so a message sent later can arrive first.
   * Defaults to 0: the message is there on the next `receive`.
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
  /** The number of messages in transit or not yet received. */
  readonly inFlight: number;
}

/**
 * Makes an in-memory network. Nothing is lost, and nothing happens until the
 * test says so: a message is in transit for as many steps as its delay, and
 * time advances when `step` is called. Messages travel as text, so a message
 * that wouldn't survive a wire doesn't survive this either.
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
  // Per peer, what is on its way to it.
  const flights = new Map<
    string,
    { readonly at: number; readonly order: number; readonly text: string }[]
  >();
  const ports = new Map<string, Listener>();
  const port = (peer: string): Listener => {
    let made = ports.get(peer);
    if (made === undefined) {
      const mine: { at: number; order: number; text: string }[] = [];
      flights.set(peer, mine);
      made = {
        send(message) {
          const encoded = Message.encode(message);
          for (const [other, theirs] of flights) {
            if (other !== peer) {
              theirs.push({
                at: now + (min === max ? min : dice.int(min, max)),
                order: sent++,
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
          const messages: Message.Message[] = [];
          for (const flight of due) {
            const message = Message.decode(flight.text);
            if (Exit.isSuccess(message)) {
              messages.push(message.value);
            }
          }
          return messages;
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
    get inFlight() {
      let count = 0;
      for (const mine of flights.values()) {
        count += mine.length;
      }
      return count;
    },
  };
};
