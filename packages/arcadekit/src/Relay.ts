/**
 * Relays pass a game's messages between peers on different machines.
 *
 * Each peer opens a WebSocket to the relay, at an address that names a room and
 * the peer. The relay forwards what one peer sends to the others in its room.
 * It runs no game and keeps no game state: it receives text and forwards text.
 *
 * The relay is a handler, not a server: plain functions that decide what to do
 * with a connection and with what it sends, called by whatever accepts the
 * sockets. The host can store its connections anywhere, including on the socket
 * itself, on platforms that discard everything else between two messages:
 *
 *   // a peer asks to connect: who is it, and may it join?
 *   const member = Relay.join(request.url, present)        // Exit<Member, Refused>
 *
 *   // a member sent something: what goes to whom?
 *   const deliveries = Relay.forward(member, data, present) // Exit<Delivery[], Refused>
 *   for (const { to, text } of deliveries.value) socketOf(to).send(text)
 *
 * `present` is everyone connected to that room, as the host tracks them: on
 * Cloudflare, what a Durable Object reads back from its sockets' attachments;
 * behind an API Gateway, the rows of a connections table. `Relay.make()` tracks
 * them itself, for a host that stays in memory, such as a Node server or a
 * test.
 *
 * The relay authenticates the sender. A peer declares its name once, when it
 * connects, and is held to it: a message that claims to be from anyone else is
 * refused, and its socket closed. The `from` a handler receives is therefore
 * the peer the relay admitted under that name. Deciding whether to admit that
 * peer under that name is the host's responsibility, before it calls `join`,
 * using a token in the request, a session, or whatever it has.
 *
 * A room belongs to nobody: the first peer to connect opens it, and it closes
 * when the last one leaves. The relay doesn't announce who joins or leaves.
 */
import { Data, Exit, Predicate, Schema } from "effect";

import * as Lockstep from "./Lockstep";

/**
 * A connection's identity: its room, and the peer it speaks for. A host stores
 * this with the connection, and passes the relay everyone in a room when it
 * asks what to do.
 *
 * @category Schemas
 */
export const Member: Schema.Struct<{
  readonly room: typeof Schema.String;
  readonly peer: typeof Schema.String;
}> = Schema.Struct({ room: Schema.String, peer: Schema.String });

export type Member = typeof Member.Type;

/**
 * One text to send to one member of the room.
 *
 * @category Models
 */
export interface Delivery {
  readonly to: Member;
  readonly text: string;
}

/**
 * The relay refuses a peer that may not join, or a message it won't forward.
 *
 * The host closes the socket with `code` and `reason`:
 * `socket.close(refused.code, refused.reason)`. The reason is a few words,
 * since a close frame carries at most 123 bytes, and is what the peer's
 * transport receives. `message` gives more detail, with names, for a log or for
 * the body of an HTTP response with `status`. A page learns nothing from a
 * connection request rejected with a status, so a host that wants the peer to
 * know why accepts the socket and then closes it.
 *
 * @category Errors
 */
export class Refused extends Data.TaggedError("RelayRefused")<{
  readonly reason:
    | "not an address"
    | "name taken"
    | "room full"
    | "not a peer"
    | "not a message"
    | "speaks for another"
    | "too long";
  readonly message: string;
  /** For a rejected connection request: 400, 403 or 409. */
  readonly status: number;
  /** For a closed socket: 1007, 1008 or 1009. */
  readonly code: number;
}> {}

/**
 * Options for a relay's rooms: how many peers each admits, and which names.
 *
 * @category Options
 */
export interface Options {
  /**
   * The maximum number of peers in a room. Defaults to 8. One more is refused
   * with `"room full"`.
   */
  readonly maxPeers?: number;
  /**
   * The only names a room admits, for a game that knows its players. Defaults
   * to any name.
   */
  readonly peers?: readonly string[];
  /**
   * The longest text a member may send, in characters. Defaults to 65,536. A
   * longer one is refused with `"too long"`.
   */
  readonly maxLength?: number;
}

/** The maximum length of a room's or a peer's name. */
const NAME_LENGTH = 64;

const refuse = (
  reason: Refused["reason"],
  message: string,
  status: number,
  code: number
): Exit.Exit<never, Refused> =>
  Exit.fail(new Refused({ reason, message, status, code }));

/**
 * Returns the address a peer connects to: the relay's address, then the room,
 * with the peer's name as a query parameter.
 *
 *   Relay.address("wss://relay.example.com/rooms", { room: "blue", peer: "ada" })
 *   // "wss://relay.example.com/rooms/blue?peer=ada"
 *
 * @category Hosting
 */
export const address = (base: string, member: Member): string =>
  `${base.replace(/\/+$/u, "")}/${encodeURIComponent(member.room)}?peer=${encodeURIComponent(member.peer)}`;

/**
 * Decides whether a peer may join, from the address it requested and who is
 * already in that room. The returned member is what the host stores with the
 * connection.
 *
 * The room is the last segment of the address's path and the peer its `peer`
 * query parameter, as `address` writes them, each at most 64 characters. The
 * peer is refused when the address lacks either, when the name is taken in that
 * room, when the room is full, or when the room only admits other names.
 *
 * It doesn't verify that the peer is who it claims to be: the host must settle
 * that before calling it, using whatever the request carries. Whoever first
 * asks for a free name is admitted.
 *
 * @category Hosting
 */
export const join = (
  url: string,
  present: readonly Member[],
  options: Options = {}
): Exit.Exit<Member, Refused> => {
  let room: string | undefined;
  let peer: string | null;

  try {
    // A host may be handed the whole address or its path alone.
    const parsed = new URL(url, "ws://relay");
    room = decodeURIComponent(
      parsed.pathname.split("/").findLast((part) => part !== "") ?? ""
    );
    peer = parsed.searchParams.get("peer");
  } catch {
    room = undefined;
    peer = null;
  }

  if (
    room === undefined ||
    room === "" ||
    room.length > NAME_LENGTH ||
    peer === null ||
    peer === "" ||
    peer.length > NAME_LENGTH
  ) {
    return refuse(
      "not an address",
      `"${url}" is not a relay's address: it ends in a room's name and says which peer is asking, as Relay.address writes it, each ${NAME_LENGTH} characters at most.`,
      400,
      1008
    );
  }

  if (options.peers !== undefined && !options.peers.includes(peer)) {
    return refuse(
      "not a peer",
      `"${peer}" is not one of the peers the room "${room}" lets in.`,
      403,
      1008
    );
  }

  const inRoom = present.filter((member) => member.room === room);

  if (inRoom.some((member) => member.peer === peer)) {
    return refuse(
      "name taken",
      `A peer named "${peer}" is in the room "${room}" already.`,
      409,
      1008
    );
  }

  const most = options.maxPeers ?? 8;

  if (inRoom.length >= most) {
    return refuse(
      "room full",
      `The room "${room}" has the ${most} peers it takes.`,
      403,
      1008
    );
  }

  return Exit.succeed({ room, peer });
};

const decoder = new TextDecoder();

/**
 * Decides what to do with a member's message: the text to forward to every
 * other member of its room.
 *
 * The forwarded text is the message as the relay parsed it, re-serialized, so
 * nothing extra rides along. The message is refused, and the host closes the
 * socket with the refusal's `code`, when it isn't a message, when it is longer
 * than the relay accepts, or when it claims to be from anyone but the member
 * that sent it.
 *
 * @category Hosting
 */
export const forward = (
  from: Member,
  data: string | ArrayBuffer | ArrayBufferView,
  present: readonly Member[],
  options: Options = {}
): Exit.Exit<readonly Delivery[], Refused> => {
  const text = Predicate.isString(data) ? data : decoder.decode(data);
  const longest = options.maxLength ?? 65_536;

  if (text.length > longest) {
    return refuse(
      "too long",
      `"${from.peer}" sent ${text.length} characters, and the relay takes ${longest} at most.`,
      400,
      1009
    );
  }

  const message = Lockstep.decode(text);

  if (Exit.isFailure(message)) {
    return refuse(
      "not a message",
      `"${from.peer}" sent something that is not a message.`,
      400,
      1007
    );
  }

  if (message.value.from !== from.peer) {
    return refuse(
      "speaks for another",
      `"${from.peer}" sent a message that says it is from "${message.value.from}". A peer speaks for itself.`,
      403,
      1008
    );
  }

  const passedOn = Lockstep.encode(message.value);
  const deliveries: Delivery[] = [];

  for (const member of present) {
    if (member.room === from.room && member.peer !== from.peer) {
      deliveries.push({ to: member, text: passedOn });
    }
  }

  return Exit.succeed(deliveries);
};

/**
 * A peer's connection to an in-memory relay.
 *
 * @category Models
 */
export interface Connection {
  readonly member: Member;
  /**
   * Takes what the peer sent, and forwards it to the others in the room. Fails
   * when the message is refused, so the host can close the socket.
   */
  readonly receive: (
    data: string | ArrayBuffer | ArrayBufferView
  ) => Exit.Exit<void, Refused>;
  /** Ends the connection: the peer's name is free again. */
  readonly close: () => void;
}

/**
 * A relay that tracks connected peers itself.
 *
 * @category Models
 */
export interface Server {
  /**
   * Connects a peer at `url`, with `send` for the relay to reach it. Fails when
   * the peer may not join.
   */
  readonly connect: (
    url: string,
    send: (text: string) => void
  ) => Exit.Exit<Connection, Refused>;
  /** Returns who is in a room, in the order they joined. */
  readonly members: (room: string) => readonly Member[];
  /** The number of rooms with anyone in them. */
  readonly rooms: number;
}

/**
 * Makes a relay for a host that stays in memory, such as a Node server, a
 * Durable Object that doesn't hibernate, or a test. It tracks connected peers,
 * and is told about each socket as it opens and closes.
 *
 *   const relay = Relay.make()
 *   server.on("connection", (socket, request) => {
 *     const connection = relay.connect(request.url, (text) => socket.send(text))
 *     if (Exit.isFailure(connection)) return socket.close(1008, "refused")
 *     socket.on("message", (data) => connection.value.receive(data))
 *     socket.on("close", () => connection.value.close())
 *   })
 *
 * @category Constructors
 */
export const make = (options: Options = {}): Server => {
  // Per room, how to send to each peer in it, by name.
  const rooms = new Map<
    string,
    Map<string, { readonly send: (text: string) => void }>
  >();

  const members = (room: string): Member[] =>
    Array.from(rooms.get(room)?.keys() ?? [], (peer) => ({ room, peer }));

  return {
    connect(url, send) {
      // Only that room's members are needed, and the address says which.
      const all = [...rooms.keys()].flatMap((room) => members(room));
      const joined = join(url, all, options);

      if (Exit.isFailure(joined)) {
        return Exit.failCause(joined.cause);
      }

      const member = joined.value;
      let room = rooms.get(member.room);

      if (room === undefined) {
        room = new Map();
        rooms.set(member.room, room);
      }

      // The connection itself, so that its close is told from a later one's.
      const self = { send };
      room.set(member.peer, self);
      const peers = room;

      return Exit.succeed({
        member,
        receive(data) {
          const deliveries = forward(
            member,
            data,
            members(member.room),
            options
          );

          if (Exit.isFailure(deliveries)) {
            return Exit.failCause(deliveries.cause);
          }

          for (const { text, to } of deliveries.value) {
            peers.get(to.peer)?.send(text);
          }

          return Exit.void;
        },
        close() {
          // Unless the name has been given to a newer connection since.
          if (peers.get(member.peer) === self) {
            peers.delete(member.peer);

            if (peers.size === 0 && rooms.get(member.room) === peers) {
              rooms.delete(member.room);
            }
          }
        },
      });
    },
    members,
    get rooms() {
      return rooms.size;
    },
  };
};
