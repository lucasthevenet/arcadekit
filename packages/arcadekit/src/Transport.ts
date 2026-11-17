/**
 * A transport: what carries a session's messages to the other peers.
 *
 * A session of several peers holds no socket. It is given the messages
 * that arrived and gives the ones to send, and the transport is the
 * service that does the carrying:
 *
 *   const program = Effect.gen(function* () {
 *     const app = yield* App.make({ plugins: [Game], seed })
 *     const session = Rollback.make(app, { peer, peers, delta: 1 / 60 })
 *     return yield* Driver.frames(yield* Transport.connect(session), { hz: 60 })
 *   }).pipe(
 *     Effect.scoped,
 *     Effect.provide(Transport.layerBroadcastChannel("game/room-7"))
 *   )
 *
 * `Transport.connect` gives what a driver steps: each tick it hands the
 * session what has arrived, runs the session's tick, and sends what the
 * session has to say.
 *
 * It asks little of a wire: that every message arrives, in whatever order.
 * `Transport.text` makes a transport of anything that carries text, a
 * WebSocket or a data channel; `Transport.layerBroadcastChannel` is the
 * one between the tabs and workers of one browser; and `Transport.makeHub`
 * is a network in memory, for tests, which delays and reorders as it is
 * told.
 */
import { Context, Effect, Exit, Layer } from "effect";

import type { Tickable } from "./Driver";
import { Rng } from "./ecs/random";
import * as Lockstep from "./Lockstep";

/** What a transport does. Both are plain calls: nothing here waits. */
export interface Shape {
  /** Sends a message to every other peer. */
  readonly send: (message: Lockstep.Message) => void;
  /**
   * The messages that have arrived since it was last asked, in the order
   * they came. They are taken: asked again, it gives the ones that came
   * since.
   */
  readonly receive: () => readonly Lockstep.Message[];
}

/**
 * The transport of this peer. A game of several peers is given one, and
 * one that is given none does not compile: there is no default, since
 * every way of reaching the others is a choice.
 */
export class Transport extends Context.Service<Transport, Shape>()(
  "arcadekit/Transport"
) {}

/** A layer that provides a transport made by hand. */
export const layer = (transport: Shape): Layer.Layer<Transport> =>
  Layer.succeed(Transport, transport);

/**
 * A session joined to the transport: what a driver steps in the session's
 * place. Its `tick` says whether the session's tick ran.
 */
export interface Connected extends Tickable {
  readonly tick: (delta?: number) => boolean;
  /** The session's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => void;
}

/**
 * Joins a session to the transport. Each tick of what it gives hands the
 * session every message that has arrived, runs the session's tick, and
 * sends what the session has to say, whether the tick ran, waited or
 * failed: a session that stops because the peers have come apart says so
 * to the others first.
 *
 *   yield* Driver.frames(yield* Transport.connect(session), { hz: 60 })
 */
export const connect: (
  session: Pick<
    Lockstep.Session<unknown>,
    "frame" | "outgoing" | "receive" | "tick"
  >
) => Effect.Effect<Connected, never, Transport> = Effect.fnUntraced(
  function* (session) {
    const transport = yield* Transport;
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
  }
);

/**
 * Something that carries text to the other peers: a WebSocket to a relay
 * that passes each message on to the others in a room, a data channel, a
 * port.
 */
export interface Wire {
  /** Sends a text to every other peer. */
  readonly send: (text: string) => void;
  /**
   * Calls `onText` with each text that arrives from another peer. Returns
   * what stops it.
   */
  readonly listen: (onText: (text: string) => void) => () => void;
}

/** A transport over a wire, and what stops it listening. */
export interface TextTransport extends Shape {
  /** Stops listening to the wire. */
  readonly close: () => void;
  /**
   * How many texts arrived that were not a message, and were dropped.
   * Nothing that comes off a wire is trusted.
   */
  readonly dropped: number;
}

/**
 * A transport over anything that carries text. A message is sent as
 * `Lockstep.encode` writes it, and a text that arrives is read with
 * `Lockstep.decode`: one that is not a message is dropped and counted.
 *
 * The wire has to deliver every message, in whatever order. A WebSocket
 * does; a data channel has to be told to.
 */
export const text = (wire: Wire): TextTransport => {
  let inbox: Lockstep.Message[] = [];
  let dropped = 0;
  const close = wire.listen((arrived) => {
    const message = Lockstep.decode(arrived);
    if (Exit.isSuccess(message)) {
      inbox.push(message.value);
    } else {
      dropped++;
    }
  });
  return {
    send(message) {
      wire.send(Lockstep.encode(message));
    },
    receive() {
      const messages = inbox;
      inbox = [];
      return messages;
    },
    close,
    get dropped() {
      return dropped;
    },
  };
};

/**
 * The transport between the tabs, the windows and the workers of one
 * browser, or the threads of one process: a `BroadcastChannel`. Every
 * peer that opens the same name hears every other. It needs no server,
 * and reaches no other machine.
 *
 * The channel is opened when the layer is built and closed with its
 * scope, so it is provided to the whole program, as whatever listens is.
 */
export const layerBroadcastChannel = (name: string): Layer.Layer<Transport> =>
  Layer.effect(
    Transport,
    Effect.map(
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
      (held): Shape => {
        const use = (): TextTransport => {
          if (!held.open) {
            throw new Error(
              `The transport "${name}" was used after its scope had closed, and its channel with it. A layer that listens lasts as long as what it is provided to: provide it to the whole program, the one that makes the session and drives it, and not to Transport.connect alone.`
            );
          }
          return held.over;
        };
        return {
          send: (message) => use().send(message),
          receive: () => use().receive(),
        };
      }
    )
  );

/** How a hub treats what is sent through it. */
export interface HubOptions {
  /**
   * How many steps a message takes to arrive: a number, or a range from
   * which each message's is drawn, so that one sent later can arrive
   * first. 0 when left out: it is there the next time it is asked for.
   */
  readonly delay?: number | { readonly min: number; readonly max: number };
  /** Where the delays are drawn from: the same seed, the same network. */
  readonly seed?: number;
}

/**
 * A network in memory, for tests: every peer has a port, and what one
 * sends reaches every other.
 */
export interface Hub {
  /**
   * A peer's end of the network. A peer hears what is sent from the
   * moment it has a port.
   */
  readonly port: (peer: string) => Shape;
  /** A layer that provides a peer's end. */
  readonly layer: (peer: string) => Layer.Layer<Transport>;
  /** Time passes: one step. A message that was `delay` steps away is one nearer. */
  readonly step: () => void;
  /** How many messages are on their way and have not been taken. */
  readonly inFlight: number;
}

/**
 * A network made by hand. Nothing is lost, and nothing happens until the
 * test says so: a message is on its way for as many steps as its delay,
 * and time passes when `step` is called. Messages travel as text, so one
 * that would not survive a wire does not survive this.
 *
 *   const hub = Transport.makeHub({ delay: { min: 0, max: 4 }, seed: 1 })
 *   const ada = yield* Transport.connect(session).pipe(Effect.provide(hub.layer("ada")))
 *   hub.step()
 *   ada.tick()
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
  const ports = new Map<string, Shape>();
  const port = (peer: string): Shape => {
    let made = ports.get(peer);
    if (made === undefined) {
      const mine: { at: number; order: number; text: string }[] = [];
      flights.set(peer, mine);
      made = {
        send(message) {
          const encoded = Lockstep.encode(message);
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
          const messages: Lockstep.Message[] = [];
          for (const flight of due) {
            const message = Lockstep.decode(flight.text);
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
    layer: (peer) => Layer.succeed(Transport, port(peer)),
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
